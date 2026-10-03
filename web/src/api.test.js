import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, ddb, setConn, getConn, errorText, ApiError } from './api.js';

const respond = (status, body, headers = {}) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }),
  );

beforeEach(() => setConn(null));

describe('api', () => {
  it('sends CSRF header, JSON body and encoded connection', async () => {
    const f = respond(200, { ok: 1 }, { 'x-elapsed-ms': '12' });
    setConn({ kind: 'profile', profile: 'p' });
    expect(getConn()).toEqual({ kind: 'profile', profile: 'p' });
    const out = await api('/api/x', { method: 'POST', body: { a: 1 } });
    expect(out).toEqual({ ok: 1 });
    expect(out.$elapsed).toBe(12);
    expect(Object.keys(out)).toEqual(['ok']); // $elapsed is not enumerable
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/x');
    expect(init).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(init.headers).toEqual({
      'x-requested-with': 'dynamodb-studio',
      'x-conn': encodeURIComponent('{"kind":"profile","profile":"p"}'),
      'content-type': 'application/json',
    });
  });

  it('GET without body or connection; explicit conn overrides; conn null removes header', async () => {
    const f = respond(200, [1, 2]);
    expect(await api('/api/list')).toEqual([1, 2]);
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'GET', body: undefined, headers: { 'x-requested-with': 'dynamodb-studio' } });

    setConn({ kind: 'default' });
    await api('/api/y', { conn: { kind: 'endpoint', id: 'e' } });
    expect(decodeURIComponent(f.mock.calls[1][1].headers['x-conn'])).toBe('{"kind":"endpoint","id":"e"}');
    await api('/api/y', { conn: null });
    expect(f.mock.calls[2][1].headers['x-conn']).toBeUndefined();
  });

  it('handles empty and non-JSON responses', async () => {
    respond(200, '');
    expect(await api('/api/empty')).toBeNull();
    respond(200, 'plain text');
    expect(await api('/api/text')).toEqual({ message: 'plain text' });
  });

  it('throws ApiError with server error details', async () => {
    respond(400, { error: 'ValidationException', message: 'bad key' });
    const err = await api('/api/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ name: 'ValidationException', message: 'bad key', status: 400 });
    respond(502, '');
    expect(await api('/api/x').catch((e) => e.message)).toBe('HTTP 502');
  });

  it('ddb posts to the proxy route', async () => {
    const f = respond(200, { Items: [] });
    await ddb('Scan', { TableName: 'T' });
    await ddb('ListTables');
    expect(f.mock.calls[0][0]).toBe('/api/ddb/Scan');
    expect(f.mock.calls[1][1].body).toBe('{}');
  });
});

describe('errorText', () => {
  it('formats errors', () => {
    expect(errorText(null)).toBe('');
    expect(errorText(new Error('plain'))).toBe('plain');
    expect(errorText({ name: 'X', message: 'y' })).toBe('X: y');
    expect(errorText('str')).toBe('str');
    const e = new ApiError(400, {
      error: 'TransactionCanceledException',
      message: 'cancelled',
      cancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed', Message: 'failed' }],
    });
    expect(errorText(e)).toBe('TransactionCanceledException: cancelled\n  [0] None\n  [1] ConditionalCheckFailed - failed');
  });
});
