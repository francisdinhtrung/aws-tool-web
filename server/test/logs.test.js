import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { tempEnv } from './helpers.js';
import { createApp, cleanEndpoint } from '../src/app.js';
import { logsClientConfig, LOGS_COMMANDS } from '../src/logs.js';

const logsMock = mockClient(CloudWatchLogsClient);
const H = { 'x-requested-with': 'dynamodb-studio' };
const conn = (c) => encodeURIComponent(JSON.stringify(c));
const PROFILE = conn({ kind: 'profile', profile: 'default', region: 'eu-west-1' });

let env;
beforeEach(async () => {
  logsMock.reset();
  env = await tempEnv({
    config: '[default]\nregion = eu-west-1\n',
    credentials: '[default]\naws_access_key_id = AKIA\naws_secret_access_key = SECRET\n',
  });
});
afterEach(() => env.cleanup());

const app = () => createApp({ staticDir: env.root, allowedHosts: ['127.0.0.1'] });

describe('logs helpers', () => {
  it('logsClientConfig prefers the logs endpoint for custom endpoints and drops it for AWS', () => {
    const base = { region: 'r', endpoint: 'http://ddb', credentials: { accessKeyId: 'a' } };
    expect(logsClientConfig(base, { kind: 'profile' })).toEqual({ region: 'r', credentials: { accessKeyId: 'a' } });
    expect(logsClientConfig(base, { kind: 'endpoint', endpoint: 'http://x' }).endpoint).toBe('http://x');
    expect(logsClientConfig(base, { kind: 'endpoint', endpoint: 'http://x', logsEndpoint: 'http://logs' }).endpoint).toBe('http://logs');
  });

  it('allows read and query operations only', () => {
    expect(LOGS_COMMANDS.has('FilterLogEvents')).toBe(true);
    expect(LOGS_COMMANDS.has('DeleteLogGroup')).toBe(false);
  });

  it('cleanEndpoint validates the logs endpoint', () => {
    expect(cleanEndpoint({ name: 'ls', endpoint: 'http://a', logsEndpoint: ' http://b ' }).logsEndpoint).toBe('http://b');
    expect(() => cleanEndpoint({ name: 'ls', endpoint: 'http://a', logsEndpoint: 'ftp://b' })).toThrow(/CloudWatch Logs endpoint/);
  });
});

describe('logs routes', () => {
  it('proxies an allowed operation with the input as-is', async () => {
    logsMock.on(FilterLogEventsCommand).resolves({ events: [{ timestamp: 1, message: 'hi' }], nextToken: 't' });
    const r = await request(app()).post('/api/logs/op/FilterLogEvents').set(H).set('x-conn', PROFILE).send({ logGroupName: '/g', filterPattern: 'ERROR' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ events: [{ timestamp: 1, message: 'hi' }], nextToken: 't' });
    expect(r.headers['x-elapsed-ms']).toBeDefined();
    expect(logsMock.commandCalls(FilterLogEventsCommand)[0].args[0].input).toEqual({ logGroupName: '/g', filterPattern: 'ERROR' });
  });

  it('rejects unknown operations and requests without the CSRF header', async () => {
    const a = app();
    expect((await request(a).post('/api/logs/op/DeleteLogGroup').set(H).set('x-conn', PROFILE).send({})).status).toBe(404);
    expect((await request(a).post('/api/logs/op/StartQuery').set('x-conn', PROFILE).send({})).status).toBe(403);
    expect(logsMock.commandCalls(StartQueryCommand)).toHaveLength(0);
  });

  it('maps AWS errors to their HTTP status', async () => {
    logsMock.on(DescribeLogGroupsCommand).rejects(Object.assign(new Error('nope'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }));
    const r = await request(app()).post('/api/logs/op/DescribeLogGroups').set(H).set('x-conn', PROFILE).send({});
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'AccessDeniedException', message: 'nope' });
  });

  it('tests a custom endpoint connection with DescribeLogGroups', async () => {
    logsMock.on(DescribeLogGroupsCommand).resolves({ logGroups: [{ logGroupName: '/a' }, { logGroupName: '/b' }], nextToken: 'n' });
    const a = app();
    const c = await request(a).post('/api/connections').set(H).send({ name: 'ls', endpoint: 'http://localhost:4566' });
    const r = await request(a).post('/api/test').set(H).set('x-conn', conn({ kind: 'endpoint', id: c.body.id })).send({ service: 'logs' });
    expect(r.body).toMatchObject({ logGroupCount: 2, more: true, endpoint: 'http://localhost:4566' });
  });
});
