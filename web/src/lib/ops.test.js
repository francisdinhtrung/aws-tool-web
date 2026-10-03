import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api.js', () => ({ ddb: vi.fn() }));
const { ddb } = await import('../api.js');
const ops = await import('./ops.js');

beforeEach(() => {
  ddb.mockReset();
  ops.clearDescCache();
});
afterEach(() => vi.useRealTimers());

describe('describeTable cache', () => {
  it('caches by name and supports force / clear', async () => {
    ddb.mockResolvedValue({ Table: { TableName: 'T' } });
    await ops.describeTable('T');
    await ops.describeTable('T');
    expect(ddb).toHaveBeenCalledTimes(1);
    await ops.describeTable('T', { force: true });
    expect(ddb).toHaveBeenCalledTimes(2);
    ops.clearDescCache('T');
    await ops.describeTable('T');
    expect(ddb).toHaveBeenCalledTimes(3);
    expect(ddb).toHaveBeenCalledWith('DescribeTable', { TableName: 'T' });
  });
});

describe('listAllTables', () => {
  it('follows pagination', async () => {
    ddb.mockResolvedValueOnce({ TableNames: ['a', 'b'], LastEvaluatedTableName: 'b' }).mockResolvedValueOnce({ TableNames: ['c'] });
    expect(await ops.listAllTables()).toEqual(['a', 'b', 'c']);
    expect(ddb.mock.calls[0][1]).toEqual({ Limit: 100 });
    expect(ddb.mock.calls[1][1]).toEqual({ Limit: 100, ExclusiveStartTableName: 'b' });
  });
});

describe('batchWrite', () => {
  it('chunks by 25 and reports progress', async () => {
    ddb.mockResolvedValue({});
    const progress = vi.fn();
    const reqs = ops.putRequests(Array.from({ length: 60 }, (_, i) => ({ id: { N: String(i) } })));
    expect(await ops.batchWrite('T', reqs, progress)).toBe(60);
    expect(ddb).toHaveBeenCalledTimes(3);
    expect(ddb.mock.calls[0][1].RequestItems.T).toHaveLength(25);
    expect(ddb.mock.calls[2][1].RequestItems.T).toHaveLength(10);
    expect(progress.mock.calls).toEqual([[25, 60], [50, 60], [60, 60]]);
  });

  it('retries unprocessed items with backoff', async () => {
    vi.useFakeTimers();
    const unprocessed = { T: [{ DeleteRequest: { Key: { id: { S: '1' } } } }] };
    ddb.mockResolvedValueOnce({ UnprocessedItems: unprocessed }).mockResolvedValueOnce({ UnprocessedItems: {} });
    const p = ops.batchWrite('T', ops.deleteRequests([{ id: { S: '1' } }, { id: { S: '2' } }]));
    await vi.runAllTimersAsync();
    expect(await p).toBe(2);
    expect(ddb.mock.calls[1][1]).toEqual({ RequestItems: unprocessed });
  });

  it('gives up after too many retries', async () => {
    vi.useFakeTimers();
    ddb.mockResolvedValue({ UnprocessedItems: { T: [{}] } });
    const p = ops.batchWrite('T', [{}]);
    const assertion = expect(p).rejects.toThrow(/Too many retries/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(ddb).toHaveBeenCalledTimes(11);
  });

  it('stops when cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(ops.batchWrite('T', [{}], null, ac.signal)).rejects.toThrow('Cancelled');
    expect(ddb).not.toHaveBeenCalled();
  });

  it('builds put / delete requests', () => {
    expect(ops.putRequests([{ a: 1 }])).toEqual([{ PutRequest: { Item: { a: 1 } } }]);
    expect(ops.deleteRequests([{ k: 1 }])).toEqual([{ DeleteRequest: { Key: { k: 1 } } }]);
  });
});

describe('scanAll', () => {
  it('pages through and reports counts', async () => {
    ddb.mockResolvedValueOnce({ Items: [1, 2], LastEvaluatedKey: { k: 1 } }).mockResolvedValueOnce({});
    const onPage = vi.fn();
    expect(await ops.scanAll({ TableName: 'T' }, onPage)).toEqual([1, 2]);
    expect(ddb.mock.calls[1][1]).toEqual({ TableName: 'T', ExclusiveStartKey: { k: 1 } });
    expect(onPage.mock.calls).toEqual([[2], [2]]);
  });

  it('stops when cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(ops.scanAll({}, null, ac.signal)).rejects.toThrow('Cancelled');
  });
});

describe('waitForActive', () => {
  it('polls until the table and its indexes are ACTIVE', async () => {
    vi.useFakeTimers();
    ddb
      .mockResolvedValueOnce({ Table: { TableStatus: 'CREATING' } })
      .mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [{ IndexStatus: 'CREATING' }] } })
      .mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [{ IndexStatus: 'ACTIVE' }, {}] } });
    const tick = vi.fn();
    const p = ops.waitForActive('T', tick);
    await vi.runAllTimersAsync();
    expect((await p).TableStatus).toBe('ACTIVE');
    expect(tick.mock.calls.map((c) => c[0])).toEqual(['CREATING', 'ACTIVE', 'ACTIVE']);
  });

  it('times out', async () => {
    vi.useFakeTimers();
    ddb.mockResolvedValue({ Table: { TableStatus: 'UPDATING' } });
    const p = ops.waitForActive('T', undefined, 2000);
    const assertion = expect(p).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});

describe('tableExists', () => {
  it('maps ResourceNotFoundException to false and rethrows others', async () => {
    ddb.mockResolvedValueOnce({ Table: {} });
    expect(await ops.tableExists('A')).toBe(true);
    ddb.mockRejectedValueOnce(Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }));
    expect(await ops.tableExists('B')).toBe(false);
    ddb.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(ops.tableExists('C')).rejects.toThrow('denied');
  });
});
