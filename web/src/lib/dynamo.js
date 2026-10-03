// AttributeValue helpers, expression builders, table-definition helpers and code generation.

export const AV_TYPES = ['S', 'N', 'B', 'BOOL', 'NULL', 'M', 'L', 'SS', 'NS', 'BS'];
export const KEY_TYPES = ['S', 'N', 'B'];
export const TYPE_LABELS = {
  S: 'String', N: 'Number', B: 'Binary', BOOL: 'Boolean', NULL: 'Null', M: 'Map', L: 'List',
  SS: 'String set', NS: 'Number set', BS: 'Binary set', PLAIN: 'JSON (auto)', JSON: 'DynamoDB JSON', RAW: 'DynamoDB JSON',
};
// Value types offered by expression builders.
export const VALUE_TYPES = ['S', 'N', 'BOOL', 'NULL', 'B', 'SS', 'NS', 'BS', 'PLAIN', 'JSON'];

export const avType = (av) => (av && typeof av === 'object' ? Object.keys(av)[0] : undefined);

export function isAttributeValue(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const ks = Object.keys(x);
  return ks.length === 1 && AV_TYPES.includes(ks[0]);
}
export const isDdbJsonItem = (obj) => {
  const vals = Object.values(obj || {});
  return vals.length > 0 && vals.every(isAttributeValue);
};

function numOrString(s) {
  const n = Number(s);
  const digits = String(s).replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '').replace(/^0+/, '');
  return Number.isFinite(n) && digits.length <= 15 ? n : s;
}

export function toPlain(av) {
  const t = avType(av);
  const v = av?.[t];
  switch (t) {
    case 'S':
    case 'B':
    case 'BOOL':
      return v;
    case 'N':
      return numOrString(v);
    case 'NULL':
      return null;
    case 'M':
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
    case 'L':
      return v.map(toPlain);
    case 'SS':
    case 'BS':
      return [...v];
    case 'NS':
      return v.map(numOrString);
    default:
      return undefined;
  }
}

export function fromPlain(v) {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(fromPlain) };
  if (typeof v === 'object') return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromPlain(x)])) };
  return { S: String(v) };
}

export const itemToPlain = (item) => Object.fromEntries(Object.entries(item || {}).map(([k, v]) => [k, toPlain(v)]));
export const itemFromPlain = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, fromPlain(v)]));
export const normalizeItem = (obj) => (isDdbJsonItem(obj) ? obj : itemFromPlain(obj));

export function displayValue(av, max = 160) {
  const t = avType(av);
  let s;
  if (t === 'S' || t === 'N') s = av[t];
  else if (t === 'BOOL') s = String(av.BOOL);
  else if (t === 'NULL') s = 'null';
  else if (t === 'B') s = `<binary ${Math.floor((av.B.length * 3) / 4) - (av.B.match(/=+$/)?.[0].length || 0)}B>`;
  else s = JSON.stringify(toPlain(av));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const stableKey = (item, names) => JSON.stringify(names.map((n) => item?.[n] ?? null));
export const pickKey = (item, names) => Object.fromEntries(names.filter((n) => item?.[n]).map((n) => [n, item[n]]));

export function columnsOf(items, first = []) {
  const set = new Set();
  for (const it of items) for (const k of Object.keys(it)) set.add(k);
  const rest = [...set].filter((k) => !first.includes(k)).sort((a, b) => a.localeCompare(b));
  return [...first.filter((k) => set.has(k) || items.length === 0), ...rest];
}

function parseList(str) {
  const s = String(str).trim();
  if (s.startsWith('[')) return JSON.parse(s).map(String);
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

// Convert a builder value (type + text) to an AttributeValue.
export function toAV(type, str = '') {
  switch (type) {
    case 'N': {
      const s = String(str).trim();
      if (s === '' || Number.isNaN(Number(s))) throw new Error(`"${str}" is not a valid number`);
      return { N: s };
    }
    case 'BOOL':
      return { BOOL: str === true || str === 'true' };
    case 'NULL':
      return { NULL: true };
    case 'B':
      return { B: String(str).trim() };
    case 'SS':
      return { SS: parseList(str) };
    case 'NS': {
      const l = parseList(str);
      l.forEach((x) => toAV('N', x));
      return { NS: l };
    }
    case 'BS':
      return { BS: parseList(str) };
    case 'PLAIN':
      return fromPlain(JSON.parse(str));
    case 'JSON': {
      const v = JSON.parse(str);
      if (!isAttributeValue(v)) throw new Error('Expected a DynamoDB JSON attribute value, e.g. {"S":"x"}');
      return v;
    }
    default:
      return { S: String(str) };
  }
}

// --- Expressions ---------------------------------------------------------------
export class ExprCtx {
  constructor(prefix = '') {
    this.names = {};
    this.values = {};
    this.n = 0;
    this.v = 0;
    this.prefix = prefix;
  }
  // Supports document paths: a.b[0].c
  name(path) {
    return String(path)
      .split('.')
      .map((part) => {
        const m = part.match(/^(.*?)((?:\[\d+\])*)$/);
        const base = m[1];
        let key = Object.keys(this.names).find((k) => this.names[k] === base);
        if (!key) {
          key = `#${this.prefix}n${this.n++}`;
          this.names[key] = base;
        }
        return key + m[2];
      })
      .join('.');
  }
  value(av) {
    const key = `:${this.prefix}v${this.v++}`;
    this.values[key] = av;
    return key;
  }
  apply(input) {
    if (Object.keys(this.names).length) input.ExpressionAttributeNames = this.names;
    if (Object.keys(this.values).length) input.ExpressionAttributeValues = this.values;
    return input;
  }
}

export const COND_OPS = [
  ['=', '='], ['<>', '≠'], ['<', '<'], ['<=', '≤'], ['>', '>'], ['>=', '≥'],
  ['between', 'Between'], ['begins_with', 'Begins with'], ['contains', 'Contains'], ['not_contains', 'Not contains'],
  ['exists', 'Exists'], ['not_exists', 'Not exists'], ['in', 'In (a, b, c)'], ['attribute_type', 'Attribute type is'],
  ['size_eq', 'Size ='], ['size_gt', 'Size >'], ['size_lt', 'Size <'],
];
export const SK_OPS = [
  ['=', '='], ['<', '<'], ['<=', '≤'], ['>', '>'], ['>=', '≥'], ['between', 'Between'], ['begins_with', 'Begins with'],
];
export const NO_VALUE_OPS = new Set(['exists', 'not_exists']);

export function condExpr(row, ctx) {
  const n = ctx.name(row.attr);
  const val = (s) => ctx.value(toAV(row.type || 'S', s));
  switch (row.op) {
    case 'exists': return `attribute_exists(${n})`;
    case 'not_exists': return `attribute_not_exists(${n})`;
    case 'between': return `${n} BETWEEN ${val(row.value)} AND ${val(row.value2)}`;
    case 'begins_with': return `begins_with(${n}, ${val(row.value)})`;
    case 'contains': return `contains(${n}, ${val(row.value)})`;
    case 'not_contains': return `NOT contains(${n}, ${val(row.value)})`;
    case 'in': return `${n} IN (${String(row.value).split(',').map((s) => val(s.trim())).join(', ')})`;
    case 'attribute_type': return `attribute_type(${n}, ${ctx.value({ S: String(row.value).trim() })})`;
    case 'size_eq': return `size(${n}) = ${ctx.value(toAV('N', row.value))}`;
    case 'size_gt': return `size(${n}) > ${ctx.value(toAV('N', row.value))}`;
    case 'size_lt': return `size(${n}) < ${ctx.value(toAV('N', row.value))}`;
    default: return `${n} ${row.op || '='} ${val(row.value)}`;
  }
}

export function buildCondition(rows, ctx) {
  let out = '';
  for (const r of rows || []) {
    if (!r.attr) continue;
    const e = condExpr(r, ctx);
    out = out ? `${out} ${r.join || 'AND'} ${e}` : e;
  }
  return out || undefined;
}

export const UPDATE_ACTIONS = [
  ['set', 'SET'], ['increment', 'SET  += (increment)'], ['decrement', 'SET  -= (decrement)'],
  ['append', 'SET list_append'], ['if_not_exists', 'SET if_not_exists'],
  ['remove', 'REMOVE'], ['add', 'ADD (number / set)'], ['delete', 'DELETE (from set)'],
];

export function buildUpdate(rows, ctx) {
  const clauses = { SET: [], REMOVE: [], ADD: [], DELETE: [] };
  for (const r of rows || []) {
    if (!r.attr) continue;
    const n = ctx.name(r.attr);
    const v = () => ctx.value(toAV(r.type || 'S', r.value));
    switch (r.action) {
      case 'remove': clauses.REMOVE.push(n); break;
      case 'add': clauses.ADD.push(`${n} ${v()}`); break;
      case 'delete': clauses.DELETE.push(`${n} ${v()}`); break;
      case 'increment': clauses.SET.push(`${n} = ${n} + ${v()}`); break;
      case 'decrement': clauses.SET.push(`${n} = ${n} - ${v()}`); break;
      case 'append': clauses.SET.push(`${n} = list_append(if_not_exists(${n}, ${ctx.value({ L: [] })}), ${v()})`); break;
      case 'if_not_exists': clauses.SET.push(`${n} = if_not_exists(${n}, ${v()})`); break;
      default: clauses.SET.push(`${n} = ${v()}`);
    }
  }
  const expr = Object.entries(clauses)
    .filter(([, l]) => l.length)
    .map(([k, l]) => `${k} ${l.join(', ')}`)
    .join(' ');
  return expr || undefined;
}

export function buildProjection(str, ctx) {
  const parts = String(str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts.map((p) => ctx.name(p)).join(', ') : undefined;
}

// --- Table descriptions -----------------------------------------------------------
export function keysOf(desc, indexName) {
  if (!desc) return { pk: null, sk: null };
  const types = Object.fromEntries((desc.AttributeDefinitions || []).map((a) => [a.AttributeName, a.AttributeType]));
  let schema = desc.KeySchema;
  if (indexName) {
    const idx = [...(desc.GlobalSecondaryIndexes || []), ...(desc.LocalSecondaryIndexes || [])].find((i) => i.IndexName === indexName);
    schema = idx?.KeySchema || [];
  }
  const pk = schema?.find((k) => k.KeyType === 'HASH')?.AttributeName || null;
  const sk = schema?.find((k) => k.KeyType === 'RANGE')?.AttributeName || null;
  return { pk, sk, pkType: types[pk] || 'S', skType: types[sk] || 'S', types };
}
export const tableKeyNames = (desc) => {
  const { pk, sk } = keysOf(desc);
  return [pk, sk].filter(Boolean);
};
export const indexesOf = (desc) => [
  ...(desc?.GlobalSecondaryIndexes || []).map((i) => ({ ...i, kind: 'GSI' })),
  ...(desc?.LocalSecondaryIndexes || []).map((i) => ({ ...i, kind: 'LSI' })),
];

// Workbench-format table definition -> CreateTable input.
export function createTableInput(def) {
  const attrs = new Map();
  const keySchema = (ka) => {
    const ks = [{ AttributeName: ka.PartitionKey.AttributeName, KeyType: 'HASH' }];
    attrs.set(ka.PartitionKey.AttributeName, ka.PartitionKey.AttributeType || 'S');
    if (ka.SortKey?.AttributeName) {
      ks.push({ AttributeName: ka.SortKey.AttributeName, KeyType: 'RANGE' });
      attrs.set(ka.SortKey.AttributeName, ka.SortKey.AttributeType || 'S');
    }
    return ks;
  };
  const provisioned = def.BillingMode === 'PROVISIONED';
  const tp = def.ProvisionedCapacitySettings?.ProvisionedThroughput || {};
  const throughput = { ReadCapacityUnits: Number(tp.ReadCapacityUnits) || 5, WriteCapacityUnits: Number(tp.WriteCapacityUnits) || 5 };
  const projection = (p) => {
    const out = { ProjectionType: p?.ProjectionType || 'ALL' };
    if (out.ProjectionType === 'INCLUDE') out.NonKeyAttributes = p.NonKeyAttributes || [];
    return out;
  };
  const input = {
    TableName: def.TableName,
    KeySchema: keySchema(def.KeyAttributes),
    BillingMode: provisioned ? 'PROVISIONED' : 'PAY_PER_REQUEST',
  };
  if (provisioned) input.ProvisionedThroughput = throughput;
  if (def.GlobalSecondaryIndexes?.length) {
    input.GlobalSecondaryIndexes = def.GlobalSecondaryIndexes.map((g) => ({
      IndexName: g.IndexName,
      KeySchema: keySchema(g.KeyAttributes),
      Projection: projection(g.Projection),
      ...(provisioned ? { ProvisionedThroughput: throughput } : {}),
    }));
  }
  if (def.LocalSecondaryIndexes?.length) {
    input.LocalSecondaryIndexes = def.LocalSecondaryIndexes.map((l) => ({
      IndexName: l.IndexName,
      KeySchema: keySchema({ PartitionKey: def.KeyAttributes.PartitionKey, SortKey: l.KeyAttributes?.SortKey || l.SortKey }),
      Projection: projection(l.Projection),
    }));
  }
  if (def.TableClass && def.TableClass !== 'STANDARD') input.TableClass = def.TableClass;
  if (def.DeletionProtectionEnabled) input.DeletionProtectionEnabled = true;
  if (def.StreamViewType) input.StreamSpecification = { StreamEnabled: true, StreamViewType: def.StreamViewType };
  input.AttributeDefinitions = [...attrs].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType }));
  return input;
}

// DescribeTable output -> Workbench-format table definition.
export function descToDef(desc) {
  const k = keysOf(desc);
  const key = (schema) => {
    const pk = schema.find((x) => x.KeyType === 'HASH')?.AttributeName;
    const sk = schema.find((x) => x.KeyType === 'RANGE')?.AttributeName;
    const out = { PartitionKey: { AttributeName: pk, AttributeType: k.types[pk] || 'S' } };
    if (sk) out.SortKey = { AttributeName: sk, AttributeType: k.types[sk] || 'S' };
    return out;
  };
  const def = {
    TableName: desc.TableName,
    KeyAttributes: key(desc.KeySchema),
    NonKeyAttributes: [],
    GlobalSecondaryIndexes: (desc.GlobalSecondaryIndexes || []).map((g) => ({
      IndexName: g.IndexName,
      KeyAttributes: key(g.KeySchema),
      Projection: { ProjectionType: g.Projection?.ProjectionType || 'ALL', ...(g.Projection?.NonKeyAttributes ? { NonKeyAttributes: g.Projection.NonKeyAttributes } : {}) },
    })),
    TableData: [],
    DataAccess: { MySql: {} },
    BillingMode: desc.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST' ? 'PAY_PER_REQUEST' : 'PROVISIONED',
  };
  if (desc.LocalSecondaryIndexes?.length) {
    def.LocalSecondaryIndexes = desc.LocalSecondaryIndexes.map((l) => ({
      IndexName: l.IndexName,
      KeyAttributes: key(l.KeySchema),
      Projection: { ProjectionType: l.Projection?.ProjectionType || 'ALL' },
    }));
  }
  if (def.BillingMode === 'PROVISIONED') {
    def.ProvisionedCapacitySettings = {
      ProvisionedThroughput: {
        ReadCapacityUnits: desc.ProvisionedThroughput?.ReadCapacityUnits || 5,
        WriteCapacityUnits: desc.ProvisionedThroughput?.WriteCapacityUnits || 5,
      },
    };
  }
  return def;
}

export function inferNonKeyAttributes(def) {
  const keys = new Set([def.KeyAttributes?.PartitionKey?.AttributeName, def.KeyAttributes?.SortKey?.AttributeName]);
  const seen = new Map((def.NonKeyAttributes || []).map((a) => [a.AttributeName, a.AttributeType]));
  for (const it of def.TableData || []) {
    for (const [k, v] of Object.entries(it)) if (!keys.has(k) && !seen.has(k)) seen.set(k, avType(v));
  }
  return [...seen].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType }));
}

export function cloudFormation(model) {
  const resources = {};
  for (const def of model.DataModel || []) {
    let id = String(def.TableName).replace(/[^A-Za-z0-9]/g, '') || 'Table';
    id = id[0].toUpperCase() + id.slice(1);
    while (resources[id]) id += 'X';
    const props = createTableInput(def);
    resources[id] = { Type: 'AWS::DynamoDB::Table', Properties: props };
  }
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `${model.ModelName || 'Data model'} - generated by DynamoDB Studio`,
    Resources: resources,
  };
}

// --- Code generation ----------------------------------------------------------------
const snake = (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const kebab = (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

function py(v, ind = 0) {
  const pad = '    '.repeat(ind + 1);
  const end = '    '.repeat(ind);
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => pad + py(x, ind + 1)).join(',\n')}\n${end}]`;
  }
  const entries = Object.entries(v);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${py(x, ind + 1)}`).join(',\n')}\n${end}}`;
}

export const CODE_LANGS = [
  ['python', 'Python (boto3)'],
  ['javascript', 'JavaScript (SDK v3)'],
  ['cli', 'AWS CLI'],
];

export function genCode(op, input, lang, conn = {}) {
  const region = conn.region || 'us-east-1';
  const endpoint = conn.endpoint;
  if (lang === 'python') {
    return [
      'import boto3',
      '',
      `client = boto3.client("dynamodb", region_name=${JSON.stringify(region)}${endpoint ? `, endpoint_url=${JSON.stringify(endpoint)}` : ''})`,
      '',
      `response = client.${snake(op)}(**${py(input)})`,
      'print(response)',
    ].join('\n');
  }
  if (lang === 'javascript') {
    return [
      `import { DynamoDBClient, ${op}Command } from "@aws-sdk/client-dynamodb";`,
      '',
      `const client = new DynamoDBClient({ region: ${JSON.stringify(region)}${endpoint ? `, endpoint: ${JSON.stringify(endpoint)}` : ''} });`,
      '',
      `const input = ${JSON.stringify(input, null, 2)};`,
      '',
      `const response = await client.send(new ${op}Command(input));`,
      'console.log(JSON.stringify(response, null, 2));',
    ].join('\n');
  }
  const json = JSON.stringify(input, null, 2).replace(/'/g, `'\\''`);
  return `aws dynamodb ${kebab(op)} \\\n  --region ${region}${endpoint ? ` \\\n  --endpoint-url ${endpoint}` : ''} \\\n  --cli-input-json '${json}'`;
}

// --- Import / export -----------------------------------------------------------------
function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function itemsToCsv(items, firstCols = []) {
  const cols = columnsOf(items, firstCols);
  const cell = (av) => {
    if (!av) return '';
    const t = avType(av);
    if (t === 'S' || t === 'N' || t === 'B') return av[t];
    if (t === 'BOOL') return String(av.BOOL);
    if (t === 'NULL') return '';
    return JSON.stringify(toPlain(av));
  };
  return [cols.map(csvCell).join(','), ...items.map((it) => cols.map((c) => csvCell(cell(it[c]))).join(','))].join('\n');
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

// Header cells may carry a type hint: "price (N)" / "tags (SS)" / "meta (M)".
export function csvToItems(text, { inferNumbers = true, inferJson = true } = {}) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const cols = header.map((h) => {
    const m = h.trim().match(/^(.*?)\s*\((S|N|B|BOOL|NULL|M|L|SS|NS|BS)\)$/i);
    return m ? { name: m[1], type: m[2].toUpperCase() } : { name: h.trim(), type: null };
  });
  return rows.map((r) => {
    const item = {};
    cols.forEach((c, i) => {
      const raw = r[i] ?? '';
      if (raw === '' || !c.name) return;
      if (c.type) {
        item[c.name] = ['M', 'L'].includes(c.type) ? fromPlain(JSON.parse(raw)) : toAV(c.type, raw);
      } else if (inferNumbers && /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(raw)) item[c.name] = { N: raw };
      else if (raw === 'true' || raw === 'false') item[c.name] = { BOOL: raw === 'true' };
      else if (inferJson && /^[[{]/.test(raw)) {
        try {
          item[c.name] = fromPlain(JSON.parse(raw));
        } catch {
          item[c.name] = { S: raw };
        }
      } else item[c.name] = { S: raw };
    });
    return item;
  });
}

export function parseJsonItems(text) {
  const t = text.trim();
  let data;
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      data = JSON.parse(t);
    } catch (e) {
      // JSON lines fallback
      data = t.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      if (!data.length) throw e;
    }
  }
  if (!Array.isArray(data)) {
    if (data?.Items) data = data.Items;
    else if (data?.Item) data = [data.Item];
    else data = [data];
  }
  return data.map((d) => normalizeItem(d.Item && isDdbJsonItem(d.Item) ? d.Item : d));
}

export const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export const REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'ca-west-1', 'sa-east-1', 'mx-central-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1', 'eu-south-2',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-7',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1', 'ap-south-2', 'ap-east-1',
  'me-south-1', 'me-central-1', 'il-central-1', 'af-south-1', 'us-gov-west-1', 'us-gov-east-1', 'cn-north-1', 'cn-northwest-1',
];
