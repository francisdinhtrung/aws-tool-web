import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import Modeler from './Modeler.jsx';
import { clearDescCache } from '../lib/ops.js';
import { renderWithApp, mockBackend, awsError, SHOP_DESC } from '../test/utils.jsx';

const MODEL = {
  ModelName: 'Shop',
  ModelMetadata: { Description: 'single table', DateLastModified: '2026-01-01' },
  DataModel: [
    {
      TableName: 'Shop',
      KeyAttributes: { PartitionKey: { AttributeName: 'PK', AttributeType: 'S' }, SortKey: { AttributeName: 'SK', AttributeType: 'S' } },
      NonKeyAttributes: [{ AttributeName: 'total', AttributeType: 'N' }],
      GlobalSecondaryIndexes: [{ IndexName: 'GSI1', KeyAttributes: { PartitionKey: { AttributeName: 'GSI1PK', AttributeType: 'S' } }, Projection: { ProjectionType: 'ALL' } }],
      TableFacets: [{ FacetName: 'Order', KeyAttributeAlias: { PartitionKeyAlias: 'CustomerId', SortKeyAlias: 'OrderId' }, NonKeyAttributes: ['total'] }],
      TableData: [
        { PK: { S: 'C#1' }, SK: { S: 'ORDER#1' }, total: { N: '5' }, GSI1PK: { S: 'O1' } },
        { PK: { S: 'C#1' }, SK: { S: 'PROFILE' }, name: { S: 'Ann' } },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    },
    { TableName: 'Logs' },
  ],
};
const editor = (handlers = {}, ctx = {}) => {
  const api = mockBackend({ 'GET /api/models/:id': structuredClone(MODEL), 'PUT /api/models/:id': { ok: true }, ...handlers });
  return { api, ...renderWithApp(<Modeler id="m1" />, ctx) };
};
const tab = (re) => fireEvent.click(screen.getByRole('tab', { name: re }));
const fileInput = (scope = document) => scope.querySelector('input[type=file]');
const exportSel = () => screen.getByDisplayValue('Export…');
const titleInput = async (value) => {
  await waitFor(() => expect(document.querySelector('.title-input')).toHaveValue(value));
  return document.querySelector('.title-input');
};

beforeEach(() => clearDescCache());

describe('model list', () => {
  it('shows an empty state, creates and imports models', async () => {
    const api = mockBackend({ 'GET /api/models': [], 'POST /api/models': { id: 'new1' } });
    renderWithApp(<Modeler />);
    expect(await screen.findByText(/No data models yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('+ New data model'));
    await waitFor(() => expect(window.location.hash).toBe('#/modeler/new1'));
    expect(api.calls('POST /api/models')[0]).toMatchObject({ ModelName: 'New data model', DataModel: [] });

    fireEvent.change(fileInput(), { target: { files: [new File([JSON.stringify([{ TableName: 'Bare' }])], 'arr.json')] } });
    expect(await screen.findByText('Imported Imported model')).toBeInTheDocument();
    const imported = api.calls('POST /api/models')[1];
    expect(imported.DataModel[0]).toMatchObject({ TableName: 'Bare', BillingMode: 'PROVISIONED', TableData: [], KeyAttributes: { PartitionKey: { AttributeName: 'pk' } } });

    fireEvent.change(fileInput(), { target: { files: [new File(['{"nope":1}'], 'bad.json')] } });
    expect(await screen.findByText('Import failed: Not a NoSQL Workbench data model (missing "DataModel")')).toBeInTheDocument();
  });

  it('lists models and reports errors', async () => {
    mockBackend({
      'GET /api/models': [{ id: 'a', name: 'Alpha', description: 'desc', tables: 2, updated: '2026-01-01T00:00:00Z' }, { id: 'b', name: 'Beta', description: '', tables: 0, updated: '' }],
      'POST /api/models': () => { throw awsError('Error', 'disk full', 500); },
    });
    renderWithApp(<Modeler />);
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('No description')).toBeInTheDocument();
    expect(screen.getByText(/2 table\(s\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('+ New data model'));
    expect(await screen.findByText('disk full')).toBeInTheDocument();
  });

  it('shows list load errors', async () => {
    mockBackend({ 'GET /api/models': () => { throw awsError('Error', 'offline', 500); } });
    renderWithApp(<Modeler />);
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });
});

describe('model editor', () => {
  it('loads, edits metadata and saves with the button and Ctrl/Cmd+S', async () => {
    const { api } = editor();
    const title = await titleInput('Shop');
    expect(screen.getByText('Save ⌘S')).toBeDisabled();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true }); // not dirty: ignored
    expect(api.calls('PUT /api/models/m1')).toHaveLength(0);
    fireEvent.change(title, { target: { value: 'Shop v2' } });
    fireEvent.change(screen.getByDisplayValue('single table'), { target: { value: 'updated' } });
    expect(screen.getByText('unsaved')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(await screen.findByText('Model saved')).toBeInTheDocument();
    const saved = api.calls('PUT /api/models/m1')[0];
    expect(saved.ModelName).toBe('Shop v2');
    expect(saved.ModelMetadata.Description).toBe('updated');
    expect(saved.ModelMetadata.DateLastModified).not.toBe('2026-01-01');
    expect(screen.queryByText('unsaved')).toBeNull();
  });

  it('warns before leaving with unsaved changes and reports save errors', async () => {
    editor({ 'PUT /api/models/:id': () => { throw awsError('InvalidId', 'Invalid id'); } });
    const title = await titleInput('Shop');
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.change(title, { target: { value: 'X' } });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByText('Save ⌘S'));
    expect(await screen.findByText('InvalidId: Invalid id')).toBeInTheDocument();
  });

  it('shows load errors', async () => {
    editor({ 'GET /api/models/:id': () => { throw awsError('ModelNotFound', 'Model not found', 404); } });
    expect(await screen.findByText('ModelNotFound: Model not found')).toBeInTheDocument();
    expect(screen.getByText('← Back')).toBeInTheDocument();
  });

  it('edits the schema, non-key attributes and removes tables', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    editor();
    await titleInput('Shop');
    fireEvent.click(screen.getByText('Logs'));
    expect(screen.getByPlaceholderText('MyTable')).toHaveValue('Logs');
    fireEvent.change(screen.getByPlaceholderText('MyTable'), { target: { value: 'x' } });
    expect(screen.getByText(/Table name must be/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Shop', { selector: '.modeler-tables button' }));

    const attrs = () => document.querySelectorAll('.modeler-main .builder .builder-row');
    fireEvent.click(screen.getByText('+ Add attribute'));
    fireEvent.change(attrs()[1].querySelector('input'), { target: { value: 'status' } });
    fireEvent.change(attrs()[1].querySelector('select'), { target: { value: 'BOOL' } });
    fireEvent.click(attrs()[1].querySelector('button'));
    expect(attrs()).toHaveLength(1);
    fireEvent.click(screen.getByText('Infer from sample data'));
    expect([...attrs()].map((r) => r.querySelector('input').value)).toEqual(['total', 'GSI1PK', 'name']);

    fireEvent.click(screen.getByText('Remove table from model'));
    expect(screen.getAllByRole('button', { name: /Shop|Logs|x/ }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Remove table from model'));
    expect(screen.queryByText('Shop', { selector: '.modeler-tables button' })).toBeNull();

    fireEvent.click(screen.getByText('+ Add table'));
    expect(screen.getByPlaceholderText('MyTable')).toHaveValue('Table2');
  });

  it('shows an empty state when there are no tables', async () => {
    editor({ 'GET /api/models/:id': { ModelName: 'Empty', DataModel: [] } });
    expect(await screen.findByText('Add a table to start modeling.')).toBeInTheDocument();
    expect(screen.getByText('Commit to DynamoDB')).toBeDisabled();
  });

  it('edits facets', async () => {
    editor();
    await titleInput('Shop');
    tab(/Facets/);
    const facet = within(document.querySelector('.card-sub'));
    fireEvent.change(facet.getByDisplayValue('Order'), { target: { value: 'Orders' } });
    fireEvent.change(facet.getByDisplayValue('CustomerId'), { target: { value: 'Customer' } });
    fireEvent.change(facet.getByDisplayValue('OrderId'), { target: { value: 'Order' } });
    fireEvent.click(facet.getByLabelText('total'));
    expect(facet.getByLabelText('total')).not.toBeChecked();
    fireEvent.click(facet.getByLabelText('total'));
    expect(facet.getByLabelText('total')).toBeChecked();
    fireEvent.click(screen.getByText('+ Add facet'));
    expect(screen.getByDisplayValue('Facet2')).toBeInTheDocument();
    fireEvent.click(within(document.querySelectorAll('.card-sub')[1]).getByText('×'));
    expect(screen.getByRole('tab', { name: 'Facets (1)' })).toBeInTheDocument();
    tab(/Visualizer/);
    fireEvent.change(screen.getByDisplayValue('All facets'), { target: { value: 'Orders' } });
    expect(screen.getByText('Partition key: Customer')).toBeInTheDocument();
  });

  it('facets for a table without sort key or attributes', async () => {
    editor({ 'GET /api/models/:id': { ModelName: 'M', DataModel: [{ TableName: 'Simple', TableFacets: [{ FacetName: 'F' }] }] } });
    await titleInput('M');
    tab(/Facets/);
    expect(screen.getByText('Define non-key attributes first.')).toBeInTheDocument();
    expect(screen.queryByText(/Sort key alias/)).toBeNull();
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'alias' } });
  });

  it('manages sample data', async () => {
    editor();
    await titleInput('Shop');
    tab(/Sample data/);
    expect(screen.getByText('2 items')).toBeInTheDocument();

    fireEvent.click(screen.getByText('+ Add item'));
    let d = within(screen.getByRole('dialog'));
    const [pk, sk] = d.getAllByRole('textbox').filter((t) => !t.disabled);
    fireEvent.change(pk, { target: { value: 'C#1' } });
    fireEvent.change(sk, { target: { value: 'PROFILE' } });
    fireEvent.click(d.getByRole('button', { name: 'Create item' }));
    expect(await d.findByText(/already exists in the sample data/)).toBeInTheDocument();
    fireEvent.change(sk, { target: { value: 'ORDER#2' } });
    fireEvent.click(d.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(screen.getByText('3 items')).toBeInTheDocument());
    expect(screen.getByText('ORDER#2')).toBeInTheDocument();
  });

  it('edits, imports, exports and deletes sample items', async () => {
    editor();
    await titleInput('Shop');
    tab(/Sample data/);
    fireEvent.click(screen.getAllByRole('button', { name: 'C#1' })[1]);
    const d = within(screen.getByRole('dialog'));
    fireEvent.change(d.getByDisplayValue('Ann'), { target: { value: 'Anna' } });
    fireEvent.click(d.getByText('Save changes'));
    expect(await screen.findByText('Anna')).toBeInTheDocument();

    fireEvent.change(fileInput(document.querySelector('.modeler-main')), { target: { files: [new File(['PK,SK\nC#2,PROFILE'], 'x.csv')] } });
    expect(await screen.findByText('Added 1 items')).toBeInTheDocument();
    fireEvent.change(fileInput(document.querySelector('.modeler-main')), { target: { files: [new File(['[{"PK":"C#3","SK":"P"}]'], 'x.json')] } });
    expect(await screen.findByText('4 items')).toBeInTheDocument();
    fireEvent.change(fileInput(document.querySelector('.modeler-main')), { target: { files: [new File(['{bad'], 'bad.json')] } });
    expect(await screen.findByText(/JSON/, { selector: '.toast' })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Export CSV'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Select all'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete (4)' }));
    expect(screen.getByText('0 items')).toBeInTheDocument();
    expect(screen.getByText('Export CSV')).toBeDisabled();
  });

  it('closes the sample item editor', async () => {
    editor();
    await titleInput('Shop');
    tab(/Sample data/);
    fireEvent.click(screen.getByText('+ Add item'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('exports the model and CloudFormation', async () => {
    editor();
    await titleInput('Shop');
    fireEvent.change(exportSel(), { target: { value: 'json' } });
    expect(HTMLAnchorElement.prototype.click.mock.contexts.at(-1).download).toBe('Shop.json');
    fireEvent.change(exportSel(), { target: { value: 'cfn' } });
    expect(HTMLAnchorElement.prototype.click.mock.contexts.at(-1).download).toBe('Shop.cfn.json');
    const cfn = JSON.parse(await URL.createObjectURL.mock.calls.at(-1)[0].text());
    expect(Object.keys(cfn.Resources)).toEqual(['Shop', 'Logs']);
    fireEvent.change(exportSel(), { target: { value: 'cfnview' } });
    expect(screen.getByText('CloudFormation template')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close'));
    fireEvent.change(exportSel(), { target: { value: '' } });
  });

  it('deletes the model after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const { api } = editor({ 'DELETE /api/models/:id': { ok: true } });
    await titleInput('Shop');
    fireEvent.click(screen.getByText('Delete model'));
    fireEvent.click(screen.getByText('Delete model'));
    await waitFor(() => expect(window.location.hash).toBe('#/modeler'));
    expect(api.log.filter((l) => l.key === 'DELETE /api/models/m1')).toHaveLength(1);
  });
});

describe('commit to DynamoDB', () => {
  it('creates missing tables, skips existing ones and writes sample data', async () => {
    let shopExists = false;
    const { api, ctx } = editor({
      DescribeTable: (b) => {
        if (b.TableName === 'Logs') return { Table: { TableName: 'Logs', TableStatus: 'ACTIVE' } };
        if (!shopExists) throw awsError('ResourceNotFoundException', 'not found');
        return { Table: { ...SHOP_DESC, TableStatus: 'ACTIVE' } };
      },
      CreateTable: () => { shopExists = true; return {}; },
      BatchWriteItem: {},
    });
    await titleInput('Shop');
    fireEvent.click(screen.getByText('Commit to DynamoDB'));
    const d = within(screen.getByRole('dialog'));
    expect(d.getByText('Local')).toBeInTheDocument();
    fireEvent.click(d.getByRole('button', { name: 'Commit' }));
    expect(await d.findByText('Done.')).toBeInTheDocument();
    expect(d.getByText('Shop: 2 items written')).toBeInTheDocument();
    expect(d.getByText('Logs: already exists, skipping creation')).toHaveClass('log-warn');
    expect(api.calls('CreateTable')).toHaveLength(1);
    expect(api.calls('CreateTable')[0]).toMatchObject({ TableName: 'Shop', BillingMode: 'PAY_PER_REQUEST' });
    expect(ctx.reloadTables).toHaveBeenCalled();
    fireEvent.click(d.getByText('Close'));
  });

  it('respects checkboxes and reports per-table errors', async () => {
    const { api } = editor(
      {
        'GET /api/models/:id': {
          ...structuredClone(MODEL),
          DataModel: [...structuredClone(MODEL).DataModel, { TableName: 'ab' }, { TableName: 'Third', KeyAttributes: { PartitionKey: { AttributeName: 'id', AttributeType: 'S' } } }],
        },
        DescribeTable: () => { throw awsError('ResourceNotFoundException', 'not found'); },
      },
      { info: { label: 'dev', region: 'eu-west-1' } },
    );
    await titleInput('Shop');
    fireEvent.click(screen.getByText('Commit to DynamoDB'));
    const d = within(screen.getByRole('dialog'));
    expect(d.getByText(/Target:.*\(eu-west-1\)/)).toBeInTheDocument();
    const rows = d.getAllByRole('row').slice(1);
    // Shop: data only (table must exist); Logs: nothing; Third: create, no data
    fireEvent.click(within(rows[0]).getAllByRole('checkbox')[0]);
    within(rows[1]).getAllByRole('checkbox').forEach((c) => fireEvent.click(c));
    fireEvent.click(within(rows[3]).getAllByRole('checkbox')[1]);
    fireEvent.click(d.getByRole('button', { name: 'Commit' }));
    expect(await d.findByText('Done.')).toBeInTheDocument();
    expect(d.getByText('Shop: table does not exist')).toHaveClass('log-bad');
    expect(d.getByText(/^ab: Table name must be/)).toBeInTheDocument();
    expect(document.querySelector('.log').textContent).not.toMatch(/Logs/);
    expect(api.calls('CreateTable').map((c) => c.TableName)).toEqual(['Third']);
  });

  it('requires a connection', async () => {
    editor({}, { conn: null });
    await titleInput('Shop');
    fireEvent.click(screen.getByText('Commit to DynamoDB'));
    expect(screen.getByText('Select a connection in the top bar first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });
});

describe('import from DynamoDB', () => {
  it('imports selected tables with sample items', async () => {
    const { api } = editor({ DescribeTable: { Table: SHOP_DESC }, Scan: { Items: [{ PK: { S: 'Z' }, SK: { S: 'Y' }, extra: { BOOL: true } }] } }, { tables: ['Shop', 'Other'] });
    await titleInput('Shop');
    fireEvent.click(screen.getByText('Import from DynamoDB'));
    const d = within(screen.getByRole('dialog'));
    expect(d.getByRole('button', { name: 'Import 0 table(s)' })).toBeDisabled();
    fireEvent.click(d.getByLabelText('Other'));
    fireEvent.click(d.getByLabelText('Other'));
    fireEvent.click(d.getByLabelText('Shop'));
    fireEvent.change(d.getByDisplayValue('50'), { target: { value: '10' } });
    fireEvent.click(d.getByRole('button', { name: 'Import 1 table(s)' }));
    expect(await screen.findByText('Imported 1 table(s)')).toBeInTheDocument();
    expect(api.calls('Scan')[0]).toEqual({ TableName: 'Shop', Limit: 10 });
    expect(screen.getAllByText('Shop', { selector: '.modeler-tables button' })).toHaveLength(2);
  });

  it('skips sampling at 0 and shows errors / empty states', async () => {
    const { api } = editor({ DescribeTable: () => { throw awsError('AccessDeniedException', 'denied'); } }, { tables: ['Shop'] });
    await titleInput('Shop');
    fireEvent.click(screen.getByText('Import from DynamoDB'));
    const d = within(screen.getByRole('dialog'));
    fireEvent.change(d.getByDisplayValue('50'), { target: { value: '0' } });
    fireEvent.click(d.getByLabelText('Shop'));
    fireEvent.click(d.getByRole('button', { name: 'Import 1 table(s)' }));
    expect(await d.findByText('AccessDeniedException: denied')).toBeInTheDocument();
    expect(api.calls('Scan')).toHaveLength(0);
    fireEvent.click(d.getByText('Cancel'));
  });

  it('imports without sample data', async () => {
    const { api } = editor({ DescribeTable: { Table: SHOP_DESC } }, { tables: ['Shop'] });
    await titleInput('Shop');
    fireEvent.click(screen.getByText('Import from DynamoDB'));
    const d = within(screen.getByRole('dialog'));
    fireEvent.change(d.getByDisplayValue('50'), { target: { value: '0' } });
    fireEvent.click(d.getByLabelText('Shop'));
    fireEvent.click(d.getByRole('button', { name: 'Import 1 table(s)' }));
    expect(await screen.findByText('Imported 1 table(s)')).toBeInTheDocument();
    expect(api.calls('Scan')).toHaveLength(0);
  });

  it('shows hints without connection or tables', async () => {
    editor({}, { conn: null, tables: [] });
    await titleInput('Shop');
    fireEvent.click(screen.getByText('Import from DynamoDB'));
    expect(screen.getByText('Select a connection first.')).toBeInTheDocument();
    expect(screen.getByText('No tables in the current connection.')).toBeInTheDocument();
  });
});
