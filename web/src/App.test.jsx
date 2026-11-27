import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import App from './App.jsx';
import Home from './pages/Home.jsx';
import { mockBackend, renderWithApp, awsError, SHOP_DESC } from './test/utils.jsx';

const PROFILES = [{ name: 'default', region: 'us-west-2', type: 'static', settings: {}, secrets: [] }];
const ENDPOINTS = [{ id: 'e1', name: 'Local', endpoint: 'http://localhost:8000', region: 'us-east-1', authMode: 'local' }];

const backend = (extra = {}) =>
  mockBackend({
    'GET /api/profiles': PROFILES,
    'GET /api/connections': ENDPOINTS,
    'GET /api/info': { awsDirWritable: true, configFile: '/c', credentialsFile: '/k' },
    'GET /api/models': [],
    'POST /api/test': { region: 'us-west-2', identity: { account: '123456789012', arn: 'arn:aws:iam::123:user/me' }, tableCount: 2 },
    ListTables: { TableNames: ['Orders', 'Shop'] },
    DescribeTable: { Table: SHOP_DESC },
    Scan: { Items: [], Count: 0 },
    ...extra,
  });
const go = (hash) => act(() => {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
});

describe('<Home>', () => {
  it('shows getting started without a connection and status with one', () => {
    const { unmount } = renderWithApp(<Home />, { conn: null });
    expect(screen.getByText('Get started')).toBeInTheDocument();
    unmount();
    renderWithApp(<Home />, { info: { label: 'dev', region: 'eu-west-1' }, tables: ['a'] });
    expect(screen.getByText('Connected: dev')).toBeInTheDocument();
    expect(screen.getByText(/Region eu-west-1 · 1 tables/)).toBeInTheDocument();
  });

  it('shows the endpoint when connected to one', () => {
    renderWithApp(<Home />);
    expect(screen.getByText(/Endpoint http:\/\/localhost:8000/)).toBeInTheDocument();
  });
});

describe('<App>', () => {
  it('starts without a connection and lists connections in the picker', async () => {
    backend();
    render(<App />);
    expect(screen.getByText('Get started')).toBeInTheDocument();
    expect(screen.getByText('Select a connection to list tables.')).toBeInTheDocument();
    await screen.findByRole('option', { name: 'default' });
    expect(screen.getByRole('option', { name: 'Local' })).toBeInTheDocument();
    expect(screen.getByTitle('Refresh')).toBeDisabled();
    expect(screen.getByText('Developed by Trung.Vu')).toBeInTheDocument();
  });

  it('selecting a profile lists tables, shows identity and allows region switch', async () => {
    const api = backend();
    render(<App />);
    await screen.findByRole('option', { name: 'default' });
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'p:default' } });
    expect(await screen.findByText('Orders')).toBeInTheDocument();
    expect(await screen.findByText('123456789012')).toBeInTheDocument();
    expect(screen.getByTitle('arn:aws:iam::123:user/me')).toHaveClass('ok');
    expect(JSON.parse(localStorage.getItem('ddbs.conn'))).toEqual({ kind: 'profile', profile: 'default', region: 'us-west-2' });

    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu-west-1' } });
    await waitFor(() => expect(JSON.parse(decodeURIComponent(api.log.at(-1).headers['x-conn'])).region).toBe('eu-west-1'));

    fireEvent.change(screen.getByPlaceholderText('Filter tables…'), { target: { value: 'sho' } });
    expect(screen.queryByText('Orders')).toBeNull();
    expect(screen.getByText('Shop')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Refresh'));
    await waitFor(() => expect(api.calls('ListTables').length).toBeGreaterThan(2));
  });

  it('supports endpoint, default chain and clearing the connection', async () => {
    backend();
    render(<App />);
    await screen.findByRole('option', { name: 'Local' });
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'e:e1' } });
    expect(await screen.findByText('http://localhost:8000', { selector: '.chip' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Region')).toBeNull();
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'd' } });
    expect(screen.getByLabelText('Region')).toHaveValue('us-east-1');
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: '' } });
    expect(screen.getByText('Get started')).toBeInTheDocument();
  });

  it('shows table listing and connection errors', async () => {
    backend({
      ListTables: () => { throw awsError('UnrecognizedClientException', 'bad token'); },
      'POST /api/test': () => { throw awsError('UnrecognizedClientException', 'bad token'); },
    });
    localStorage.setItem('ddbs.conn', JSON.stringify({ kind: 'endpoint', id: 'e1' }));
    render(<App />);
    expect(await screen.findByText('UnrecognizedClientException: bad token', { selector: '.side-error' })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.status-dot')).toHaveClass('bad'));
  });

  it('shows "No tables" and survives failing profile/connection loads', async () => {
    mockBackend({
      'GET /api/profiles': () => { throw awsError('Error', 'down', 500); },
      'GET /api/connections': () => { throw awsError('Error', 'down', 500); },
      ListTables: { TableNames: [] },
      'POST /api/test': { tableCount: 0 },
    });
    localStorage.setItem('ddbs.conn', JSON.stringify({ kind: 'default', region: 'us-east-1' }));
    render(<App />);
    expect(await screen.findByText('No tables.')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.status-dot')).toHaveClass('ok'));
  });

  it('routes between pages', async () => {
    backend();
    localStorage.setItem('ddbs.conn', JSON.stringify({ kind: 'endpoint', id: 'e1' }));
    render(<App />);
    await screen.findByText('Orders');
    go('#/ops');
    expect(await screen.findByRole('heading', { name: 'Operation builder' })).toBeInTheDocument();
    go('#/partiql');
    expect(await screen.findByRole('heading', { name: 'PartiQL editor' })).toBeInTheDocument();
    go('#/modeler');
    expect(await screen.findByRole('heading', { name: 'Data modeler' })).toBeInTheDocument();
    go('#/connections');
    expect(await screen.findByRole('heading', { name: 'Connections' })).toBeInTheDocument();
    go('#/table/Shop');
    expect(await screen.findByRole('heading', { name: 'Shop' })).toBeInTheDocument();
    expect(screen.getByText('Shop', { selector: 'a' })).toHaveClass('active');
    go('#/unknown');
    expect(await screen.findByText(/Connected: Local/)).toBeInTheDocument();
  });

  it('opens the modeler without a connection', async () => {
    backend();
    render(<App />);
    go('#/modeler');
    expect(await screen.findByRole('heading', { name: 'Data modeler' })).toBeInTheDocument();
  });

  it('creates a table and navigates to it', async () => {
    const api = backend({ CreateTable: {} });
    localStorage.setItem('ddbs.conn', JSON.stringify({ kind: 'endpoint', id: 'e1' }));
    render(<App />);
    await screen.findByText('Orders');
    fireEvent.click(screen.getByTitle('Create table'));
    fireEvent.change(screen.getByPlaceholderText('MyTable'), { target: { value: 'NewTable' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create table' }));
    await waitFor(() => expect(window.location.hash).toBe('#/table/NewTable'));
    expect(api.calls('CreateTable')).toHaveLength(1);
  });

  it('closes the create table modal and applies themes', async () => {
    backend();
    localStorage.setItem('ddbs.conn', JSON.stringify({ kind: 'endpoint', id: 'e1' }));
    render(<App />);
    await screen.findByText('Orders');
    fireEvent.click(screen.getByTitle('Create table'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('MyTable')).toBeNull();

    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'dark' } });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'auto' } });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('the S3 workspace shows only S3 UI and the switcher goes back to DynamoDB', async () => {
    const api = backend({
      'POST /api/s3/op/ListBuckets': { Buckets: [{ Name: 'zeta' }, { Name: 'alpha' }] },
      'POST /api/s3/op/ListObjectsV2': { Contents: [{ Key: 'readme.txt', Size: 1 }] },
    });
    render(<App />);
    await screen.findByRole('option', { name: 'default' });
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'p:default' } });
    await screen.findByText('Orders');
    expect(api.calls('POST /api/s3/op/ListBuckets')).toHaveLength(0);
    expect(api.calls('POST /api/test').at(-1)).toEqual({ service: 'dynamodb' });

    fireEvent.click(screen.getByRole('tab', { name: 'S3' }));
    await waitFor(() => expect(window.location.hash).toBe('#/s3'));
    go('#/s3');
    const links = await screen.findAllByRole('link', { name: /^(alpha|zeta)$/ });
    expect(links.map((l) => l.textContent)).toEqual(['alpha', 'zeta']); // sorted
    expect(screen.getByText('S3 Browser')).toBeInTheDocument();
    expect(document.title).toBe('S3 Browser · AWS Tool Web');
    expect(document.documentElement.dataset.workspace).toBe('s3');
    // No DynamoDB UI in the S3 workspace
    for (const t of ['Orders', 'Operation builder', 'PartiQL editor', 'Data modeler', 'DynamoDB Studio']) expect(screen.queryByText(new RegExp(t))).not.toBeInTheDocument();
    await waitFor(() => expect(api.calls('POST /api/test').at(-1)).toEqual({ service: 's3' }));

    // Shared pages keep the workspace; home redirects to the bucket list
    go('#/connections');
    expect(screen.getByText('🪣 Buckets')).toBeInTheDocument();
    go('#/s3/alpha/');
    expect(await screen.findByText('readme.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'DynamoDB' }));
    go('#/');
    expect(await screen.findByText('Orders')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /DynamoDB Studio/ })).toBeInTheDocument();
    expect(screen.queryByText('🪣 Buckets')).not.toBeInTheDocument();
  });

  it('the S3 workspace without a connection shows S3 getting started', async () => {
    backend();
    go('#/s3');
    render(<App />);
    expect(screen.getByText('🪣 S3 Browser')).toBeInTheDocument();
    expect(screen.getByText('Select a connection to list buckets.')).toBeInTheDocument();
    expect(screen.queryByText(/NoSQL Workbench/)).not.toBeInTheDocument();
  });

  it('opens Secrets Manager, paginates metadata, and retrieves only the selected version on demand', async () => {
    const arn = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:apps/config+prod-a1b2c3';
    const secret = { ARN: arn, Name: 'apps/config+prod', VersionIdsToStages: { v1: ['AWSPREVIOUS'], v2: ['AWSCURRENT'] } };
    const api = backend({
      'POST /api/secrets/op/ListSecrets': ({ NextToken }) => NextToken ? { SecretList: [secret] } : { SecretList: [{ Name: 'another' }], NextToken: 'page-2' },
      'POST /api/secrets/op/DescribeSecret': secret,
      'POST /api/secrets/op/GetSecretValue': ({ VersionStage }) => VersionStage === 'AWSPREVIOUS' ? { SecretBinary: 'AQID' } : { SecretString: 'current-placeholder' },
    });
    localStorage.setItem('ddbs.conn', JSON.stringify({ kind: 'profile', profile: 'default', region: 'us-west-2' }));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Secrets Manager' }));
    go('#/secrets');
    await screen.findByRole('link', { name: 'another' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    fireEvent.click(await screen.findByRole('link', { name: secret.Name }));
    await screen.findByRole('heading', { name: secret.Name });
    expect(api.calls('POST /api/test').at(-1)).toEqual({ service: 'secrets' });
    expect(api.calls('POST /api/secrets/op/ListSecrets').at(-1)).toMatchObject({ IncludePlannedDeletion: true, NextToken: 'page-2' });
    expect(api.calls('POST /api/secrets/op/DescribeSecret')).toEqual([{ SecretId: arn }]);
    expect(api.calls('POST /api/secrets/op/GetSecretValue')).toEqual([]);

    fireEvent.change(screen.getByLabelText('Version stage'), { target: { value: 'AWSPREVIOUS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retrieve value' }));
    expect(await screen.findByText('AQID')).toBeInTheDocument();
    expect(screen.getByText('Binary value shown as Base64.')).toBeInTheDocument();
    expect(api.calls('POST /api/secrets/op/GetSecretValue')).toEqual([{ SecretId: arn, VersionStage: 'AWSPREVIOUS' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Hide value' }));
    expect(screen.queryByText('AQID')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Version stage'), { target: { value: 'AWSCURRENT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retrieve value' }));
    expect(await screen.findByText('current-placeholder')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu-west-1' } });
    expect(screen.queryByText('current-placeholder')).not.toBeInTheDocument();
    expect(api.calls('POST /api/secrets/op/GetSecretValue')).toHaveLength(2);
    expect(window.location.hash).not.toContain('current-placeholder');
  });

  it('manages a secret through creation, value updates, scheduled deletion and restore', async () => {
    const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:app/demo-a1b2c3';
    let secret;
    const api = backend({
      'POST /api/secrets/op/ListSecrets': { SecretList: [] },
      'POST /api/secrets/op/CreateSecret': (input) => {
        secret = { ARN: arn, Name: input.Name, Description: input.Description };
        return { ARN: arn, Name: secret.Name };
      },
      'POST /api/secrets/op/DescribeSecret': () => secret,
      'POST /api/secrets/op/UpdateSecret': (input) => {
        secret.Description = input.Description;
        return { ARN: arn, Name: secret.Name, VersionId: 'new-version' };
      },
      'POST /api/secrets/op/DeleteSecret': { ARN: arn, DeletionDate: '2026-02-01T00:00:00.000Z' },
      'POST /api/secrets/op/RestoreSecret': { ARN: arn },
    });
    localStorage.setItem('ddbs.conn', JSON.stringify({ kind: 'endpoint', id: 'e1' }));
    go('#/secrets');
    render(<App />);
    await screen.findByText('No secrets in this region.');
    fireEvent.click(screen.getByRole('button', { name: 'Create secret' }));
    const create = within(screen.getByRole('dialog', { name: 'Create secret' }));
    fireEvent.change(create.getByRole('textbox', { name: /^Name/ }), { target: { value: 'app/demo' } });
    fireEvent.change(create.getByLabelText('Description'), { target: { value: 'Original description' } });
    fireEvent.change(create.getByLabelText('Secret value'), { target: { value: ' original value ' } });
    fireEvent.click(create.getByRole('button', { name: 'Create secret' }));
    await screen.findByRole('heading', { name: 'app/demo' });
    expect(api.calls('POST /api/secrets/op/CreateSecret')).toEqual([{ Name: 'app/demo', Description: 'Original description', SecretString: ' original value ' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit secret' }));
    const edit = within(screen.getByRole('dialog', { name: 'Edit secret' }));
    const value = edit.getByRole('textbox', { name: /^New secret value/ });
    expect(value).toHaveValue('');
    fireEvent.change(value, { target: { value: '{"key":"new"}' } });
    fireEvent.change(edit.getByLabelText('Description'), { target: { value: 'Updated description' } });
    fireEvent.click(edit.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schedule deletion' })).toBeEnabled());
    expect(api.calls('POST /api/secrets/op/UpdateSecret')).toEqual([{ SecretId: arn, Description: 'Updated description', SecretString: '{"key":"new"}' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Schedule deletion' }));
    const deletion = within(screen.getByRole('dialog', { name: 'Schedule deletion' }));
    expect(api.calls('POST /api/secrets/op/DeleteSecret')).toEqual([]);
    fireEvent.change(deletion.getByRole('spinbutton'), { target: { value: '7' } });
    fireEvent.click(deletion.getByRole('button', { name: 'Schedule deletion' }));
    expect(await screen.findByRole('button', { name: 'Restore secret' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retrieve value' })).not.toBeInTheDocument();
    expect(api.calls('POST /api/secrets/op/DeleteSecret')).toEqual([{ SecretId: arn, RecoveryWindowInDays: 7 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Restore secret' }));
    expect(await screen.findByRole('button', { name: 'Retrieve value' })).toBeInTheDocument();
    expect(api.calls('POST /api/secrets/op/RestoreSecret')).toEqual([{ SecretId: arn }]);
    expect(api.calls('POST /api/secrets/op/GetSecretValue')).toEqual([]);
  });

  it('opens and downloads an exact S3 URI from the bucket list without listing the folder', async () => {
    const key = '/inbox//résumé #?+%2F.png';
    const api = backend({
      'POST /api/s3/op/HeadObject': ({ Key }) => {
        if (Key !== key) throw awsError('NotFound', 'object missing', 404);
        return { ContentType: 'image/png', ContentLength: 10 };
      },
    });
    localStorage.setItem('ddbs.conn', JSON.stringify({ kind: 'endpoint', id: 'e1' }));
    go('#/s3');
    render(<App />);

    const open = (uri) => {
      fireEvent.click(screen.getByRole('button', { name: 'Open S3 path' }));
      const dialog = screen.getByRole('dialog', { name: 'Open S3 path' });
      fireEvent.change(within(dialog).getByRole('textbox', { name: /^S3 path/ }), { target: { value: uri } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
    };

    open(`s3://private-bucket/${key}`);
    expect(await screen.findByRole('img', { name: 'résumé #?+%2F.png' })).toBeInTheDocument();
    expect(api.calls('POST /api/s3/op/HeadObject')).toEqual([{ Bucket: 'private-bucket', Key: key }]);
    expect(api.calls('POST /api/s3/op/ListObjectsV2')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '⬇ Download' }));
    const download = HTMLAnchorElement.prototype.click.mock.instances.at(-1);
    expect(new URL(download.href).searchParams.get('key')).toBe(key);
    expect(new URL(download.href).searchParams.get('bucket')).toBe('private-bucket');

    open('s3://private-bucket/missing');
    expect(await screen.findByText('Object not found.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '⬇ Download' })).not.toBeInTheDocument();

    open('s3://private-bucket//inbox//');
    await waitFor(() => expect(api.calls('POST /api/s3/op/ListObjectsV2')).toEqual([
      expect.objectContaining({ Bucket: 'private-bucket', Prefix: '/inbox//', Delimiter: '/' }),
    ]));
  });

  it('searches nested S3 files across pages and opens a matching object', async () => {
    const key = 'reports/2026/January REPORT.png';
    const api = backend({
      'POST /api/s3/op/ListObjectsV2': (body) => {
        if (body.Delimiter) return { CommonPrefixes: [{ Prefix: 'reports/2026/' }] };
        if (!body.ContinuationToken) return {
          Contents: [{ Key: 'reports/January/' }, { Key: 'reports/February.png' }],
          IsTruncated: true,
          NextContinuationToken: 'second',
        };
        return { Contents: [{ Key: key, Size: 12 }] };
      },
      'POST /api/s3/op/HeadObject': { ContentType: 'image/png', ContentLength: 12 },
    });
    localStorage.setItem('ddbs.conn', JSON.stringify({ kind: 'endpoint', id: 'e1' }));
    go('#/s3/alpha/reports/');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Search files' }));
    const search = within(screen.getByRole('dialog', { name: 'Search files' }));
    fireEvent.change(search.getByRole('searchbox'), { target: { value: 'JANUARY' } });
    fireEvent.click(search.getByRole('button', { name: 'Search' }));
    const link = await search.findByRole('link', { name: '2026/January REPORT.png' });
    expect(search.getAllByRole('link')).toEqual([link]);
    const pages = api.calls('POST /api/s3/op/ListObjectsV2').filter((body) => !body.Delimiter);
    expect(pages).toEqual([
      { Bucket: 'alpha', Prefix: 'reports/', MaxKeys: 1000 },
      { Bucket: 'alpha', Prefix: 'reports/', MaxKeys: 1000, ContinuationToken: 'second' },
    ]);
    fireEvent.click(link);
    expect(await screen.findByRole('img', { name: 'January REPORT.png' })).toBeInTheDocument();
    expect(api.calls('POST /api/s3/op/HeadObject')).toEqual([{ Bucket: 'alpha', Key: key }]);
  });

  it('the CloudWatch workspace lists log groups, favorites and opens the viewer', async () => {
    const api = backend({
      'POST /api/logs/op/DescribeLogGroups': (b) =>
        b.nextToken ? { logGroups: [{ logGroupName: '/ecs/web' }] } : { logGroups: [{ logGroupName: '/aws/lambda/a', retentionInDays: 7 }], nextToken: 'p2' },
      'POST /api/logs/op/FilterLogEvents': { events: [{ eventId: 'e', timestamp: 1, message: '[WARN] slow', logStreamName: 's' }] },
    });
    localStorage.setItem('ddbs.logs.favorites', JSON.stringify(['/ecs/web']));
    render(<App />);
    await screen.findByRole('option', { name: 'default' });
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'p:default' } });
    fireEvent.click(screen.getByRole('tab', { name: 'CloudWatch' }));
    await waitFor(() => expect(window.location.hash).toBe('#/logs'));
    go('#/logs');
    expect(await screen.findByRole('heading', { name: /Log groups/ })).toBeInTheDocument();
    expect(document.title).toBe('CloudWatch Logs · AWS Tool Web');
    expect(document.documentElement.dataset.workspace).toBe('logs');
    await waitFor(() => expect(api.calls('POST /api/test').at(-1)).toEqual({ service: 'logs' }));
    expect(api.calls('POST /api/logs/op/DescribeLogGroups')).toHaveLength(2); // paged
    expect(screen.getByText('Favorites')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.queryByText('Orders')).not.toBeInTheDocument();

    go('#/logs/group/%2Fecs%2Fweb?range=1h');
    expect(await screen.findByText('[WARN] slow')).toBeInTheDocument();
    expect(api.calls('POST /api/logs/op/FilterLogEvents')[0].logGroupName).toBe('/ecs/web');
    go('#/logs/insights');
    expect(await screen.findByRole('heading', { name: /Logs Insights/ })).toBeInTheDocument();
    localStorage.removeItem('ddbs.logs.favorites');
  });

  it('the SQS workspace lists queues, opens a queue and creates one', async () => {
    const Q = 'https://sqs.us-west-2.amazonaws.com/123/orders';
    const api = backend({
      'POST /api/sqs/op/ListQueues': { QueueUrls: [Q, 'https://sqs.us-west-2.amazonaws.com/123/pay.fifo'] },
      'POST /api/sqs/op/GetQueueUrl': (b) => ({ QueueUrl: `https://sqs.us-west-2.amazonaws.com/123/${b.QueueName}` }),
      'POST /api/sqs/op/GetQueueAttributes': { Attributes: { ApproximateNumberOfMessages: '4', QueueArn: 'arn:aws:sqs:us-west-2:123:orders' } },
      'POST /api/sqs/op/CreateQueue': { QueueUrl: 'https://sqs.us-west-2.amazonaws.com/123/new-q' },
    });
    render(<App />);
    await screen.findByRole('option', { name: 'default' });
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'p:default' } });
    fireEvent.click(screen.getByRole('tab', { name: 'SQS' }));
    await waitFor(() => expect(window.location.hash).toBe('#/sqs'));
    go('#/sqs');
    expect(await screen.findByRole('heading', { name: /Queues/ })).toBeInTheDocument();
    expect(document.title).toBe('SQS Console · AWS Tool Web');
    expect(document.documentElement.dataset.workspace).toBe('sqs');
    await waitFor(() => expect(api.calls('POST /api/test').at(-1)).toEqual({ service: 'sqs' }));
    expect(screen.getAllByText('pay.fifo').length).toBeGreaterThan(0);
    expect(screen.queryByText('Orders')).not.toBeInTheDocument();

    go('#/sqs/queue/orders');
    expect(await screen.findByText('📨 orders')).toBeInTheDocument();
    expect(api.calls('POST /api/sqs/op/GetQueueUrl')).toEqual([{ QueueName: 'orders' }]);

    fireEvent.click(screen.getByTitle('Create queue'));
    fireEvent.change(screen.getByLabelText('Queue name'), { target: { value: 'new-q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create queue' }));
    await waitFor(() => expect(window.location.hash).toBe('#/sqs/queue/new-q'));
    expect(api.calls('POST /api/sqs/op/CreateQueue')[0]).toMatchObject({ QueueName: 'new-q' });
  });
  it('the Lambda workspace lists functions, opens one and creates one', async () => {
    const FN = { FunctionName: 'orders-api', Runtime: 'nodejs22.x', MemorySize: 256, Timeout: 10, CodeSize: 900, FunctionArn: 'arn:aws:lambda:us-west-2:123:function:orders-api' };
    const api = backend({
      'POST /api/lambda/op/ListFunctions': { Functions: [FN, { ...FN, FunctionName: 'resizer', Runtime: 'python3.12' }] },
      'POST /api/lambda/op/GetFunction': (b) => ({ Configuration: { ...FN, FunctionName: b.FunctionName, Handler: 'index.handler', State: 'Active', LastUpdateStatus: 'Successful' } }),
      'POST /api/lambda/code/files': { files: [{ path: 'index.mjs', size: 10, content: 'export {}' }], codeSha256: 'sha', codeSize: 100 },
      'POST /api/lambda/iam/ListRoles': { Roles: [] },
      'POST /api/lambda/code/zip': { ZipFile: 'UEs=' },
      'POST /api/lambda/op/CreateFunction': { FunctionName: 'new-fn' },
    });
    render(<App />);
    await screen.findByRole('option', { name: 'default' });
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'p:default' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Lambda' }));
    await waitFor(() => expect(window.location.hash).toBe('#/lambda'));
    go('#/lambda');
    expect(await screen.findByRole('heading', { name: /Functions/ })).toBeInTheDocument();
    expect(document.title).toBe('Lambda Console · AWS Tool Web');
    expect(document.documentElement.dataset.workspace).toBe('lambda');
    await waitFor(() => expect(api.calls('POST /api/test').at(-1)).toEqual({ service: 'lambda' }));
    expect(screen.getAllByText('resizer').length).toBeGreaterThan(0);

    go('#/lambda/function/orders-api');
    expect(await screen.findByText('λ orders-api')).toBeInTheDocument();
    expect(api.calls('POST /api/lambda/op/GetFunction')[0]).toEqual({ FunctionName: 'orders-api' });

    fireEvent.click(screen.getByTitle('Create function'));
    fireEvent.change(screen.getByLabelText('Function name'), { target: { value: 'new-fn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter role ARN' }));
    fireEvent.change(screen.getByLabelText('Role ARN'), { target: { value: 'arn:aws:iam::123:role/r' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create function' }));
    await waitFor(() => expect(window.location.hash).toBe('#/lambda/function/new-fn'));
    expect(api.calls('POST /api/lambda/op/CreateFunction')[0]).toMatchObject({ FunctionName: 'new-fn', Runtime: 'nodejs22.x', Handler: 'index.handler', Role: 'arn:aws:iam::123:role/r', Code: { ZipFile: 'UEs=' } });
  });

  it('the Step Functions workspace lists state machines, opens one and an execution, and creates one', async () => {
    const ARN = 'arn:aws:states:us-west-2:123:stateMachine:orders';
    const EX = 'arn:aws:states:us-west-2:123:execution:orders:run-1';
    const DEF = JSON.stringify({ StartAt: 'A', States: { A: { Type: 'Pass', End: true } } });
    const list = [{ name: 'orders', stateMachineArn: ARN, type: 'STANDARD', creationDate: '2026-01-01T00:00:00Z' }];
    const api = backend({
      'POST /api/sfn/op/ListStateMachines': () => ({ stateMachines: list }),
      'POST /api/sfn/op/DescribeStateMachine': (b) => ({ ...list.find((m) => m.stateMachineArn === b.stateMachineArn), definition: DEF, roleArn: 'arn:aws:iam::123:role/r' }),
      'POST /api/sfn/op/ListExecutions': { executions: [{ name: 'run-1', executionArn: EX, status: 'SUCCEEDED', startDate: '2026-01-02T00:00:00Z' }] },
      'POST /api/sfn/op/DescribeExecution': { name: 'run-1', executionArn: EX, stateMachineArn: ARN, status: 'SUCCEEDED', input: '{}', output: '{}', startDate: '2026-01-02T00:00:00Z' },
      'POST /api/sfn/op/GetExecutionHistory': { events: [] },
      'POST /api/sfn/op/DescribeStateMachineForExecution': { definition: DEF },
      'POST /api/lambda/iam/ListRoles': { Roles: [] },
      'POST /api/sfn/op/CreateStateMachine': (b) => {
        list.push({ name: b.name, stateMachineArn: ARN.replace('orders', b.name), type: b.type });
        return { stateMachineArn: ARN.replace('orders', b.name) };
      },
    });
    render(<App />);
    await screen.findByRole('option', { name: 'default' });
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'p:default' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Step Functions' }));
    await waitFor(() => expect(window.location.hash).toBe('#/sfn'));
    go('#/sfn');
    expect(await screen.findByRole('heading', { name: /State machines/ })).toBeInTheDocument();
    expect(document.title).toBe('Step Functions · AWS Tool Web');
    expect(document.documentElement.dataset.workspace).toBe('sfn');
    await waitFor(() => expect(api.calls('POST /api/test').at(-1)).toEqual({ service: 'sfn' }));

    go('#/sfn/machine/orders');
    expect(await screen.findByText('⛓ orders')).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'run-1' });
    go(link.getAttribute('href'));
    expect(await screen.findByRole('heading', { name: 'run-1' })).toBeInTheDocument();
    expect(api.calls('POST /api/sfn/op/DescribeExecution')[0]).toEqual({ executionArn: EX });
    expect(document.querySelector('.sidebar a.active[title^="orders"]')).toBeTruthy(); // sidebar keeps the state machine selected

    fireEvent.click(screen.getByTitle('Create state machine'));
    fireEvent.change(screen.getByLabelText('State machine name'), { target: { value: 'flow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter role ARN' }));
    fireEvent.change(screen.getByLabelText('Role ARN'), { target: { value: 'arn:aws:iam::123:role/r' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create state machine' }));
    await waitFor(() => expect(window.location.hash).toBe('#/sfn/machine/flow'));
    expect(await screen.findByText('⛓ flow')).toBeInTheDocument();
    expect(api.calls('POST /api/sfn/op/CreateStateMachine')[0]).toMatchObject({ name: 'flow', type: 'STANDARD', roleArn: 'arn:aws:iam::123:role/r' });
  });
});
