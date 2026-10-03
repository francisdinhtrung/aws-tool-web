import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import TableDefEditor, { emptyDef, normalizeDef, validateDef, KeyAttrInput } from './TableDefEditor.jsx';

describe('normalizeDef', () => {
  it('drops empty sort keys and invalid LSIs without mutating the input', () => {
    const def = {
      ...emptyDef(),
      TableName: 'T',
      KeyAttributes: { PartitionKey: { AttributeName: 'pk', AttributeType: 'S' }, SortKey: { AttributeName: '', AttributeType: 'S' } },
      GlobalSecondaryIndexes: [{ IndexName: 'G1', KeyAttributes: { PartitionKey: { AttributeName: 'g' }, SortKey: { AttributeName: '' } } }],
      LocalSecondaryIndexes: [{ IndexName: 'L1', KeyAttributes: { SortKey: { AttributeName: '' } } }],
    };
    const n = normalizeDef(def);
    expect(n.KeyAttributes.SortKey).toBeUndefined();
    expect(n.GlobalSecondaryIndexes[0].KeyAttributes.SortKey).toBeUndefined();
    expect(n.LocalSecondaryIndexes).toBeUndefined();
    expect(def.KeyAttributes.SortKey).toBeDefined();
    expect(normalizeDef({ ...def, LocalSecondaryIndexes: [{ IndexName: 'L', KeyAttributes: { SortKey: { AttributeName: 'd' } } }] }).LocalSecondaryIndexes).toHaveLength(1);
    expect(normalizeDef({ KeyAttributes: { PartitionKey: { AttributeName: 'p' } } }).GlobalSecondaryIndexes).toEqual([]);
  });
});

describe('validateDef', () => {
  const ok = { ...emptyDef(), TableName: 'Orders' };
  it.each([
    ['valid', ok, null],
    ['short name', { ...ok, TableName: 'ab' }, /Table name/],
    ['no name', { ...ok, TableName: undefined }, /Table name/],
    ['no pk', { ...ok, KeyAttributes: { PartitionKey: { AttributeName: '' } } }, /Partition key is required/],
    ['type clash in keys', { ...ok, KeyAttributes: { PartitionKey: { AttributeName: 'a', AttributeType: 'S' }, SortKey: { AttributeName: 'a', AttributeType: 'N' } } }, /different types/],
    ['bad index name', { ...ok, GlobalSecondaryIndexes: [{ IndexName: 'x', KeyAttributes: { PartitionKey: { AttributeName: 'g' } } }] }, /Index name "x"/],
    ['missing index name', { ...ok, GlobalSecondaryIndexes: [{ KeyAttributes: {} }] }, /Index name ""/],
    ['duplicate index', { ...ok, GlobalSecondaryIndexes: [{ IndexName: 'GSI', KeyAttributes: {} }], LocalSecondaryIndexes: [{ IndexName: 'GSI', KeyAttributes: {} }] }, /Duplicate index/],
    ['index type clash', { ...ok, GlobalSecondaryIndexes: [{ IndexName: 'GSI', KeyAttributes: { PartitionKey: { AttributeName: 'pk', AttributeType: 'N' } } }] }, /different types/],
  ])('%s', (_, def, expected) => {
    const r = validateDef(def);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toMatch(expected);
  });
});

function Harness({ live, initial = { ...emptyDef(), TableName: 'T' } }) {
  const [def, setDef] = useState(initial);
  Harness.def = def;
  return <TableDefEditor def={def} onChange={setDef} live={live} />;
}

describe('<TableDefEditor>', () => {
  it('edits keys, capacity and live-only options', () => {
    render(<Harness live />);
    fireEvent.change(screen.getByPlaceholderText('MyTable'), { target: { value: 'Orders' } });
    const [pkName, skName] = screen.getAllByPlaceholderText(/attribute name|\(optional\)/);
    fireEvent.change(pkName, { target: { value: 'id' } });
    fireEvent.change(skName, { target: { value: '' } });
    expect(Harness.def.KeyAttributes).toMatchObject({ PartitionKey: { AttributeName: 'id' }, SortKey: { AttributeName: '' } });
    fireEvent.change(pkName, { target: { value: '' } });
    expect(Harness.def.KeyAttributes.PartitionKey).toEqual({ AttributeName: '', AttributeType: 'S' });
    fireEvent.change(screen.getAllByDisplayValue('String')[0], { target: { value: 'N' } });
    expect(Harness.def.KeyAttributes.PartitionKey.AttributeType).toBe('N');

    fireEvent.change(screen.getByDisplayValue('On-demand'), { target: { value: 'PROVISIONED' } });
    const [rcu, wcu] = screen.getAllByDisplayValue('5');
    fireEvent.change(rcu, { target: { value: '10' } });
    fireEvent.change(wcu, { target: { value: '20' } });
    expect(Harness.def.ProvisionedCapacitySettings.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 10, WriteCapacityUnits: 20 });

    fireEvent.change(screen.getByDisplayValue('Standard'), { target: { value: 'STANDARD_INFREQUENT_ACCESS' } });
    fireEvent.change(screen.getByDisplayValue('Disabled'), { target: { value: 'NEW_IMAGE' } });
    fireEvent.click(screen.getByLabelText('Deletion protection'));
    expect(Harness.def).toMatchObject({ TableName: 'Orders', TableClass: 'STANDARD_INFREQUENT_ACCESS', StreamViewType: 'NEW_IMAGE', DeletionProtectionEnabled: true });
    fireEvent.change(screen.getByDisplayValue('NEW_IMAGE'), { target: { value: '' } });
    expect(Harness.def.StreamViewType).toBeUndefined();
  });

  it('adds, edits and removes GSIs and LSIs', () => {
    const { container } = render(<Harness live />);
    fireEvent.click(screen.getByText('+ Global secondary index'));
    fireEvent.click(screen.getByText('+ Local secondary index'));
    expect(Harness.def.GlobalSecondaryIndexes[0].IndexName).toBe('GSI1');
    expect(Harness.def.LocalSecondaryIndexes[0].IndexName).toBe('LSI1');

    const [gsiCard, lsiCard] = container.querySelectorAll('.card-sub');
    const g = within(gsiCard);
    fireEvent.change(g.getByDisplayValue('GSI1'), { target: { value: 'ByEmail' } });
    fireEvent.change(g.getByPlaceholderText('attribute name'), { target: { value: 'email' } });
    fireEvent.change(g.getByPlaceholderText('(optional)'), { target: { value: 'created' } });
    fireEvent.change(g.getByDisplayValue('ALL'), { target: { value: 'INCLUDE' } });
    fireEvent.change(g.getByLabelText('Included attributes (comma-separated)'), { target: { value: 'a, b,' } });
    expect(Harness.def.GlobalSecondaryIndexes[0]).toMatchObject({
      IndexName: 'ByEmail',
      KeyAttributes: { PartitionKey: { AttributeName: 'email' }, SortKey: { AttributeName: 'created' } },
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['a', 'b'] },
    });
    fireEvent.change(g.getByDisplayValue('INCLUDE'), { target: { value: 'KEYS_ONLY' } });
    expect(Harness.def.GlobalSecondaryIndexes[0].Projection).toEqual({ ProjectionType: 'KEYS_ONLY' });

    const l = within(lsiCard);
    expect(l.getByDisplayValue('pk')).toBeDisabled();
    fireEvent.change(l.getByDisplayValue('LSI1'), { target: { value: 'ByDate' } });
    fireEvent.change(l.getByPlaceholderText('attribute name'), { target: { value: 'date' } });
    fireEvent.change(l.getByDisplayValue('ALL'), { target: { value: 'KEYS_ONLY' } });
    expect(Harness.def.LocalSecondaryIndexes[0]).toMatchObject({ IndexName: 'ByDate', KeyAttributes: { SortKey: { AttributeName: 'date' } } });

    fireEvent.click(l.getByText('×'));
    fireEvent.click(g.getByText('×'));
    expect(Harness.def.GlobalSecondaryIndexes).toEqual([]);
    expect(Harness.def.LocalSecondaryIndexes).toEqual([]);
  });

  it('hides live-only options for data models and tolerates missing fields', () => {
    render(<Harness initial={{ TableName: 'M', BillingMode: 'PROVISIONED' }} />);
    expect(screen.queryByText('+ Local secondary index')).toBeNull();
    expect(screen.queryByLabelText('Deletion protection')).toBeNull();
    fireEvent.click(screen.getByText('+ Global secondary index'));
    expect(Harness.def.GlobalSecondaryIndexes).toHaveLength(1);
    fireEvent.change(screen.getAllByDisplayValue('5')[0], { target: { value: '8' } });
    expect(Harness.def.ProvisionedCapacitySettings.ProvisionedThroughput.ReadCapacityUnits).toBe(8);
  });
});

describe('<KeyAttrInput>', () => {
  it('keeps the attribute name when the type changes', () => {
    let v;
    render(<KeyAttrInput label="Key" value={undefined} onChange={(x) => (v = x)} optional />);
    fireEvent.change(screen.getByDisplayValue('String'), { target: { value: 'B' } });
    expect(v).toEqual({ AttributeName: '', AttributeType: 'B' });
  });
});
