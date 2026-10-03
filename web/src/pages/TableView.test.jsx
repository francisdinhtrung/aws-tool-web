import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import TableView from './TableView.jsx';
import { clearDescCache } from '../lib/ops.js';
import { renderWithApp, mockBackend, awsError, SHOP_DESC } from '../test/utils.jsx';

const PROVISIONED = {
  ...SHOP_DESC,
  BillingModeSummary: { BillingMode: 'PROVISIONED' },
  ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 6 },
  StreamSpecification: { StreamEnabled: true, StreamViewType: 'KEYS_ONLY' },
  LatestStreamArn: 'arn:stream',
  DeletionProtectionEnabled: true,
  TableClassSummary: { TableClass: 'STANDARD_INFREQUENT_ACCESS' },
  SSEDescription: { SSEType: 'KMS', Status: 'ENABLED' },
  Replicas: [{ RegionName: 'eu-west-1' }],
  CreationDateTime: '2026-01-01T00:00:00Z',
  TableSizeBytes: 5 * 1024 * 1024,
};
const ITEMS = [{ PK: { S: 'A' }, SK: { S: 'X#1' }, v: { N: '1' } }];

const setup = (handlers = {}, desc = SHOP_DESC) => {
  const api = mockBackend({
    DescribeTable: { Table: desc },
    DescribeTimeToLive: { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } },
    DescribeContinuousBackups: { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' } } },
    Scan: { Items: ITEMS, Count: 1 },
    ListTagsOfResource: { Tags: [{ Key: 'env', Value: 'dev' }] },
    ListBackups: { BackupSummaries: [{ BackupArn: 'arn:b1', BackupName: 'nightly', BackupCreationDateTime: '2026-01-01T00:00:00Z', BackupStatus: 'AVAILABLE', BackupSizeBytes: 100 }] },
    ...handlers,
  });
  const utils = renderWithApp(<TableView name={desc.TableName} />);
  return { api, ...utils };
};
const tab = (name) => fireEvent.click(screen.getByRole('tab', { name }));
const card = (title) => within(screen.getByRole('heading', { name: title }).closest('.card'));

beforeEach(() => clearDescCache());

describe('<TableView> header and loading', () => {
  it('shows the table header and explores items by default', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: 'Shop' })).toBeInTheDocument();
    expect(screen.getByText('PK / SK · ~3 items')).toBeInTheDocument();
    expect(await screen.findByText('X#1')).toBeInTheDocument();
  });

  it('shows describe errors', async () => {
    setup({ DescribeTable: () => { throw awsError('ResourceNotFoundException', 'Requested resource not found'); } });
    expect(await screen.findByText('ResourceNotFoundException: Requested resource not found')).toBeInTheDocument();
  });

  it('polls until a creating table becomes active and tolerates TTL/PITR failures', async () => {
    let n = 0;
    const { api } = setup({
      DescribeTable: () => ({ Table: { ...SHOP_DESC, KeySchema: [SHOP_DESC.KeySchema[0]], TableStatus: n++ === 0 ? 'CREATING' : 'ACTIVE' } }),
      DescribeTimeToLive: () => { throw awsError('UnknownOperationException', 'x'); },
      DescribeContinuousBackups: () => { throw awsError('UnknownOperationException', 'x'); },
    });
    expect(await screen.findByText('ACTIVE')).toBeInTheDocument();
    await waitFor(() => expect(api.calls('DescribeTable').length).toBeGreaterThanOrEqual(3));
    expect(screen.getByText('PK · ~3 items')).toBeInTheDocument();
  });
});

describe('Overview tab', () => {
  it('shows on-demand details', async () => {
    setup();
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Overview');
    const g = card('General information');
    expect(g.getByText('On-demand')).toBeInTheDocument();
    expect(g.getByText('2.0 KB')).toBeInTheDocument();
    const f = card('Features');
    expect(f.getByText('1 GSI · 1 LSI')).toBeInTheDocument();
    expect(f.getAllByText('DISABLED')).toHaveLength(2);
    expect(f.getByText('AWS owned key')).toBeInTheDocument();
    expect(f.getByText('None')).toBeInTheDocument();
    fireEvent.click(g.getByText('↻ Refresh'));
  });

  it('shows provisioned details', async () => {
    setup({ DescribeTimeToLive: { TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'exp' } } }, PROVISIONED);
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Overview');
    expect(screen.getByText('5 / 6')).toBeInTheDocument();
    expect(screen.getByText('5.0 MB')).toBeInTheDocument();
    expect(screen.getByText('ENABLED (exp)')).toBeInTheDocument();
    expect(screen.getByText('Enabled (KEYS_ONLY)')).toBeInTheDocument();
    expect(screen.getByText('KMS (ENABLED)')).toBeInTheDocument();
    expect(screen.getByText('eu-west-1')).toBeInTheDocument();
  });

  it('shows dashes when info is missing', async () => {
    setup({ DescribeTimeToLive: {}, DescribeContinuousBackups: {} }, { ...SHOP_DESC, TableSizeBytes: undefined, ItemCount: undefined, CreationDateTime: undefined, GlobalSecondaryIndexes: undefined, LocalSecondaryIndexes: undefined });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Overview');
    expect(screen.getAllByText('—').length).toBeGreaterThan(3);
  });

  it('deletes the table only when the name is typed', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('nope').mockReturnValue('Shop');
    const { api, ctx } = setup({ DeleteTable: {} });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Overview');
    fireEvent.click(screen.getByText('Delete table'));
    expect(api.calls('DeleteTable')).toHaveLength(0);
    fireEvent.click(screen.getByText('Delete table'));
    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(ctx.reloadTables).toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('reports delete errors', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Shop');
    setup({ DeleteTable: () => { throw awsError('ValidationException', 'deletion protection is enabled'); } });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Overview');
    fireEvent.click(screen.getByText('Delete table'));
    expect(await screen.findByText('ValidationException: deletion protection is enabled')).toBeInTheDocument();
  });
});

describe('Indexes tab', () => {
  it('lists indexes and creates a GSI on an on-demand table', async () => {
    const { api } = setup({ UpdateTable: {} });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Indexes');
    expect(screen.getByText('GSI1PK (S)')).toBeInTheDocument();
    expect(screen.getByText('n (N)')).toBeInTheDocument();
    expect(screen.getByText('KEYS_ONLY')).toBeInTheDocument();
    fireEvent.click(screen.getByText('+ Create GSI'));
    const sub = within(document.querySelector('.card-sub'));
    fireEvent.change(sub.getByLabelText('Index name'), { target: { value: 'ByStatus' } });
    fireEvent.change(sub.getByPlaceholderText('attribute name'), { target: { value: 'status' } });
    fireEvent.change(sub.getByPlaceholderText('attribute name'), { target: { value: '' } });
    fireEvent.change(sub.getByPlaceholderText('attribute name'), { target: { value: 'status' } });
    fireEvent.change(sub.getByPlaceholderText('(optional)'), { target: { value: 'created' } });
    fireEvent.change(sub.getByDisplayValue('ALL'), { target: { value: 'INCLUDE' } });
    fireEvent.change(sub.getByLabelText('Included attributes'), { target: { value: 'a, b' } });
    fireEvent.click(sub.getByText('Create index'));
    expect(await screen.findByText('Index creation started')).toBeInTheDocument();
    const input = api.calls('UpdateTable')[0];
    expect(input.GlobalSecondaryIndexUpdates[0].Create).toEqual({
      IndexName: 'ByStatus',
      KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'created', KeyType: 'RANGE' }],
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['a', 'b'] },
    });
    expect(input.AttributeDefinitions).toContainEqual({ AttributeName: 'status', AttributeType: 'S' });
  });

  it('creates a GSI with throughput on provisioned tables, shows errors and cancels', async () => {
    const { api } = setup({ UpdateTable: () => { throw awsError('LimitExceededException', 'too many'); } }, PROVISIONED);
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Indexes');
    fireEvent.click(screen.getByText('+ Create GSI'));
    const sub = within(document.querySelector('.card-sub'));
    fireEvent.change(sub.getByLabelText('Index name'), { target: { value: 'G2' } });
    fireEvent.change(sub.getByPlaceholderText('attribute name'), { target: { value: 'g' } });
    fireEvent.change(sub.getByLabelText('RCU'), { target: { value: '7' } });
    fireEvent.change(sub.getByLabelText('WCU'), { target: { value: '8' } });
    fireEvent.click(sub.getByText('Create index'));
    expect(await screen.findByText('LimitExceededException: too many')).toBeInTheDocument();
    expect(api.calls('UpdateTable')[0].GlobalSecondaryIndexUpdates[0].Create.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 7, WriteCapacityUnits: 8 });
    fireEvent.click(screen.getAllByText('×')[0]);
    fireEvent.click(sub.getByText('Cancel'));
    expect(document.querySelector('.card-sub')).toBeNull();
    fireEvent.click(screen.getByText('↻ Refresh'));
  });

  it('deletes a GSI after confirmation and reports errors', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    let fail = false;
    const { api } = setup({ UpdateTable: () => { if (fail) throw awsError('ResourceInUseException', 'busy'); return {}; } });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Indexes');
    const del = () => fireEvent.click(within(screen.getByText('GSI1', { selector: 'strong' }).closest('tr')).getByText('Delete'));
    del();
    expect(api.calls('UpdateTable')).toHaveLength(0);
    del();
    expect(await screen.findByText('Index deletion started')).toBeInTheDocument();
    expect(api.calls('UpdateTable')[0]).toEqual({ TableName: 'Shop', GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: 'GSI1' } }] });
    fail = true;
    del();
    expect(await screen.findByText('ResourceInUseException: busy')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    setup({}, { ...SHOP_DESC, GlobalSecondaryIndexes: [], LocalSecondaryIndexes: [] });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Indexes');
    expect(screen.getByText('No secondary indexes')).toBeInTheDocument();
  });

  it('shows index status details', async () => {
    setup({}, { ...SHOP_DESC, GlobalSecondaryIndexes: [{ ...SHOP_DESC.GlobalSecondaryIndexes[0], IndexStatus: 'CREATING', Backfilling: true, ItemCount: 5, IndexSizeBytes: 10, Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['x', 'y'] } }] });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Indexes');
    expect(screen.getByText('CREATING (backfilling)')).toBeInTheDocument();
    expect(screen.getByText('INCLUDE: x, y')).toBeInTheDocument();
    expect(screen.getByText('10 B')).toBeInTheDocument();
  });
});

describe('Settings tab', () => {
  it('switches on-demand to provisioned (updating GSIs) and toggles features', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const { api } = setup({ UpdateTable: {}, UpdateTimeToLive: {}, UpdateContinuousBackups: {} });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Settings');
    const cap = card('Capacity');
    fireEvent.change(cap.getByLabelText('Mode'), { target: { value: 'PROVISIONED' } });
    fireEvent.change(cap.getByLabelText('RCU'), { target: { value: '3' } });
    fireEvent.change(cap.getByLabelText('WCU'), { target: { value: '4' } });
    fireEvent.click(cap.getByText('Apply capacity'));
    await screen.findByText('Capacity updated');
    expect(api.calls('UpdateTable')[0]).toEqual({
      TableName: 'Shop',
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
      GlobalSecondaryIndexUpdates: [{ Update: { IndexName: 'GSI1', ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 } } }],
    });

    const ttl = card('Time to Live (TTL)');
    fireEvent.change(ttl.getByPlaceholderText('TTL attribute'), { target: { value: 'expiresAt' } });
    fireEvent.click(ttl.getByText('Enable TTL'));
    await screen.findByText('TTL enabled');
    expect(api.calls('UpdateTimeToLive')[0]).toEqual({ TableName: 'Shop', TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' } });

    const stream = card('DynamoDB Streams');
    fireEvent.change(stream.getByDisplayValue('NEW_AND_OLD_IMAGES'), { target: { value: 'NEW_IMAGE' } });
    fireEvent.click(stream.getByText('Enable stream'));
    await screen.findByText('Stream updated');
    expect(api.calls('UpdateTable')[1].StreamSpecification).toEqual({ StreamEnabled: true, StreamViewType: 'NEW_IMAGE' });

    const prot = card('Protection & recovery');
    fireEvent.click(prot.getByText('Enable PITR'));
    await screen.findByText('Point-in-time recovery updated');
    expect(api.calls('UpdateContinuousBackups')[0].PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    fireEvent.click(prot.getByText('Enable deletion protection'));
    await screen.findByText('Deletion protection updated');
    expect(api.calls('UpdateTable')[2]).toEqual({ TableName: 'Shop', DeletionProtectionEnabled: true });
    fireEvent.click(prot.getByText('Switch table class'));
    expect(api.calls('UpdateTable')).toHaveLength(3);
    fireEvent.click(prot.getByText('Switch table class'));
    await screen.findByText('Table class updated');
    expect(api.calls('UpdateTable')[3]).toEqual({ TableName: 'Shop', TableClass: 'STANDARD_INFREQUENT_ACCESS' });
  });

  it('disables features on a provisioned table and goes back to on-demand', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { api } = setup(
      {
        UpdateTable: {},
        UpdateTimeToLive: {},
        UpdateContinuousBackups: {},
        DescribeTimeToLive: { TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'exp' } },
        DescribeContinuousBackups: { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED' } } },
      },
      PROVISIONED,
    );
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Settings');
    const cap = card('Capacity');
    fireEvent.click(cap.getByText('Apply capacity'));
    await screen.findByText('Capacity updated');
    expect(api.calls('UpdateTable')[0]).toEqual({ TableName: 'Shop', BillingMode: 'PROVISIONED', ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 6 } });
    fireEvent.change(cap.getByLabelText('Mode'), { target: { value: 'PAY_PER_REQUEST' } });
    fireEvent.click(cap.getByText('Apply capacity'));
    await waitFor(() => expect(api.calls('UpdateTable')).toHaveLength(2));
    expect(api.calls('UpdateTable')[1]).toEqual({ TableName: 'Shop', BillingMode: 'PAY_PER_REQUEST' });

    fireEvent.click(card('Time to Live (TTL)').getByText('Disable TTL'));
    await screen.findByText('TTL disabled');
    expect(api.calls('UpdateTimeToLive')[0].TimeToLiveSpecification).toEqual({ Enabled: false, AttributeName: 'exp' });
    fireEvent.click(card('DynamoDB Streams').getByText('Disable stream (KEYS_ONLY)'));
    await waitFor(() => expect(api.calls('UpdateTable')[2].StreamSpecification).toEqual({ StreamEnabled: false }));
    const prot = card('Protection & recovery');
    fireEvent.click(prot.getByText('Disable PITR'));
    fireEvent.click(prot.getByText('Disable deletion protection'));
    fireEvent.click(prot.getByText('Switch table class'));
    await waitFor(() => expect(api.calls('UpdateTable')).toHaveLength(5));
    expect(api.calls('UpdateTable')[4].TableClass).toBe('STANDARD');
  });

  it('reports setting errors', async () => {
    setup({ UpdateContinuousBackups: () => { throw awsError('UnknownOperationException', 'not supported'); } });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Settings');
    fireEvent.click(screen.getByText('Enable PITR'));
    expect(await screen.findByText('UnknownOperationException: not supported')).toBeInTheDocument();
  });

  it('manages tags', async () => {
    const { api } = setup({ TagResource: {}, UntagResource: {} });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Settings');
    const tags = card('Tags');
    expect(await tags.findByText('env')).toBeInTheDocument();
    expect(tags.getByText('Add tag')).toBeDisabled();
    fireEvent.change(tags.getByPlaceholderText('key'), { target: { value: 'team' } });
    fireEvent.change(tags.getByPlaceholderText('value'), { target: { value: 'core' } });
    fireEvent.click(tags.getByText('Add tag'));
    await screen.findByText('Tag added');
    expect(api.calls('TagResource')[0]).toEqual({ ResourceArn: SHOP_DESC.TableArn, Tags: [{ Key: 'team', Value: 'core' }] });
    expect(tags.getByPlaceholderText('key')).toHaveValue('');
    fireEvent.click(tags.getByText('Remove'));
    await screen.findByText('Tag removed');
    expect(api.calls('UntagResource')[0]).toEqual({ ResourceArn: SHOP_DESC.TableArn, TagKeys: ['env'] });
  });

  it('shows empty and failing tag/backup lists', async () => {
    setup({ ListTagsOfResource: {}, ListBackups: () => { throw awsError('UnknownOperationException', 'backups unsupported'); } });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Settings');
    expect(await screen.findByText('No tags')).toBeInTheDocument();
    expect(await screen.findByText('UnknownOperationException: backups unsupported')).toBeInTheDocument();
  });

  it('shows tag errors and empty backups', async () => {
    setup({ ListTagsOfResource: () => { throw awsError('AccessDeniedException', 'no tags for you'); }, ListBackups: {} });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Settings');
    expect(await screen.findByText('AccessDeniedException: no tags for you')).toBeInTheDocument();
    expect(await screen.findByText('No backups')).toBeInTheDocument();
  });

  it('creates, restores and deletes backups', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce(null).mockReturnValueOnce('mine').mockReturnValueOnce(null).mockReturnValueOnce('Shop-copy');
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const { api } = setup({ CreateBackup: {}, RestoreTableFromBackup: {}, DeleteBackup: {} });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Settings');
    const b = card('On-demand backups');
    expect(await b.findByText('nightly')).toBeInTheDocument();
    fireEvent.click(b.getByText('+ Create backup'));
    fireEvent.click(b.getByText('+ Create backup'));
    await screen.findByText('Backup started');
    expect(api.calls('CreateBackup')).toEqual([{ TableName: 'Shop', BackupName: 'mine' }]);
    fireEvent.click(b.getByText('Restore'));
    fireEvent.click(b.getByText('Restore'));
    await screen.findByText('Restore started');
    expect(api.calls('RestoreTableFromBackup')).toEqual([{ TargetTableName: 'Shop-copy', BackupArn: 'arn:b1' }]);
    fireEvent.click(b.getByText('Delete'));
    fireEvent.click(b.getByText('Delete'));
    await screen.findByText('Backup deleted');
    expect(api.calls('DeleteBackup')).toEqual([{ BackupArn: 'arn:b1' }]);
    expect(prompt).toHaveBeenCalledTimes(4);
  });
});

describe('Visualizer tab', () => {
  it('scans a sample and renders the aggregate view; reloads with a new size', async () => {
    const { api } = setup({
      Scan: (b) => (b.ExclusiveStartKey ? { Items: [{ PK: { S: 'B' }, SK: { S: 'Y#1' } }] } : { Items: ITEMS, LastEvaluatedKey: { PK: { S: 'A' } } }),
    });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Visualizer');
    expect(await screen.findByText('2 partitions · 2 items')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('500'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Reload'));
    await waitFor(() => expect(api.calls('Scan').at(-1).Limit).toBeLessThanOrEqual(100));
  });

  it('shows scan errors', async () => {
    let first = true;
    setup({ Scan: () => { if (first) { first = false; return { Items: [] }; } throw awsError('AccessDeniedException', 'denied'); } });
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Visualizer');
    expect(await screen.findByText('AccessDeniedException: denied')).toBeInTheDocument();
  });
});

describe('Import / Export tab', () => {
  const openIO = async (handlers) => {
    const r = setup(handlers);
    await screen.findByRole('heading', { name: 'Shop' });
    tab('Import / Export');
    return r;
  };
  const fileInput = () => document.querySelector('input[type=file]');

  it('exports the whole table in every format', async () => {
    await openIO();
    for (const [label, name] of [['CSV', /\.csv$/], ['JSON (plain)', /\.json$/], ['DynamoDB JSON', /\.ddb\.json$/], ['DynamoDB JSON lines (S3 export format)', /\.jsonl$/]]) {
      const before = URL.createObjectURL.mock.calls.length;
      fireEvent.click(screen.getByText(label));
      await waitFor(() => expect(URL.createObjectURL.mock.calls.length).toBe(before + 1));
      const a = HTMLAnchorElement.prototype.click.mock.contexts.at(-1);
      expect(a.download).toMatch(name);
    }
    const blob = URL.createObjectURL.mock.calls.at(-1)[0];
    expect(await blob.text()).toBe(JSON.stringify({ Item: ITEMS[0] }));
  });

  it('can cancel a running export and shows errors', async () => {
    let release;
    let calls = 0;
    await openIO({
      Scan: () => {
        calls++;
        if (calls === 1) return { Items: [] }; // explorer
        return new Promise((r) => { release = () => r({ Items: ITEMS, LastEvaluatedKey: { PK: { S: 'A' } } }); });
      },
    });
    fireEvent.click(screen.getByText('CSV'));
    expect(await screen.findByText('Scanning…')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    release();
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('imports a CSV file', async () => {
    const { api } = await openIO({ BatchWriteItem: {} });
    fireEvent.click(screen.getByLabelText('CSV: numeric text → Number'));
    fireEvent.click(screen.getByLabelText('CSV: JSON text → Map/List'));
    fireEvent.change(fileInput(), { target: { files: [new File(['PK,SK,n\nA,1,5\nB,2,6'], 'data.csv')] } });
    expect(await screen.findByText(/2/, { selector: 'strong' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Import'));
    expect(await screen.findByText('Imported 2 items')).toBeInTheDocument();
    expect(api.calls('BatchWriteItem')[0].RequestItems.Shop[0]).toEqual({ PutRequest: { Item: { PK: { S: 'A' }, SK: { S: '1' }, n: { S: '5' } } } });
  });

  it('imports JSON, cancels pending imports and reports write errors', async () => {
    await openIO({ BatchWriteItem: () => { throw awsError('ValidationException', 'bad item'); } });
    fireEvent.change(fileInput(), { target: { files: [new File(['[{"PK":"A","SK":"1"}]'], 'data.json')] } });
    await screen.findByText(/ready to import/);
    fireEvent.click(screen.getAllByText('Cancel').at(-1));
    expect(screen.queryByText(/ready to import/)).toBeNull();
    fireEvent.change(fileInput(), { target: { files: [new File(['[{"PK":"A","SK":"1"}]'], 'data.json')] } });
    await screen.findByText(/ready to import/);
    fireEvent.click(screen.getByText('Import'));
    expect(await screen.findByText('ValidationException: bad item')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('×').at(-1));
  });

  it('rejects files with missing keys or invalid content', async () => {
    await openIO();
    fireEvent.change(fileInput(), { target: { files: [new File(['[{"PK":"A"}]'], 'x.json')] } });
    expect(await screen.findByText('Could not parse x.json: Item #1 is missing key attribute(s) PK, SK')).toBeInTheDocument();
    fireEvent.change(fileInput(), { target: { files: [new File(['{bad'], 'y.json')] } });
    expect(await screen.findByText(/Could not parse y.json/)).toBeInTheDocument();
  });

  it('deletes all items only after typing the table name', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('').mockReturnValue('Shop');
    const { api } = await openIO({ BatchWriteItem: {} });
    fireEvent.click(screen.getByText('Delete all items…'));
    expect(api.calls('BatchWriteItem')).toHaveLength(0);
    fireEvent.click(screen.getByText('Delete all items…'));
    expect(await screen.findByText('Deleted 1 items')).toBeInTheDocument();
    const scan = api.calls('Scan').at(-1);
    expect(scan).toMatchObject({ ProjectionExpression: '#k0, #k1', ExpressionAttributeNames: { '#k0': 'PK', '#k1': 'SK' } });
    expect(api.calls('BatchWriteItem')[0].RequestItems.Shop).toEqual([{ DeleteRequest: { Key: { PK: { S: 'A' }, SK: { S: 'X#1' } } } }]);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('reports truncate errors', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Shop');
    await openIO({ BatchWriteItem: () => { throw awsError('AccessDeniedException', 'no delete'); } });
    fireEvent.click(screen.getByText('Delete all items…'));
    expect(await screen.findByText('AccessDeniedException: no delete')).toBeInTheDocument();
  });
});
