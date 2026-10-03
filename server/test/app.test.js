import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient, ListTablesCommand, GetItemCommand, PutItemCommand, TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { tempEnv } from './helpers.js';
import {
  createApp, seed, reviveInput, serializeOutput, safeEqual, parseAllowedHosts, resolveConn, clientConfig, cleanEndpoint,
} from '../src/app.js';

const ddbMock = mockClient(DynamoDBClient);
const stsMock = mockClient(STSClient);
const H = { 'x-requested-with': 'aws-tool-web' };
const conn = (c) => encodeURIComponent(JSON.stringify(c));

let env;
let staticDir;
beforeEach(async () => {
  ddbMock.reset();
  stsMock.reset();
  env = await tempEnv({
    config: '[default]\nregion = us-west-2\n\n[profile noregion]\noutput = json\n',
    credentials: '[default]\naws_access_key_id = AKIA\naws_secret_access_key = SECRET\n',
  });
  staticDir = path.join(env.root, 'static');
  await fs.mkdir(staticDir);
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>spa</title>');
});
afterEach(() => env.cleanup());

const app = (opts = {}) => createApp({ staticDir, allowedHosts: ['127.0.0.1', 'localhost'], ...opts });

describe('pure helpers', () => {
  it('reviveInput converts base64 B / BS to Buffers only inside attribute values', () => {
    const out = reviveInput({ Item: { b: { B: 'aGk=' }, bs: { BS: ['YQ==', 'Yg=='] }, B: { S: 'name B' }, l: { L: [{ B: 'eA==' }] } }, Limit: 1 });
    expect(Buffer.isBuffer(out.Item.b.B)).toBe(true);
    expect(out.Item.b.B.toString()).toBe('hi');
    expect(out.Item.bs.BS.map(String)).toEqual(['a', 'b']);
    expect(out.Item.B).toEqual({ S: 'name B' });
    expect(out.Item.l.L[0].B.toString()).toBe('x');
    expect(out.Limit).toBe(1);
    expect(reviveInput(null)).toBe(null);
    expect(reviveInput({ BS: [1] })).toEqual({ BS: [1] });
  });

  it('serializeOutput encodes binary, dates and strips $metadata', () => {
    const out = serializeOutput({
      $metadata: { httpStatusCode: 200 },
      Item: { b: { B: new Uint8Array([104, 105]) }, bs: { BS: [new Uint8Array([97])] } },
      Table: { CreationDateTime: new Date('2026-01-02T03:04:05Z') },
      n: null,
    });
    expect(out).toEqual({ Item: { b: { B: 'aGk=' }, bs: { BS: ['YQ=='] } }, Table: { CreationDateTime: '2026-01-02T03:04:05.000Z' }, n: null });
  });

  it('safeEqual compares strings in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual(undefined, '')).toBe(true);
  });

  it('parseAllowedHosts defaults to loopback names', () => {
    expect(parseAllowedHosts()).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(parseAllowedHosts(' A.com , ,b ')).toEqual(['a.com', 'b']);
  });

  it('clientConfig builds credentials per connection kind', () => {
    expect(clientConfig({ kind: 'default', region: 'r' })).toEqual({ region: 'r', maxAttempts: 3 });
    expect(typeof clientConfig({ kind: 'profile', profile: 'p', region: 'r' }).credentials).toBe('function');
    expect(clientConfig({ kind: 'endpoint', endpoint: 'http://x', region: 'r', authMode: 'local' })).toMatchObject({
      endpoint: 'http://x',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    expect(clientConfig({ kind: 'endpoint', region: 'r', authMode: 'keys', accessKeyId: 'a', secretAccessKey: 'b' }).credentials).toEqual({ accessKeyId: 'a', secretAccessKey: 'b' });
    expect(clientConfig({ kind: 'endpoint', region: 'r', authMode: 'keys' }).credentials).toEqual({ accessKeyId: '', secretAccessKey: '' });
    expect(typeof clientConfig({ kind: 'endpoint', region: 'r', authMode: 'profile', profile: 'p' }).credentials).toBe('function');
  });

  it('cleanEndpoint validates and normalises input', () => {
    expect(() => cleanEndpoint({ name: 'x', endpoint: 'ftp://x' })).toThrow(/http/);
    expect(() => cleanEndpoint({ name: ' ', endpoint: 'http://x' })).toThrow(/Name/);
    expect(cleanEndpoint({ name: ' L ', endpoint: ' http://x ', authMode: 'weird' })).toMatchObject({ name: 'L', endpoint: 'http://x', authMode: 'local', region: 'us-east-1', profile: '', accessKeyId: '' });
    expect(cleanEndpoint({ name: 'k', endpoint: 'http://x', authMode: 'keys', accessKeyId: 'a' }, { secretAccessKey: 'old' }).secretAccessKey).toBe('old');
    expect(cleanEndpoint({ name: 'k', endpoint: 'http://x', authMode: 'keys', secretAccessKey: 'new' }, { secretAccessKey: 'old' }).secretAccessKey).toBe('new');
    expect(cleanEndpoint({ name: 'p', endpoint: 'http://x', authMode: 'profile', profile: 'dev' }).profile).toBe('dev');
  });
});

describe('resolveConn', () => {
  it.each([
    [undefined, 400, 'NoConnection'],
    ['%E0%A4%A', 400, 'BadConnection'],
    [conn({ kind: 'what' }), 400, 'BadConnection'],
    [conn({ kind: 'profile' }), 400, 'BadConnection'],
    [conn({ kind: 'endpoint', id: 'missing' }), 404, 'ConnectionNotFound'],
  ])('rejects %s', async (raw, status, name) => {
    await expect(resolveConn(raw)).rejects.toMatchObject({ status, name });
  });

  it('resolves profile region from request, config, env, then default', async () => {
    expect((await resolveConn(conn({ kind: 'profile', profile: 'default', region: 'eu-north-1' }))).region).toBe('eu-north-1');
    expect((await resolveConn(conn({ kind: 'profile', profile: 'default' }))).region).toBe('us-west-2');
    process.env.AWS_REGION = 'ca-central-1';
    expect((await resolveConn(conn({ kind: 'profile', profile: 'noregion' }))).region).toBe('ca-central-1');
    expect((await resolveConn(conn({ kind: 'default' }))).region).toBe('ca-central-1');
    delete process.env.AWS_REGION;
    expect((await resolveConn(conn({ kind: 'profile', profile: 'noregion' }))).region).toBe('us-east-1');
    process.env.AWS_DEFAULT_REGION = 'sa-east-1';
    expect((await resolveConn(conn({ kind: 'default' }))).region).toBe('sa-east-1');
    delete process.env.AWS_DEFAULT_REGION;
    expect(await resolveConn(conn({ kind: 'default' }))).toEqual({ kind: 'default', key: 'd:us-east-1', region: 'us-east-1' });
  });
});

describe('seed', () => {
  it('creates endpoint connections once', async () => {
    expect(await seed('')).toBe(false);
    expect(await seed('Local=http://dynamodb-local:8000, Other = http://o:1,garbage')).toBe(true);
    const list = JSON.parse(await fs.readFile(path.join(env.data, 'connections.json'), 'utf8'));
    expect(list.map((c) => [c.name, c.endpoint, c.authMode])).toEqual([
      ['Local', 'http://dynamodb-local:8000', 'local'],
      ['Other', 'http://o:1', 'local'],
    ]);
    expect(await seed('X=http://x')).toBe(false);
  });

  it('reads DEFAULT_ENDPOINTS by default', async () => {
    process.env.DEFAULT_ENDPOINTS = 'E=http://e';
    expect(await seed()).toBe(true);
    delete process.env.DEFAULT_ENDPOINTS;
  });
});

describe('security middleware', () => {
  it('blocks unknown Host headers but allows health checks', async () => {
    const a = app();
    await request(a).get('/api/profiles').set('Host', 'evil.com').expect(403, /not allowed/);
    await request(a).get('/api/health').set('Host', 'evil.com').expect(200, { ok: true });
    await request(a).get('/api/profiles').set('Host', 'localhost:8080').expect(200);
    await request(app({ allowedHosts: ['*'] })).get('/api/profiles').set('Host', 'evil.com').expect(200);
  });

  it('requires basic auth when a password is set', async () => {
    const a = app({ password: 'pw', username: 'me' });
    await request(a).get('/api/profiles').set('Host', 'localhost').expect(401).expect('WWW-Authenticate', /Basic/);
    await request(a).get('/api/profiles').set('Host', 'localhost').auth('me', 'wrong').expect(401);
    await request(a).get('/api/profiles').set('Host', 'localhost').auth('other', 'pw').expect(401);
    await request(a).get('/api/profiles').set('Host', 'localhost').auth('me', 'pw').expect(200);
    await request(a).get('/api/health').set('Host', 'localhost').expect(200);
  });

  it('reads auth and hosts from the environment by default', async () => {
    process.env.APP_PASSWORD = 'envpw';
    process.env.ALLOWED_HOSTS = 'studio.local';
    const a = createApp({ staticDir });
    await request(a).get('/api/profiles').set('Host', 'studio.local').expect(401);
    await request(a).get('/api/profiles').set('Host', 'studio.local').auth('admin', 'envpw').expect(200);
    await request(a).get('/api/profiles').set('Host', 'localhost').auth('admin', 'envpw').expect(403);
    delete process.env.APP_PASSWORD;
    delete process.env.ALLOWED_HOSTS;
  });

  it('rejects state-changing requests without X-Requested-With (CSRF)', async () => {
    const res = await request(app()).post('/api/profiles').set('Host', 'localhost').send({ name: 'x' }).expect(403);
    expect(res.body.message).toMatch(/X-Requested-With/);
  });
});

describe('info, profiles and static routes', () => {
  it('GET /api/info reports paths and writability', async () => {
    const res = await request(app()).get('/api/info').set('Host', 'localhost').expect(200);
    expect(res.body).toMatchObject({ awsDir: env.aws, configFile: path.join(env.aws, 'config'), awsDirWritable: true, dataDir: env.data });
    await fs.rm(env.aws, { recursive: true });
    expect((await request(app()).get('/api/info').set('Host', 'localhost')).body.awsDirWritable).toBe(false);
  });

  it('profile CRUD round-trip, never leaking secrets', async () => {
    const a = app();
    const list = await request(a).get('/api/profiles').set('Host', 'localhost').expect(200);
    expect(JSON.stringify(list.body)).not.toContain('SECRET');

    await request(a).post('/api/profiles').set('Host', 'localhost').set(H).send({ name: 'new', settings: { region: 'eu-west-1' } }).expect(200, { ok: true });
    await request(a).post('/api/profiles').set('Host', 'localhost').set(H).send({ name: 'new', settings: {} }).expect(409);
    await request(a).put('/api/profiles/new').set('Host', 'localhost').set(H).send({ name: 'renamed', settings: { region: 'eu-west-2' } }).expect(200);
    await request(a).put('/api/profiles/renamed').set('Host', 'localhost').set(H).send({ settings: { region: 'eu-west-3' } }).expect(200);
    expect(await env.read('config')).toContain('[profile renamed]\nregion = eu-west-3');
    await request(a).delete('/api/profiles/renamed').set('Host', 'localhost').set(H).expect(200);
    await request(a).delete('/api/profiles/renamed').set('Host', 'localhost').set(H).expect(404);
  });

  it('serves the SPA and falls back to index.html; unknown API routes are JSON 404', async () => {
    const a = app();
    await request(a).get('/').set('Host', 'localhost').expect(200, /spa/);
    await request(a).get('/deep/link').set('Host', 'localhost').expect(200, /spa/);
    await request(a).post('/deep/link').set('Host', 'localhost').expect(404);
    await request(a).get('/api/nope').set('Host', 'localhost').expect(404, { error: 'NotFound', message: 'Unknown API route' });
  });

  it('returns 404 when the static build is missing', async () => {
    await request(app({ staticDir: path.join(env.root, 'none') })).get('/x').set('Host', 'localhost').expect(404);
  });
});

describe('endpoint connections', () => {
  it('CRUD with secret masking and secret retention', async () => {
    const a = app();
    const created = await request(a)
      .post('/api/connections').set('Host', 'localhost').set(H)
      .send({ name: 'LS', endpoint: 'http://ls:4566', authMode: 'keys', accessKeyId: 'AK', secretAccessKey: 'SK' })
      .expect(200);
    expect(created.body).toMatchObject({ name: 'LS', hasSecret: true });
    expect(created.body.secretAccessKey).toBeUndefined();

    const id = created.body.id;
    await request(a).put(`/api/connections/${id}`).set('Host', 'localhost').set(H).send({ name: 'LS2', endpoint: 'http://ls:4566', authMode: 'keys', accessKeyId: 'AK' }).expect(200);
    const stored = JSON.parse(await fs.readFile(path.join(env.data, 'connections.json'), 'utf8'));
    expect(stored[0]).toMatchObject({ name: 'LS2', secretAccessKey: 'SK' });

    const list = await request(a).get('/api/connections').set('Host', 'localhost').expect(200);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('SK"');

    await request(a).put('/api/connections/missing').set('Host', 'localhost').set(H).send({ name: 'x', endpoint: 'http://x' }).expect(404);
    await request(a).post('/api/connections').set('Host', 'localhost').set(H).send({ name: 'x', endpoint: 'nope' }).expect(400);
    await request(a).delete(`/api/connections/${id}`).set('Host', 'localhost').set(H).expect(200);
    expect((await request(a).get('/api/connections').set('Host', 'localhost')).body).toEqual([]);
  });
});

describe('DynamoDB proxy', () => {
  async function endpointConn(a) {
    const res = await request(a).post('/api/connections').set('Host', 'localhost').set(H).send({ name: 'L', endpoint: 'http://localhost:8000' });
    return conn({ kind: 'endpoint', id: res.body.id });
  }

  it('forwards allowed commands with binary conversion and timing header', async () => {
    ddbMock.on(GetItemCommand).resolves({ $metadata: {}, Item: { pk: { S: 'a' }, bin: { B: new Uint8Array([1, 2]) } } });
    const a = app();
    const c = await endpointConn(a);
    const res = await request(a).post('/api/ddb/GetItem').set('Host', 'localhost').set(H).set('x-conn', c).send({ TableName: 'T', Key: { pk: { S: 'a' } } }).expect(200);
    expect(res.body).toEqual({ Item: { pk: { S: 'a' }, bin: { B: 'AQI=' } } });
    expect(res.headers['x-elapsed-ms']).toMatch(/^\d+$/);
    expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input).toEqual({ TableName: 'T', Key: { pk: { S: 'a' } } });
  });

  it('revives base64 binary on the way in', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    const a = app();
    const c = await endpointConn(a);
    await request(a).post('/api/ddb/PutItem').set('Host', 'localhost').set(H).set('x-conn', c).send({ TableName: 'T', Item: { b: { B: 'aGk=' } } }).expect(200, {});
    const input = ddbMock.commandCalls(PutItemCommand)[0].args[0].input;
    expect(Buffer.from(input.Item.b.B).toString()).toBe('hi');
  });

  it('sends an empty input when there is no body', async () => {
    ddbMock.on(ListTablesCommand).resolves({ TableNames: [] });
    const a = app();
    const c = await endpointConn(a);
    await request(a).post('/api/ddb/ListTables').set('Host', 'localhost').set(H).set('x-conn', c).expect(200, { TableNames: [] });
    expect(ddbMock.commandCalls(ListTablesCommand)[0].args[0].input).toEqual({});
  });

  it('rejects unknown operations and missing connections', async () => {
    const a = app();
    await request(a).post('/api/ddb/DeleteEverything').set('Host', 'localhost').set(H).expect(404, /not supported/);
    await request(a).post('/api/ddb/ListTables').set('Host', 'localhost').set(H).expect(400, /Select a connection/);
  });

  it('maps AWS errors to their HTTP status and includes cancellation reasons', async () => {
    const err = Object.assign(new Error('Transaction cancelled'), {
      name: 'TransactionCanceledException',
      $metadata: { httpStatusCode: 400 },
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    ddbMock.on(TransactWriteItemsCommand).rejects(err);
    const a = app();
    const c = await endpointConn(a);
    const res = await request(a).post('/api/ddb/TransactWriteItems').set('Host', 'localhost').set(H).set('x-conn', c).send({ TransactItems: [] }).expect(400);
    expect(res.body).toEqual({ error: 'TransactionCanceledException', message: 'Transaction cancelled', cancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
  });

  it('turns unexpected errors into 500 and odd statuses into 500', async () => {
    ddbMock.on(ListTablesCommand).rejectsOnce(new Error('boom')).rejectsOnce(Object.assign(new Error('weird'), { status: 302 }));
    const a = app();
    const c = await endpointConn(a);
    await request(a).post('/api/ddb/ListTables').set('Host', 'localhost').set(H).set('x-conn', c).expect(500, /boom/);
    await request(a).post('/api/ddb/ListTables').set('Host', 'localhost').set(H).set('x-conn', c).expect(500, /weird/);
  });

  it('reuses clients per connection and drops them when profiles change', async () => {
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['a'] });
    const a = app();
    const c = conn({ kind: 'profile', profile: 'default' });
    await request(a).post('/api/ddb/ListTables').set('Host', 'localhost').set(H).set('x-conn', c).expect(200);
    await request(a).post('/api/ddb/ListTables').set('Host', 'localhost').set(H).set('x-conn', c).expect(200);
    await request(a).post('/api/profiles').set('Host', 'localhost').set(H).send({ name: 'z', settings: { region: 'x' } });
    await request(a).post('/api/ddb/ListTables').set('Host', 'localhost').set(H).set('x-conn', c).expect(200);
    expect(ddbMock.commandCalls(ListTablesCommand)).toHaveLength(3);
  });
});

describe('POST /api/test', () => {
  it('checks identity via STS for profile connections', async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123', Arn: 'arn:aws:iam::123:user/me', UserId: 'U' });
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['a', 'b'], LastEvaluatedTableName: 'b' });
    const res = await request(app()).post('/api/test').set('Host', 'localhost').set(H).set('x-conn', conn({ kind: 'profile', profile: 'default' })).expect(200);
    expect(res.body).toEqual({ region: 'us-west-2', endpoint: null, identity: { account: '123', arn: 'arn:aws:iam::123:user/me', userId: 'U' }, tableCount: 2, more: true });
  });

  it('skips STS for endpoint connections', async () => {
    ddbMock.on(ListTablesCommand).resolves({ TableNames: [] });
    const a = app();
    const created = await request(a).post('/api/connections').set('Host', 'localhost').set(H).send({ name: 'L', endpoint: 'http://l:8000', region: 'eu-west-1' });
    const res = await request(a).post('/api/test').set('Host', 'localhost').set(H).set('x-conn', conn({ kind: 'endpoint', id: created.body.id })).expect(200);
    expect(res.body).toEqual({ region: 'eu-west-1', endpoint: 'http://l:8000', tableCount: 0, more: false });
    expect(stsMock.calls()).toHaveLength(0);
  });

  it('surfaces credential errors', async () => {
    stsMock.on(GetCallerIdentityCommand).rejects(Object.assign(new Error('The security token is invalid'), { name: 'InvalidClientTokenId', $metadata: { httpStatusCode: 403 } }));
    const res = await request(app()).post('/api/test').set('Host', 'localhost').set(H).set('x-conn', conn({ kind: 'default' })).expect(403);
    expect(res.body.error).toBe('InvalidClientTokenId');
  });
});

describe('models API', () => {
  it('create, list, get, update, delete', async () => {
    const a = app();
    const { body } = await request(a).post('/api/models').set('Host', 'localhost').set(H).send({ ModelName: 'Shop', DataModel: [] }).expect(200);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    await request(a).put(`/api/models/${body.id}`).set('Host', 'localhost').set(H).send({ ModelName: 'Shop2', DataModel: [{}] }).expect(200);
    expect((await request(a).get(`/api/models/${body.id}`).set('Host', 'localhost')).body.ModelName).toBe('Shop2');
    expect((await request(a).get('/api/models').set('Host', 'localhost')).body).toEqual([{ id: body.id, name: 'Shop2', description: '', tables: 1, updated: '' }]);
    await request(a).delete(`/api/models/${body.id}`).set('Host', 'localhost').set(H).expect(200);
    await request(a).get(`/api/models/${body.id}`).set('Host', 'localhost').expect(404);
    await request(a).get('/api/models/..%2Fx').set('Host', 'localhost').expect(400);
  });
});
