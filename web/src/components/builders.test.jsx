import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ConditionRows, UpdateRows, KeyInputs, AttributeRows, newCondRow, newUpdateRow, keyFromInputs, avToRow, rowToAV, rowsToItem, itemToRows,
} from './builders.jsx';

// Renders a controlled builder and exposes the latest rows.
function Harness({ Comp, initial, ...props }) {
  const [rows, setRows] = useState(initial);
  Harness.rows = rows;
  return <Comp rows={rows} onChange={setRows} {...props} />;
}

describe('row conversion', () => {
  it('avToRow handles scalars, sets, maps and lossy maps', () => {
    expect(avToRow('a', { S: 'x' })).toMatchObject({ name: 'a', type: 'S', value: 'x' });
    expect(avToRow('a', { N: '1' })).toMatchObject({ type: 'N', value: '1' });
    expect(avToRow('a', { B: 'aGk=' })).toMatchObject({ type: 'B', value: 'aGk=' });
    expect(avToRow('a', { BOOL: false })).toMatchObject({ type: 'BOOL', value: 'false' });
    expect(avToRow('a', { NULL: true })).toMatchObject({ type: 'NULL', value: '' });
    expect(avToRow('a', { SS: ['x'] })).toMatchObject({ type: 'SS', value: '["x"]' });
    expect(avToRow('a', { M: { k: { N: '1' } } })).toMatchObject({ type: 'M', value: '{\n  "k": 1\n}' });
    expect(avToRow('a', { L: [{ S: 'x' }] })).toMatchObject({ type: 'L', value: '[\n  "x"\n]' });
    // Set nested in a map cannot be represented as plain JSON -> raw DynamoDB JSON
    expect(avToRow('a', { M: { s: { SS: ['x'] } } })).toMatchObject({ type: 'RAW', value: JSON.stringify({ M: { s: { SS: ['x'] } } }, null, 2) });
  });

  it('rowToAV parses each type and reports errors with the attribute name', () => {
    expect(rowToAV({ name: 'm', type: 'M', value: '{"a":1}' })).toEqual({ M: { a: { N: '1' } } });
    expect(rowToAV({ name: 'm', type: 'M', value: '' })).toEqual({ M: {} });
    expect(rowToAV({ name: 'l', type: 'L', value: '' })).toEqual({ L: [] });
    expect(rowToAV({ name: 'r', type: 'RAW', value: '{"NS":["1"]}' })).toEqual({ NS: ['1'] });
    expect(rowToAV({ name: 's', type: 'SS', value: 'a,b' })).toEqual({ SS: ['a', 'b'] });
    expect(rowToAV({ name: 'n', type: 'N', value: '5' })).toEqual({ N: '5' });
    expect(() => rowToAV({ name: 'm', type: 'M', value: '[1]' })).toThrow('attribute "m": expected a JSON object');
    expect(() => rowToAV({ name: 'm', type: 'M', value: 'null' })).toThrow(/JSON object/);
    expect(() => rowToAV({ name: 'l', type: 'L', value: '{}' })).toThrow(/JSON array/);
    expect(() => rowToAV({ name: 'r', type: 'RAW', value: '{"x":1}' })).toThrow(/DynamoDB JSON/);
    expect(() => rowToAV({ name: 's', type: 'SS', value: '' })).toThrow(/cannot be empty/);
    expect(() => rowToAV({ name: 's', type: 'NS', value: '1,1' })).toThrow(/duplicates/);
    expect(() => rowToAV({ name: 'n', type: 'N', value: 'x' })).toThrow('attribute "n": "x" is not a valid number');
  });

  it('rowsToItem trims names, skips blanks and rejects duplicates', () => {
    expect(rowsToItem([{ name: ' a ', type: 'S', value: 'x' }, { name: '', type: 'S', value: 'y' }])).toEqual({ a: { S: 'x' } });
    expect(() => rowsToItem([{ name: 'a', type: 'S' }, { name: 'a', type: 'S' }])).toThrow('Duplicate attribute "a"');
  });

  it('itemToRows puts locked key rows first, with placeholders for missing keys', () => {
    const rows = itemToRows({ x: { S: '1' }, pk: { S: 'p' } }, ['pk', 'sk'], { sk: 'N' });
    expect(rows.map((r) => [r.name, r.type, r.value, !!r.locked])).toEqual([
      ['pk', 'S', 'p', true],
      ['sk', 'N', '', true],
      ['x', 'S', '1', false],
    ]);
    expect(itemToRows(null, ['id']).map((r) => r.type)).toEqual(['S']);
    expect(itemToRows(undefined)).toEqual([]);
  });

  it('keyFromInputs builds typed keys and validates', () => {
    const keys = { pk: 'pk', sk: 'n', pkType: 'S', skType: 'N' };
    expect(keyFromInputs(keys, { pk: 'a', n: '3' })).toEqual({ pk: { S: 'a' }, n: { N: '3' } });
    expect(keyFromInputs({ pk: 'id', pkType: 'S' }, { id: 'x' })).toEqual({ id: { S: 'x' } });
    expect(() => keyFromInputs({ pk: null }, {})).toThrow('Select a table');
    expect(() => keyFromInputs(keys, { pk: 'a' })).toThrow('Key attribute "n" is required');
    expect(() => keyFromInputs(keys, { pk: '', n: '1' })).toThrow(/"pk"/);
  });

  it('new row factories', () => {
    expect(newCondRow()).toMatchObject({ join: 'AND', op: '=', type: 'S', value: '' });
    expect(newUpdateRow()).toMatchObject({ action: 'set', type: 'S' });
  });
});

describe('<ConditionRows>', () => {
  it('adds, edits and removes rows; adapts inputs to operator', () => {
    render(<Harness Comp={ConditionRows} initial={[]} title="Filter" />);
    fireEvent.click(screen.getByText('+ Add filter condition'));
    fireEvent.click(screen.getByText('+ Add filter condition'));
    expect(Harness.rows).toHaveLength(2);

    const attrs = screen.getAllByPlaceholderText('attribute name');
    fireEvent.change(attrs[0], { target: { value: 'age' } });
    const [op1] = screen.getAllByDisplayValue('=');
    fireEvent.change(op1, { target: { value: 'between' } });
    expect(screen.getByPlaceholderText('and')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('and'), { target: { value: '9' } });
    fireEvent.change(screen.getAllByPlaceholderText('value')[0], { target: { value: '1' } });
    fireEvent.change(screen.getAllByDisplayValue('String')[0], { target: { value: 'N' } });

    fireEvent.change(screen.getByDisplayValue('AND'), { target: { value: 'OR' } });
    expect(Harness.rows[0]).toMatchObject({ attr: 'age', op: 'between', value: '1', value2: '9', type: 'N' });
    expect(Harness.rows[1].join).toBe('OR');

    const ops = screen.getAllByRole('combobox').filter((s) => s.querySelector('option[value="exists"]'));
    fireEvent.change(ops[1], { target: { value: 'exists' } });
    expect(screen.getAllByPlaceholderText('value')).toHaveLength(1);
    fireEvent.change(ops[1], { target: { value: 'attribute_type' } });
    expect(screen.getByDisplayValue('S')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('S'), { target: { value: 'SS' } });
    expect(Harness.rows[1].value).toBe('SS');
    fireEvent.change(ops[1], { target: { value: 'size_gt' } });
    fireEvent.change(ops[0], { target: { value: '=' } });
    fireEvent.change(screen.getAllByDisplayValue('Number')[0], { target: { value: 'BOOL' } });
    fireEvent.change(screen.getByDisplayValue('true'), { target: { value: 'false' } });
    expect(Harness.rows[0].value).toBe('false');
    fireEvent.change(screen.getByDisplayValue('Boolean'), { target: { value: 'NULL' } });
    expect(screen.getByText('null')).toBeInTheDocument();

    fireEvent.click(screen.getAllByTitle('Remove')[0]);
    expect(Harness.rows).toHaveLength(1);
  });

  it('uses "condition" wording for the Condition title', () => {
    render(<ConditionRows rows={[]} onChange={vi.fn()} title="Condition" />);
    expect(screen.getByText('+ Add condition')).toBeInTheDocument();
  });

  it('uses defaults for title and join', () => {
    render(<ConditionRows rows={[newCondRow(), { ...newCondRow(), join: undefined, type: 'JSON' }]} onChange={vi.fn()} />);
    expect(screen.getByText('Filter')).toBeInTheDocument();
    expect(screen.getByDisplayValue('AND')).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('value')[1]).toHaveClass('mono');
  });
});

describe('<UpdateRows>', () => {
  it('edits actions and hides value for REMOVE', () => {
    render(<Harness Comp={UpdateRows} initial={[]} />);
    fireEvent.click(screen.getByText('+ Add update action'));
    fireEvent.change(screen.getByPlaceholderText('attribute path (a.b[0])'), { target: { value: 'n' } });
    fireEvent.change(screen.getByDisplayValue('String'), { target: { value: 'N' } });
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: '2' } });
    fireEvent.change(screen.getByDisplayValue('SET'), { target: { value: 'increment' } });
    expect(Harness.rows[0]).toMatchObject({ action: 'increment', attr: 'n', type: 'N', value: '2' });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'remove' } });
    expect(screen.queryByPlaceholderText('value')).toBeNull();
    fireEvent.click(screen.getByTitle('Remove'));
    expect(Harness.rows).toEqual([]);
  });
});

describe('<KeyInputs>', () => {
  it('renders pk/sk inputs and reports changes', () => {
    const onChange = vi.fn();
    const { rerender } = render(<KeyInputs keys={{ pk: null }} value={{}} onChange={onChange} />);
    expect(screen.getByText('Select a table')).toBeInTheDocument();
    rerender(<KeyInputs keys={{ pk: 'PK', sk: 'SK', pkType: 'S', skType: 'N' }} value={{ PK: 'a' }} onChange={onChange} />);
    expect(screen.getByText('SK · N')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('sort key value'), { target: { value: '3' } });
    expect(onChange).toHaveBeenLastCalledWith({ PK: 'a', SK: '3' });
    fireEvent.change(screen.getByPlaceholderText('partition key value'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenLastCalledWith({ PK: 'b' });
    rerender(<KeyInputs keys={{ pk: 'id', pkType: 'S' }} value={{}} onChange={onChange} />);
    expect(screen.queryByPlaceholderText('sort key value')).toBeNull();
  });
});

describe('<AttributeRows>', () => {
  it('switching types seeds sensible values, keys are locked', () => {
    const initial = itemToRows({ pk: { S: 'p' }, long: { S: 'x'.repeat(100) } }, ['pk']);
    const { container } = render(<Harness Comp={AttributeRows} initial={initial} lockKeyValues />);
    expect(screen.getByDisplayValue('pk')).toBeDisabled();
    expect(screen.getByDisplayValue('p')).toBeDisabled();
    expect(screen.getByText('key')).toBeInTheDocument();
    expect(screen.getByDisplayValue('x'.repeat(100)).tagName).toBe('TEXTAREA');

    fireEvent.click(screen.getByText('+ Add attribute'));
    const name = screen.getAllByPlaceholderText('name').at(-1);
    fireEvent.change(name, { target: { value: 'meta' } });
    const typeSel = () => [...container.querySelectorAll('.attr-row')].at(-1).querySelector('select');
    fireEvent.change(typeSel(), { target: { value: 'M' } });
    expect(Harness.rows.at(-1)).toMatchObject({ name: 'meta', type: 'M', value: '{}' });
    fireEvent.change(typeSel(), { target: { value: 'L' } });
    expect(Harness.rows.at(-1).value).toBe('{}'); // already multiline -> value kept
    fireEvent.change(typeSel(), { target: { value: 'S' } });
    fireEvent.change(typeSel(), { target: { value: 'L' } });
    expect(Harness.rows.at(-1).value).toBe('[]');
    fireEvent.change(typeSel(), { target: { value: 'S' } });
    fireEvent.change(typeSel(), { target: { value: 'RAW' } });
    expect(Harness.rows.at(-1).value).toBe('{"S": ""}');
    fireEvent.change(screen.getByDisplayValue('{"S": ""}'), { target: { value: '{"S":"z"}' } });
    fireEvent.change(typeSel(), { target: { value: 'BOOL' } });
    expect(Harness.rows.at(-1).value).toBe('true');
    fireEvent.change(screen.getByDisplayValue('true'), { target: { value: 'false' } });
    fireEvent.change(typeSel(), { target: { value: 'NULL' } });
    expect(screen.getByText('null')).toBeInTheDocument();
    fireEvent.change(typeSel(), { target: { value: 'SS' } });
    expect(screen.getByPlaceholderText('["a","b"] or a, b')).toBeInTheDocument();
    fireEvent.change(typeSel(), { target: { value: 'B' } });
    fireEvent.change(screen.getByPlaceholderText('base64'), { target: { value: 'aGk=' } });
    expect(Harness.rows.at(-1)).toMatchObject({ type: 'B', value: 'aGk=' });

    const removes = screen.getAllByText('×');
    fireEvent.click(removes.at(-1));
    expect(Harness.rows.map((r) => r.name)).toEqual(['pk', 'long']);
  });
});
