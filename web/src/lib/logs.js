import { api } from '../api.js';

export const logs = (op, input = {}) => api(`/api/logs/op/${op}`, { method: 'POST', body: input });

// --- Time ranges -------------------------------------------------------------------------
// A range is { rel: '15m' } (relative to now) or { start, end } (epoch ms).
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const UNIT_NAME = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week' };

export const QUICK_RANGES = ['5m', '15m', '30m', '1h', '3h', '6h', '12h', '1d', '3d', '1w'];

export function parseDuration(text) {
  const m = /^\s*(\d+)\s*([smhdw])\s*$/i.exec(String(text || ''));
  return m && Number(m[1]) > 0 ? Number(m[1]) * UNIT_MS[m[2].toLowerCase()] : null;
}

export function durationLabel(rel) {
  const m = /^(\d+)([smhdw])$/.exec(rel || '');
  if (!m) return rel;
  const n = Number(m[1]);
  return `Last ${n === 1 ? '' : `${n} `}${UNIT_NAME[m[2]]}${n === 1 ? '' : 's'}`;
}

export function resolveRange(range, now = Date.now()) {
  if (range?.rel) return { startTime: now - (parseDuration(range.rel) || UNIT_MS.m * 15), endTime: now };
  return { startTime: Number(range?.start) || now - UNIT_MS.m * 15, endTime: Number(range?.end) || now };
}

export const fmtDuration = (ms) => {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h`;
  return `${(s / 86400).toFixed(1)}d`;
};

export function rangeLabel(range, utc) {
  if (range?.rel) return durationLabel(range.rel);
  return `${fmtTime(range.start, utc, true)} → ${fmtTime(range.end, utc, true)}`;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** "2024-05-01 13:04:05.123" in local time or UTC. `short` drops the milliseconds. */
export function fmtTime(ms, utc = false, short = false) {
  if (ms === undefined || ms === null || Number.isNaN(Number(ms))) return '—';
  const d = new Date(Number(ms));
  const g = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
  const s = `${g[0]}-${pad(g[1])}-${pad(g[2])} ${pad(g[3])}:${pad(g[4])}:${pad(g[5])}`;
  return short ? s : `${s}.${pad(g[6], 3)}`;
}

// <input type="datetime-local"> value <-> epoch ms, honouring the UTC toggle.
export function toInputValue(ms, utc) {
  return fmtTime(ms, utc, true).replace(' ', 'T');
}
export function fromInputValue(text, utc) {
  if (!text) return null;
  const v = text.length === 16 ? `${text}:00` : text;
  const ms = utc ? Date.parse(`${v}Z`) : new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function timeAgo(ms, now = Date.now()) {
  if (!ms) return '—';
  const d = Math.max(0, now - ms);
  if (d < 60000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
  return `${Math.round(d / 86400000)}d ago`;
}

// --- Messages ------------------------------------------------------------------------------
export const LEVELS = ['error', 'warn', 'info', 'debug'];
const LEVEL_WORDS = { fatal: 'error', critical: 'error', crit: 'error', error: 'error', err: 'error', severe: 'error', panic: 'error', warn: 'warn', warning: 'warn', info: 'info', notice: 'info', debug: 'debug', trace: 'debug' };
const PINO = { 10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error' };
const LEVEL_RE = /\b(FATAL|CRITICAL|CRIT|ERROR|ERR|SEVERE|PANIC|WARN|WARNING|INFO|NOTICE|DEBUG|TRACE)\b/i;

/** Split "prefix {json}" (Lambda / framework prefixes) into the prefix and the parsed JSON object. */
export function parseJsonMessage(message) {
  const text = String(message ?? '').trim();
  const i = text.search(/[{[]/);
  if (i < 0) return null;
  const body = text.slice(i);
  if (!/[}\]]$/.test(body)) return null;
  try {
    const json = JSON.parse(body);
    if (json === null || typeof json !== 'object') return null;
    return { prefix: text.slice(0, i).trim(), json };
  } catch {
    return null;
  }
}

export function detectLevel(message, json) {
  const j = json === undefined ? parseJsonMessage(message)?.json : json;
  if (j && !Array.isArray(j)) {
    const v = j.level ?? j.severity ?? j.levelname ?? j.lvl ?? j.log_level ?? j.logLevel ?? j['log.level'];
    if (typeof v === 'number' && PINO[v]) return PINO[v];
    if (typeof v === 'string' && LEVEL_WORDS[v.toLowerCase()]) return LEVEL_WORDS[v.toLowerCase()];
  }
  const text = String(message ?? '');
  if (/^(START|END|REPORT|INIT_START) RequestId:|^(START|END|REPORT|INIT_START) /.test(text)) return 'system';
  const m = LEVEL_RE.exec(text.slice(0, 300));
  if (m) return LEVEL_WORDS[m[1].toLowerCase()];
  if (/\b(Exception|Traceback|Unhandled|Task timed out)\b/.test(text.slice(0, 300))) return 'error';
  return '';
}

const MSG_KEYS = ['message', 'msg', 'Message', 'event', 'error_message', 'errorMessage'];
const LEVEL_KEYS = ['level', 'severity', 'levelname', 'lvl', 'log_level', 'logLevel', 'log.level'];

/** One-line summary of a JSON log: the message field first, then key=value pairs (level is shown as a tag). */
export function jsonSummary(json) {
  if (!json || Array.isArray(json)) return JSON.stringify(json);
  const mk = MSG_KEYS.find((k) => typeof json[k] === 'string');
  const parts = mk ? [json[mk]] : [];
  for (const [k, v] of Object.entries(json)) {
    if (k === mk || LEVEL_KEYS.includes(k)) continue;
    let t = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (t.length > 160) t = `${t.slice(0, 160)}…`;
    parts.push(`${k}=${t}`);
  }
  return parts.join('  ');
}

/** Enrich raw FilterLogEvents / GetLogEvents events once, so rendering stays cheap. */
export function enrichEvent(e) {
  const message = String(e.message ?? '').replace(/\n$/, '');
  const parsed = parseJsonMessage(message);
  return {
    ...e,
    message,
    id: e.eventId || `${e.logStreamName || ''}:${e.timestamp}:${e.ingestionTime}:${message.slice(0, 64)}`,
    json: parsed?.json,
    prefix: parsed?.prefix,
    summary: parsed ? jsonSummary(parsed.json) : null,
    level: detectLevel(message, parsed?.json ?? null),
  };
}

/** Plain words / phrases from a filter pattern, used to highlight matches. JSON / space-delimited patterns give none. */
export function patternTerms(pattern) {
  const p = String(pattern || '').trim();
  if (!p || p.startsWith('{') || p.startsWith('[') || p.startsWith('%')) return [];
  const out = [];
  const re = /([?-]?)"([^"]+)"|([?-]?)(\S+)/g;
  let m;
  while ((m = re.exec(p))) {
    const neg = (m[1] || m[3]) === '-';
    const t = m[2] ?? m[4];
    if (!neg && t) out.push(t);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split text into [{ text, hit }] for highlighting the given terms (case-insensitive). */
export function splitHighlights(text, terms) {
  const list = (terms || []).filter(Boolean);
  if (!list.length || !text) return [{ text, hit: false }];
  const re = new RegExp(`(${list.map(escapeRe).join('|')})`, 'gi');
  return String(text)
    .split(re)
    .filter((s) => s !== '')
    .map((s, i, all) => ({ text: s, hit: list.some((t) => t.toLowerCase() === s.toLowerCase()) && all.length > 1 }));
}

export const FILTER_EXAMPLES = [
  ['ERROR', 'Contains ERROR (case-sensitive)'],
  ['?ERROR ?Error ?error', 'Any of the terms'],
  ['"Request failed"', 'Exact phrase'],
  ['ERROR -Timeout', 'ERROR but not Timeout'],
  ['%[Ee]rror|[Ee]xception%', 'Regular expression'],
  ['{ $.level = "error" }', 'JSON field equals'],
  ['{ $.statusCode >= 500 }', 'JSON numeric compare'],
  ['{ $.userId = "42" && $.action = "login" }', 'JSON AND'],
  ['{ $.message = "*timeout*" }', 'JSON wildcard'],
  ['[ip, id, user, ts, request, status = 5*, size]', 'Space-delimited fields'],
];

// --- Export ---------------------------------------------------------------------------------
const csvCell = (v) => {
  const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (columns, rows) => [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n');

export function eventsToCsv(events, utc) {
  return toCsv(['timestamp', 'logStreamName', 'message'], events.map((e) => ({ ...e, timestamp: fmtTime(e.timestamp, utc) })));
}
export const eventsToText = (events, utc) => events.map((e) => `${fmtTime(e.timestamp, utc)}\t${e.logStreamName || ''}\t${e.message}`).join('\n');
export const eventsToJson = (events) =>
  JSON.stringify(events.map(({ timestamp, ingestionTime, logStreamName, eventId, message, json }) => ({ timestamp, ingestionTime, logStreamName, eventId, message: json ?? message })), null, 2);

// --- Histogram ------------------------------------------------------------------------------
export function histogram(events, startTime, endTime, bins = 60) {
  const span = Math.max(1, endTime - startTime);
  const size = span / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ start: startTime + i * size, end: startTime + (i + 1) * size, total: 0, error: 0, warn: 0 }));
  for (const e of events) {
    if (e.timestamp < startTime || e.timestamp > endTime) continue;
    const b = out[Math.min(bins - 1, Math.floor((e.timestamp - startTime) / size))];
    b.total++;
    if (e.level === 'error') b.error++;
    else if (e.level === 'warn') b.warn++;
  }
  return out;
}

// --- Insights -------------------------------------------------------------------------------
export const QUERY_TEMPLATES = [
  ['Latest 100 messages', 'fields @timestamp, @message, @logStream\n| sort @timestamp desc\n| limit 100'],
  ['Search text', 'fields @timestamp, @message, @logStream\n| filter @message like /(?i)error/\n| sort @timestamp desc\n| limit 200'],
  ['Error count over time', 'filter @message like /(?i)(error|exception)/\n| stats count(*) as errors by bin(5m)'],
  ['Top error messages', 'filter @message like /(?i)(error|exception)/\n| stats count(*) as n by @message\n| sort n desc\n| limit 25'],
  ['Events per log stream', 'stats count(*) as events by @logStream\n| sort events desc\n| limit 50'],
  ['JSON field filter', 'fields @timestamp, level, message\n| filter level = "error"\n| sort @timestamp desc\n| limit 100'],
  ['Parse a value', 'parse @message "duration=* ms" as duration\n| filter ispresent(duration)\n| stats avg(duration), max(duration), pct(duration, 95) by bin(5m)'],
  ['Lambda: duration & memory', 'filter @type = "REPORT"\n| stats avg(@duration), max(@duration), pct(@duration, 95), max(@maxMemoryUsed / 1000 / 1000) as maxMemMB by bin(5m)'],
  ['Lambda: cold starts', 'filter @type = "REPORT" and ispresent(@initDuration)\n| stats count(*) as coldStarts, avg(@initDuration) as avgInit by bin(1h)'],
  ['Lambda: slowest invocations', 'filter @type = "REPORT"\n| fields @requestId, @duration, @billedDuration, @maxMemoryUsed / 1000 / 1000 as memMB\n| sort @duration desc\n| limit 25'],
  ['Lambda: logs of one request', 'fields @timestamp, @message\n| filter @requestId = "REQUEST_ID"\n| sort @timestamp asc'],
  ['API Gateway: 5xx', 'fields @timestamp, status, path, @message\n| filter status >= 500\n| sort @timestamp desc\n| limit 100'],
];

/** GetQueryResults rows ([[{field, value}]]) -> { columns, rows } (rows are plain objects, @ptr kept but not a column). */
export function insightsTable(results = []) {
  const columns = [];
  const rows = results.map((r) => {
    const o = {};
    for (const { field, value } of r) {
      o[field] = value;
      if (field !== '@ptr' && !columns.includes(field)) columns.push(field);
    }
    return o;
  });
  return { columns, rows };
}

/** Chartable when one column is a time bin and at least one other is numeric. */
export function chartSpec(columns, rows) {
  if (!rows.length) return null;
  const x = columns.find((c) => /^bin\(/i.test(c)) || columns.find((c) => rows.every((r) => !Number.isNaN(Date.parse(String(r[c]).replace(' ', 'T')))) && /time|bin/i.test(c));
  if (!x) return null;
  const series = columns.filter((c) => c !== x && rows.every((r) => r[c] === undefined || r[c] === '' || !Number.isNaN(Number(r[c]))));
  if (!series.length) return null;
  const points = rows
    .map((r) => ({ t: /^\d{11,}$/.test(String(r[x])) ? Number(r[x]) : Date.parse(`${String(r[x]).replace(' ', 'T')}Z`), v: series.map((s) => Number(r[s]) || 0) }))
    .filter((p) => !Number.isNaN(p.t))
    .sort((a, b) => a.t - b.t);
  return points.length ? { x, series, points } : null;
}

export const queryStatusDone = (s) => ['Complete', 'Failed', 'Cancelled', 'Timeout', 'Unknown'].includes(s);

// --- Routes ---------------------------------------------------------------------------------
// #/logs, #/logs/insights?..., #/logs/group/<encoded name>?...
export const logsGroupPath = (group, params) => `/logs/group/${encodeURIComponent(group)}${params ? `?${new URLSearchParams(params)}` : ''}`;
export const insightsPath = (params) => `/logs/insights${params ? `?${new URLSearchParams(params)}` : ''}`;

export function rangeToParams(range) {
  return range?.rel ? { range: range.rel } : { start: String(range.start), end: String(range.end) };
}
export function rangeFromParams(q, fallback = { rel: '15m' }) {
  if (q.get('range') && parseDuration(q.get('range'))) return { rel: q.get('range') };
  const start = Number(q.get('start'));
  const end = Number(q.get('end'));
  if (start && end && end > start) return { start, end };
  return fallback;
}

/** Replace the hash query without a history entry or a hashchange event. */
export function replaceHashQuery(path, params) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const qs = new URLSearchParams(clean).toString();
  const url = `#${path}${qs ? `?${qs}` : ''}`;
  if (window.location.hash !== url) window.history.replaceState(null, '', url);
}

export const retentionLabel = (days) => (days ? (days % 365 === 0 ? `${days / 365}y` : days % 30 === 0 && days >= 30 ? `${days / 30}mo` : `${days}d`) : 'Never expire');
export const RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

/** Page through DescribeLogGroups. Returns { groups, more } (more = hit `max` before the end). */
export async function listLogGroups({ pattern, max = 500 } = {}) {
  const groups = [];
  let nextToken;
  do {
    const out = await logs('DescribeLogGroups', { limit: 50, nextToken, ...(pattern ? { logGroupNamePattern: pattern } : {}) });
    groups.push(...(out.logGroups || []));
    nextToken = out.nextToken;
  } while (nextToken && groups.length < max);
  return { groups, more: Boolean(nextToken) };
}
