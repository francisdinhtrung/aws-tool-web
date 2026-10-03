import { api } from '../api.js';

export const sqs = (op, input = {}) => api(`/api/sqs/op/${op}`, { method: 'POST', body: input });

// --- Names, URLs, ARNs ---------------------------------------------------------------------
export const queueNameFromUrl = (url) => decodeURIComponent(String(url || '').replace(/\/+$/, '').split('/').pop());
export const queueNameFromArn = (arn) => String(arn || '').split(':').pop();
export const isFifo = (name) => String(name || '').endsWith('.fifo');
export const sqsPath = (name) => (name ? `/sqs/queue/${encodeURIComponent(name)}` : '/sqs');
export const QUEUE_NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Error text for a queue name without its .fifo suffix, or '' when valid. */
export function queueNameError(base, fifo) {
  if (!base) return 'Name is required';
  if (!QUEUE_NAME_RE.test(base)) return 'Use letters, digits, hyphens and underscores only';
  if (base.length + (fifo ? 5 : 0) > 80) return 'Name is longer than 80 characters';
  return '';
}

export async function listAllQueues({ prefix, max = 5000 } = {}) {
  const urls = [];
  let NextToken;
  do {
    const out = await sqs('ListQueues', { MaxResults: 1000, ...(prefix ? { QueueNamePrefix: prefix } : {}), ...(NextToken ? { NextToken } : {}) });
    urls.push(...(out.QueueUrls || []));
    NextToken = out.NextToken;
  } while (NextToken && urls.length < max);
  return { urls: urls.sort((a, b) => queueNameFromUrl(a).localeCompare(queueNameFromUrl(b))), more: Boolean(NextToken) };
}

export const getQueueUrl = async (name) => (await sqs('GetQueueUrl', { QueueName: name })).QueueUrl;
export const getQueueAttributes = async (url) => (await sqs('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['All'] })).Attributes || {};

// --- Formatting ------------------------------------------------------------------------------
const UNITS = [
  [86400, 'day'],
  [3600, 'hour'],
  [60, 'minute'],
  [1, 'second'],
];

/** 345600 -> "4 days", 90 -> "1 minute 30 seconds". */
export function fmtSeconds(sec) {
  let n = Number(sec);
  if (sec === undefined || sec === null || sec === '' || Number.isNaN(n)) return '—';
  if (n === 0) return '0 seconds';
  const parts = [];
  for (const [size, name] of UNITS) {
    if (n >= size) {
      const k = Math.floor(n / size);
      n -= k * size;
      parts.push(`${k} ${name}${k === 1 ? '' : 's'}`);
    }
  }
  return parts.slice(0, 2).join(' ');
}

export const fmtEpoch = (v, seconds = false) => {
  const n = Number(v);
  if (!v || Number.isNaN(n)) return '—';
  return new Date(seconds ? n * 1000 : n).toLocaleString();
};

export const byteLength = (s) => new TextEncoder().encode(String(s ?? '')).length;

export function parseJsonSafe(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Pretty-prints a JSON body; returns the input unchanged when it is not JSON. */
export function prettyBody(body) {
  const t = String(body ?? '').trim();
  if (!/^[[{]/.test(t)) return body;
  const v = parseJsonSafe(t);
  return v === undefined ? body : JSON.stringify(v, null, 2);
}

// --- Queue attributes ------------------------------------------------------------------------
// [name, label, min, max, unit hint]
export const NUMERIC_ATTRS = [
  ['VisibilityTimeout', 'Visibility timeout', 0, 43200, 'seconds (0 – 12 hours)'],
  ['MessageRetentionPeriod', 'Message retention period', 60, 1209600, 'seconds (1 minute – 14 days)'],
  ['DelaySeconds', 'Delivery delay', 0, 900, 'seconds (0 – 15 minutes)'],
  ['MaximumMessageSize', 'Maximum message size', 1024, 1048576, 'bytes (1 KiB – 1 MiB)'],
  ['ReceiveMessageWaitTimeSeconds', 'Receive message wait time', 0, 20, 'seconds (0 – 20, > 0 enables long polling)'],
];

export const DEFAULT_ATTRS = { VisibilityTimeout: '30', MessageRetentionPeriod: '345600', DelaySeconds: '0', MaximumMessageSize: '262144', ReceiveMessageWaitTimeSeconds: '0' };

/** Validates the numeric attributes of a form; returns { name: message }. */
export function attrErrors(values) {
  const errs = {};
  for (const [k, label, min, max] of NUMERIC_ATTRS) {
    if (values[k] === undefined || values[k] === '') continue;
    const n = Number(values[k]);
    if (!Number.isInteger(n) || n < min || n > max) errs[k] = `${label} must be an integer between ${min} and ${max}`;
  }
  return errs;
}

/** Attributes whose value differs from `old`, as strings (SetQueueAttributes input). */
export function changedAttrs(values, old = {}) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    if (String(v) !== String(old[k] ?? '')) out[k] = String(v);
  }
  return out;
}

export function parseRedrivePolicy(text) {
  const p = parseJsonSafe(text);
  if (!p?.deadLetterTargetArn) return null;
  return { deadLetterTargetArn: p.deadLetterTargetArn, maxReceiveCount: Number(p.maxReceiveCount) || 0 };
}

export const buildRedrivePolicy = (arn, maxReceiveCount) => (arn ? JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: Number(maxReceiveCount) || 1 }) : '');

export function parseRedriveAllow(text) {
  const p = parseJsonSafe(text);
  if (!p?.redrivePermission) return { redrivePermission: 'allowAll', sourceQueueArns: [] };
  return { redrivePermission: p.redrivePermission, sourceQueueArns: p.sourceQueueArns || [] };
}

export function buildRedriveAllow({ redrivePermission, sourceQueueArns = [] }) {
  if (redrivePermission === 'byQueue') return JSON.stringify({ redrivePermission, sourceQueueArns });
  return JSON.stringify({ redrivePermission });
}

export function encryptionLabel(a = {}) {
  if (a.KmsMasterKeyId) return `SSE-KMS (${a.KmsMasterKeyId})`;
  if (a.SqsManagedSseEnabled === 'true') return 'SSE-SQS';
  return 'None';
}

/** Approximate counters as numbers. */
export const queueCounts = (a = {}) => ({
  available: Number(a.ApproximateNumberOfMessages || 0),
  inFlight: Number(a.ApproximateNumberOfMessagesNotVisible || 0),
  delayed: Number(a.ApproximateNumberOfMessagesDelayed || 0),
});

// --- Messages -----------------------------------------------------------------------------------
export const ATTR_TYPES = ['String', 'Number', 'Binary'];

/** Converts editor rows [{ name, type, value }] to SQS MessageAttributes. Throws on invalid rows. */
export function toMessageAttributes(rows = []) {
  const out = {};
  for (const r of rows) {
    const name = String(r.name || '').trim();
    if (!name && !r.value) continue;
    if (!name) throw new Error('Message attribute name is required');
    if (out[name]) throw new Error(`Duplicate message attribute "${name}"`);
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(name) || /^(aws\.|amazon\.)/i.test(name) || name.startsWith('.') || name.endsWith('.') || name.includes('..')) {
      throw new Error(`Invalid message attribute name "${name}"`);
    }
    const type = r.type || 'String';
    const base = type.split('.')[0];
    if (base === 'Number' && (r.value === '' || Number.isNaN(Number(r.value)))) throw new Error(`Attribute "${name}" must be a number`);
    if (base === 'Binary') {
      try {
        atob(String(r.value || ''));
      } catch {
        throw new Error(`Attribute "${name}" must be base64`);
      }
      out[name] = { DataType: type, BinaryValue: String(r.value || '') };
    } else {
      if (r.value === '' || r.value === undefined) throw new Error(`Attribute "${name}" needs a value`);
      out[name] = { DataType: type, StringValue: String(r.value) };
    }
  }
  return out;
}

export const fromMessageAttributes = (attrs = {}) =>
  Object.entries(attrs).map(([name, a]) => ({ name, type: a.DataType || 'String', value: a.StringValue ?? a.BinaryValue ?? '' }));

/** SendMessage input from the send form. */
export function buildSendInput(url, { body, delay, groupId, dedupId, attrs }, fifo = isFifo(queueNameFromUrl(url))) {
  if (!String(body ?? '').length) throw new Error('Message body is required');
  const input = { QueueUrl: url, MessageBody: String(body) };
  if (fifo) {
    if (!String(groupId || '').trim()) throw new Error('Message group ID is required for FIFO queues');
    input.MessageGroupId = String(groupId).trim();
    if (String(dedupId || '').trim()) input.MessageDeduplicationId = String(dedupId).trim();
  } else if (delay !== undefined && delay !== '') {
    const d = Number(delay);
    if (!Number.isInteger(d) || d < 0 || d > 900) throw new Error('Delay must be an integer between 0 and 900 seconds');
    input.DelaySeconds = d;
  }
  const ma = toMessageAttributes(attrs);
  if (Object.keys(ma).length) input.MessageAttributes = ma;
  return input;
}

/** Sends `count` copies of a message using SendMessageBatch (10 per call). FIFO copies get unique dedup IDs. */
export async function sendCopies(input, count, onProgress) {
  let sent = 0;
  const failed = [];
  for (let start = 0; start < count; start += 10) {
    const n = Math.min(10, count - start);
    const Entries = Array.from({ length: n }, (_, i) => {
      const { QueueUrl, ...rest } = input; // eslint-disable-line no-unused-vars
      const e = { Id: String(start + i), ...rest };
      if (e.MessageDeduplicationId) e.MessageDeduplicationId = `${e.MessageDeduplicationId}-${start + i}`;
      return e;
    });
    const out = await sqs('SendMessageBatch', { QueueUrl: input.QueueUrl, Entries });
    sent += (out.Successful || []).length;
    failed.push(...(out.Failed || []));
    onProgress?.(sent, count);
  }
  return { sent, failed };
}

/**
 * Receives up to `max` messages within `seconds`, deduplicated by MessageId (latest receipt handle wins).
 * Messages stay invisible to other consumers for `visibility` seconds and their receive count goes up.
 */
export async function pollMessages(url, { max = 10, seconds = 10, visibility = 30, onBatch, signal } = {}) {
  const found = new Map();
  const deadline = Date.now() + seconds * 1000;
  let empty = 0;
  while (found.size < max && !signal?.aborted) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) break;
    const out = await sqs('ReceiveMessage', {
      QueueUrl: url,
      MaxNumberOfMessages: Math.min(10, max - found.size),
      WaitTimeSeconds: Math.min(left, 5),
      VisibilityTimeout: visibility,
      MessageSystemAttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    });
    if (signal?.aborted) break;
    const msgs = out.Messages || [];
    let fresh = 0;
    for (const m of msgs) {
      if (!found.has(m.MessageId)) fresh++;
      found.set(m.MessageId, m);
    }
    if (msgs.length) onBatch?.([...found.values()]);
    // With visibility 0 the same messages come back: stop once nothing new arrives a few times.
    empty = fresh ? 0 : empty + 1;
    if (empty >= (visibility === 0 ? 2 : 1000)) break;
  }
  return [...found.values()];
}

export async function deleteMessages(url, messages) {
  const failed = [];
  for (let i = 0; i < messages.length; i += 10) {
    const chunk = messages.slice(i, i + 10);
    const out = await sqs('DeleteMessageBatch', { QueueUrl: url, Entries: chunk.map((m, j) => ({ Id: String(j), ReceiptHandle: m.ReceiptHandle })) });
    for (const f of out.Failed || []) failed.push({ ...f, MessageId: chunk[Number(f.Id)]?.MessageId });
  }
  return failed;
}

/** Makes messages visible again right away (visibility timeout 0). */
export async function releaseMessages(url, messages) {
  const failed = [];
  for (let i = 0; i < messages.length; i += 10) {
    const chunk = messages.slice(i, i + 10);
    const out = await sqs('ChangeMessageVisibilityBatch', {
      QueueUrl: url,
      Entries: chunk.map((m, j) => ({ Id: String(j), ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 })),
    });
    for (const f of out.Failed || []) failed.push({ ...f, MessageId: chunk[Number(f.Id)]?.MessageId });
  }
  return failed;
}

/** Plain objects for export (without receipt handles). */
export const messagesForExport = (messages) =>
  messages.map((m) => ({
    MessageId: m.MessageId,
    Body: m.Body,
    Attributes: m.Attributes,
    MessageAttributes: m.MessageAttributes,
    MD5OfBody: m.MD5OfBody,
  }));
