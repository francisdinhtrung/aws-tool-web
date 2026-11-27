import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SecretsManagerClient, ListSecretsCommand, DescribeSecretCommand, GetSecretValueCommand,
  CreateSecretCommand, UpdateSecretCommand, DeleteSecretCommand, RestoreSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { createApp } from '../src/app.js';
import { tempEnv } from './helpers.js';

const sdk = mockClient(SecretsManagerClient);
const headers = { 'x-requested-with': 'aws-tool-web' };
const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:app/config-a1b2c3';
let env;
let app;
let conn;

beforeEach(async () => {
  sdk.reset();
  env = await tempEnv();
  app = createApp({ staticDir: env.root, allowedHosts: ['127.0.0.1'] });
  const { body } = await request(app).post('/api/connections').set(headers).send({
    name: 'LocalStack', endpoint: 'http://localhost:8000', secretsEndpoint: 'http://localhost:4566',
  }).expect(200);
  conn = encodeURIComponent(JSON.stringify({ kind: 'endpoint', id: body.id }));
});
afterEach(() => env.cleanup());

const post = (op, input) => request(app).post(`/api/secrets/op/${op}`).set(headers).set('x-conn', conn).send(input);

describe('Secrets Manager routes', () => {
  it('lists paginated metadata and tests the selected service connection', async () => {
    sdk.on(ListSecretsCommand).resolves({ SecretList: [{ ARN: arn, Name: 'app/config' }], NextToken: 'next' });
    sdk.on(DescribeSecretCommand).resolves({ ARN: arn, Name: 'app/config', LastChangedDate: new Date('2026-01-01T00:00:00Z') });
    const listing = await post('ListSecrets', { IncludePlannedDeletion: true, NextToken: 'page-2' }).expect(200);
    expect(listing.body.NextToken).toBe('next');
    expect(listing.headers['cache-control']).toBe('no-store');
    expect(sdk.commandCalls(ListSecretsCommand)[0].args[0].input).toMatchObject({ IncludePlannedDeletion: true, NextToken: 'page-2' });
    const detail = await post('DescribeSecret', { SecretId: arn }).expect(200);
    expect(detail.body.LastChangedDate).toBe('2026-01-01T00:00:00.000Z');
    expect(sdk.commandCalls(GetSecretValueCommand)).toHaveLength(0);
    const status = await request(app).post('/api/test').set(headers).set('x-conn', conn).send({ service: 'secrets' }).expect(200);
    expect(status.body).toMatchObject({ endpoint: 'http://localhost:4566', secretCount: 1, more: true });
  });

  it('retrieves a binary version without caching or attaching a value fingerprint', async () => {
    sdk.on(GetSecretValueCommand).resolves({ ARN: arn, SecretBinary: new Uint8Array([1, 2, 3]), VersionStages: ['AWSPREVIOUS'] });
    const res = await post('GetSecretValue', { SecretId: arn, VersionStage: 'AWSPREVIOUS' }).expect(200);
    expect(res.body).toEqual({ ARN: arn, SecretBinary: 'AQID', VersionStages: ['AWSPREVIOUS'] });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
    expect(sdk.commandCalls(GetSecretValueCommand)[0].args[0].input).toEqual({ SecretId: arn, VersionStage: 'AWSPREVIOUS' });
    await request(app).post('/api/secrets/op/GetSecretValue').set('x-conn', conn).send({ SecretId: arn }).expect(403);
  });

  it('creates and updates secrets using text and decoded binary values', async () => {
    sdk.on(CreateSecretCommand).resolves({ ARN: arn });
    sdk.on(UpdateSecretCommand).resolves({ ARN: arn });
    await post('CreateSecret', { Name: 'app/config', SecretString: ' {"token":"demo"}\n' }).expect(200);
    expect(sdk.commandCalls(CreateSecretCommand)[0].args[0].input.SecretString).toBe(' {"token":"demo"}\n');
    await post('UpdateSecret', { SecretId: arn, SecretBinary: 'AQID\n' }).expect(200);
    await post('UpdateSecret', { SecretId: arn, SecretBinary: 'not base64!' }).expect(400);
    expect(sdk.commandCalls(UpdateSecretCommand)).toHaveLength(1);
    expect(sdk.commandCalls(UpdateSecretCommand)[0].args[0].input.SecretBinary).toEqual(Buffer.from([1, 2, 3]));
  });

  it('requires recoverable deletion and supports restoring a secret', async () => {
    sdk.on(DeleteSecretCommand).resolves({ ARN: arn, DeletionDate: new Date('2026-02-01T00:00:00Z') });
    sdk.on(RestoreSecretCommand).resolves({ ARN: arn });
    await post('DeleteSecret', { SecretId: arn, RecoveryWindowInDays: 1 }).expect(400);
    await post('DeleteSecret', { SecretId: arn, ForceDeleteWithoutRecovery: true }).expect(200);
    expect(sdk.commandCalls(DeleteSecretCommand)[0].args[0].input).toEqual({ SecretId: arn, RecoveryWindowInDays: 30 });
    await post('RestoreSecret', { SecretId: arn }).expect(200);
    expect(sdk.commandCalls(RestoreSecretCommand)[0].args[0].input).toEqual({ SecretId: arn });
  });

  it('does not echo raw upstream error messages that may contain secret values', async () => {
    sdk.on(UpdateSecretCommand).rejects(Object.assign(new Error('Upstream repeated demo-secret'), { name: 'InvalidParameterException', $metadata: { httpStatusCode: 400 } }));
    const res = await post('UpdateSecret', { SecretId: arn, SecretString: 'demo-secret' }).expect(400);
    expect(res.body).toEqual({ error: 'InvalidParameterException', message: 'Secrets Manager request failed.' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
