import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as DDB from '@aws-sdk/client-dynamodb';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromIni } from '@aws-sdk/credential-providers';
import { listProfiles, saveProfile, deleteProfile, getProfileRegion, HttpError, awsPaths } from './profiles.js';
import { readJson, writeJson, exists, newId, listModels, getModel, saveModel, deleteModel, dataDir } from './store.js';
import { s3Routes } from './s3.js';
import { logsRoutes } from './logs.js';
import { sqsRoutes } from './sqs.js';
import { lambdaRoutes } from './lambda.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ALLOWED_COMMANDS = new Set([
  'ListTables', 'DescribeTable', 'CreateTable', 'DeleteTable', 'UpdateTable',
  'DescribeTimeToLive', 'UpdateTimeToLive', 'DescribeContinuousBackups', 'UpdateContinuousBackups',
  'GetItem', 'PutItem', 'UpdateItem', 'DeleteItem', 'Query', 'Scan',
  'BatchGetItem', 'BatchWriteItem', 'TransactGetItems', 'TransactWriteItems',
  'ExecuteStatement', 'BatchExecuteStatement', 'ExecuteTransaction',
  'ListTagsOfResource', 'TagResource', 'UntagResource',
  'CreateBackup', 'ListBackups', 'DescribeBackup', 'DeleteBackup', 'RestoreTableFromBackup',
  'DescribeLimits', 'DescribeEndpoints', 'ListGlobalTables', 'DescribeGlobalTable',
  'DescribeContributorInsights', 'UpdateContributorInsights', 'DescribeKinesisStreamingDestination',
  'ListExports', 'DescribeExport', 'ListImports', 'DescribeImport', 'DescribeTableReplicaAutoScaling',
]);

// --- Binary (base64) <-> Uint8Array conversion for AttributeValues ---------------
export function reviveInput(node) {
  if (Array.isArray(node)) return node.map(reviveInput);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'B' && typeof v === 'string') out[k] = Buffer.from(v, 'base64');
      else if (k === 'BS' && Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        out[k] = v.map((x) => Buffer.from(x, 'base64'));
      } else out[k] = reviveInput(v);
    }
    return out;
  }
  return node;
}

export function serializeOutput(node) {
  if (node instanceof Uint8Array) return Buffer.from(node).toString('base64');
  if (node instanceof Date) return node.toISOString();
  if (Array.isArray(node)) return node.map(serializeOutput);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) if (k !== '$metadata') out[k] = serializeOutput(v);
    return out;
  }
  return node;
}

export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function parseAllowedHosts(value) {
  return (value || 'localhost,127.0.0.1,[::1]')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const listEndpoints = () => readJson('connections.json', []);

export async function resolveConn(raw) {
  if (!raw) throw new HttpError(400, 'NoConnection', 'Select a connection first');
  let c;
  try {
    c = JSON.parse(decodeURIComponent(raw));
  } catch {
    throw new HttpError(400, 'BadConnection', 'Invalid connection header');
  }
  if (c.kind === 'endpoint') {
    const s = (await listEndpoints()).find((x) => x.id === c.id);
    if (!s) throw new HttpError(404, 'ConnectionNotFound', 'Endpoint connection not found');
    return { ...s, kind: 'endpoint', key: `e:${s.id}:${s.updatedAt}`, region: s.region || 'us-east-1' };
  }
  if (c.kind === 'profile') {
    if (!c.profile) throw new HttpError(400, 'BadConnection', 'Missing profile');
    const region = c.region || (await getProfileRegion(c.profile)) || process.env.AWS_REGION || 'us-east-1';
    return { kind: 'profile', key: `p:${c.profile}:${region}`, profile: c.profile, region };
  }
  if (c.kind === 'default') {
    const region = c.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    return { kind: 'default', key: `d:${region}`, region };
  }
  throw new HttpError(400, 'BadConnection', `Unknown connection kind "${c.kind}"`);
}

export function clientConfig(r) {
  const cfg = { region: r.region, maxAttempts: 3 };
  if (r.endpoint) cfg.endpoint = r.endpoint;
  if (r.kind === 'profile' || (r.kind === 'endpoint' && r.authMode === 'profile' && r.profile)) {
    const p = awsPaths(); // honour AWS_DIR, not only the SDK's default ~/.aws
    cfg.credentials = fromIni({ profile: r.profile, filepath: p.credentials, configFilepath: p.config, ignoreCache: true });
  } else if (r.kind === 'endpoint') {
    cfg.credentials =
      r.authMode === 'keys'
        ? { accessKeyId: r.accessKeyId || '', secretAccessKey: r.secretAccessKey || '' }
        : { accessKeyId: 'local', secretAccessKey: 'local' };
  }
  return cfg;
}

const maskEndpoint = ({ secretAccessKey, ...rest }) => ({ ...rest, hasSecret: Boolean(secretAccessKey) });

export function cleanEndpoint(body, old = {}) {
  const endpoint = String(body.endpoint || '').trim();
  if (!/^https?:\/\/.+/i.test(endpoint)) throw new HttpError(400, 'InvalidEndpoint', 'Endpoint must be an http(s) URL');
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(400, 'InvalidName', 'Name is required');
  const s3Endpoint = String(body.s3Endpoint || '').trim();
  if (s3Endpoint && !/^https?:\/\/.+/i.test(s3Endpoint)) throw new HttpError(400, 'InvalidEndpoint', 'S3 endpoint must be an http(s) URL');
  const logsEndpoint = String(body.logsEndpoint || '').trim();
  if (logsEndpoint && !/^https?:\/\/.+/i.test(logsEndpoint)) throw new HttpError(400, 'InvalidEndpoint', 'CloudWatch Logs endpoint must be an http(s) URL');
  const sqsEndpoint = String(body.sqsEndpoint || '').trim();
  if (sqsEndpoint && !/^https?:\/\/.+/i.test(sqsEndpoint)) throw new HttpError(400, 'InvalidEndpoint', 'SQS endpoint must be an http(s) URL');
  const lambdaEndpoint = String(body.lambdaEndpoint || '').trim();
  if (lambdaEndpoint && !/^https?:\/\/.+/i.test(lambdaEndpoint)) throw new HttpError(400, 'InvalidEndpoint', 'Lambda endpoint must be an http(s) URL');
  const authMode = ['local', 'keys', 'profile'].includes(body.authMode) ? body.authMode : 'local';
  return {
    name,
    endpoint,
    s3Endpoint,
    logsEndpoint,
    sqsEndpoint,
    lambdaEndpoint,
    region: String(body.region || 'us-east-1').trim(),
    authMode,
    profile: authMode === 'profile' ? String(body.profile || '') : '',
    accessKeyId: authMode === 'keys' ? String(body.accessKeyId || '') : '',
    secretAccessKey: authMode === 'keys' ? String(body.secretAccessKey || '') || old.secretAccessKey || '' : '',
    updatedAt: Date.now(),
  };
}

// Seed endpoint connections on first start, e.g. DEFAULT_ENDPOINTS="DynamoDB Local=http://dynamodb-local:8000"
export async function seed(value = process.env.DEFAULT_ENDPOINTS) {
  if (!value || (await exists('connections.json'))) return false;
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('='))
    .map((s) => {
      const i = s.indexOf('=');
      return { id: newId(), name: s.slice(0, i).trim(), endpoint: s.slice(i + 1).trim(), region: 'us-east-1', authMode: 'local', profile: '', accessKeyId: '', secretAccessKey: '', updatedAt: Date.now() };
    });
  await writeJson('connections.json', list);
  return true;
}

export function createApp(options = {}) {
  const {
    username = process.env.APP_USERNAME || 'admin',
    password = process.env.APP_PASSWORD,
    allowedHosts = parseAllowedHosts(process.env.ALLOWED_HOSTS),
    staticDir = process.env.STATIC_DIR || path.resolve(__dirname, '../../web/dist'),
  } = options;

  const app = express();
  app.disable('x-powered-by');

  // --- Security -------------------------------------------------------------
  // Host allow-list protects against DNS-rebinding (a malicious site resolving to 127.0.0.1).
  app.use((req, res, next) => {
    if (allowedHosts.includes('*') || req.path === '/api/health') return next();
    const host = String(req.headers.host || '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    if (allowedHosts.includes(host)) return next();
    res.status(403).send(`Host "${host}" is not allowed. Add it to ALLOWED_HOSTS.`);
  });

  if (password) {
    app.use((req, res, next) => {
      if (req.path === '/api/health') return next();
      const raw = Buffer.from(String(req.headers.authorization || '').replace(/^Basic\s+/i, ''), 'base64').toString();
      const i = raw.indexOf(':');
      if (i > 0 && safeEqual(raw.slice(0, i), username) && safeEqual(raw.slice(i + 1), password)) return next();
      res.set('WWW-Authenticate', 'Basic realm="DynamoDB Studio"').status(401).send('Authentication required');
    });
  }

  // Custom header forces a CORS preflight, so other origins cannot fire state-changing requests (CSRF).
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'dynamodb-studio') {
      return res.status(403).json({ error: 'Forbidden', message: 'Missing X-Requested-With header' });
    }
    next();
  });
  app.use(express.json({ limit: '100mb' }));

  // --- Connections ------------------------------------------------------------
  const clients = new Map();
  const s3 = s3Routes({ resolve: resolveConn, config: clientConfig, serialize: serializeOutput });
  const logs = logsRoutes({ resolve: resolveConn, config: clientConfig, serialize: serializeOutput });
  const sqs = sqsRoutes({ resolve: resolveConn, config: clientConfig, serialize: serializeOutput });
  const lambda = lambdaRoutes({ resolve: resolveConn, config: clientConfig, serialize: serializeOutput, fetchImpl: options.fetchImpl });
  const invalidateClients = () => {
    clients.clear();
    s3.clear();
    logs.clear();
    sqs.clear();
    lambda.clear();
  };

  async function getClient(req) {
    const r = await resolveConn(req.get('x-conn'));
    if (!clients.has(r.key)) {
      const cfg = clientConfig(r);
      clients.set(r.key, { r, cfg, ddb: new DDB.DynamoDBClient(cfg) });
    }
    return clients.get(r.key);
  }

  // --- Routes -------------------------------------------------------------------
  const api = express.Router();

  api.get('/health', (req, res) => res.json({ ok: true }));

  api.get('/info', (req, res) => {
    const p = awsPaths();
    let writable = false;
    try {
      fs.accessSync(p.dir, fs.constants.W_OK);
      writable = true;
    } catch {
      /* read-only or missing */
    }
    res.json({ awsDir: p.dir, configFile: p.config, credentialsFile: p.credentials, awsDirWritable: writable, dataDir: dataDir() });
  });

  api.get('/profiles', async (req, res) => res.json(await listProfiles()));
  api.post('/profiles', async (req, res) => {
    await saveProfile(req.body.name, req.body.settings);
    invalidateClients();
    res.json({ ok: true });
  });
  api.put('/profiles/:name', async (req, res) => {
    await saveProfile(req.body.name ?? req.params.name, req.body.settings, req.params.name);
    invalidateClients();
    res.json({ ok: true });
  });
  api.delete('/profiles/:name', async (req, res) => {
    await deleteProfile(req.params.name);
    invalidateClients();
    res.json({ ok: true });
  });

  api.get('/connections', async (req, res) => res.json((await listEndpoints()).map(maskEndpoint)));
  api.post('/connections', async (req, res) => {
    const list = await listEndpoints();
    const item = { id: newId(), ...cleanEndpoint(req.body) };
    list.push(item);
    await writeJson('connections.json', list);
    res.json(maskEndpoint(item));
  });
  api.put('/connections/:id', async (req, res) => {
    const list = await listEndpoints();
    const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) throw new HttpError(404, 'ConnectionNotFound', 'Connection not found');
    list[i] = { id: list[i].id, ...cleanEndpoint(req.body, list[i]) };
    await writeJson('connections.json', list);
    invalidateClients();
    res.json(maskEndpoint(list[i]));
  });
  api.delete('/connections/:id', async (req, res) => {
    const list = (await listEndpoints()).filter((x) => x.id !== req.params.id);
    await writeJson('connections.json', list);
    invalidateClients();
    res.json({ ok: true });
  });

  api.post('/test', async (req, res) => {
    const c = await getClient(req);
    const out = { region: c.r.region, endpoint: c.r.endpoint || null };
    if (c.r.kind !== 'endpoint') {
      const sts = new STSClient({ region: c.cfg.region, credentials: c.cfg.credentials });
      const id = await sts.send(new GetCallerIdentityCommand({}));
      out.identity = { account: id.Account, arn: id.Arn, userId: id.UserId };
    }
    if (req.body?.service === 'logs') {
      const g = await logs.listGroups(c.r);
      out.logGroupCount = (g.logGroups || []).length;
      out.more = Boolean(g.nextToken);
      return res.json(out);
    }
    if (req.body?.service === 'sqs') {
      const q = await sqs.listQueues(c.r);
      out.queueCount = (q.QueueUrls || []).length;
      out.more = Boolean(q.NextToken);
      return res.json(out);
    }
    if (req.body?.service === 'lambda') {
      const f = await lambda.listFunctions(c.r);
      out.functionCount = (f.Functions || []).length;
      out.more = Boolean(f.NextMarker);
      return res.json(out);
    }
    if (req.body?.service === 's3') {
      out.bucketCount = ((await s3.listBuckets(c.r)).Buckets || []).length;
      return res.json(out);
    }
    try {
      const t = await c.ddb.send(new DDB.ListTablesCommand({ Limit: 100 }));
      out.tableCount = t.TableNames.length;
      out.more = Boolean(t.LastEvaluatedTableName);
    } catch (e) {
      // A custom endpoint may be S3-only (MinIO, s3rver): accept it if S3 answers.
      if (c.r.kind !== 'endpoint') throw e;
      try {
        out.bucketCount = ((await s3.listBuckets(c.r)).Buckets || []).length;
        out.dynamodb = false;
      } catch {
        throw e;
      }
    }
    res.json(out);
  });

  api.post('/ddb/:op', async (req, res) => {
    const op = req.params.op;
    if (!ALLOWED_COMMANDS.has(op)) throw new HttpError(404, 'UnknownOperation', `Operation ${op} is not supported`);
    const c = await getClient(req);
    const started = Date.now();
    const out = await c.ddb.send(new DDB[`${op}Command`](reviveInput(req.body || {})));
    res.set('x-elapsed-ms', String(Date.now() - started));
    res.json(serializeOutput(out));
  });

  api.use('/s3', s3.router);
  api.use('/logs', logs.router);
  api.use('/sqs', sqs.router);
  api.use('/lambda', lambda.router);

  api.get('/models', async (req, res) => res.json(await listModels()));
  api.get('/models/:id', async (req, res) => res.json(await getModel(req.params.id)));
  api.post('/models', async (req, res) => {
    const id = newId();
    await saveModel(id, req.body);
    res.json({ id });
  });
  api.put('/models/:id', async (req, res) => {
    await saveModel(req.params.id, req.body);
    res.json({ ok: true });
  });
  api.delete('/models/:id', async (req, res) => {
    await deleteModel(req.params.id);
    res.json({ ok: true });
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'NotFound', message: 'Unknown API route' }));

  // --- Static frontend ------------------------------------------------------------
  app.use(express.static(staticDir, { index: 'index.html', maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(staticDir, 'index.html'), (err) => err && next());
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || err.$metadata?.httpStatusCode || 500;
    if (status < 400 || status > 599) status = 500;
    if (status >= 500 && process.env.NODE_ENV !== 'test') console.error(err);
    res.status(status).json({
      error: err.name || 'Error',
      message: err.message || String(err),
      cancellationReasons: err.CancellationReasons,
    });
  });

  return app;
}
