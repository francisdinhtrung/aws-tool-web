import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import { SFNClient, ListStateMachinesCommand, DescribeExecutionCommand, StartExecutionCommand, DeleteStateMachineCommand } from '@aws-sdk/client-sfn';
import { tempEnv } from './helpers.js';
import { createApp, cleanEndpoint } from '../src/app.js';
import { sfnClientConfig, SFN_COMMANDS } from '../src/sfn.js';

const sfnMock = mockClient(SFNClient);
const H = { 'x-requested-with': 'aws-tool-web' };
const conn = (c) => encodeURIComponent(JSON.stringify(c));
const PROFILE = conn({ kind: 'profile', profile: 'default', region: 'eu-west-1' });
const SM = 'arn:aws:states:eu-west-1:123:stateMachine:orders';

let env;
beforeEach(async () => {
  sfnMock.reset();
  env = await tempEnv({
    config: '[default]\nregion = eu-west-1\n',
    credentials: '[default]\naws_access_key_id = AKIA\naws_secret_access_key = SECRET\n',
  });
});
afterEach(() => env.cleanup());

const app = () => createApp({ staticDir: env.root, allowedHosts: ['127.0.0.1'] });

describe('sfn helpers', () => {
  it('sfnClientConfig prefers the Step Functions endpoint and disables host prefixes for custom endpoints', () => {
    const base = { region: 'r', endpoint: 'http://ddb', credentials: { accessKeyId: 'a' } };
    expect(sfnClientConfig(base, { kind: 'profile' })).toEqual({ region: 'r', credentials: { accessKeyId: 'a' } });
    expect(sfnClientConfig(base, { kind: 'endpoint', endpoint: 'http://x' })).toMatchObject({ endpoint: 'http://x', disableHostPrefix: true });
    expect(sfnClientConfig(base, { kind: 'endpoint', endpoint: 'http://x', sfnEndpoint: 'http://s:8083' }).endpoint).toBe('http://s:8083');
  });

  it('allows state machine, execution and activity operations only', () => {
    expect(SFN_COMMANDS.has('StartExecution')).toBe(true);
    expect(SFN_COMMANDS.has('GetExecutionHistory')).toBe(true);
    expect(SFN_COMMANDS.has('SendTaskSuccess')).toBe(false);
    expect(SFN_COMMANDS.has('GetActivityTask')).toBe(false);
  });

  it('cleanEndpoint validates the Step Functions endpoint', () => {
    expect(cleanEndpoint({ name: 'ls', endpoint: 'http://a', sfnEndpoint: ' http://b ' }).sfnEndpoint).toBe('http://b');
    expect(() => cleanEndpoint({ name: 'ls', endpoint: 'http://a', sfnEndpoint: 'ftp://b' })).toThrow(/Step Functions endpoint/);
  });
});

describe('sfn routes', () => {
  it('proxies an allowed operation', async () => {
    sfnMock.on(StartExecutionCommand).resolves({ executionArn: `${SM}:run-1`, startDate: new Date('2026-01-01T00:00:00Z') });
    const r = await request(app()).post('/api/sfn/op/StartExecution').set(H).set('x-conn', PROFILE).send({ stateMachineArn: SM, input: '{}' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ executionArn: `${SM}:run-1`, startDate: '2026-01-01T00:00:00.000Z' });
    expect(r.headers['x-elapsed-ms']).toBeDefined();
    expect(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input).toEqual({ stateMachineArn: SM, input: '{}' });
  });

  it('serializes dates in execution descriptions', async () => {
    sfnMock.on(DescribeExecutionCommand).resolves({ status: 'SUCCEEDED', startDate: new Date(0), stopDate: new Date(1000) });
    const r = await request(app()).post('/api/sfn/op/DescribeExecution').set(H).set('x-conn', PROFILE).send({ executionArn: `${SM}:x` });
    expect(r.body).toEqual({ status: 'SUCCEEDED', startDate: '1970-01-01T00:00:00.000Z', stopDate: '1970-01-01T00:00:01.000Z' });
  });

  it('rejects unknown operations and requests without the CSRF header', async () => {
    const a = app();
    expect((await request(a).post('/api/sfn/op/SendTaskSuccess').set(H).set('x-conn', PROFILE).send({})).status).toBe(404);
    expect((await request(a).post('/api/sfn/op/DeleteStateMachine').set('x-conn', PROFILE).send({ stateMachineArn: SM })).status).toBe(403);
    expect(sfnMock.commandCalls(DeleteStateMachineCommand)).toHaveLength(0);
  });

  it('maps AWS errors to their HTTP status', async () => {
    sfnMock.on(DescribeExecutionCommand).rejects(Object.assign(new Error('Execution does not exist'), { name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 } }));
    const r = await request(app()).post('/api/sfn/op/DescribeExecution').set(H).set('x-conn', PROFILE).send({ executionArn: 'x' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'ExecutionDoesNotExist', message: 'Execution does not exist' });
  });

  it('reports operations an emulator does not implement', async () => {
    sfnMock.on(ListStateMachinesCommand).rejects(Object.assign(new SyntaxError("Unexpected token '<'\n  Deserialization error: to see the raw response..."), { $metadata: { httpStatusCode: 404 } }));
    const r = await request(app()).post('/api/sfn/op/ListStateMachines').set(H).set('x-conn', PROFILE).send({});
    expect(r.status).toBe(501);
    expect(r.body).toMatchObject({ error: 'NotSupported', message: expect.stringMatching(/ListStateMachines is not supported/) });
  });

  it('tests a custom endpoint connection with ListStateMachines', async () => {
    sfnMock.on(ListStateMachinesCommand).resolves({ stateMachines: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], nextToken: 'n' });
    const a = app();
    const c = await request(a).post('/api/connections').set(H).send({ name: 'ls', endpoint: 'http://localhost:4566' });
    const r = await request(a).post('/api/test').set(H).set('x-conn', conn({ kind: 'endpoint', id: c.body.id })).send({ service: 'sfn' });
    expect(r.body).toMatchObject({ stateMachineCount: 3, more: true, endpoint: 'http://localhost:4566' });
  });
});
