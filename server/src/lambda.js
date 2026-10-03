import express from 'express';
import zlib from 'node:zlib';
import * as LAMBDA from '@aws-sdk/client-lambda';
import * as CW from '@aws-sdk/client-cloudwatch';
import * as IAM from '@aws-sdk/client-iam';
import { HttpError } from './profiles.js';

// Lambda API surface exposed to the UI. DeleteFunction is confirmed in the UI (the user types the name).
export const LAMBDA_COMMANDS = new Set([
  'ListFunctions', 'GetFunction', 'GetFunctionConfiguration', 'CreateFunction', 'DeleteFunction',
  'UpdateFunctionConfiguration', 'UpdateFunctionCode', 'GetAccountSettings',
  'ListVersionsByFunction', 'PublishVersion', 'ListAliases', 'GetAlias', 'CreateAlias', 'UpdateAlias', 'DeleteAlias',
  'ListEventSourceMappings', 'GetEventSourceMapping', 'CreateEventSourceMapping', 'UpdateEventSourceMapping', 'DeleteEventSourceMapping',
  'GetPolicy', 'AddPermission', 'RemovePermission',
  'ListFunctionUrlConfigs', 'GetFunctionUrlConfig', 'CreateFunctionUrlConfig', 'UpdateFunctionUrlConfig', 'DeleteFunctionUrlConfig',
  'GetFunctionConcurrency', 'PutFunctionConcurrency', 'DeleteFunctionConcurrency',
  'ListProvisionedConcurrencyConfigs', 'PutProvisionedConcurrencyConfig', 'DeleteProvisionedConcurrencyConfig',
  'GetFunctionEventInvokeConfig', 'PutFunctionEventInvokeConfig', 'DeleteFunctionEventInvokeConfig',
  'ListTags', 'TagResource', 'UntagResource',
  'ListLayers', 'ListLayerVersions', 'GetLayerVersion', 'PublishLayerVersion',
]);

// Read-only CloudWatch metrics (Monitoring tab) and the IAM calls needed to pick or create an execution role.
export const CW_COMMANDS = new Set(['GetMetricData']);
export const IAM_COMMANDS = new Set(['ListRoles', 'GetRole', 'CreateRole', 'AttachRolePolicy', 'ListAttachedRolePolicies', 'ListRolePolicies']);

const MAX_TEXT_FILE = 1024 * 1024; // files larger than this are listed but not sent to the editor
const MAX_TEXT_TOTAL = 10 * 1024 * 1024;
const MAX_DIRECT_ZIP = 50 * 1024 * 1024; // UpdateFunctionCode ZipFile limit

export function lambdaClientConfig(base, r) {
  const cfg = { ...base };
  delete cfg.endpoint;
  if (r.kind === 'endpoint') cfg.endpoint = r.lambdaEndpoint || r.endpoint;
  return cfg;
}

// IAM is global: the regional endpoint is irrelevant, but emulators serve it on the Lambda endpoint.
export function iamClientConfig(base, r) {
  const cfg = lambdaClientConfig(base, r);
  if (r.kind !== 'endpoint') cfg.region = 'us-east-1';
  return cfg;
}

/** Deployment packages travel as base64 strings in JSON. */
export function reviveLambdaInput(op, input = {}) {
  const out = { ...input };
  if (op === 'CreateFunction' && typeof out.Code?.ZipFile === 'string') out.Code = { ...out.Code, ZipFile: Buffer.from(out.Code.ZipFile, 'base64') };
  if (op === 'UpdateFunctionCode' && typeof out.ZipFile === 'string') out.ZipFile = Buffer.from(out.ZipFile, 'base64');
  if (op === 'PublishLayerVersion' && typeof out.Content?.ZipFile === 'string') out.Content = { ...out.Content, ZipFile: Buffer.from(out.Content.ZipFile, 'base64') };
  return out;
}

/** CloudWatch wants Date objects for the time range. */
export function reviveCwInput(input = {}) {
  const out = { ...input };
  for (const k of ['StartTime', 'EndTime']) if (out[k] !== undefined) out[k] = new Date(out[k]);
  return out;
}

// --- ZIP (deployment packages) ------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Reads every entry of a zip file. Entries keep their unix mode (an executable `bootstrap` must stay executable). */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new HttpError(422, 'InvalidZip', 'The deployment package is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new HttpError(422, 'InvalidZip', 'ZIP64 packages are not supported');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new HttpError(422, 'InvalidZip', 'Corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + compressedSize);
    let data;
    if (name.endsWith('/')) data = Buffer.alloc(0);
    else if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new HttpError(422, 'InvalidZip', `Unsupported compression method ${method} for ${name}`);
    entries.push({ name, data, size, mode: externalAttrs >>> 16 });
  }
  return entries;
}

/** Writes a deflated zip. `entries` = [{ name, data: Buffer, mode? }]. */
export function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const dir = e.name.endsWith('/');
    const data = dir ? Buffer.alloc(0) : e.data;
    const comp = dir ? data : zlib.deflateRawSync(data);
    const crc = crc32(data);
    const method = dir ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const mode = e.mode || (dir ? 0o40755 : 0o100644);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x031e, 4); // made by unix, spec 3.0
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** Text files go to the editor; binaries and big files are listed only. */
export const isText = (data) => data.length <= MAX_TEXT_FILE && !data.includes(0) && Buffer.from(data.toString('utf8'), 'utf8').equals(data);

/**
 * Applies editor changes to zip entries: `changes` maps path -> new text, or null to delete the file.
 * New paths are added. Paths must be relative and must not escape the package.
 */
export function applyChanges(entries, changes = {}) {
  const out = entries.map((e) => ({ ...e }));
  for (const [path, text] of Object.entries(changes)) {
    if (!path || path.startsWith('/') || path.split('/').includes('..') || path.endsWith('/')) throw new HttpError(400, 'InvalidPath', `Invalid file path "${path}"`);
    const i = out.findIndex((e) => e.name === path);
    if (text === null) {
      if (i >= 0) out.splice(i, 1);
    } else if (i >= 0) out[i] = { ...out[i], data: Buffer.from(String(text), 'utf8') };
    else out.push({ name: path, data: Buffer.from(String(text), 'utf8') });
  }
  return out;
}

/**
 * URLs to try for Code.Location. Emulators hand out URLs on a host name that only resolves inside their network,
 * so for custom endpoints also try the same path on the endpoint, and path-style for virtual-hosted S3 URLs.
 */
export function codeUrls(location, r) {
  const urls = [location];
  const base = r.kind === 'endpoint' && (r.lambdaEndpoint || r.endpoint);
  if (!base) return urls;
  const u = new URL(location);
  const b = new URL(base);
  const swapped = new URL(location);
  swapped.protocol = b.protocol;
  swapped.host = b.host;
  urls.push(swapped.toString());
  const bucket = u.hostname.match(/^(.+?)\.s3[.-]/)?.[1];
  if (bucket) urls.push(`${b.origin}/${bucket}${u.pathname}${u.search}`);
  return [...new Set(urls)];
}

/**
 * Lambda routes. Same contract as s3Routes / sqsRoutes: `resolve(raw)` turns the x-conn header into a connection,
 * `config(r)` builds the base SDK config, `serialize(out)` makes SDK output JSON safe.
 */
export function lambdaRoutes({ resolve, config, serialize, fetchImpl = globalThis.fetch }) {
  const clients = new Map();
  const router = express.Router();

  const clientsFor = (r) => {
    if (!clients.has(r.key)) {
      const base = config(r);
      clients.set(r.key, {
        lambda: new LAMBDA.LambdaClient(lambdaClientConfig(base, r)),
        cw: new CW.CloudWatchClient(lambdaClientConfig(base, r)),
        iam: new IAM.IAMClient(iamClientConfig(base, r)),
      });
    }
    return clients.get(r.key);
  };
  const conn = (req) => resolve(req.get('x-conn') || req.query.conn);

  // Emulators answer unknown actions with an HTML page, which the SDK reports as a deserialization error.
  const send = async (client, command, op) => {
    try {
      return await client.send(command);
    } catch (e) {
      if (e.name === 'SyntaxError' && /Deserialization error/.test(e.message)) {
        throw new HttpError(501, 'NotSupported', `${op} is not supported by this endpoint`);
      }
      throw e;
    }
  };

  const timed = (res, started, out) => {
    res.set('x-elapsed-ms', String(Date.now() - started));
    res.json(serialize(out));
  };

  router.post('/op/:op', async (req, res) => {
    const op = req.params.op;
    if (!LAMBDA_COMMANDS.has(op)) throw new HttpError(404, 'UnknownOperation', `Operation ${op} is not supported`);
    const r = await conn(req);
    const started = Date.now();
    timed(res, started, await send(clientsFor(r).lambda, new LAMBDA[`${op}Command`](reviveLambdaInput(op, req.body || {})), op));
  });

  router.post('/cw/:op', async (req, res) => {
    const op = req.params.op;
    if (!CW_COMMANDS.has(op)) throw new HttpError(404, 'UnknownOperation', `Operation ${op} is not supported`);
    const r = await conn(req);
    const started = Date.now();
    timed(res, started, await send(clientsFor(r).cw, new CW[`${op}Command`](reviveCwInput(req.body || {})), op));
  });

  router.post('/iam/:op', async (req, res) => {
    const op = req.params.op;
    if (!IAM_COMMANDS.has(op)) throw new HttpError(404, 'UnknownOperation', `Operation ${op} is not supported`);
    const r = await conn(req);
    const started = Date.now();
    timed(res, started, await send(clientsFor(r).iam, new IAM[`${op}Command`](req.body || {}), op));
  });

  // Invoke: the payload goes in as text and comes back as text; the 4 KB log tail is decoded too.
  router.post('/invoke', async (req, res) => {
    const { FunctionName, Qualifier, InvocationType = 'RequestResponse', Payload = '', ClientContext } = req.body || {};
    if (!FunctionName) throw new HttpError(400, 'InvalidInput', 'FunctionName is required');
    const r = await conn(req);
    const started = Date.now();
    const out = await clientsFor(r).lambda.send(
      new LAMBDA.InvokeCommand({
        FunctionName,
        InvocationType,
        LogType: InvocationType === 'RequestResponse' ? 'Tail' : 'None',
        Payload: Buffer.from(typeof Payload === 'string' ? Payload : JSON.stringify(Payload), 'utf8'),
        ...(Qualifier ? { Qualifier } : {}),
        ...(ClientContext ? { ClientContext: Buffer.from(JSON.stringify(ClientContext)).toString('base64') } : {}),
      }),
    );
    res.set('x-elapsed-ms', String(Date.now() - started));
    res.json({
      StatusCode: out.StatusCode,
      FunctionError: out.FunctionError,
      ExecutedVersion: out.ExecutedVersion,
      Payload: out.Payload ? Buffer.from(out.Payload).toString('utf8') : '',
      LogResult: out.LogResult ? Buffer.from(out.LogResult, 'base64').toString('utf8') : '',
      RequestId: out.$metadata?.requestId,
    });
  });

  // --- Deployment package -----------------------------------------------------------------------
  async function fetchPackage(r, FunctionName, Qualifier) {
    const fn = await clientsFor(r).lambda.send(new LAMBDA.GetFunctionCommand({ FunctionName, ...(Qualifier ? { Qualifier } : {}) }));
    if (fn.Configuration?.PackageType === 'Image') throw new HttpError(400, 'ImageFunction', 'Container image functions have no zip package');
    const location = fn.Code?.Location;
    if (!location) throw new HttpError(404, 'NoCode', 'The function has no downloadable code');
    let failure;
    for (const url of codeUrls(location, r)) {
      try {
        const resp = await fetchImpl(url);
        if (resp.ok) return { fn, zip: Buffer.from(await resp.arrayBuffer()) };
        failure = `HTTP ${resp.status}`;
      } catch (e) {
        failure = e.cause?.code || e.message;
      }
    }
    throw new HttpError(502, 'CodeDownloadFailed', `Downloading the code failed (${failure})`);
  }

  // Lists the files of the package; text files (up to 1 MB each, 10 MB in total) include their content.
  router.post('/code/files', async (req, res) => {
    const { FunctionName, Qualifier } = req.body || {};
    if (!FunctionName) throw new HttpError(400, 'InvalidInput', 'FunctionName is required');
    const r = await conn(req);
    const { fn, zip } = await fetchPackage(r, FunctionName, Qualifier);
    let budget = MAX_TEXT_TOTAL;
    const files = readZip(zip)
      .filter((e) => !e.name.endsWith('/'))
      .map((e) => {
        const text = budget > 0 && isText(e.data);
        if (text) budget -= e.data.length;
        return { path: e.name, size: e.data.length, mode: e.mode, ...(text ? { content: e.data.toString('utf8') } : { binary: true }) };
      });
    res.json({ files, codeSha256: fn.Configuration?.CodeSha256, codeSize: zip.length, truncated: budget <= 0 });
  });

  // Applies edits to the current package and deploys it. Refuses when the code changed since it was loaded.
  router.post('/code/deploy', async (req, res) => {
    const { FunctionName, changes, expectedSha256, Publish } = req.body || {};
    if (!FunctionName) throw new HttpError(400, 'InvalidInput', 'FunctionName is required');
    const r = await conn(req);
    const { fn, zip } = await fetchPackage(r, FunctionName);
    if (expectedSha256 && fn.Configuration?.CodeSha256 && expectedSha256 !== fn.Configuration.CodeSha256) {
      throw new HttpError(409, 'CodeChanged', 'The function code was changed by someone else since you opened it. Reload the code and apply your edits again.');
    }
    const next = writeZip(applyChanges(readZip(zip), changes));
    if (next.length > MAX_DIRECT_ZIP) throw new HttpError(413, 'PackageTooLarge', 'The package is larger than 50 MB; upload it through S3 instead');
    const out = await clientsFor(r).lambda.send(
      new LAMBDA.UpdateFunctionCodeCommand({ FunctionName, ZipFile: next, ...(Publish ? { Publish: true } : {}), ...(fn.Configuration?.Architectures ? { Architectures: fn.Configuration.Architectures } : {}) }),
    );
    res.json(serialize(out));
  });

  // Builds a zip from files sent by the UI (create a function from inline code). Returns base64.
  router.post('/code/zip', async (req, res) => {
    const files = req.body?.files || {};
    if (!Object.keys(files).length) throw new HttpError(400, 'InvalidInput', 'At least one file is required');
    const zip = writeZip(applyChanges([], files));
    res.json({ ZipFile: zip.toString('base64'), size: zip.length });
  });

  // Download the deployment package. GET so it works from <a href>; the connection comes in ?conn=.
  router.get('/code/download', async (req, res) => {
    const { name, qualifier } = req.query;
    if (!name) throw new HttpError(400, 'InvalidInput', 'name is required');
    const r = await conn(req);
    const { zip } = await fetchPackage(r, String(name), qualifier ? String(qualifier) : undefined);
    res.set('content-type', 'application/zip');
    res.set('content-disposition', `attachment; filename="${String(name).replace(/[^\w.-]/g, '_')}.zip"`);
    res.send(zip);
  });

  return {
    router,
    listFunctions: (r) => clientsFor(r).lambda.send(new LAMBDA.ListFunctionsCommand({ MaxItems: 50 })),
    clear: () => clients.clear(),
  };
}
