import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, ListQueuesCommand, SendMessageCommand, ReceiveMessageCommand, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { tempEnv } from './helpers.js';
import { createApp, cleanEndpoint } from '../src/app.js';
import { sqsClientConfig, reviveSqsInput, SQS_COMMANDS } from '../src/sqs.js';

const sqsMock = mockClient(SQSClient);
const H = { 'x-requested-with': 'aws-tool-web' };
const conn = (c) => encodeURIComponent(JSON.stringify(c));
const PROFILE = conn({ kind: 'profile', profile: 'default', region: 'eu-west-1' });
const Q = 'https://sqs.eu-west-1.amazonaws.com/123/orders';

let env;
beforeEach(async () => {
  sqsMock.reset();
  env = await tempEnv({
    config: '[default]\nregion = eu-west-1\n',
    credentials: '[default]\naws_access_key_id = AKIA\naws_secret_access_key = SECRET\n',
  });
});
afterEach(() => env.cleanup());

const app = () => createApp({ staticDir: env.root, allowedHosts: ['127.0.0.1'] });

describe('sqs helpers', () => {
  it('sqsClientConfig prefers the SQS endpoint for custom endpoints and drops it for AWS', () => {
    const base = { region: 'r', endpoint: 'http://ddb', credentials: { accessKeyId: 'a' } };
    expect(sqsClientConfig(base, { kind: 'profile' })).toEqual({ region: 'r', credentials: { accessKeyId: 'a' } });
    expect(sqsClientConfig(base, { kind: 'endpoint', endpoint: 'http://x' })).toMatchObject({ endpoint: 'http://x', useQueueUrlAsEndpoint: false });
    expect(sqsClientConfig(base, { kind: 'endpoint', endpoint: 'http://x', sqsEndpoint: 'http://q:9324' }).endpoint).toBe('http://q:9324');
  });

  it('revives base64 binary message attributes', () => {
    const out = reviveSqsInput({ MessageAttributes: { b: { DataType: 'Binary', BinaryValue: 'aGk=' }, s: { DataType: 'String', StringValue: 'aGk=' } } });
    expect(Buffer.from(out.MessageAttributes.b.BinaryValue).toString()).toBe('hi');
    expect(out.MessageAttributes.s.StringValue).toBe('aGk=');
  });

  it('allows queue and message operations only', () => {
    expect(SQS_COMMANDS.has('ReceiveMessage')).toBe(true);
    expect(SQS_COMMANDS.has('AddPermission')).toBe(false);
  });

  it('cleanEndpoint validates the SQS endpoint', () => {
    expect(cleanEndpoint({ name: 'mq', endpoint: 'http://a', sqsEndpoint: ' http://b ' }).sqsEndpoint).toBe('http://b');
    expect(() => cleanEndpoint({ name: 'mq', endpoint: 'http://a', sqsEndpoint: 'ftp://b' })).toThrow(/SQS endpoint/);
  });
});

describe('sqs routes', () => {
  it('proxies an allowed operation', async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1', MD5OfMessageBody: 'x' });
    const r = await request(app()).post('/api/sqs/op/SendMessage').set(H).set('x-conn', PROFILE).send({ QueueUrl: Q, MessageBody: 'hi' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ MessageId: 'm1', MD5OfMessageBody: 'x' });
    expect(r.headers['x-elapsed-ms']).toBeDefined();
    expect(sqsMock.commandCalls(SendMessageCommand)[0].args[0].input).toEqual({ QueueUrl: Q, MessageBody: 'hi' });
  });

  it('serializes binary attributes in received messages as base64', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [{ MessageId: 'm', Body: 'b', MessageAttributes: { a: { DataType: 'Binary', BinaryValue: new Uint8Array([104, 105]) } } }] });
    const r = await request(app()).post('/api/sqs/op/ReceiveMessage').set(H).set('x-conn', PROFILE).send({ QueueUrl: Q });
    expect(r.body.Messages[0].MessageAttributes.a.BinaryValue).toBe('aGk=');
  });

  it('rejects unknown operations and requests without the CSRF header', async () => {
    const a = app();
    expect((await request(a).post('/api/sqs/op/AddPermission').set(H).set('x-conn', PROFILE).send({})).status).toBe(404);
    expect((await request(a).post('/api/sqs/op/PurgeQueue').set('x-conn', PROFILE).send({ QueueUrl: Q })).status).toBe(403);
    expect(sqsMock.commandCalls(PurgeQueueCommand)).toHaveLength(0);
  });

  it('maps AWS errors to their HTTP status', async () => {
    sqsMock.on(PurgeQueueCommand).rejects(Object.assign(new Error('wait 60s'), { name: 'PurgeQueueInProgress', $metadata: { httpStatusCode: 403 } }));
    const r = await request(app()).post('/api/sqs/op/PurgeQueue').set(H).set('x-conn', PROFILE).send({ QueueUrl: Q });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'PurgeQueueInProgress', message: 'wait 60s' });
  });

  it('reports operations an emulator does not implement', async () => {
    sqsMock.on(ListQueuesCommand).rejects(Object.assign(new SyntaxError('Unexpected token \'<\'\n  Deserialization error: to see the raw response...'), { $metadata: { httpStatusCode: 404 } }));
    const r = await request(app()).post('/api/sqs/op/ListQueues').set(H).set('x-conn', PROFILE).send({});
    expect(r.status).toBe(501);
    expect(r.body).toMatchObject({ error: 'NotSupported', message: expect.stringMatching(/ListQueues is not supported/) });
  });

  it('tests a custom endpoint connection with ListQueues', async () => {
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [Q, `${Q}-dlq`], NextToken: 'n' });
    const a = app();
    const c = await request(a).post('/api/connections').set(H).send({ name: 'mq', endpoint: 'http://localhost:9324' });
    const r = await request(a).post('/api/test').set(H).set('x-conn', conn({ kind: 'endpoint', id: c.body.id })).send({ service: 'sqs' });
    expect(r.body).toMatchObject({ queueCount: 2, more: true, endpoint: 'http://localhost:9324' });
  });
});
