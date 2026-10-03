import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
