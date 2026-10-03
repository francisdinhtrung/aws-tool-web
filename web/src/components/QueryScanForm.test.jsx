import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QueryScanForm, { buildQueryScanInput, initialQueryState } from './QueryScanForm.jsx';
import { SHOP_DESC } from '../test/utils.jsx';

describe('buildQueryScanInput', () => {
  it('builds a plain scan with limit', () => {
    expect(buildQueryScanInput(SHOP_DESC, initialQueryState())).toEqual({ op: 'Scan', input: { TableName: 'Shop', Limit: 100 } });
    expect(buildQueryScanInput(SHOP_DESC, initialQueryState(), { includeLimit: false }).input).toEqual({ TableName: 'Shop' });
    expect(buildQueryScanInput(SHOP_DESC, { ...initialQueryState(), limit: '' }).input.Limit).toBeUndefined();
  });

  it('builds a query with every sort-key operator', () => {
    const base = { ...initialQueryState(), mode: 'query', pk: 'CUST#1' };
    const q = (patch) => buildQueryScanInput(SHOP_DESC, { ...base, ...patch }).input;
    expect(q({})).toMatchObject({ KeyConditionExpression: '#n0 = :v0', ExpressionAttributeNames: { '#n0': 'PK' }, ExpressionAttributeValues: { ':v0': { S: 'CUST#1' } } });
    expect(q({ sk: 'ORDER#', skOp: 'begins_with' }).KeyConditionExpression).toBe('#n0 = :v0 AND begins_with(#n1, :v1)');
    expect(q({ sk: 'a', sk2: 'b', skOp: 'between' }).KeyConditionExpression).toBe('#n0 = :v0 AND #n1 BETWEEN :v1 AND :v2');
    expect(q({ sk: 'a', skOp: '>=' }).KeyConditionExpression).toBe('#n0 = :v0 AND #n1 >= :v1');
    expect(q({ forward: false }).ScanIndexForward).toBe(false);
    expect(buildQueryScanInput(SHOP_DESC, { ...base, mode: 'query' }).op).toBe('Query');
  });

  it('queries an index with typed keys, filters, projection and consistency', () => {
    const { input } = buildQueryScanInput(SHOP_DESC, {
      ...initialQueryState(),
      mode: 'query',
      index: 'LSI1',
      pk: 'C',
      sk: '5',
      skOp: '<',
      filters: [{ attr: 'status', op: '=', type: 'S', value: 'OPEN' }],
      projection: 'PK, total',
      consistent: true,
    });
    expect(input).toEqual({
      TableName: 'Shop',
      IndexName: 'LSI1',
      KeyConditionExpression: '#n0 = :v0 AND #n1 < :v1',
      FilterExpression: '#n2 = :v2',
      ProjectionExpression: '#n0, #n3',
      Limit: 100,
      ConsistentRead: true,
      ExpressionAttributeNames: { '#n0': 'PK', '#n1': 'n', '#n2': 'status', '#n3': 'total' },
      ExpressionAttributeValues: { ':v0': { S: 'C' }, ':v1': { N: '5' }, ':v2': { S: 'OPEN' } },
    });
  });

  it('requires a partition key value for queries', () => {
    expect(() => buildQueryScanInput(SHOP_DESC, { ...initialQueryState(), mode: 'query' })).toThrow('Partition key "PK" value is required for Query');
  });
});

function Harness() {
  const [s, setS] = useState(initialQueryState());
  Harness.state = s;
  return <QueryScanForm desc={SHOP_DESC} state={s} setState={setS} />;
}

describe('<QueryScanForm>', () => {
  it('switches modes and indexes and edits key conditions', () => {
    render(<Harness />);
    expect(screen.queryByText('Partition')).toBeNull();
    fireEvent.click(screen.getByText('Query'));
    expect(Harness.state.mode).toBe('query');
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'C1' } });
    fireEvent.change(screen.getByPlaceholderText('value (optional)'), { target: { value: 'A' } });
    fireEvent.change(screen.getByDisplayValue('='), { target: { value: 'between' } });
    fireEvent.change(screen.getByPlaceholderText('and'), { target: { value: 'Z' } });
    fireEvent.click(screen.getByLabelText('Descending'));
    fireEvent.click(screen.getByLabelText('Strongly consistent'));
    expect(Harness.state).toMatchObject({ pk: 'C1', sk: 'A', sk2: 'Z', skOp: 'between', forward: false, consistent: true });

    fireEvent.change(screen.getByDisplayValue('Table: Shop'), { target: { value: 'GSI1' } });
    expect(Harness.state).toMatchObject({ index: 'GSI1', consistent: false });
    expect(screen.getByLabelText('Strongly consistent')).toBeDisabled();
    expect(screen.queryByPlaceholderText('value (optional)')).toBeNull(); // GSI1 has no sort key

    fireEvent.change(screen.getByPlaceholderText('all attributes'), { target: { value: 'a,b' } });
    fireEvent.change(screen.getByDisplayValue('100'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('+ Add filter condition'));
    expect(Harness.state).toMatchObject({ projection: 'a,b', limit: '5' });
    expect(Harness.state.filters).toHaveLength(1);
    fireEvent.click(screen.getByText('Scan'));
    expect(screen.queryByLabelText('Descending')).toBeNull();
  });

  it('compact layout uses two columns', () => {
    const { container } = render(<QueryScanForm desc={SHOP_DESC} state={initialQueryState()} setState={() => {}} compact />);
    expect(container.querySelector('.grid-2')).not.toBeNull();
  });
});
