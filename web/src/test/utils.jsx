import React from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { AppCtx } from '../context.js';
import { ToastProvider } from '../components/ui.jsx';

export function renderWithApp(ui, ctx = {}) {
  const value = {
    conn: { kind: 'endpoint', id: 'e1' },
    setConn: vi.fn(),
    profiles: [],
    endpoints: [{ id: 'e1', name: 'Local', endpoint: 'http://localhost:8000', region: 'us-east-1' }],
    reloadConnections: vi.fn(async () => ({})),
    tables: ['Shop'],
    reloadTables: vi.fn(),
    info: { region: 'us-east-1', endpoint: 'http://localhost:8000', label: 'Local' },
    ...ctx,
  };
  return { ctx: value, ...render(<ToastProvider><AppCtx.Provider value={value}>{ui}</AppCtx.Provider></ToastProvider>) };
}

// A DescribeTable "Table" object for a single-table design with one GSI and one LSI.
export const SHOP_DESC = {
  TableName: 'Shop',
  TableStatus: 'ACTIVE',
  TableArn: 'arn:aws:dynamodb:us-east-1:000:table/Shop',
  ItemCount: 3,
  TableSizeBytes: 2048,
  KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
  AttributeDefinitions: [
    { AttributeName: 'PK', AttributeType: 'S' },
    { AttributeName: 'SK', AttributeType: 'S' },
    { AttributeName: 'GSI1PK', AttributeType: 'S' },
    { AttributeName: 'n', AttributeType: 'N' },
  ],
  BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
  GlobalSecondaryIndexes: [
    { IndexName: 'GSI1', KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' }, IndexStatus: 'ACTIVE' },
  ],
  LocalSecondaryIndexes: [
    { IndexName: 'LSI1', KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'n', KeyType: 'RANGE' }], Projection: { ProjectionType: 'KEYS_ONLY' } },
  ],
};

/**
 * Fake backend: replaces fetch. `handlers` maps "METHOD /path" or a DynamoDB op name ("Scan")
 * to a value, or to a function (body, url) => value. Throwing { status, error, message } makes an error response.
 * Returns the spy; `calls(opOrRoute)` lists request bodies for that key.
 */
export function mockBackend(handlers = {}) {
  const log = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const path = String(url).split('?')[0];
    const op = path.startsWith('/api/ddb/') ? path.slice(9) : null;
    const key = op || `${method} ${path}`;
    log.push({ key, body, headers: init.headers });
    let h = handlers[key];
    if (h === undefined && !op) h = handlers[`${method} ${path.replace(/\/[^/]+$/, '/:id')}`];
    if (h === undefined) h = op ? {} : { ok: true };
    try {
      const value = typeof h === 'function' ? await h(body, path) : h;
      return new Response(JSON.stringify(value ?? {}), { status: 200, headers: { 'x-elapsed-ms': '3' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.error || e.name || 'Error', message: e.message, cancellationReasons: e.cancellationReasons }), { status: e.status || 400 });
    }
  });
  spy.calls = (key) => log.filter((l) => l.key === key).map((l) => l.body);
  spy.log = log;
  return spy;
}

export const awsError = (error, message, status = 400) => Object.assign(new Error(message), { error, status });
