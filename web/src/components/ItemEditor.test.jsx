import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ItemEditor from './ItemEditor.jsx';

const ITEM = { pk: { S: 'USER#1' }, sk: { S: 'PROFILE' }, age: { N: '30' }, tags: { SS: ['a'] } };
const setup = (props = {}) => {
  const onSave = vi.fn(async () => {});
  const onClose = vi.fn();
  const utils = render(<ItemEditor item={ITEM} keyNames={['pk', 'sk']} keyTypes={{ pk: 'S', sk: 'S' }} onSave={onSave} onClose={onClose} {...props} />);
  return { onSave, onClose, ...utils };
};
const textarea = () => screen.getByRole('textbox', { name: '' });

describe('<ItemEditor>', () => {
  it('edits an existing item via the form and saves it', async () => {
    const { onSave } = setup();
    expect(screen.getByText('Edit item')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...ITEM, age: { N: '31' } }));
  });

  it('switches between form, DynamoDB JSON and plain JSON', () => {
    setup();
    fireEvent.click(screen.getByRole('tab', { name: 'DynamoDB JSON' }));
    expect(JSON.parse(textarea().value)).toEqual(ITEM);
    fireEvent.click(screen.getByRole('tab', { name: 'Plain JSON' }));
    expect(JSON.parse(textarea().value)).toEqual({ pk: 'USER#1', sk: 'PROFILE', age: 30, tags: ['a'] });
    expect(screen.getByText(/Sets and binary are not preserved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Plain JSON' })); // no-op on same tab
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
    // tags round-tripped through plain JSON became a list
    expect(screen.getByDisplayValue('L · List')).toBeInTheDocument();
  });

  it('validates JSON input and blocks key changes for existing items', async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole('tab', { name: 'DynamoDB JSON' }));
    fireEvent.change(textarea(), { target: { value: '{bad' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getByText(/Expected property name/)).toBeInTheDocument();
    fireEvent.change(textarea(), { target: { value: '[1]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Item must be a JSON object')).toBeInTheDocument();
    fireEvent.change(textarea(), { target: { value: '{"pk":"plain"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText(/Not valid DynamoDB JSON/)).toBeInTheDocument();
    fireEvent.change(textarea(), { target: { value: JSON.stringify({ ...ITEM, pk: { S: 'OTHER' } }) } });
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getByText('Key attribute "pk" cannot be changed for an existing item')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText(/Use "Duplicate"/)).toBeInTheDocument();
    fireEvent.change(textarea(), { target: { value: JSON.stringify({ sk: { S: 'PROFILE' } }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Key attribute "pk" is required')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('×')[1]); // dismiss error
    expect(screen.queryByText('Key attribute "pk" is required')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('accepts an empty DynamoDB JSON object when switching tabs', () => {
    setup({ isNew: true, item: null });
    fireEvent.click(screen.getByRole('tab', { name: 'DynamoDB JSON' }));
    fireEvent.change(textarea(), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getAllByPlaceholderText('name')).toHaveLength(2); // key rows recreated
  });

  it('creates a new item from plain JSON', async () => {
    const { onSave } = setup({ isNew: true, item: null, title: 'Duplicate item' });
    expect(screen.getByText('Duplicate item')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Plain JSON' }));
    fireEvent.change(textarea(), { target: { value: '{"pk":"a","sk":"b","n":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ pk: { S: 'a' }, sk: { S: 'b' }, n: { N: '1' } }));
  });

  it('shows save errors and re-enables the button', async () => {
    const onSave = vi.fn().mockRejectedValue(Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }));
    setup({ onSave, isNew: true, item: { pk: { S: 'a' }, sk: { S: 'b' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }));
    expect(await screen.findByText('ConditionalCheckFailedException: The conditional request failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create item' })).not.toBeDisabled();
  });

  it('reports form errors', () => {
    setup();
    fireEvent.change(screen.getByDisplayValue('30'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('attribute "age": "abc" is not a valid number')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'DynamoDB JSON' }));
    expect(screen.getByText('attribute "age": "abc" is not a valid number')).toBeInTheDocument();
  });

  it('closes via Cancel, the × button and Escape', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByLabelText('Close'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('works with defaults (no keys)', async () => {
    const onSave = vi.fn(async () => {});
    render(<ItemEditor item={{ a: { S: '1' } }} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ a: { S: '1' } }));
  });
});
