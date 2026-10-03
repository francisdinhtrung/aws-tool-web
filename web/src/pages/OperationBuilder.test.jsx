import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import OperationBuilder from './OperationBuilder.jsx';
import { clearDescCache } from '../lib/ops.js';
import { renderWithApp, mockBackend, awsError, SHOP_DESC } from '../test/utils.jsx';

const USERS_DESC = { TableName: 'Users', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'N' }] };
const setup = (handlers = {}) => {
  const api = mockBackend({
    DescribeTable: (b) => {
      if (b.TableName === 'Shop') return { Table: SHOP_DESC };
      if (b.TableName === 'Users') return { Table: USERS_DESC };
      throw awsError('ResourceNotFoundException', 'Requested resource not found');
    },
    ...handlers,
  });
  return { api, ...renderWithApp(<OperationBuilder />, { tables: ['Shop', 'Users', 'Missing'] }) };
};
const pickOp = (name) => fireEvent.click(within(document.querySelector('.ops-list')).getByRole('button', { name }));
const pickTable = async (name, scope = screen, index = 0) => {
  fireEvent.change(scope.getAllByDisplayValue('— select table —')[index], { target: { value: name } });
  await scope.findAllByText(name === 'Users' ? /id/ : /PK/);
};
const request = () => JSON.parse(within(document.querySelector('.code-wrap')).getByText(/^\{/).textContent);
const run = () => fireEvent.click(screen.getByRole('button', { name: 'Run' }));

beforeEach(() => clearDescCache());

describe('<OperationBuilder> item operations', () => {
  it('GetItem with projection and consistent read', async () => {
    const { api } = setup({ GetItem: { Item: { PK: { S: 'A' }, SK: { S: 'B' }, x: { N: '1' } } } });
    expect(screen.getByText('Select a table', { selector: '.muted' })).toBeInTheDocument();
    expect(screen.getByText('// Select a table')).toBeInTheDocument();
    await pickTable('Shop');
    expect(screen.getByText(/Key attribute "PK" is required/, { selector: '.muted' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('partition key value'), { target: { value: 'A' } });
    fireEvent.change(screen.getByPlaceholderText('sort key value'), { target: { value: 'B' } });
    fireEvent.change(screen.getByPlaceholderText('all attributes'), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText('Strongly consistent read'));
    expect(request()).toEqual({
      TableName: 'Shop', Key: { PK: { S: 'A' }, SK: { S: 'B' } }, ProjectionExpression: '#n0', ConsistentRead: true, ExpressionAttributeNames: { '#n0': 'x' },
    });
    run();
    expect(await screen.findByText(/Completed in 3 ms/)).toBeInTheDocument();
    expect(api.calls('GetItem')).toHaveLength(1);
    expect(screen.getAllByText('A').length).toBeGreaterThan(0);
  });

  it('GetItem reports a missing item and shows code for each language', async () => {
    setup({ GetItem: {} });
    await pickTable('Users');
    fireEvent.change(screen.getByPlaceholderText('partition key value'), { target: { value: '7' } });
    run();
    expect(await screen.findByText('Item not found.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Python (boto3)' }));
    expect(screen.getByText(/client.get_item/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'JavaScript (SDK v3)' }));
    expect(screen.getByText(/GetItemCommand/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'AWS CLI' }));
    expect(screen.getByText(/aws dynamodb get-item/)).toBeInTheDocument();
  });

  it('shows describe errors for unknown tables and invalid input in code tabs', async () => {
    setup();
    fireEvent.change(screen.getByDisplayValue('— select table —'), { target: { value: 'Missing' } });
    expect(await screen.findByText('ResourceNotFoundException: Requested resource not found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'AWS CLI' }));
    expect(screen.getByText('Loading table…', { selector: 'div' })).toBeInTheDocument();
    run();
    fireEvent.click(screen.getByRole('tab', { name: 'Response' }));
    expect(screen.getByText('Loading table…', { selector: 'pre' })).toBeInTheDocument();
  });

  it('PutItem seeds key rows and supports a condition and return values', async () => {
    const { api } = setup({ PutItem: { Attributes: { PK: { S: 'old' } } } });
    pickOp('PutItem');
    await pickTable('Shop');
    expect(screen.getByDisplayValue('PK')).toBeDisabled();
    const values = document.querySelectorAll('.attr-row:not(.attr-head) input:not([disabled])');
    fireEvent.change(values[0], { target: { value: 'A' } });
    fireEvent.change(values[1], { target: { value: 'B' } });
    fireEvent.click(screen.getByText('+ Add condition'));
    fireEvent.change(screen.getByPlaceholderText('attribute name'), { target: { value: 'PK' } });
    fireEvent.change(screen.getAllByDisplayValue('=').at(-1), { target: { value: 'not_exists' } });
    fireEvent.change(screen.getByDisplayValue('NONE'), { target: { value: 'ALL_OLD' } });
    expect(request()).toEqual({
      TableName: 'Shop', Item: { PK: { S: 'A' }, SK: { S: 'B' } }, ConditionExpression: 'attribute_not_exists(#n0)', ReturnValues: 'ALL_OLD', ExpressionAttributeNames: { '#n0': 'PK' },
    });
    run();
    await waitFor(() => expect(api.calls('PutItem')).toHaveLength(1));
    expect(await screen.findByText(/"old"/)).toBeInTheDocument();
  });

  it('PutItem requires key attributes', async () => {
    setup();
    pickOp('PutItem');
    await pickTable('Shop');
    expect(screen.getByText('Key attribute "PK" is required', { selector: '.muted' })).toBeInTheDocument();
  });

  it('UpdateItem builds an update expression', async () => {
    const { api } = setup({ UpdateItem: { Attributes: { n: { N: '2' } } } });
    pickOp('UpdateItem');
    await pickTable('Users');
    fireEvent.change(screen.getByPlaceholderText('partition key value'), { target: { value: '1' } });
    expect(screen.getByText('Add at least one update action', { selector: '.muted' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('attribute path (a.b[0])'), { target: { value: 'n' } });
    fireEvent.change(screen.getByDisplayValue('SET'), { target: { value: 'add' } });
    fireEvent.change(screen.getAllByDisplayValue('String')[0], { target: { value: 'N' } });
    fireEvent.change(screen.getAllByPlaceholderText('value')[0], { target: { value: '1' } });
    fireEvent.change(screen.getByDisplayValue('NONE'), { target: { value: 'UPDATED_NEW' } });
    expect(request()).toMatchObject({ Key: { id: { N: '1' } }, UpdateExpression: 'ADD #n0 :v0', ReturnValues: 'UPDATED_NEW' });
    run();
    await waitFor(() => expect(api.calls('UpdateItem')).toHaveLength(1));
  });

  it('DeleteItem shows AWS errors with cancellation details', async () => {
    setup({ DeleteItem: () => { throw awsError('ConditionalCheckFailedException', 'The conditional request failed'); } });
    pickOp('DeleteItem');
    await pickTable('Users');
    fireEvent.change(screen.getByPlaceholderText('partition key value'), { target: { value: '1' } });
    run();
    expect(await screen.findByText('ConditionalCheckFailedException: The conditional request failed')).toBeInTheDocument();
  });

  it('keeps the table when switching between item operations', async () => {
    setup();
    await pickTable('Users');
    pickOp('DeleteItem');
    expect(screen.getByDisplayValue('Users')).toBeInTheDocument();
  });
});

describe('<OperationBuilder> query and scan', () => {
  it('builds a query and renders returned items', async () => {
    const { api } = setup({ Query: { Items: [{ PK: { S: 'A' }, SK: { S: 'ORDER#1' } }], Count: 1 } });
    pickOp('Query');
    expect(screen.getByText('Select a table', { selector: '.muted' })).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('— select table —'), { target: { value: 'Shop' } });
    expect(await screen.findByText(/Partition key "PK" value is required/, { selector: '.muted' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'A' } });
    expect(request()).toMatchObject({ TableName: 'Shop', KeyConditionExpression: '#n0 = :v0', Limit: 100 });
    run();
    expect(await screen.findByText('ORDER#1')).toBeInTheDocument();
    expect(api.calls('Query')).toHaveLength(1);
    pickOp('Scan');
    fireEvent.click(screen.getByRole('tab', { name: 'Request' }));
    expect(request()).toEqual({ TableName: 'Shop', Limit: 100 });
  });
});

describe('<OperationBuilder> batch and transactions', () => {
  it('BatchWriteItem groups put and delete requests by table', async () => {
    const { api } = setup({ BatchWriteItem: { UnprocessedItems: {} } });
    pickOp('BatchWriteItem');
    expect(screen.getByText('Add at least one action', { selector: '.muted' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('+ Add action'));
    const first = within(document.querySelectorAll('.card-sub')[0]);
    fireEvent.change(first.getByDisplayValue('— select table —'), { target: { value: 'Users' } });
    await first.findByDisplayValue('id');
    fireEvent.change(first.getAllByRole('textbox').find((el) => !el.disabled), { target: { value: '1' } });
    expect(first.queryByText('+ Add condition')).toBeNull();

    fireEvent.click(screen.getByText('+ Add action'));
    const second = within(document.querySelectorAll('.card-sub')[1]);
    expect(second.getByDisplayValue('Users')).toBeInTheDocument(); // inherits previous table
    fireEvent.change(second.getByDisplayValue('Put request'), { target: { value: 'Delete' } });
    fireEvent.change(await second.findByPlaceholderText('partition key value'), { target: { value: '2' } });
    expect(request()).toEqual({
      RequestItems: { Users: [{ PutRequest: { Item: { id: { N: '1' } } } }, { DeleteRequest: { Key: { id: { N: '2' } } } }] },
    });
    run();
    await waitFor(() => expect(api.calls('BatchWriteItem')).toHaveLength(1));

    fireEvent.click(second.getByText('×', { selector: '.card-sub-head button' }));
    expect(document.querySelectorAll('.card-sub')).toHaveLength(1);
  });

  it('BatchGetItem collects keys per table and renders responses', async () => {
    setup({ BatchGetItem: { Responses: { Users: [{ id: { N: '1' }, name: { S: 'Neo' } }] } } });
    pickOp('BatchGetItem');
    fireEvent.click(screen.getByText('+ Add action'));
    fireEvent.click(screen.getByText('+ Add action'));
    const cards = document.querySelectorAll('.card-sub');
    for (const [i, v] of [[0, '1'], [1, '2']]) {
      const c = within(cards[i]);
      fireEvent.change(c.getByDisplayValue('— select table —'), { target: { value: 'Users' } });
      fireEvent.change(await c.findByPlaceholderText('partition key value'), { target: { value: v } });
    }
    expect(screen.queryByPlaceholderText('all attributes')).toBeNull();
    expect(request()).toEqual({ RequestItems: { Users: { Keys: [{ id: { N: '1' } }, { id: { N: '2' } }] } } });
    run();
    expect(await screen.findByText('Neo')).toBeInTheDocument();
  });

  it('TransactWriteItems with condition checks and per-action errors', async () => {
    const { api } = setup({
      TransactWriteItems: () => { throw Object.assign(awsError('TransactionCanceledException', 'Transaction cancelled'), { cancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] }); },
    });
    pickOp('TransactWriteItems');
    fireEvent.click(screen.getByText('+ Add action'));
    let c = within(document.querySelectorAll('.card-sub')[0]);
    fireEvent.change(c.getByDisplayValue('Put'), { target: { value: 'ConditionCheck' } });
    fireEvent.change(c.getByDisplayValue('— select table —'), { target: { value: 'Users' } });
    fireEvent.change(await c.findByPlaceholderText('partition key value'), { target: { value: '1' } });
    expect(screen.getByText(/#1: ConditionCheck requires a condition/, { selector: '.muted' })).toBeInTheDocument();
    fireEvent.click(c.getByText('+ Add condition'));
    fireEvent.change(c.getByPlaceholderText('attribute name'), { target: { value: 'id' } });
    fireEvent.change(c.getAllByDisplayValue('=').at(-1), { target: { value: 'exists' } });
    fireEvent.click(c.getByLabelText('Return item on condition failure'));
    fireEvent.click(c.getByLabelText('Return item on condition failure'));
    fireEvent.click(c.getByLabelText('Return item on condition failure'));

    fireEvent.click(screen.getByText('+ Add action'));
    c = within(document.querySelectorAll('.card-sub')[1]);
    fireEvent.change(c.getByDisplayValue('Put'), { target: { value: 'Update' } });
    fireEvent.change(await c.findByPlaceholderText('partition key value'), { target: { value: '2' } });
    fireEvent.change(c.getByPlaceholderText('attribute path (a.b[0])'), { target: { value: 'v' } });
    fireEvent.change(c.getAllByPlaceholderText('value')[0], { target: { value: 'x' } });

    expect(request()).toEqual({
      TransactItems: [
        { ConditionCheck: { TableName: 'Users', Key: { id: { N: '1' } }, ConditionExpression: 'attribute_exists(#n0)', ReturnValuesOnConditionCheckFailure: 'ALL_OLD', ExpressionAttributeNames: { '#n0': 'id' } } },
        { Update: { TableName: 'Users', Key: { id: { N: '2' } }, UpdateExpression: 'SET #n0 = :v0', ExpressionAttributeNames: { '#n0': 'v' }, ExpressionAttributeValues: { ':v0': { S: 'x' } } } },
      ],
    });
    run();
    expect(await screen.findByText(/\[1\] ConditionalCheckFailed/)).toBeInTheDocument();
    expect(api.calls('TransactWriteItems')).toHaveLength(1);
  });

  it('TransactGetItems wraps Get actions and renders responses', async () => {
    setup({ TransactGetItems: { Responses: [{ Item: { id: { N: '1' }, name: { S: 'Trinity' } } }, {}] } });
    pickOp('TransactGetItems');
    fireEvent.click(screen.getByText('+ Add action'));
    const c = within(document.querySelector('.card-sub'));
    fireEvent.change(c.getByDisplayValue('— select table —'), { target: { value: 'Users' } });
    fireEvent.change(await c.findByPlaceholderText('partition key value'), { target: { value: '1' } });
    fireEvent.change(c.getByPlaceholderText('all attributes'), { target: { value: 'name' } });
    expect(c.queryByLabelText('Strongly consistent read')).toBeNull();
    expect(request()).toEqual({ TransactItems: [{ Get: { TableName: 'Users', Key: { id: { N: '1' } }, ProjectionExpression: '#n0', ExpressionAttributeNames: { '#n0': 'name' } } }] });
    run();
    expect(await screen.findByText('Trinity')).toBeInTheDocument();
  });
});

describe('<OperationBuilder> PartiQL and raw JSON', () => {
  it('ExecuteStatement with typed parameters, limit and consistency', async () => {
    const { api } = setup({ ExecuteStatement: { Items: [{ id: { N: '1' } }] } });
    pickOp('ExecuteStatement');
    expect(screen.getByText('Enter a statement', { selector: '.muted' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/SELECT \* FROM/), { target: { value: 'SELECT * FROM "Users" WHERE id = ?' } });
    fireEvent.click(screen.getByText('+ Parameter'));
    fireEvent.click(screen.getByText('+ Parameter'));
    fireEvent.change(screen.getAllByDisplayValue('String')[0], { target: { value: 'N' } });
    fireEvent.change(document.querySelectorAll('.builder-row input')[0], { target: { value: '1' } });
    fireEvent.click(screen.getAllByText('×').at(-1));
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText('Strongly consistent'));
    expect(request()).toEqual({ Statement: 'SELECT * FROM "Users" WHERE id = ?', Parameters: [{ N: '1' }], ConsistentRead: true, Limit: 5 });
    run();
    await waitFor(() => expect(api.calls('ExecuteStatement')).toHaveLength(1));
  });

  it('ExecuteStatement reports invalid parameters', async () => {
    setup();
    pickOp('ExecuteStatement');
    fireEvent.change(screen.getByPlaceholderText(/SELECT \* FROM/), { target: { value: 'SELECT 1' } });
    fireEvent.click(screen.getByText('+ Parameter'));
    fireEvent.change(screen.getByDisplayValue('String'), { target: { value: 'N' } });
    expect(screen.getByText(/is not a valid number/, { selector: '.muted' })).toBeInTheDocument();
  });

  it('BatchExecuteStatement and ExecuteTransaction take multiple statements', async () => {
    setup();
    pickOp('BatchExecuteStatement');
    expect(screen.getByText('Enter at least one statement', { selector: '.muted' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('+ Add statement'));
    const boxes = () => screen.getAllByPlaceholderText(/SELECT \* FROM/);
    fireEvent.change(boxes()[0], { target: { value: 'SELECT 1' } });
    fireEvent.change(boxes()[1], { target: { value: 'SELECT 2' } });
    fireEvent.click(screen.getAllByText('+ Parameter')[1]);
    fireEvent.change(document.querySelectorAll('.card-sub')[1].querySelector('.builder-row input'), { target: { value: 'p' } });
    expect(request()).toEqual({ Statements: [{ Statement: 'SELECT 1' }, { Statement: 'SELECT 2', Parameters: [{ S: 'p' }] }] });
    pickOp('ExecuteTransaction');
    expect(request()).toEqual({ TransactStatements: [{ Statement: 'SELECT 1' }, { Statement: 'SELECT 2', Parameters: [{ S: 'p' }] }] });
    fireEvent.click(within(document.querySelectorAll('.card-sub')[1]).getAllByText('×')[0]);
    expect(screen.getAllByPlaceholderText(/SELECT \* FROM/)).toHaveLength(1);
  });

  it('edits the request JSON directly', async () => {
    const { api } = setup({ ListTables: {}, GetItem: { Item: { id: { N: '1' } } } });
    fireEvent.click(screen.getByLabelText('Edit request JSON directly'));
    const box = screen.getAllByRole('textbox').find((t) => t.value.includes('{'));
    expect(box.value).toBe('{\n  \n}');
    fireEvent.change(box, { target: { value: '{"TableName":"Users","Key":{"id":{"N":"1"}}}' } });
    run();
    await waitFor(() => expect(api.calls('GetItem')).toEqual([{ TableName: 'Users', Key: { id: { N: '1' } } }]));
    fireEvent.change(box, { target: { value: '{oops' } });
    run();
    expect(await screen.findByText(/JSON/, { selector: 'pre' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Edit request JSON directly'));
    expect(screen.getByDisplayValue('— select table —')).toBeInTheDocument();
  });

  it('starts raw mode from a valid generated request', async () => {
    setup();
    await pickTable('Users');
    fireEvent.change(screen.getByPlaceholderText('partition key value'), { target: { value: '3' } });
    fireEvent.click(screen.getByLabelText('Edit request JSON directly'));
    const box = screen.getAllByRole('textbox').find((t) => t.value.includes('TableName'));
    expect(JSON.parse(box.value)).toEqual({ TableName: 'Users', Key: { id: { N: '3' } } });
  });

  it('shows a placeholder before anything ran', () => {
    setup();
    fireEvent.click(screen.getByRole('tab', { name: 'Response' }));
    expect(screen.getByText('Run the operation to see the response.')).toBeInTheDocument();
  });
});
