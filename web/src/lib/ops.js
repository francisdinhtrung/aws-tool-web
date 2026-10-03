import { ddb } from '../api.js';
import { chunk } from './dynamo.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const descCache = new Map();
export async function describeTable(name, { force = false } = {}) {
  if (!force && descCache.has(name)) return descCache.get(name);
  const out = await ddb('DescribeTable', { TableName: name });
  descCache.set(name, out.Table);
  return out.Table;
}
export const clearDescCache = (name) => (name ? descCache.delete(name) : descCache.clear());

export async function listAllTables() {
  const names = [];
  let start;
  do {
    const out = await ddb('ListTables', { Limit: 100, ...(start ? { ExclusiveStartTableName: start } : {}) });
    names.push(...out.TableNames);
    start = out.LastEvaluatedTableName;
  } while (start);
  return names;
}

// Writes requests (PutRequest/DeleteRequest) in chunks of 25, retrying UnprocessedItems with backoff.
export async function batchWrite(table, requests, onProgress, signal) {
  let done = 0;
  for (const part of chunk(requests, 25)) {
    let pending = { [table]: part };
    let attempt = 0;
    while (pending && Object.keys(pending).length) {
      if (signal?.aborted) throw new Error('Cancelled');
      const out = await ddb('BatchWriteItem', { RequestItems: pending });
      pending = out.UnprocessedItems && Object.keys(out.UnprocessedItems).length ? out.UnprocessedItems : null;
      if (pending) {
        attempt++;
        if (attempt > 10) throw new Error('Too many retries for unprocessed items');
        await sleep(Math.min(2000, 50 * 2 ** attempt));
      }
    }
    done += part.length;
    onProgress?.(done, requests.length);
  }
  return done;
}

export const putRequests = (items) => items.map((Item) => ({ PutRequest: { Item } }));
export const deleteRequests = (keys) => keys.map((Key) => ({ DeleteRequest: { Key } }));

export async function scanAll(input, onPage, signal) {
  const items = [];
  let ExclusiveStartKey;
  do {
    if (signal?.aborted) throw new Error('Cancelled');
    const out = await ddb('Scan', { ...input, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) });
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
    onPage?.(items.length);
  } while (ExclusiveStartKey);
  return items;
}

export async function waitForActive(table, onTick, timeoutMs = 300000) {
  const start = Date.now();
  for (;;) {
    const t = await describeTable(table, { force: true });
    const indexesBusy = (t.GlobalSecondaryIndexes || []).some((g) => g.IndexStatus && g.IndexStatus !== 'ACTIVE');
    onTick?.(t.TableStatus);
    if (t.TableStatus === 'ACTIVE' && !indexesBusy) return t;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${table} to become ACTIVE`);
    await sleep(1500);
  }
}

export async function tableExists(name) {
  try {
    await describeTable(name, { force: true });
    return true;
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') return false;
    throw e;
  }
}
