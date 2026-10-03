import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import ItemExplorer from './ItemExplorer.jsx';
import { renderWithApp, mockBackend, awsError, SHOP_DESC } from '../test/utils.jsx';

const ITEMS = [
  { PK: { S: 'CUST#1' }, SK: { S: 'PROFILE' }, name: { S: 'Alice' } },
  { PK: { S: 'CUST#1' }, SK: { S: 'ORDER#1' }, total: { N: '10' } },
];
const setup = (handlers = {}) => {
  const api = mockBackend({
    Scan: { Items: ITEMS, Count: 2, ScannedCount: 5, ConsumedCapacity: { CapacityUnits: 0.5 } },
    ...handlers,
  });
  return { api, ...renderWithApp(<ItemExplorer desc={SHOP_DESC} />) };
};
const rowOf = (text) => screen.getByText(text).closest('tr');

describe('<ItemExplorer>', () => {
  it('runs an initial scan and shows stats', async () => {
    const { api } = setup();
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Scan: 2 items (scanned 5) · 0.5 RCU · 3 ms')).toBeInTheDocument();
    expect(api.calls('Scan')[0]).toEqual({ TableName: 'Shop', Limit: 100, ReturnConsumedCapacity: 'TOTAL' });
  });

  it('runs a query, paginates with Load more and resets', async () => {
    const { api } = setup({
      Query: (b) => (b.ExclusiveStartKey ? { Items: [ITEMS[1]], Count: 1, ScannedCount: 1 } : { Items: [ITEMS[0]], Count: 1, ScannedCount: 1, LastEvaluatedKey: { PK: { S: 'CUST#1' }, SK: { S: 'PROFILE' } } }),
    });
    await screen.findByText('Alice');
    fireEvent.click(screen.getByText('Query'));
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'CUST#1' } });
    fireEvent.click(screen.getByText('Run query'));
    await waitFor(() => expect(api.calls('Query')).toHaveLength(1));
    expect(await screen.findByText('Load more')).toBeInTheDocument();
    expect(screen.queryByText('10')).toBeNull();
    fireEvent.click(screen.getByText('Load more'));
    expect(await screen.findByText('10')).toBeInTheDocument();
    expect(api.calls('Query')[1].ExclusiveStartKey).toEqual({ PK: { S: 'CUST#1' }, SK: { S: 'PROFILE' } });
    expect(screen.getByText(/Query: 2 items · 0 RCU/)).toBeInTheDocument();
    expect(screen.queryByText('Load more')).toBeNull();
    fireEvent.click(screen.getByText('Reset'));
    expect(screen.getByText('Run scan')).toBeInTheDocument();
  });

  it('shows validation and AWS errors', async () => {
    setup({ Scan: () => { throw awsError('AccessDeniedException', 'not authorized'); } });
    expect(await screen.findByText('AccessDeniedException: not authorized')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Query'));
    fireEvent.click(screen.getByText('Run query'));
    expect(await screen.findByText(/Partition key "PK" value is required/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Generate code'));
    expect(screen.getAllByText(/Partition key "PK" value is required/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText('×')[0]);
  });

  it('creates an item with a not-exists condition', async () => {
    const { api } = setup({ PutItem: {} });
    await screen.findByText('Alice');
    fireEvent.click(screen.getByText('+ Create item'));
    const d = within(screen.getByRole('dialog'));
    const [pk, sk] = d.getAllByRole('textbox').slice(0, 4).filter((el) => !el.disabled);
    fireEvent.change(pk, { target: { value: 'CUST#9' } });
    fireEvent.change(sk, { target: { value: 'PROFILE' } });
    fireEvent.click(d.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(api.calls('PutItem')).toHaveLength(1));
    expect(api.calls('PutItem')[0]).toEqual({
      TableName: 'Shop',
      Item: { PK: { S: 'CUST#9' }, SK: { S: 'PROFILE' } },
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': 'PK' },
    });
    expect(await screen.findByText('Item created')).toBeInTheDocument();
    expect(screen.getByText('CUST#9')).toBeInTheDocument();
  });

  it('edits an item in place and duplicates one', async () => {
    const { api } = setup({ PutItem: {} });
    await screen.findByText('Alice');
    fireEvent.click(within(rowOf('Alice')).getByRole('button', { name: 'CUST#1' }));
    let d = within(screen.getByRole('dialog'));
    fireEvent.change(d.getByDisplayValue('Alice'), { target: { value: 'Alicia' } });
    fireEvent.click(d.getByText('Save changes'));
    expect(await screen.findByText('Alicia')).toBeInTheDocument();
    expect(api.calls('PutItem')[0].ConditionExpression).toBeUndefined();

    fireEvent.click(within(rowOf('10')).getByText('Duplicate'));
    d = within(screen.getByRole('dialog'));
    expect(d.getByText('Duplicate item')).toBeInTheDocument();
    fireEvent.change(d.getByDisplayValue('ORDER#1'), { target: { value: 'ORDER#2' } });
    fireEvent.click(d.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(api.calls('PutItem')).toHaveLength(2));
    expect(api.calls('PutItem')[1].Item.SK).toEqual({ S: 'ORDER#2' });
  });

  it('closes the editor', async () => {
    setup();
    await screen.findByText('Alice');
    fireEvent.click(screen.getByText('+ Create item'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('deletes one item and handles delete errors', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const { api } = setup({ DeleteItem: {} });
    await screen.findByText('Alice');
    fireEvent.click(within(rowOf('Alice')).getByText('Delete'));
    expect(api.calls('DeleteItem')).toHaveLength(0);
    fireEvent.click(within(rowOf('Alice')).getByText('Delete'));
    await waitFor(() => expect(screen.queryByText('Alice')).toBeNull());
    expect(api.calls('DeleteItem')[0]).toEqual({ TableName: 'Shop', Key: { PK: { S: 'CUST#1' }, SK: { S: 'PROFILE' } } });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('reports a failed single delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup({ DeleteItem: () => { throw awsError('ConditionalCheckFailedException', 'nope'); } });
    await screen.findByText('Alice');
    fireEvent.click(within(rowOf('Alice')).getByText('Delete'));
    expect(await screen.findByText('ConditionalCheckFailedException: nope')).toBeInTheDocument();
  });

  it('deletes selected items in a batch', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const { api } = setup({ BatchWriteItem: {} });
    await screen.findByText('Alice');
    const bar = within(document.querySelector('.results-bar'));
    expect(bar.getByRole('button', { name: 'Delete' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Select all'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete (2)' }));
    expect(api.calls('BatchWriteItem')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Delete (2)' }));
    expect(await screen.findByText('Deleted 2 item(s)')).toBeInTheDocument();
    expect(api.calls('BatchWriteItem')[0].RequestItems.Shop).toHaveLength(2);
    expect(screen.getByText('No items')).toBeInTheDocument();
  });

  it('reports batch delete errors', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup({ BatchWriteItem: () => { throw awsError('ProvisionedThroughputExceededException', 'slow down'); } });
    await screen.findByText('Alice');
    fireEvent.click(within(rowOf('Alice')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete (1)' }));
    expect(await screen.findByText('ProvisionedThroughputExceededException: slow down')).toBeInTheDocument();
  });

  it('exports results (all or selected) in three formats', async () => {
    setup();
    await screen.findByText('Alice');
    const exp = () => screen.getByDisplayValue(/Export (results|selected)…/);
    for (const v of ['csv', 'json', 'ddb', '']) fireEvent.change(exp(), { target: { value: v } });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(3);
    fireEvent.click(within(rowOf('Alice')).getByRole('checkbox'));
    fireEvent.change(exp(), { target: { value: 'json' } });
    const blob = URL.createObjectURL.mock.calls.at(-1)[0];
    expect(JSON.parse(await blob.text())).toEqual([{ PK: 'CUST#1', SK: 'PROFILE', name: 'Alice' }]);
  });

  it('switches result views and shows generated code', async () => {
    setup();
    await screen.findByText('Alice');
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    expect(screen.getByText(/"name": "Alice"/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Generate code'));
    const d = within(screen.getByRole('dialog'));
    expect(d.getByText(/client.scan/)).toBeInTheDocument();
    fireEvent.click(d.getByText('AWS CLI'));
    expect(d.getByText(/aws dynamodb scan/)).toBeInTheDocument();
    fireEvent.click(d.getByLabelText('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('handles responses without Items', async () => {
    setup({ Scan: {} });
    expect(await screen.findByText('No items')).toBeInTheDocument();
    expect(screen.getByText(/Scan: 0 items · 0 RCU/)).toBeInTheDocument();
  });
});
