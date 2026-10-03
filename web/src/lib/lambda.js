import { api, getConn } from '../api.js';

export const lambda = (op, input = {}) => api(`/api/lambda/op/${op}`, { method: 'POST', body: input });
export const lambdaCw = (op, input = {}) => api(`/api/lambda/cw/${op}`, { method: 'POST', body: input });
export const lambdaIam = (op, input = {}) => api(`/api/lambda/iam/${op}`, { method: 'POST', body: input });
export const invokeFunction = (input) => api('/api/lambda/invoke', { method: 'POST', body: input });
export const codeFiles = (FunctionName, Qualifier) => api('/api/lambda/code/files', { method: 'POST', body: { FunctionName, ...(Qualifier ? { Qualifier } : {}) } });
export const deployCode = (input) => api('/api/lambda/code/deploy', { method: 'POST', body: input });
export const zipFiles = async (files) => (await api('/api/lambda/code/zip', { method: 'POST', body: { files } })).ZipFile;

export function codeDownloadUrl(name, qualifier) {
  const q = new URLSearchParams({ name });
  if (qualifier) q.set('qualifier', qualifier);
  const c = getConn();
  if (c) q.set('conn', encodeURIComponent(JSON.stringify(c)));
  return `/api/lambda/code/download?${q}`;
}

// --- Names, ARNs, paths -----------------------------------------------------------------------
export const lambdaPath = (name, tab) => (name ? `/lambda/function/${encodeURIComponent(name)}${tab ? `?tab=${tab}` : ''}` : '/lambda');
export const FUNCTION_NAME_RE = /^[a-zA-Z0-9-_]{1,64}$/;

/** "arn:aws:lambda:r:1:function:name:alias" -> "name". Plain names pass through. */
export const fnNameFromArn = (arn) => {
  const p = String(arn || '').split(':');
  return p.length >= 7 && p[5] === 'function' ? p[6] : String(arn || '');
};
export const arnTail = (arn) => String(arn || '').split(':').pop().split('/').pop();
export const roleNameFromArn = (arn) => String(arn || '').split('/').pop();

/** Service of an event source ARN: sqs, kinesis, dynamodb, kafka, mq, docdb… */
export function sourceService(arn) {
  const p = String(arn || '').split(':');
  if (p[2] === 'dynamodb') return 'dynamodb';
  return p[2] || 'unknown';
}

/** Readable name of an event source ARN (queue, stream, table/stream). */
export function sourceLabel(arn) {
  const s = String(arn || '');
  const svc = sourceService(s);
  if (svc === 'dynamodb') return s.split(':table/').pop().split('/stream/')[0];
  if (svc === 'kinesis') return s.split(':stream/').pop();
  return arnTail(s);
}

export const logGroupOf = (cfg = {}) => cfg.LoggingConfig?.LogGroup || `/aws/lambda/${cfg.FunctionName}`;

// --- Listing -------------------------------------------------------------------------------------
export async function listAllFunctions({ max = 5000 } = {}) {
  const fns = [];
  let Marker;
  do {
    const out = await lambda('ListFunctions', { MaxItems: 50, ...(Marker ? { Marker } : {}) });
    fns.push(...(out.Functions || []));
    Marker = out.NextMarker;
  } while (Marker && fns.length < max);
  return { functions: fns.sort((a, b) => a.FunctionName.localeCompare(b.FunctionName)), more: Boolean(Marker) };
}

export async function listAll(op, input, key, markerIn = 'Marker', markerOut = 'NextMarker', max = 1000) {
  const items = [];
  let m;
  do {
    const out = await lambda(op, { ...input, ...(m ? { [markerIn]: m } : {}) });
    items.push(...(out[key] || []));
    m = out[markerOut];
  } while (m && items.length < max);
  return items;
}

// --- Formatting -----------------------------------------------------------------------------------
export function fmtBytes(b) {
  const n = Number(b);
  if (b === undefined || b === null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export const fmtMemory = (mb) => (mb ? (mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`) : '—');

export function fmtTimeout(sec) {
  const n = Number(sec);
  if (!n) return '—';
  if (n < 60) return `${n} s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

export const fmtMs = (ms) => (ms === undefined || ms === null || Number.isNaN(Number(ms)) ? '—' : Number(ms) >= 1000 ? `${(Number(ms) / 1000).toFixed(2)} s` : `${Number(ms).toFixed(Number(ms) < 10 ? 2 : Number(ms) < 100 ? 1 : 0)} ms`);

export const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—');

/** "2024-01-01T00:00:00.000+0000" -> Date (Lambda's LastModified format is not ISO in every browser). */
export const parseLastModified = (s) => (s ? new Date(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : null);

/** Badge for the function state / last update status. */
export function stateOf(cfg = {}) {
  if (cfg.State && cfg.State !== 'Active') return { label: cfg.State, kind: cfg.State === 'Failed' ? 'bad' : cfg.State === 'Inactive' ? 'muted' : 'warn', reason: cfg.StateReason };
  if (cfg.LastUpdateStatus === 'InProgress') return { label: 'Updating', kind: 'warn' };
  if (cfg.LastUpdateStatus === 'Failed') return { label: 'Update failed', kind: 'bad', reason: cfg.LastUpdateStatusReason };
  return { label: cfg.State || 'Active', kind: 'ok' };
}

// --- Invocation log -------------------------------------------------------------------------------
/** Parses the REPORT line of a log tail. */
export function parseReport(text) {
  const line = String(text || '').split('\n').find((l) => l.startsWith('REPORT '));
  if (!line) return null;
  const num = (re) => {
    const m = line.match(re);
    return m ? Number(m[1]) : undefined;
  };
  return {
    requestId: (line.match(/RequestId: (\S+)/) || [])[1],
    duration: num(/\bDuration: ([\d.]+) ms/),
    billed: num(/Billed Duration: ([\d.]+) ms/),
    memorySize: num(/Memory Size: (\d+) MB/),
    maxMemory: num(/Max Memory Used: (\d+) MB/),
    initDuration: num(/Init Duration: ([\d.]+) ms/),
  };
}

export function prettyJson(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

export const isJson = (text) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// --- Runtimes and starter code ------------------------------------------------------------------
// [runtime, label]; deprecated runtimes still show up for existing functions.
export const RUNTIMES = [
  ['nodejs22.x', 'Node.js 22.x'],
  ['nodejs20.x', 'Node.js 20.x'],
  ['python3.13', 'Python 3.13'],
  ['python3.12', 'Python 3.12'],
  ['python3.11', 'Python 3.11'],
  ['java21', 'Java 21'],
  ['java17', 'Java 17'],
  ['dotnet8', '.NET 8'],
  ['ruby3.3', 'Ruby 3.3'],
  ['provided.al2023', 'Amazon Linux 2023 (custom runtime)'],
  ['provided.al2', 'Amazon Linux 2 (custom runtime)'],
];

export const runtimeFamily = (rt = '') =>
  rt.startsWith('nodejs') ? 'node' : rt.startsWith('python') ? 'python' : rt.startsWith('java') ? 'java' : rt.startsWith('dotnet') ? 'dotnet' : rt.startsWith('ruby') ? 'ruby' : rt.startsWith('provided') ? 'custom' : 'other';

/** Inline starter code for a runtime: { handler, files } or null when the runtime needs a build (Java, .NET). */
export function starterCode(runtime) {
  switch (runtimeFamily(runtime)) {
    case 'node':
      return {
        handler: 'index.handler',
        files: {
          'index.mjs': `export const handler = async (event, context) => {\n  console.log('event', JSON.stringify(event));\n  return {\n    statusCode: 200,\n    body: JSON.stringify({ message: 'Hello from Lambda!' }),\n  };\n};\n`,
        },
      };
    case 'python':
      return {
        handler: 'lambda_function.lambda_handler',
        files: {
          'lambda_function.py': `import json\n\n\ndef lambda_handler(event, context):\n    print(json.dumps(event))\n    return {\n        "statusCode": 200,\n        "body": json.dumps({"message": "Hello from Lambda!"}),\n    }\n`,
        },
      };
    case 'ruby':
      return {
        handler: 'lambda_function.lambda_handler',
        files: { 'lambda_function.rb': `require 'json'\n\ndef lambda_handler(event:, context:)\n  puts event.to_json\n  { statusCode: 200, body: JSON.generate(message: 'Hello from Lambda!') }\nend\n` },
      };
    case 'custom':
      return {
        handler: 'function.handler',
        files: {
          bootstrap: `#!/bin/sh\nset -euo pipefail\nwhile true; do\n  HEADERS="$(mktemp)"\n  EVENT=$(curl -sS -LD "$HEADERS" "http://\${AWS_LAMBDA_RUNTIME_API}/2018-06-01/runtime/invocation/next")\n  REQUEST_ID=$(grep -Fi Lambda-Runtime-Aws-Request-Id "$HEADERS" | tr -d '[:space:]' | cut -d: -f2)\n  curl -sS -X POST "http://\${AWS_LAMBDA_RUNTIME_API}/2018-06-01/runtime/invocation/$REQUEST_ID/response" -d '{"message":"Hello from Lambda!"}'\ndone\n`,
        },
      };
    default:
      return null;
  }
}

// --- Configuration validation ------------------------------------------------------------------
export const LIMITS = {
  memory: [128, 10240],
  timeout: [1, 900],
  storage: [512, 10240],
};

export function configErrors({ MemorySize, Timeout, EphemeralStorage }) {
  const errs = {};
  const check = (k, v, [min, max], label) => {
    if (v === undefined || v === '') return;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) errs[k] = `${label} must be an integer between ${min} and ${max}`;
  };
  check('MemorySize', MemorySize, LIMITS.memory, 'Memory');
  check('Timeout', Timeout, LIMITS.timeout, 'Timeout');
  check('EphemeralStorage', EphemeralStorage, LIMITS.storage, 'Ephemeral storage');
  return errs;
}

// Set by Lambda itself; a function cannot override them.
export const RESERVED_ENV = new Set([
  '_HANDLER', '_X_AMZN_TRACE_ID', 'AWS_DEFAULT_REGION', 'AWS_REGION', 'AWS_EXECUTION_ENV', 'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_LAMBDA_FUNCTION_MEMORY_SIZE', 'AWS_LAMBDA_FUNCTION_VERSION', 'AWS_LAMBDA_INITIALIZATION_TYPE', 'AWS_LAMBDA_LOG_GROUP_NAME',
  'AWS_LAMBDA_LOG_STREAM_NAME', 'AWS_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_LAMBDA_RUNTIME_API', 'LAMBDA_TASK_ROOT', 'LAMBDA_RUNTIME_DIR',
]);

/** Editor rows [{ key, value }] -> Variables map. Throws on invalid rows (4 KB limit in total). */
export function envFromRows(rows = []) {
  const out = {};
  for (const r of rows) {
    const key = String(r.key || '').trim();
    if (!key && !r.value) continue;
    if (!key) throw new Error('Environment variable name is required');
    if (!/^[a-zA-Z]\w+$/.test(key)) throw new Error(`Invalid environment variable name "${key}": use 2+ characters, a letter then letters, digits or _`);
    if (RESERVED_ENV.has(key)) throw new Error(`"${key}" is reserved by Lambda`);
    if (key in out) throw new Error(`Duplicate environment variable "${key}"`);
    out[key] = String(r.value ?? '');
  }
  const size = new TextEncoder().encode(JSON.stringify(out)).length;
  if (size > 4096) throw new Error(`Environment variables use ${size} bytes; the limit is 4 KB`);
  return out;
}

export const envToRows = (vars = {}) => Object.entries(vars).map(([key, value]) => ({ key, value }));

/** Parses KEY=VALUE lines (.env format). */
export function parseDotEnv(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let value = line.slice(i + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    rows.push({ key: line.slice(0, i).trim().replace(/^export\s+/, ''), value });
  }
  return rows;
}

/** Tag changes between two maps: { set, remove }. */
export function tagDiff(orig = {}, next = {}) {
  return {
    set: Object.fromEntries(Object.entries(next).filter(([k, v]) => orig[k] !== v)),
    remove: Object.keys(orig).filter((k) => !(k in next)),
  };
}

// --- Resource-based policy ---------------------------------------------------------------------------
/** Flattens a function policy into rows for display. */
export function policyStatements(policyText) {
  let p;
  try {
    p = typeof policyText === 'string' ? JSON.parse(policyText) : policyText;
  } catch {
    return [];
  }
  const list = Array.isArray(p?.Statement) ? p.Statement : p?.Statement ? [p.Statement] : [];
  return list.map((s) => {
    const pr = s.Principal;
    const principal = typeof pr === 'string' ? pr : pr?.Service || pr?.AWS || JSON.stringify(pr);
    const cond = s.Condition || {};
    const sourceArn = cond.ArnLike?.['AWS:SourceArn'] || cond.ArnEquals?.['AWS:SourceArn'] || cond.ArnLike?.['aws:SourceArn'] || cond.ArnEquals?.['aws:SourceArn'];
    const sourceAccount = cond.StringEquals?.['AWS:SourceAccount'] || cond.StringEquals?.['aws:SourceAccount'];
    const urlAuth = cond.StringEquals?.['lambda:FunctionUrlAuthType'];
    return { sid: s.Sid, effect: s.Effect, principal: Array.isArray(principal) ? principal.join(', ') : principal, action: [].concat(s.Action || []).join(', '), sourceArn, sourceAccount, urlAuth, raw: s };
  });
}

/** Triggers implied by the resource policy (API Gateway, S3, SNS, EventBridge…), like the console's diagram. */
export function policyTriggers(policyText) {
  return policyStatements(policyText)
    .filter((s) => s.effect === 'Allow' && /\.amazonaws\.com$/.test(s.principal || ''))
    .map((s) => ({ service: s.principal.replace('.amazonaws.com', ''), source: s.sourceArn || s.sourceAccount || (s.urlAuth ? `Function URL (${s.urlAuth})` : '—'), sid: s.sid }));
}

// Principals offered by the "Add permission" form. [principal, label, source ARN placeholder]
export const PERMISSION_PRESETS = [
  ['apigateway.amazonaws.com', 'API Gateway', 'arn:aws:execute-api:REGION:ACCOUNT:API_ID/*/*/*'],
  ['s3.amazonaws.com', 'S3 bucket notification', 'arn:aws:s3:::bucket-name'],
  ['sns.amazonaws.com', 'SNS topic', 'arn:aws:sns:REGION:ACCOUNT:topic'],
  ['events.amazonaws.com', 'EventBridge rule / schedule', 'arn:aws:events:REGION:ACCOUNT:rule/name'],
  ['logs.amazonaws.com', 'CloudWatch Logs subscription', 'arn:aws:logs:REGION:ACCOUNT:log-group:name:*'],
  ['elasticloadbalancing.amazonaws.com', 'Application Load Balancer', 'arn:aws:elasticloadbalancing:REGION:ACCOUNT:targetgroup/name/id'],
  ['iot.amazonaws.com', 'AWS IoT', 'arn:aws:iot:REGION:ACCOUNT:rule/name'],
  ['cognito-idp.amazonaws.com', 'Cognito user pool trigger', 'arn:aws:cognito-idp:REGION:ACCOUNT:userpool/id'],
  ['', 'Other AWS account / principal', ''],
];

// --- Event source mappings --------------------------------------------------------------------------
export const ESM_SOURCES = [
  ['sqs', 'Amazon SQS', 'arn:aws:sqs:REGION:ACCOUNT:queue'],
  ['dynamodb', 'DynamoDB stream', 'arn:aws:dynamodb:REGION:ACCOUNT:table/name/stream/label'],
  ['kinesis', 'Kinesis data stream', 'arn:aws:kinesis:REGION:ACCOUNT:stream/name'],
  ['kafka', 'Amazon MSK', 'arn:aws:kafka:REGION:ACCOUNT:cluster/name/id'],
];

/** CreateEventSourceMapping input from the form. Stream sources need a starting position. */
export function buildMappingInput(FunctionName, f) {
  const arn = String(f.EventSourceArn || '').trim();
  if (!/^arn:/.test(arn)) throw new Error('Event source ARN is required');
  const svc = sourceService(arn);
  const input = { FunctionName, EventSourceArn: arn, Enabled: f.Enabled !== false };
  if (f.BatchSize) input.BatchSize = Number(f.BatchSize);
  if (f.MaximumBatchingWindowInSeconds) input.MaximumBatchingWindowInSeconds = Number(f.MaximumBatchingWindowInSeconds);
  if (svc === 'kinesis' || svc === 'dynamodb' || svc === 'kafka') input.StartingPosition = f.StartingPosition || 'LATEST';
  if (f.ReportBatchItemFailures) input.FunctionResponseTypes = ['ReportBatchItemFailures'];
  if (f.FilterPattern?.trim()) {
    const patterns = f.FilterPattern.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const p of patterns) if (!isJson(p)) throw new Error(`Filter pattern is not valid JSON: ${p}`);
    input.FilterCriteria = { Filters: patterns.map((Pattern) => ({ Pattern })) };
  }
  if (svc === 'sqs' && f.MaximumConcurrency) input.ScalingConfig = { MaximumConcurrency: Number(f.MaximumConcurrency) };
  return input;
}

// --- Metrics ---------------------------------------------------------------------------------------
export const METRICS = [
  ['invocations', 'Invocations', 'Invocations', 'Sum'],
  ['errors', 'Errors', 'Errors', 'Sum'],
  ['throttles', 'Throttles', 'Throttles', 'Sum'],
  ['durationAvg', 'Duration (avg)', 'Duration', 'Average'],
  ['durationMax', 'Duration (max)', 'Duration', 'Maximum'],
  ['concurrency', 'Concurrent executions', 'ConcurrentExecutions', 'Maximum'],
];

/** Picks a CloudWatch period so a range has at most ~120 points (multiple of 60 s). */
export function metricPeriod(rangeMs) {
  const steps = [60, 300, 900, 3600, 21600, 86400];
  return steps.find((s) => rangeMs / 1000 / s <= 120) || 86400;
}

export function metricQueries(FunctionName, Qualifier, period) {
  const dims = [{ Name: 'FunctionName', Value: FunctionName }];
  if (Qualifier) dims.push({ Name: 'Resource', Value: `${FunctionName}:${Qualifier}` });
  return METRICS.map(([Id, , MetricName, Stat]) => ({
    Id: Id.toLowerCase(),
    MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName, Dimensions: dims }, Period: period, Stat },
    ReturnData: true,
  }));
}

/** GetMetricData results -> { id: [{ t, v }] } sorted by time. */
export function metricSeries(results = []) {
  const out = {};
  for (const r of results) {
    out[r.Id] = (r.Timestamps || []).map((t, i) => ({ t: new Date(t).getTime(), v: r.Values[i] })).sort((a, b) => a.t - b.t);
  }
  return out;
}

// --- Test events -------------------------------------------------------------------------------------
const now = '2026-01-01T00:00:00.000Z';
export const EVENT_TEMPLATES = {
  'hello-world': { key1: 'value1', key2: 'value2', key3: 'value3' },
  'apigateway-http-api': {
    version: '2.0',
    routeKey: 'GET /hello',
    rawPath: '/hello',
    rawQueryString: 'name=world',
    headers: { 'content-type': 'application/json', host: 'example.execute-api.us-east-1.amazonaws.com' },
    queryStringParameters: { name: 'world' },
    requestContext: { http: { method: 'GET', path: '/hello', sourceIp: '127.0.0.1', userAgent: 'curl' }, requestId: 'req-id', stage: '$default', timeEpoch: 1767225600000 },
    body: null,
    isBase64Encoded: false,
  },
  'apigateway-rest-proxy': {
    resource: '/{proxy+}',
    path: '/hello',
    httpMethod: 'POST',
    headers: { 'Content-Type': 'application/json' },
    queryStringParameters: { name: 'world' },
    pathParameters: { proxy: 'hello' },
    requestContext: { stage: 'prod', requestId: 'req-id', identity: { sourceIp: '127.0.0.1' } },
    body: '{"message":"hi"}',
    isBase64Encoded: false,
  },
  sqs: {
    Records: [
      {
        messageId: '059f36b4-87a3-44ab-83d2-661975830a7d',
        receiptHandle: 'AQEBwJnKyrHigUMZj6rYigCgxlaS3SLy0a',
        body: '{"orderId": 42}',
        attributes: { ApproximateReceiveCount: '1', SentTimestamp: '1767225600000', ApproximateFirstReceiveTimestamp: '1767225600001' },
        messageAttributes: {},
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
        awsRegion: 'us-east-1',
      },
    ],
  },
  's3-put': {
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: 'us-east-1',
        eventTime: now,
        eventName: 'ObjectCreated:Put',
        s3: { bucket: { name: 'my-bucket', arn: 'arn:aws:s3:::my-bucket' }, object: { key: 'uploads/photo.jpg', size: 1024, eTag: 'd41d8cd98f00b204e9800998ecf8427e' } },
      },
    ],
  },
  sns: {
    Records: [
      {
        EventSource: 'aws:sns',
        EventVersion: '1.0',
        Sns: { Type: 'Notification', MessageId: '95df01b4-ee98-5cb9-9903-4c221d41eb5e', TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic', Subject: 'Hello', Message: 'Hello from SNS!', Timestamp: now, MessageAttributes: {} },
      },
    ],
  },
  eventbridge: { version: '0', id: 'abcd-1234', 'detail-type': 'Order Placed', source: 'com.example.orders', account: '123456789012', time: now, region: 'us-east-1', resources: [], detail: { orderId: 42 } },
  'scheduled-event': { version: '0', id: 'cdc73f9d-aea9-11e3-9d5a-835b769c0d9c', 'detail-type': 'Scheduled Event', source: 'aws.events', account: '123456789012', time: now, region: 'us-east-1', resources: ['arn:aws:events:us-east-1:123456789012:rule/my-schedule'], detail: {} },
  'dynamodb-stream': {
    Records: [
      {
        eventID: '1',
        eventName: 'INSERT',
        eventSource: 'aws:dynamodb',
        awsRegion: 'us-east-1',
        dynamodb: { Keys: { PK: { S: 'USER#1' } }, NewImage: { PK: { S: 'USER#1' }, name: { S: 'Alice' } }, SequenceNumber: '111', SizeBytes: 26, StreamViewType: 'NEW_AND_OLD_IMAGES' },
        eventSourceARN: 'arn:aws:dynamodb:us-east-1:123456789012:table/Users/stream/2026-01-01T00:00:00.000',
      },
    ],
  },
  kinesis: {
    Records: [
      {
        kinesis: { partitionKey: 'pk-1', kinesisSchemaVersion: '1.0', data: 'SGVsbG8sIHRoaXMgaXMgYSB0ZXN0Lg==', sequenceNumber: '4954', approximateArrivalTimestamp: 1767225600 },
        eventSource: 'aws:kinesis',
        eventID: 'shardId-000000000000:4954',
        eventName: 'aws:kinesis:record',
        awsRegion: 'us-east-1',
        eventSourceARN: 'arn:aws:kinesis:us-east-1:123456789012:stream/my-stream',
      },
    ],
  },
  'alb-request': {
    requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/abc' } },
    httpMethod: 'GET',
    path: '/health',
    queryStringParameters: {},
    headers: { host: 'example.com' },
    body: '',
    isBase64Encoded: false,
  },
  'cloudwatch-logs': { awslogs: { data: 'H4sIAAAAAAAAAHWPwQqCQBCGX0Xm7EFtK+smZBEUgXoLCdMhFtKV3akI8d0bLYmgThs/831/m77jGP6YRiFeKYcTRr4zGaWC' } },
};

export const TEMPLATE_LABELS = {
  'hello-world': 'Hello world',
  'apigateway-http-api': 'API Gateway HTTP API (v2)',
  'apigateway-rest-proxy': 'API Gateway REST proxy',
  sqs: 'SQS message',
  's3-put': 'S3 put',
  sns: 'SNS notification',
  eventbridge: 'EventBridge event',
  'scheduled-event': 'Scheduled event',
  'dynamodb-stream': 'DynamoDB stream',
  kinesis: 'Kinesis record',
  'alb-request': 'ALB request',
  'cloudwatch-logs': 'CloudWatch Logs subscription',
};

// --- Code editor ----------------------------------------------------------------------------------
/** Sorted file list with folders first per level, like an explorer. */
export function sortFiles(files = []) {
  return [...files].sort((a, b) => {
    const pa = a.path.split('/');
    const pb = b.path.split('/');
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const lastA = i === pa.length - 1;
      const lastB = i === pb.length - 1;
      if (pa[i] !== pb[i]) {
        if (lastA !== lastB) return lastA ? 1 : -1; // folders before files
        return pa[i].localeCompare(pb[i]);
      }
    }
    return pa.length - pb.length;
  });
}

/** The file that holds the handler: "src/index.handler" -> src/index.(mjs|js|cjs|ts|py|rb). */
export function handlerFile(handler, files = []) {
  const h = String(handler || '');
  const base = h.includes('.') ? h.slice(0, h.lastIndexOf('.')) : h;
  const paths = files.map((f) => f.path);
  for (const ext of ['.mjs', '.js', '.cjs', '.ts', '.py', '.rb']) if (paths.includes(base + ext)) return base + ext;
  return files.find((f) => !f.binary)?.path || null;
}
