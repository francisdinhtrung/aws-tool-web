import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  queueNameFromUrl, queueNameFromArn, isFifo, sqsPath, queueNameError, fmtSeconds, prettyBody, attrErrors, changedAttrs,
  parseRedrivePolicy, buildRedrivePolicy, parseRedriveAllow, buildRedriveAllow, encryptionLabel, toMessageAttributes, fromMessageAttributes,
  buildSendInput, sendCopies, pollMessages, deleteMessages, listAllQueues,
} from './sqs.js';
import { mockBackend } from '../test/utils.jsx';

const URL = 'http://localhost:4566/000000000000/orders';
const FURL = 'http://localhost:4566/000000000000/pay.fifo';
const op = (name) => `POST /api/sqs/op/${name}`;

afterEach(() => vi.restoreAllMocks());

describe('names', () => {
  it('extracts names from URLs and ARNs', () => {
    expect(queueNameFromUrl(URL)).toBe('orders');
    expect(queueNameFromArn('arn:aws:sqs:us-east-1:000:orders-dlq')).toBe('orders-dlq');
    expect(isFifo('pay.fifo')).toBe(true);
    expect(isFifo('orders')).toBe(false);
    expect(sqsPath('a b')).toBe('/sqs/queue/a%20b');
    expect(sqsPath('')).toBe('/sqs');
  });

  it('validates queue names', () => {
    expect(queueNameError('', false)).toMatch(/required/);
    expect(queueNameError('bad name', false)).toMatch(/letters/);
    expect(queueNameError('a'.repeat(80), false)).toBe('');
    expect(queueNameError('a'.repeat(80), true)).toMatch(/80/);
  });
});

describe('formatting', () => {
  it('formats seconds', () => {
    expect(fmtSeconds(30)).toBe('30 seconds');
    expect(fmtSeconds('345600')).toBe('4 days');
    expect(fmtSeconds(90)).toBe('1 minute 30 seconds');
    expect(fmtSeconds(0)).toBe('0 seconds');
    expect(fmtSeconds(undefined)).toBe('—');
  });

  it('pretty-prints JSON bodies only', () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody('plain {text}')).toBe('plain {text}');
    expect(prettyBody('{broken')).toBe('{broken');
  });

  it('labels encryption', () => {
    expect(encryptionLabel({ SqsManagedSseEnabled: 'true' })).toBe('SSE-SQS');
    expect(encryptionLabel({ KmsMasterKeyId: 'alias/x' })).toBe('SSE-KMS (alias/x)');
    expect(encryptionLabel({})).toBe('None');
  });
});

describe('attributes', () => {
  it('validates numeric ranges and diffs changes', () => {
    expect(attrErrors({ VisibilityTimeout: '30', DelaySeconds: '901', MessageRetentionPeriod: '' })).toEqual({ DelaySeconds: expect.stringMatching(/between 0 and 900/) });
    expect(changedAttrs({ VisibilityTimeout: '60', DelaySeconds: '0', KmsMasterKeyId: '' }, { VisibilityTimeout: '30', DelaySeconds: '0' })).toEqual({ VisibilityTimeout: '60' });
  });

  it('builds and parses redrive policies', () => {
    const p = buildRedrivePolicy('arn:dlq', '3');
    expect(JSON.parse(p)).toEqual({ deadLetterTargetArn: 'arn:dlq', maxReceiveCount: 3 });
    expect(parseRedrivePolicy(p)).toEqual({ deadLetterTargetArn: 'arn:dlq', maxReceiveCount: 3 });
    expect(parseRedrivePolicy('{"deadLetterTargetArn":"arn:x","maxReceiveCount":"5"}').maxReceiveCount).toBe(5);
    expect(parseRedrivePolicy(undefined)).toBeNull();
    expect(buildRedrivePolicy('', 3)).toBe('');
    expect(parseRedriveAllow(undefined)).toEqual({ redrivePermission: 'allowAll', sourceQueueArns: [] });
    expect(JSON.parse(buildRedriveAllow({ redrivePermission: 'byQueue', sourceQueueArns: ['a'] }))).toEqual({ redrivePermission: 'byQueue', sourceQueueArns: ['a'] });
    expect(JSON.parse(buildRedriveAllow({ redrivePermission: 'denyAll', sourceQueueArns: ['a'] }))).toEqual({ redrivePermission: 'denyAll' });
  });
});

describe('messages', () => {
  it('converts message attribute rows and back', () => {
    const rows = [
      { name: 'tenant', type: 'String', value: 'acme' },
      { name: 'n', type: 'Number', value: '4' },
      { name: 'b', type: 'Binary', value: 'aGk=' },
      { name: '', type: 'String', value: '' },
    ];
    const attrs = toMessageAttributes(rows);
    expect(attrs).toEqual({
      tenant: { DataType: 'String', StringValue: 'acme' },
      n: { DataType: 'Number', StringValue: '4' },
      b: { DataType: 'Binary', BinaryValue: 'aGk=' },
    });
    expect(fromMessageAttributes(attrs)).toEqual(rows.slice(0, 3));
    expect(() => toMessageAttributes([{ name: 'n', type: 'Number', value: 'x' }])).toThrow(/number/);
    expect(() => toMessageAttributes([{ name: 'aws.x', type: 'String', value: '1' }])).toThrow(/Invalid/);
    expect(() => toMessageAttributes([{ name: 'a', value: '1' }, { name: 'a', value: '2' }])).toThrow(/Duplicate/);
  });

  it('builds SendMessage input for standard and FIFO queues', () => {
    expect(buildSendInput(URL, { body: 'hi', delay: '5', attrs: [] })).toEqual({ QueueUrl: URL, MessageBody: 'hi', DelaySeconds: 5 });
    expect(buildSendInput(FURL, { body: 'hi', delay: '5', groupId: ' g ', dedupId: 'd' })).toEqual({ QueueUrl: FURL, MessageBody: 'hi', MessageGroupId: 'g', MessageDeduplicationId: 'd' });
    expect(() => buildSendInput(FURL, { body: 'hi' })).toThrow(/group ID/);
    expect(() => buildSendInput(URL, { body: '' })).toThrow(/body/);
    expect(() => buildSendInput(URL, { body: 'x', delay: '901' })).toThrow(/Delay/);
  });

  it('sends copies in batches of 10 with unique FIFO dedup IDs', async () => {
    const api = mockBackend({ [op('SendMessageBatch')]: (b) => ({ Successful: b.Entries.map((e) => ({ Id: e.Id })) }) });
    const progress = vi.fn();
    const out = await sendCopies({ QueueUrl: FURL, MessageBody: 'x', MessageGroupId: 'g', MessageDeduplicationId: 'd' }, 12, progress);
    expect(out).toEqual({ sent: 12, failed: [] });
    const calls = api.calls(op('SendMessageBatch'));
    expect(calls.map((c) => c.Entries.length)).toEqual([10, 2]);
    expect(calls[1].Entries[1]).toEqual({ Id: '11', MessageBody: 'x', MessageGroupId: 'g', MessageDeduplicationId: 'd-11' });
    expect(progress).toHaveBeenLastCalledWith(12, 12);
  });

  it('polls until max messages, deduplicating by MessageId', async () => {
    let n = 0;
    const api = mockBackend({
      [op('ReceiveMessage')]: () => {
        n++;
        return { Messages: n === 1 ? [{ MessageId: 'a', ReceiptHandle: 'r1' }, { MessageId: 'b', ReceiptHandle: 'r2' }] : [{ MessageId: 'a', ReceiptHandle: 'r3' }, { MessageId: 'c', ReceiptHandle: 'r4' }] };
      },
    });
    const out = await pollMessages(URL, { max: 3, seconds: 10, visibility: 15 });
    expect(out.map((m) => m.MessageId)).toEqual(['a', 'b', 'c']);
    expect(out[0].ReceiptHandle).toBe('r3');
    const calls = api.calls(op('ReceiveMessage'));
    expect(calls[0]).toMatchObject({ QueueUrl: URL, MaxNumberOfMessages: 3, VisibilityTimeout: 15, MessageAttributeNames: ['All'] });
    expect(calls[1].MaxNumberOfMessages).toBe(1);
  });

  it('stops peeking (visibility 0) once nothing new arrives', async () => {
    const api = mockBackend({ [op('ReceiveMessage')]: { Messages: [{ MessageId: 'a', ReceiptHandle: 'r' }] } });
    const out = await pollMessages(URL, { max: 10, seconds: 30, visibility: 0 });
    expect(out).toHaveLength(1);
    expect(api.calls(op('ReceiveMessage'))).toHaveLength(3);
  });

  it('deletes in batches and reports failures by message ID', async () => {
    mockBackend({ [op('DeleteMessageBatch')]: (b) => ({ Successful: [], Failed: b.Entries.length === 10 ? [{ Id: '9', Code: 'ReceiptHandleIsInvalid' }] : [] }) });
    const msgs = Array.from({ length: 11 }, (_, i) => ({ MessageId: `m${i}`, ReceiptHandle: `r${i}` }));
    expect(await deleteMessages(URL, msgs)).toEqual([{ Id: '9', Code: 'ReceiptHandleIsInvalid', MessageId: 'm9' }]);
  });

  it('lists all queues across pages, sorted by name', async () => {
    mockBackend({ [op('ListQueues')]: (b) => (b.NextToken ? { QueueUrls: ['http://h/1/b'] } : { QueueUrls: ['http://h/1/c', 'http://h/1/a'], NextToken: 't' }) });
    expect(await listAllQueues()).toEqual({ urls: ['http://h/1/a', 'http://h/1/b', 'http://h/1/c'], more: false });
  });
});
