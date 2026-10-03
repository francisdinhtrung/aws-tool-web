import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  LambdaClient, ListFunctionsCommand, InvokeCommand, GetFunctionCommand, UpdateFunctionCodeCommand, CreateFunctionCommand,
} from '@aws-sdk/client-lambda';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { IAMClient, ListRolesCommand } from '@aws-sdk/client-iam';
import { tempEnv } from './helpers.js';
import { createApp, cleanEndpoint } from '../src/app.js';
import { codeUrls, lambdaClientConfig, iamClientConfig, reviveLambdaInput, readZip, writeZip, applyChanges, crc32, isText, LAMBDA_COMMANDS } from '../src/lambda.js';

const lambdaMock = mockClient(LambdaClient);
const cwMock = mockClient(CloudWatchClient);
const iamMock = mockClient(IAMClient);
const H = { 'x-requested-with': 'dynamodb-studio' };
const conn = (c) => encodeURIComponent(JSON.stringify(c));
const PROFILE = conn({ kind: 'profile', profile: 'default', region: 'eu-west-1' });

let env;
let fetchImpl;
beforeEach(async () => {
  lambdaMock.reset();
  cwMock.reset();
  iamMock.reset();
  fetchImpl = vi.fn();
  env = await tempEnv({
    config: '[default]\nregion = eu-west-1\n',
    credentials: '[default]\naws_access_key_id = AKIA\naws_secret_access_key = SECRET\n',
  });
});
afterEach(() => env.cleanup());

const app = () => createApp({ staticDir: env.root, allowedHosts: ['127.0.0.1'], fetchImpl });
const pkg = () =>
  writeZip([
    { name: 'index.mjs', data: Buffer.from('export const handler = async () => 1;\n') },
    { name: 'lib/', data: Buffer.alloc(0) },
    { name: 'lib/util.js', data: Buffer.from('module.exports = 2;\n') },
    { name: 'bootstrap', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]), mode: 0o100755 },
  ]);
const zipResponse = (buf) => ({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });

describe('lambda helpers', () => {
  it('uses the Lambda endpoint for custom endpoints and drops it for AWS', () => {
    const base = { region: 'r', endpoint: 'http://ddb' };
    expect(lambdaClientConfig(base, { kind: 'profile' })).toEqual({ region: 'r' });
    expect(lambdaClientConfig(base, { kind: 'endpoint', endpoint: 'http://x' }).endpoint).toBe('http://x');
    expect(lambdaClientConfig(base, { kind: 'endpoint', endpoint: 'http://x', lambdaEndpoint: 'http://l' }).endpoint).toBe('http://l');
    expect(iamClientConfig(base, { kind: 'profile' }).region).toBe('us-east-1');
  });

  it('revives base64 zip files', () => {
    expect(Buffer.from(reviveLambdaInput('UpdateFunctionCode', { ZipFile: 'aGk=' }).ZipFile).toString()).toBe('hi');
    expect(Buffer.from(reviveLambdaInput('CreateFunction', { Code: { ZipFile: 'aGk=' } }).Code.ZipFile).toString()).toBe('hi');
    expect(Buffer.from(reviveLambdaInput('PublishLayerVersion', { Content: { ZipFile: 'aGk=' } }).Content.ZipFile).toString()).toBe('hi');
    expect(reviveLambdaInput('ListFunctions', { ZipFile: 'aGk=' }).ZipFile).toBe('aGk=');
  });

  it('lists fallback URLs for emulator code locations', () => {
    expect(codeUrls('https://b.s3.amazonaws.com/k', { kind: 'profile' })).toEqual(['https://b.s3.amazonaws.com/k']);
    expect(codeUrls('https://awslambda-tasks.s3.us-east-1.amazonaws.com/fn-1?sig=x', { kind: 'endpoint', endpoint: 'http://localhost:5000' })).toEqual([
      'https://awslambda-tasks.s3.us-east-1.amazonaws.com/fn-1?sig=x',
      'http://localhost:5000/fn-1?sig=x',
      'http://localhost:5000/awslambda-tasks/fn-1?sig=x',
    ]);
  });

  it('computes crc32', () => {
    expect(crc32(Buffer.from('hello'))).toBe(0x3610a686);
  });

  it('round-trips a zip and keeps file modes', () => {
    const entries = readZip(pkg());
    expect(entries.map((e) => e.name)).toEqual(['index.mjs', 'lib/', 'lib/util.js', 'bootstrap']);
    expect(entries[0].data.toString()).toContain('handler');
    expect(entries[3].mode & 0o777).toBe(0o755);
    expect(isText(entries[0].data)).toBe(true);
    expect(isText(entries[3].data)).toBe(false);
  });

  it('applies edits, additions and deletions, and rejects unsafe paths', () => {
    const out = applyChanges(readZip(pkg()), { 'index.mjs': 'new', 'lib/util.js': null, 'README.md': '# hi' });
    expect(out.map((e) => e.name)).toEqual(['index.mjs', 'lib/', 'bootstrap', 'README.md']);
    expect(out[0].data.toString()).toBe('new');
    expect(() => applyChanges([], { '../etc/passwd': 'x' })).toThrow(/Invalid file path/);
    expect(() => applyChanges([], { '/abs': 'x' })).toThrow(/Invalid file path/);
  });

  it('rejects non-zip data', () => {
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'))).toThrow(/not a zip/);
  });

  it('cleanEndpoint validates the Lambda endpoint', () => {
    expect(cleanEndpoint({ name: 'ls', endpoint: 'http://a', lambdaEndpoint: ' http://b ' }).lambdaEndpoint).toBe('http://b');
    expect(() => cleanEndpoint({ name: 'ls', endpoint: 'http://a', lambdaEndpoint: 'ftp://b' })).toThrow(/Lambda endpoint/);
  });

  it('exposes function management but not account-wide destructive calls', () => {
    expect(LAMBDA_COMMANDS.has('UpdateFunctionConfiguration')).toBe(true);
    expect(LAMBDA_COMMANDS.has('DeleteLayerVersion')).toBe(false);
    expect(LAMBDA_COMMANDS.has('Invoke')).toBe(false); // goes through /invoke
  });
});

describe('lambda routes', () => {
  it('proxies an allowed operation', async () => {
    lambdaMock.on(ListFunctionsCommand).resolves({ Functions: [{ FunctionName: 'f1' }] });
    const r = await request(app()).post('/api/lambda/op/ListFunctions').set(H).set('x-conn', PROFILE).send({ MaxItems: 10 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ Functions: [{ FunctionName: 'f1' }] });
    expect(lambdaMock.commandCalls(ListFunctionsCommand)[0].args[0].input).toEqual({ MaxItems: 10 });
  });

  it('rejects unknown operations and requests without the CSRF header', async () => {
    const a = app();
    expect((await request(a).post('/api/lambda/op/DeleteLayerVersion').set(H).set('x-conn', PROFILE).send({})).status).toBe(404);
    expect((await request(a).post('/api/lambda/op/DeleteFunction').set('x-conn', PROFILE).send({ FunctionName: 'f' })).status).toBe(403);
    expect((await request(a).post('/api/lambda/cw/PutMetricAlarm').set(H).set('x-conn', PROFILE).send({})).status).toBe(404);
    expect((await request(a).post('/api/lambda/iam/DeleteRole').set(H).set('x-conn', PROFILE).send({})).status).toBe(404);
  });

  it('reports operations an emulator does not implement', async () => {
    lambdaMock.on(ListFunctionsCommand).rejects(Object.assign(new SyntaxError("Unexpected token '<'\n  Deserialization error: to see the raw response..."), { $metadata: { httpStatusCode: 404 } }));
    const r = await request(app()).post('/api/lambda/op/ListFunctions').set(H).set('x-conn', PROFILE).send({});
    expect(r.status).toBe(501);
    expect(r.body).toMatchObject({ error: 'NotSupported', message: 'ListFunctions is not supported by this endpoint' });
  });

  it('invokes with a text payload and decodes the response and log tail', async () => {
    lambdaMock.on(InvokeCommand).resolves({
      StatusCode: 200,
      FunctionError: 'Unhandled',
      ExecutedVersion: '$LATEST',
      Payload: new TextEncoder().encode('{"errorMessage":"boom"}'),
      LogResult: Buffer.from('START RequestId: 1\nREPORT RequestId: 1 Duration: 3.1 ms').toString('base64'),
      $metadata: { requestId: 'req-1' },
    });
    const r = await request(app()).post('/api/lambda/invoke').set(H).set('x-conn', PROFILE).send({ FunctionName: 'f', Payload: '{"a":1}', Qualifier: 'live' });
    expect(r.body).toMatchObject({ StatusCode: 200, FunctionError: 'Unhandled', Payload: '{"errorMessage":"boom"}', RequestId: 'req-1' });
    expect(r.body.LogResult).toMatch(/REPORT RequestId: 1/);
    const input = lambdaMock.commandCalls(InvokeCommand)[0].args[0].input;
    expect(Buffer.from(input.Payload).toString()).toBe('{"a":1}');
    expect(input).toMatchObject({ FunctionName: 'f', Qualifier: 'live', LogType: 'Tail', InvocationType: 'RequestResponse' });
  });

  it('async invokes do not ask for the log tail', async () => {
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
    await request(app()).post('/api/lambda/invoke').set(H).set('x-conn', PROFILE).send({ FunctionName: 'f', InvocationType: 'Event' });
    expect(lambdaMock.commandCalls(InvokeCommand)[0].args[0].input.LogType).toBe('None');
  });

  it('lists the files of the deployment package', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({ Configuration: { CodeSha256: 'sha', PackageType: 'Zip' }, Code: { Location: 'https://s3/pkg.zip' } });
    fetchImpl.mockResolvedValue(zipResponse(pkg()));
    const r = await request(app()).post('/api/lambda/code/files').set(H).set('x-conn', PROFILE).send({ FunctionName: 'f' });
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith('https://s3/pkg.zip');
    expect(r.body.codeSha256).toBe('sha');
    expect(r.body.files.map((f) => f.path)).toEqual(['index.mjs', 'lib/util.js', 'bootstrap']);
    expect(r.body.files[0].content).toContain('handler');
    expect(r.body.files[2]).toMatchObject({ binary: true, size: 6 });
  });

  it('retries the package download on the endpoint origin for emulators', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({ Configuration: {}, Code: { Location: 'http://s3.localhost.localstack.cloud:4566/b/k.zip?x=1' } });
    fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(zipResponse(pkg()));
    const a = app();
    const c = await request(a).post('/api/connections').set(H).send({ name: 'ls', endpoint: 'http://localhost:4566' });
    const r = await request(a).post('/api/lambda/code/files').set(H).set('x-conn', conn({ kind: 'endpoint', id: c.body.id })).send({ FunctionName: 'f' });
    expect(r.status).toBe(200);
    expect(fetchImpl.mock.calls[1][0]).toBe('http://localhost:4566/b/k.zip?x=1');
  });

  it('refuses container image functions', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({ Configuration: { PackageType: 'Image' }, Code: { ImageUri: 'x' } });
    const r = await request(app()).post('/api/lambda/code/files').set(H).set('x-conn', PROFILE).send({ FunctionName: 'f' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('ImageFunction');
  });

  it('deploys edited files and keeps the architecture', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({ Configuration: { CodeSha256: 'sha', Architectures: ['arm64'] }, Code: { Location: 'https://s3/pkg.zip' } });
    lambdaMock.on(UpdateFunctionCodeCommand).resolves({ CodeSha256: 'new', LastUpdateStatus: 'InProgress' });
    fetchImpl.mockResolvedValue(zipResponse(pkg()));
    const r = await request(app())
      .post('/api/lambda/code/deploy')
      .set(H)
      .set('x-conn', PROFILE)
      .send({ FunctionName: 'f', expectedSha256: 'sha', changes: { 'index.mjs': 'export const handler = async () => 2;', 'new.txt': 'n' } });
    expect(r.status).toBe(200);
    expect(r.body.CodeSha256).toBe('new');
    const input = lambdaMock.commandCalls(UpdateFunctionCodeCommand)[0].args[0].input;
    expect(input.Architectures).toEqual(['arm64']);
    const files = readZip(Buffer.from(input.ZipFile));
    expect(files.find((f) => f.name === 'index.mjs').data.toString()).toContain('=> 2');
    expect(files.find((f) => f.name === 'bootstrap').mode & 0o777).toBe(0o755);
    expect(files.map((f) => f.name)).toContain('new.txt');
  });

  it('refuses to deploy over code that changed meanwhile', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({ Configuration: { CodeSha256: 'other' }, Code: { Location: 'https://s3/pkg.zip' } });
    fetchImpl.mockResolvedValue(zipResponse(pkg()));
    const r = await request(app()).post('/api/lambda/code/deploy').set(H).set('x-conn', PROFILE).send({ FunctionName: 'f', expectedSha256: 'sha', changes: {} });
    expect(r.status).toBe(409);
    expect(lambdaMock.commandCalls(UpdateFunctionCodeCommand)).toHaveLength(0);
  });

  it('zips inline files for a new function and passes base64 zips to CreateFunction', async () => {
    const a = app();
    const z = await request(a).post('/api/lambda/code/zip').set(H).send({ files: { 'index.mjs': 'x' } });
    expect(readZip(Buffer.from(z.body.ZipFile, 'base64'))[0].name).toBe('index.mjs');
    lambdaMock.on(CreateFunctionCommand).resolves({ FunctionName: 'f' });
    await request(a).post('/api/lambda/op/CreateFunction').set(H).set('x-conn', PROFILE).send({ FunctionName: 'f', Code: { ZipFile: z.body.ZipFile } });
    expect(Buffer.isBuffer(lambdaMock.commandCalls(CreateFunctionCommand)[0].args[0].input.Code.ZipFile)).toBe(true);
  });

  it('downloads the package with the connection in the query string', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({ Configuration: {}, Code: { Location: 'https://s3/pkg.zip' } });
    fetchImpl.mockResolvedValue(zipResponse(pkg()));
    const r = await request(app()).get(`/api/lambda/code/download?name=my-fn&conn=${encodeURIComponent(PROFILE)}`).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toContain('my-fn.zip');
  });

  it('proxies GetMetricData with dates and IAM ListRoles', async () => {
    cwMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'inv', Timestamps: [new Date(0)], Values: [3] }] });
    iamMock.on(ListRolesCommand).resolves({ Roles: [{ RoleName: 'r', Arn: 'arn:aws:iam::1:role/r', CreateDate: new Date(0) }] });
    const a = app();
    const m = await request(a).post('/api/lambda/cw/GetMetricData').set(H).set('x-conn', PROFILE).send({ StartTime: '2026-01-01T00:00:00Z', EndTime: '2026-01-02T00:00:00Z', MetricDataQueries: [] });
    expect(m.body.MetricDataResults[0].Timestamps[0]).toBe('1970-01-01T00:00:00.000Z');
    expect(cwMock.commandCalls(GetMetricDataCommand)[0].args[0].input.StartTime).toBeInstanceOf(Date);
    const roles = await request(a).post('/api/lambda/iam/ListRoles').set(H).set('x-conn', PROFILE).send({});
    expect(roles.body.Roles[0].RoleName).toBe('r');
  });

  it('tests a connection with ListFunctions', async () => {
    lambdaMock.on(ListFunctionsCommand).resolves({ Functions: [{ FunctionName: 'a' }, { FunctionName: 'b' }], NextMarker: 'm' });
    const a = app();
    const c = await request(a).post('/api/connections').set(H).send({ name: 'ls', endpoint: 'http://localhost:4566' });
    const r = await request(a).post('/api/test').set(H).set('x-conn', conn({ kind: 'endpoint', id: c.body.id })).send({ service: 'lambda' });
    expect(r.body).toMatchObject({ functionCount: 2, more: true });
  });
});
