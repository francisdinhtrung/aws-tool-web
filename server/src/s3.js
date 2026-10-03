import express from 'express';
import * as S3 from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HttpError } from './profiles.js';

export const S3_COMMANDS = new Set([
  'ListBuckets', 'CreateBucket', 'DeleteBucket', 'HeadBucket', 'GetBucketLocation',
  'ListObjectsV2', 'ListObjectVersions', 'HeadObject', 'PutObject', 'DeleteObject', 'DeleteObjects', 'CopyObject', 'RestoreObject',
  'GetObjectTagging', 'PutObjectTagging', 'DeleteObjectTagging', 'GetObjectAcl',
  'GetBucketVersioning', 'PutBucketVersioning', 'GetBucketTagging', 'PutBucketTagging', 'DeleteBucketTagging',
  'GetBucketPolicy', 'PutBucketPolicy', 'DeleteBucketPolicy', 'GetBucketCors', 'PutBucketCors', 'DeleteBucketCors',
  'GetBucketLifecycleConfiguration', 'PutBucketLifecycleConfiguration', 'DeleteBucketLifecycle',
  'GetBucketEncryption', 'GetPublicAccessBlock', 'PutPublicAccessBlock', 'GetBucketAcl', 'GetBucketWebsite', 'GetBucketLogging',
  'ListMultipartUploads', 'AbortMultipartUpload',
]);

// Types the browser may render inline (preview). Anything else is served as an attachment.
export const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)|video\/[\w.+-]+|audio\/[\w.+-]+|text\/plain|application\/pdf)(;|$)/i;
// Bucket content is untrusted: sandbox every response so it can never run script on this origin.
// (PDF is exempt because Chrome refuses to render sandboxed PDFs; PDF script cannot reach the origin.)
export const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

export function contentDisposition(kind, key) {
  const name = String(key).split('/').filter(Boolean).pop() || 'download';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function s3ClientConfig(base, r, region) {
  const cfg = { ...base, region, followRegionRedirects: true };
  delete cfg.endpoint;
  if (r.kind === 'endpoint') {
    cfg.endpoint = r.s3Endpoint || r.endpoint;
    cfg.forcePathStyle = true;
  }
  return cfg;
}

const need = (v, name) => {
  if (!v) throw new HttpError(400, 'BadRequest', `Missing ${name}`);
  return String(v);
};

/**
 * S3 routes. `resolve(raw)` turns the x-conn header into a connection, `config(r)` builds the base SDK config,
 * `serialize(out)` makes SDK output JSON safe.
 */
export function s3Routes({ resolve, config, serialize }) {
  const clients = new Map();
  const regions = new Map();
  const router = express.Router();

  const clientFor = (r, region) => {
    const k = `${r.key}|${region}`;
    if (!clients.has(k)) clients.set(k, new S3.S3Client(s3ClientConfig(config(r), r, region)));
    return clients.get(k);
  };

  // Buckets live in one region; talk to that region directly so presigned URLs and redirects are right.
  async function bucketRegion(r, bucket) {
    const k = `${r.key}|${bucket}`;
    if (regions.has(k)) return regions.get(k);
    let region;
    try {
      region = (await clientFor(r, r.region).send(new S3.HeadBucketCommand({ Bucket: bucket }))).BucketRegion;
    } catch (e) {
      region = e.$response?.headers?.['x-amz-bucket-region'];
    }
    if (region) regions.set(k, region);
    return region || r.region;
  }

  async function ctx(req, bucket, regionOverride) {
    const r = await resolve(req.get('x-conn') || req.query.conn);
    let region = r.region;
    if (regionOverride && r.kind !== 'endpoint') region = regionOverride;
    else if (bucket && r.kind !== 'endpoint') region = await bucketRegion(r, bucket);
    return { r, region, s3: clientFor(r, region) };
  }

  router.post('/op/:op', async (req, res) => {
    const op = req.params.op;
    if (!S3_COMMANDS.has(op)) throw new HttpError(404, 'UnknownOperation', `Operation ${op} is not supported`);
    const input = req.body || {};
    const override = op === 'CreateBucket' ? input.CreateBucketConfiguration?.LocationConstraint || 'us-east-1' : undefined;
    const { r, region, s3 } = await ctx(req, op === 'CreateBucket' ? undefined : input.Bucket, override);
    const started = Date.now();
    const out = await s3.send(new S3[`${op}Command`](input));
    if (op === 'DeleteBucket') regions.delete(`${r.key}|${input.Bucket}`);
    res.set('x-elapsed-ms', String(Date.now() - started));
    res.set('x-bucket-region', region);
    res.json(serialize(out));
  });

  // Upload: the raw request body is streamed to S3 (multipart for large files).
  router.put('/object', async (req, res) => {
    const Bucket = need(req.query.bucket, 'bucket');
    const Key = need(req.query.key, 'key');
    const { s3 } = await ctx(req, Bucket);
    const params = { Bucket, Key, ContentType: req.get('x-object-content-type') || 'application/octet-stream' };
    if (req.get('content-length') === '0') {
      const out = await s3.send(new S3.PutObjectCommand({ ...params, Body: '' }));
      return res.json({ ETag: out.ETag, VersionId: out.VersionId });
    }
    const upload = new Upload({ client: s3, params: { ...params, Body: req }, queueSize: 4, partSize: 8 * 1024 * 1024 });
    res.on('close', () => {
      if (!res.writableFinished) upload.abort().catch(() => {});
    });
    const out = await upload.done();
    res.json({ ETag: out.ETag, VersionId: out.VersionId });
  });

  // Download / inline preview. GET so it works from <a href>, <img> and <video>; the connection comes in ?conn=.
  router.get('/object', async (req, res) => {
    const Bucket = need(req.query.bucket, 'bucket');
    const Key = need(req.query.key, 'key');
    const { s3 } = await ctx(req, Bucket);
    const out = await s3.send(
      new S3.GetObjectCommand({ Bucket, Key, VersionId: req.query.versionId || undefined, Range: req.get('range') || undefined }),
    );
    const type = out.ContentType || 'application/octet-stream';
    const inline = req.query.inline === '1' && INLINE_TYPES.test(type);
    res.status(out.ContentRange ? 206 : 200);
    res.set({
      'Content-Type': inline ? type : 'application/octet-stream',
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', Key),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': 'bytes',
    });
    if (!(inline && /^application\/pdf/i.test(type))) res.set('Content-Security-Policy', SANDBOX_CSP);
    if (out.ContentLength !== undefined) res.set('Content-Length', String(out.ContentLength));
    if (out.ContentRange) res.set('Content-Range', out.ContentRange);
    if (out.ETag) res.set('ETag', out.ETag);
    if (out.LastModified) res.set('Last-Modified', out.LastModified.toUTCString());
    const body = out.Body;
    if (!body) return res.end();
    res.on('close', () => body.destroy?.());
    body.on('error', (e) => res.destroy(e));
    body.pipe(res);
  });

  router.post('/presign', async (req, res) => {
    const Bucket = need(req.body?.bucket, 'bucket');
    const Key = need(req.body?.key, 'key');
    const expiresIn = Math.min(604800, Math.max(1, Number(req.body.expires) || 3600));
    const { s3 } = await ctx(req, Bucket);
    const url = await getSignedUrl(s3, new S3.GetObjectCommand({ Bucket, Key, VersionId: req.body.versionId || undefined }), { expiresIn });
    res.json({ url, expiresIn });
  });

  // Recursively delete everything under a prefix. versions=true also removes old versions and delete markers.
  router.post('/delete-prefix', async (req, res) => {
    const Bucket = need(req.body?.bucket, 'bucket');
    const prefix = String(req.body.prefix || '');
    const versions = Boolean(req.body.versions);
    if (!prefix && req.body.confirm !== Bucket) throw new HttpError(400, 'ConfirmRequired', 'Emptying a whole bucket needs confirm = bucket name');
    const { s3 } = await ctx(req, Bucket);
    let deleted = 0;
    const errors = [];
    const remove = async (Objects) => {
      if (!Objects.length) return;
      const out = await s3.send(new S3.DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
      deleted += Objects.length - (out.Errors?.length || 0);
      for (const e of out.Errors || []) if (errors.length < 50) errors.push({ key: e.Key, code: e.Code, message: e.Message });
    };
    if (versions) {
      let KeyMarker;
      let VersionIdMarker;
      do {
        const out = await s3.send(new S3.ListObjectVersionsCommand({ Bucket, Prefix: prefix || undefined, KeyMarker, VersionIdMarker }));
        await remove([...(out.Versions || []), ...(out.DeleteMarkers || [])].map((v) => ({ Key: v.Key, VersionId: v.VersionId })));
        KeyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
        VersionIdMarker = out.IsTruncated ? out.NextVersionIdMarker : undefined;
      } while (KeyMarker);
    } else {
      let ContinuationToken;
      do {
        const out = await s3.send(new S3.ListObjectsV2Command({ Bucket, Prefix: prefix || undefined, ContinuationToken }));
        await remove((out.Contents || []).map((o) => ({ Key: o.Key })));
        ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (ContinuationToken);
    }
    res.json({ deleted, errors });
  });

  return {
    router,
    listBuckets: (r) => clientFor(r, r.region).send(new S3.ListBucketsCommand({})),
    clear: () => {
      clients.clear();
      regions.clear();
    },
  };
}
