import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Readable } from 'node:stream';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client, ListObjectsV2Command, HeadBucketCommand, CreateBucketCommand, GetObjectCommand, PutObjectCommand,
  DeleteObjectsCommand, ListObjectVersionsCommand, ListBucketsCommand, DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { tempEnv } from './helpers.js';
import { createApp, cleanEndpoint } from '../src/app.js';
import { contentDisposition, s3ClientConfig, INLINE_TYPES } from '../src/s3.js';

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBClient);
const H = { 'x-requested-with': 'aws-tool-web' };
const conn = (c) => encodeURIComponent(JSON.stringify(c));
const PROFILE = conn({ kind: 'profile', profile: 'default', region: 'us-west-2' });

let env;
beforeEach(async () => {
  s3Mock.reset();
  ddbMock.reset();
  env = await tempEnv({
    config: '[default]\nregion = us-west-2\n',
    credentials: '[default]\naws_access_key_id = AKIA\naws_secret_access_key = SECRET\n',
  });
});
afterEach(() => env.cleanup());

const app = () => createApp({ staticDir: env.root, allowedHosts: ['127.0.0.1'] });
const post = (a, path, body, c = PROFILE) => request(a).post(path).set(H).set('x-conn', c).send(body);

async function endpointConn(a, body = {}) {
  const r = await request(a).post('/api/connections').set(H).send({ name: 'minio', endpoint: 'http://localhost:9000', ...body });
  return conn({ kind: 'endpoint', id: r.body.id });
}

describe('helpers', () => {
  it('contentDisposition keeps an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('attachment', 'a/b/ảnh "1".png')).toBe(`attachment; filename="_nh _1_.png"; filename*=UTF-8''${encodeURIComponent('ảnh "1".png')}`);
    expect(contentDisposition('inline', '')).toMatch(/filename="download"/);
  });

  it('s3ClientConfig uses path style and the S3 endpoint for custom endpoints', () => {
    const base = { region: 'r', endpoint: 'http://ddb', credentials: { accessKeyId: 'a' } };
    expect(s3ClientConfig(base, { kind: 'profile' }, 'eu-west-1')).toEqual({ region: 'eu-west-1', followRegionRedirects: true, credentials: { accessKeyId: 'a' } });
    expect(s3ClientConfig(base, { kind: 'endpoint', endpoint: 'http://x' }, 'r')).toMatchObject({ endpoint: 'http://x', forcePathStyle: true });
    expect(s3ClientConfig(base, { kind: 'endpoint', endpoint: 'http://x', s3Endpoint: 'http://s3' }, 'r').endpoint).toBe('http://s3');
  });

  it('INLINE_TYPES only allows media, plain text and PDF', () => {
    for (const t of ['image/png', 'image/svg+xml', 'video/mp4', 'audio/mpeg', 'text/plain; charset=utf-8', 'application/pdf']) expect(INLINE_TYPES.test(t)).toBe(true);
    for (const t of ['text/html', 'application/xhtml+xml', 'application/javascript', 'image/png-evil', 'text/plainx']) expect(INLINE_TYPES.test(t)).toBe(false);
  });

  it('cleanEndpoint validates the optional S3 endpoint', () => {
    expect(cleanEndpoint({ name: 'x', endpoint: 'http://x', s3Endpoint: ' http://s3 ' }).s3Endpoint).toBe('http://s3');
    expect(cleanEndpoint({ name: 'x', endpoint: 'http://x' }).s3Endpoint).toBe('');
    expect(() => cleanEndpoint({ name: 'x', endpoint: 'http://x', s3Endpoint: 'nope' })).toThrow(/S3 endpoint/);
  });
});

describe('S3 operation passthrough', () => {
  it('runs allowed operations in the bucket region and serializes output', async () => {
    s3Mock.on(HeadBucketCommand).resolves({ BucketRegion: 'eu-central-1' });
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'a.txt', Size: 3, LastModified: new Date('2026-01-01T00:00:00Z') }] });
    const a = app();
    const res = await post(a, '/api/s3/op/ListObjectsV2', { Bucket: 'b', Delimiter: '/' });
    expect(res.status).toBe(200);
    expect(res.body.Contents[0]).toEqual({ Key: 'a.txt', Size: 3, LastModified: '2026-01-01T00:00:00.000Z' });
    expect(res.headers['x-bucket-region']).toBe('eu-central-1');
    // The region is cached per bucket.
    await post(a, '/api/s3/op/ListObjectsV2', { Bucket: 'b' });
    expect(s3Mock.commandCalls(HeadBucketCommand)).toHaveLength(1);
  });

  it('falls back to the region header of a failed HeadBucket, then to the connection region', async () => {
    s3Mock.on(HeadBucketCommand, { Bucket: 'x' }).rejects(Object.assign(new Error('Forbidden'), { $response: { headers: { 'x-amz-bucket-region': 'ap-southeast-1' } } }));
    s3Mock.on(HeadBucketCommand, { Bucket: 'y' }).rejects(new Error('boom'));
    s3Mock.on(ListObjectsV2Command).resolves({});
    expect((await post(app(), '/api/s3/op/ListObjectsV2', { Bucket: 'x' })).headers['x-bucket-region']).toBe('ap-southeast-1');
    expect((await post(app(), '/api/s3/op/ListObjectsV2', { Bucket: 'y' })).headers['x-bucket-region']).toBe('us-west-2');
  });

  it('creates buckets in the requested region and skips lookup for custom endpoints', async () => {
    s3Mock.on(CreateBucketCommand).resolves({ Location: '/b' });
    const res = await post(app(), '/api/s3/op/CreateBucket', { Bucket: 'b', CreateBucketConfiguration: { LocationConstraint: 'eu-west-1' } });
    expect(res.headers['x-bucket-region']).toBe('eu-west-1');
    const a = app();
    s3Mock.on(ListObjectsV2Command).resolves({});
    const ep = await endpointConn(a);
    expect((await post(a, '/api/s3/op/ListObjectsV2', { Bucket: 'b' }, ep)).headers['x-bucket-region']).toBe('us-east-1');
    expect(s3Mock.commandCalls(HeadBucketCommand)).toHaveLength(0);
  });

  it('forgets the region of a deleted bucket', async () => {
    s3Mock.on(HeadBucketCommand).resolves({ BucketRegion: 'us-west-2' });
    s3Mock.on(DeleteBucketCommand).resolves({});
    const a = app();
    await post(a, '/api/s3/op/DeleteBucket', { Bucket: 'b' });
    await post(a, '/api/s3/op/DeleteBucket', { Bucket: 'b' });
    expect(s3Mock.commandCalls(HeadBucketCommand)).toHaveLength(2);
  });

  it('rejects unknown operations and missing connections', async () => {
    expect((await post(app(), '/api/s3/op/GetObject', {})).status).toBe(404);
    expect((await request(app()).post('/api/s3/op/ListBuckets').set(H).send({})).status).toBe(400);
  });
});

describe('object download', () => {
  const get = (a, q, headers = {}) => request(a).get(`/api/s3/object?${new URLSearchParams({ conn: decodeURIComponent(PROFILE), ...q })}`).set(headers);

  it('previews safe types inline inside a sandbox', async () => {
    s3Mock.on(HeadBucketCommand).resolves({ BucketRegion: 'us-west-2' });
    s3Mock.on(GetObjectCommand).resolves({ Body: Readable.from([Buffer.from('hello')]), ContentType: 'text/plain', ContentLength: 5, ETag: '"e"', LastModified: new Date('2026-01-01T00:00:00Z') });
    const res = await get(app(), { bucket: 'b', key: 'dir/a.txt', inline: '1' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('hello');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="a.txt"/);
    expect(res.headers['content-security-policy']).toMatch(/^sandbox/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['last-modified']).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
  });

  it('forces unsafe types to download and passes ranges and versions through', async () => {
    s3Mock.on(HeadBucketCommand).resolves({ BucketRegion: 'us-west-2' });
    s3Mock.on(GetObjectCommand).resolves({ Body: Readable.from([Buffer.from('<h')]), ContentType: 'text/html', ContentLength: 2, ContentRange: 'bytes 0-1/10' });
    const res = await get(app(), { bucket: 'b', key: 'x.html', inline: '1', versionId: 'v1' }, { range: 'bytes=0-1' });
    expect(res.status).toBe(206);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['content-range']).toBe('bytes 0-1/10');
    expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input).toMatchObject({ Bucket: 'b', Key: 'x.html', VersionId: 'v1', Range: 'bytes=0-1' });
  });

  it('lets PDFs render without the sandbox and handles empty bodies', async () => {
    s3Mock.on(HeadBucketCommand).resolves({ BucketRegion: 'us-west-2' });
    s3Mock.on(GetObjectCommand).resolves({ ContentType: 'application/pdf' });
    const res = await get(app(), { bucket: 'b', key: 'a.pdf', inline: '1' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('requires bucket and key', async () => {
    expect((await get(app(), { bucket: 'b' })).status).toBe(400);
  });
});

describe('object upload', () => {
  it('streams the body to S3 with the object content type', async () => {
    s3Mock.on(HeadBucketCommand).resolves({ BucketRegion: 'us-west-2' });
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"e"', VersionId: 'v' });
    const res = await request(app())
      .put('/api/s3/object?bucket=b&key=dir/a.txt')
      .set(H)
      .set('x-conn', PROFILE)
      .set('x-object-content-type', 'text/plain')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('hello'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ETag: '"e"', VersionId: 'v' });
    const input = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(input).toMatchObject({ Bucket: 'b', Key: 'dir/a.txt', ContentType: 'text/plain' });
  });

  it('writes empty objects directly', async () => {
    s3Mock.on(HeadBucketCommand).resolves({ BucketRegion: 'us-west-2' });
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"d41d"' });
    const res = await request(app()).put('/api/s3/object?bucket=b&key=empty').set(H).set('x-conn', PROFILE).set('content-length', '0').send();
    expect(res.status).toBe(200);
    expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input).toEqual({ Bucket: 'b', Key: 'empty', ContentType: 'application/octet-stream', Body: '' });
  });

  it('is protected against CSRF', async () => {
    expect((await request(app()).put('/api/s3/object?bucket=b&key=k').send('x')).status).toBe(403);
  });
});

describe('presign and delete-prefix', () => {
  it('signs GET URLs with a clamped expiry', async () => {
    s3Mock.on(HeadBucketCommand).resolves({ BucketRegion: 'eu-west-1' });
    const res = await post(app(), '/api/s3/presign', { bucket: 'b', key: 'a b.txt', expires: 99999999 });
    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe(604800);
    expect(res.body.url).toMatch(/^https:\/\/s3\.eu-west-1\.amazonaws\.com\/b\/a%20b\.txt\?.*X-Amz-Credential=AKIA%2F.*X-Amz-Signature=/);
  });

  it('deletes every object under a prefix page by page', async () => {
    s3Mock.on(HeadBucketCommand).resolves({ BucketRegion: 'us-west-2' });
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({ Contents: [{ Key: 'p/1' }, { Key: 'p/2' }], IsTruncated: true, NextContinuationToken: 't' })
      .resolvesOnce({ Contents: [{ Key: 'p/3' }] });
    s3Mock.on(DeleteObjectsCommand).resolvesOnce({}).resolvesOnce({ Errors: [{ Key: 'p/3', Code: 'AccessDenied', Message: 'no' }] });
    const res = await post(app(), '/api/s3/delete-prefix', { bucket: 'b', prefix: 'p/' });
    expect(res.body).toEqual({ deleted: 2, errors: [{ key: 'p/3', code: 'AccessDenied', message: 'no' }] });
    expect(s3Mock.commandCalls(ListObjectsV2Command)[1].args[0].input.ContinuationToken).toBe('t');
    expect(s3Mock.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete.Objects).toEqual([{ Key: 'p/1' }, { Key: 'p/2' }]);
  });

  it('empties versions and delete markers, but only with confirmation for a whole bucket', async () => {
    s3Mock.on(HeadBucketCommand).resolves({ BucketRegion: 'us-west-2' });
    s3Mock.on(ListObjectVersionsCommand).resolves({ Versions: [{ Key: 'a', VersionId: '1' }], DeleteMarkers: [{ Key: 'b', VersionId: '2' }] });
    s3Mock.on(DeleteObjectsCommand).resolves({});
    expect((await post(app(), '/api/s3/delete-prefix', { bucket: 'b', prefix: '', versions: true })).status).toBe(400);
    const res = await post(app(), '/api/s3/delete-prefix', { bucket: 'b', prefix: '', versions: true, confirm: 'b' });
    expect(res.body.deleted).toBe(2);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete.Objects).toEqual([{ Key: 'a', VersionId: '1' }, { Key: 'b', VersionId: '2' }]);
  });
});

describe('connection test with S3-only endpoints', () => {
  it('accepts an endpoint that answers S3 but not DynamoDB', async () => {
    ddbMock.on(ListTablesCommand).rejects(new Error('not dynamodb'));
    s3Mock.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'a' }, { Name: 'b' }] });
    const a = app();
    const ep = await endpointConn(a);
    const res = await post(a, '/api/test', {}, ep);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dynamodb: false, bucketCount: 2 });
  });

  it('tests S3 only when asked for the S3 service', async () => {
    s3Mock.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'a' }] });
    const a = app();
    const res = await post(a, '/api/test', { service: 's3' }, await endpointConn(a));
    expect(res.body).toEqual({ region: 'us-east-1', endpoint: 'http://localhost:9000', bucketCount: 1 });
    expect(ddbMock.commandCalls(ListTablesCommand)).toHaveLength(0);
  });

  it('reports the DynamoDB error when S3 also fails', async () => {
    ddbMock.on(ListTablesCommand).rejects(Object.assign(new Error('not dynamodb'), { name: 'UnknownEndpoint' }));
    s3Mock.on(ListBucketsCommand).rejects(new Error('no s3'));
    const a = app();
    const res = await post(a, '/api/test', {}, await endpointConn(a));
    expect(res.body.message).toBe('not dynamodb');
  });
});
