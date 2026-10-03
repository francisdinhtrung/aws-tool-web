import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import LambdaHome from './LambdaFunctions.jsx';
import LambdaFunction from './LambdaFunction.jsx';
import { CreateFunctionModal, createWithRetry } from '../components/LambdaModals.jsx';
import { renderWithApp, mockBackend, awsError } from '../test/utils.jsx';

const op = (name) => `POST /api/lambda/op/${name}`;
const CFG = {
  FunctionName: 'orders-api',
  FunctionArn: 'arn:aws:lambda:us-east-1:000000000000:function:orders-api',
  Runtime: 'nodejs22.x',
  Handler: 'index.handler',
  Role: 'arn:aws:iam::000000000000:role/lambda-role',
  MemorySize: 256,
  Timeout: 10,
  CodeSize: 538,
  CodeSha256: 'sha-1',
  Description: 'HTTP API for orders',
  State: 'Active',
  LastUpdateStatus: 'Successful',
  PackageType: 'Zip',
  Environment: { Variables: { STAGE: 'dev' } },
  LastModified: '2026-01-01T00:00:00.000+0000',
};
const FILES = {
  files: [
    { path: 'index.mjs', size: 40, content: 'export const handler = async () => 1;\n' },
    { path: 'lib/math.mjs', size: 20, content: 'export const x = 1;\n' },
    { path: 'bin/tool', size: 9000, binary: true },
  ],
  codeSha256: 'sha-1',
  codeSize: 538,
};
const ctx = { functions: [CFG, { ...CFG, FunctionName: 'resizer', Runtime: 'python3.12', Description: '' }], functionsState: { loaded: true }, reloadFunctions: vi.fn() };

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const setup = (handlers = {}, tab) => {
  if (tab) localStorage.setItem('ddbs.lambda.tab', JSON.stringify(tab));
  const api = mockBackend({
    [op('GetFunction')]: { Configuration: CFG, Code: { Location: 'https://s3/x' }, Concurrency: {} },
    [op('ListVersionsByFunction')]: { Versions: [{ Version: '$LATEST' }, { Version: '1', Description: 'first', CodeSha256: 'abc' }] },
    [op('ListAliases')]: { Aliases: [{ Name: 'live', FunctionVersion: '1', AliasArn: `${CFG.FunctionArn}:live` }] },
    'POST /api/lambda/code/files': FILES,
    ...handlers,
  });
  return { api, ...renderWithApp(<LambdaFunction name="orders-api" />, ctx) };
};

describe('<LambdaHome>', () => {
  it('lists functions with runtime, memory and filter', async () => {
    mockBackend({ [op('GetAccountSettings')]: { AccountLimit: { ConcurrentExecutions: 1000, UnreservedConcurrentExecutions: 900 }, AccountUsage: { FunctionCount: 2, TotalCodeSize: 2048 } } });
    renderWithApp(<LambdaHome onCreate={vi.fn()} />, ctx);
    const row = screen.getByRole('link', { name: 'orders-api' }).closest('tr');
    expect(within(row).getByText('nodejs22.x')).toBeInTheDocument();
    expect(within(row).getByText('256 MB')).toBeInTheDocument();
    expect(within(row).getByText('HTTP API for orders')).toBeInTheDocument();
    expect(await screen.findByText('900')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'resi' } });
    expect(screen.queryByRole('link', { name: 'orders-api' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'resizer' })).toBeInTheDocument();
  });

  it('deletes a function only when the name is typed', async () => {
    const api = mockBackend({});
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('nope').mockReturnValueOnce('orders-api');
    renderWithApp(<LambdaHome onCreate={vi.fn()} />, ctx);
    const row = screen.getByRole('link', { name: 'orders-api' }).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(api.calls(op('DeleteFunction'))).toEqual([]);
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.calls(op('DeleteFunction'))).toEqual([{ FunctionName: 'orders-api' }]));
    expect(ctx.reloadFunctions).toHaveBeenCalled();
  });

  it('shows the welcome page without a connection', () => {
    renderWithApp(<LambdaHome onCreate={vi.fn()} />, { ...ctx, conn: null });
    expect(screen.getByText('λ AWS Lambda')).toBeInTheDocument();
  });
});

describe('<LambdaFunction> code', () => {
  it('shows the package, edits a file and deploys only the changes', async () => {
    const { api } = setup({ 'POST /api/lambda/code/deploy': { CodeSha256: 'sha-2' } }, 'code');
    expect(await screen.findByText('λ orders-api')).toBeInTheDocument();
    const editor = await screen.findByDisplayValue(/handler = async \(\) => 1/);
    expect(screen.getByText('handler')).toBeInTheDocument(); // badge on index.mjs
    fireEvent.change(editor, { target: { value: 'export const handler = async () => 2;\n' } });
    fireEvent.click(screen.getByRole('listitem', { name: /tool/ }));
    expect(screen.getByText(/is binary or larger than 1 MB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Deploy (1 change)' }));
    await waitFor(() => expect(api.calls('POST /api/lambda/code/deploy')).toHaveLength(1));
    expect(api.calls('POST /api/lambda/code/deploy')[0]).toEqual({ FunctionName: 'orders-api', changes: { 'index.mjs': 'export const handler = async () => 2;\n' }, expectedSha256: 'sha-1' });
  });

  it('adds and deletes files', async () => {
    const { api } = setup({ 'POST /api/lambda/code/deploy': {} }, 'code');
    await screen.findByDisplayValue(/handler/);
    vi.spyOn(window, 'prompt').mockReturnValue('util/new.mjs');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'New file' }));
    fireEvent.change(document.querySelector('.code-editor textarea'), { target: { value: 'export const n = 1;' } });
    fireEvent.click(screen.getByRole('listitem', { name: /math\.mjs/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deploy (2 changes)' }));
    await waitFor(() => expect(api.calls('POST /api/lambda/code/deploy')[0].changes).toEqual({ 'util/new.mjs': 'export const n = 1;', 'lib/math.mjs': null }));
  });

  it('is read only for a version', async () => {
    setup({}, 'code');
    await screen.findByDisplayValue(/handler/);
    fireEvent.change(screen.getByLabelText('Qualifier'), { target: { value: '1' } });
    expect(await screen.findByText('1 (read only)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Deploy/ })).not.toBeInTheDocument();
  });

  it('reports code conflicts from the server', async () => {
    setup({ 'POST /api/lambda/code/deploy': () => { throw awsError('CodeChanged', 'The function code was changed by someone else', 409); } }, 'code');
    fireEvent.change(await screen.findByDisplayValue(/handler/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deploy (1 change)' }));
    expect(await screen.findByText(/CodeChanged: The function code was changed/)).toBeInTheDocument();
  });
});

describe('<LambdaFunction> test', () => {
  it('invokes with the event and shows response, report and logs', async () => {
    const { api } = setup(
      {
        'POST /api/lambda/invoke': {
          StatusCode: 200,
          Payload: '{"statusCode":200}',
          LogResult: 'START RequestId: r1\nINFO hi\nREPORT RequestId: r1\tDuration: 12.5 ms\tBilled Duration: 13 ms\tMemory Size: 256 MB\tMax Memory Used: 80 MB\tInit Duration: 150 ms',
          RequestId: 'r1',
          ExecutedVersion: '$LATEST',
        },
      },
      'test',
    );
    expect(await screen.findByText('Test event')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'sqs' } });
    fireEvent.click(screen.getByRole('button', { name: '▶ Invoke' }));
    expect(await screen.findByText('✓ Succeeded')).toBeInTheDocument();
    const body = api.calls('POST /api/lambda/invoke')[0];
    expect(body).toMatchObject({ FunctionName: 'orders-api', InvocationType: 'RequestResponse' });
    expect(JSON.parse(body.Payload).Records[0].eventSource).toBe('aws:sqs');
    expect(screen.getByText('12.5 ms')).toBeInTheDocument();
    expect(screen.getByText('80 / 256 MB')).toBeInTheDocument();
    expect(screen.getByText(/"statusCode": 200/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Log output/ }));
    expect(screen.getByText('INFO hi')).toBeInTheDocument();
  });

  it('shows function errors, rejects bad JSON and saves events', async () => {
    setup({ 'POST /api/lambda/invoke': { StatusCode: 200, FunctionError: 'Unhandled', Payload: '{"errorMessage":"boom"}', LogResult: '' } }, 'test');
    await screen.findByText('Test event');
    const area = screen.getByDisplayValue(/key1/);
    fireEvent.change(area, { target: { value: '{bad' } });
    fireEvent.click(screen.getByRole('button', { name: '▶ Invoke' }));
    expect(await screen.findByText('The event is not valid JSON')).toBeInTheDocument();
    fireEvent.change(area, { target: { value: '{"a":1}' } });
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'my-event' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
    expect(JSON.parse(localStorage.getItem('ddbs.lambda.events.orders-api'))).toEqual({ 'my-event': '{"a":1}' });
    fireEvent.click(screen.getByRole('button', { name: '▶ Invoke' }));
    expect(await screen.findByText('✗ Failed (Unhandled)')).toBeInTheDocument();
    expect(screen.getByText(/"errorMessage": "boom"/)).toBeInTheDocument();
  });
});

describe('<LambdaFunction> configuration', () => {
  it('saves only changed settings', async () => {
    const { api } = setup({ [op('UpdateFunctionConfiguration')]: {} }, 'config');
    fireEvent.change(await screen.findByLabelText('Memory'), { target: { value: '512' } });
    fireEvent.change(screen.getByLabelText('Tracing'), { target: { value: 'Active' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save (2 changes)' }));
    await waitFor(() => expect(api.calls(op('UpdateFunctionConfiguration'))).toEqual([{ FunctionName: 'orders-api', MemorySize: 512, TracingConfig: { Mode: 'Active' } }]));
  });

  it('blocks invalid values', async () => {
    setup({}, 'config');
    fireEvent.change(await screen.findByLabelText('Timeout'), { target: { value: '901' } });
    expect(screen.getByText('Timeout must be an integer between 1 and 900')).toBeInTheDocument();
  });

  it('edits environment variables', async () => {
    const { api } = setup({ [op('UpdateFunctionConfiguration')]: {} }, 'env');
    expect(await screen.findByDisplayValue('STAGE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    fireEvent.change(screen.getByLabelText('Key 2'), { target: { value: 'TABLE' } });
    fireEvent.change(screen.getByLabelText('Value 2'), { target: { value: 'Orders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls(op('UpdateFunctionConfiguration'))[0]).toEqual({ FunctionName: 'orders-api', Environment: { Variables: { STAGE: 'dev', TABLE: 'Orders' } } }));
  });

  it('sets reserved concurrency and throttles', async () => {
    const { api } = setup({ [op('ListProvisionedConcurrencyConfigs')]: { ProvisionedConcurrencyConfigs: [] }, [op('GetFunctionEventInvokeConfig')]: () => { throw awsError('ResourceNotFoundException', 'none', 404); } }, 'concurrency');
    fireEvent.change(await screen.findByLabelText('Reserved concurrency'), { target: { value: '10' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    await waitFor(() => expect(api.calls(op('PutFunctionConcurrency'))[0]).toEqual({ FunctionName: 'orders-api', ReservedConcurrentExecutions: 10 }));
    expect(screen.getByText('Defaults: 2 retries, 6 hours')).toBeInTheDocument();
  });
});

describe('<LambdaFunction> triggers, versions, URL', () => {
  it('lists event source mappings and push triggers, and toggles a mapping', async () => {
    const { api } = setup(
      {
        [op('ListEventSourceMappings')]: { EventSourceMappings: [{ UUID: 'u1', EventSourceArn: 'arn:aws:sqs:us-east-1:0:orders-queue', State: 'Enabled', BatchSize: 5 }] },
        [op('GetPolicy')]: { Policy: JSON.stringify({ Statement: [{ Sid: 's3', Effect: 'Allow', Principal: { Service: 's3.amazonaws.com' }, Action: 'lambda:InvokeFunction', Condition: { ArnLike: { 'AWS:SourceArn': 'arn:aws:s3:::uploads' } } }] }) },
      },
      'triggers',
    );
    const link = await screen.findByRole('link', { name: 'orders-queue' });
    expect(link).toHaveAttribute('href', '#/sqs/queue/orders-queue');
    expect(await screen.findByText('arn:aws:s3:::uploads')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(api.calls(op('UpdateEventSourceMapping'))).toEqual([{ UUID: 'u1', Enabled: false }]));
  });

  it('publishes versions and creates aliases', async () => {
    const { api } = setup({ [op('PublishVersion')]: { Version: '2' }, [op('CreateAlias')]: {} }, 'versions');
    fireEvent.change(await screen.findByLabelText('Version description'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish new version' }));
    await waitFor(() => expect(api.calls(op('PublishVersion'))).toEqual([{ FunctionName: 'orders-api', Description: 'v2', CodeSha256: 'sha-1' }]));
    fireEvent.click(screen.getByRole('button', { name: '＋ Create alias' }));
    fireEvent.change(screen.getByLabelText('Alias name'), { target: { value: 'beta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls(op('CreateAlias'))[0]).toMatchObject({ FunctionName: 'orders-api', Name: 'beta', FunctionVersion: '1' }));
  });

  it('refuses to delete a version used by an alias', async () => {
    setup({}, 'versions');
    const row = (await screen.findByText('first')).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/used by alias live/)).toBeInTheDocument();
  });

  it('creates a public function URL with its permissions', async () => {
    const { api } = setup({ [op('GetFunctionUrlConfig')]: () => { throw awsError('ResourceNotFoundException', 'none', 404); }, [op('CreateFunctionUrlConfig')]: {}, [op('AddPermission')]: {} }, 'url');
    fireEvent.change(await screen.findByLabelText('Auth type'), { target: { value: 'NONE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create function URL' }));
    await waitFor(() => expect(api.calls(op('AddPermission'))).toHaveLength(2));
    expect(api.calls(op('CreateFunctionUrlConfig'))[0]).toMatchObject({ FunctionName: 'orders-api', AuthType: 'NONE', InvokeMode: 'BUFFERED', Cors: {} });
    expect(api.calls(op('AddPermission'))[0]).toMatchObject({ Principal: '*', Action: 'lambda:InvokeFunctionUrl', FunctionUrlAuthType: 'NONE' });
    expect(api.calls(op('AddPermission'))[1]).toMatchObject({ Principal: '*', Action: 'lambda:InvokeFunction', InvokedViaFunctionUrl: true });
  });
});

describe('<CreateFunctionModal>', () => {
  it('creates a Python function from scratch with a new execution role', async () => {
    const api = mockBackend({
      'POST /api/lambda/iam/ListRoles': { Roles: [] },
      'POST /api/lambda/iam/CreateRole': { Role: { Arn: 'arn:aws:iam::1:role/service-role/fn-role-x' } },
      'POST /api/lambda/code/zip': { ZipFile: 'UEs=' },
      [op('CreateFunction')]: {},
    });
    const onCreated = vi.fn();
    renderWithApp(<CreateFunctionModal onClose={vi.fn()} onCreated={onCreated} />, { conn: { kind: 'profile', profile: 'dev' } });
    fireEvent.change(screen.getByLabelText('Function name'), { target: { value: 'fn' } });
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'python3.13' } });
    fireEvent.change(screen.getByLabelText('Architecture'), { target: { value: 'arm64' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create function' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('fn'));
    expect(Object.keys(api.calls('POST /api/lambda/code/zip')[0].files)).toEqual(['lambda_function.py']);
    expect(api.calls('POST /api/lambda/iam/AttachRolePolicy')[0].PolicyArn).toMatch(/AWSLambdaBasicExecutionRole$/);
    expect(api.calls(op('CreateFunction'))[0]).toMatchObject({ FunctionName: 'fn', Runtime: 'python3.13', Handler: 'lambda_function.lambda_handler', Architectures: ['arm64'], Role: 'arn:aws:iam::1:role/service-role/fn-role-x' });
  });

  it('does not offer inline code for compiled runtimes', () => {
    mockBackend({ 'POST /api/lambda/iam/ListRoles': { Roles: [] } });
    renderWithApp(<CreateFunctionModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'java21' } });
    expect(screen.getByText(/java21 has no inline editor/)).toBeInTheDocument();
  });

  it('retries while a new role is not assumable yet', async () => {
    let n = 0;
    mockBackend({ [op('CreateFunction')]: () => { if (++n < 3) throw awsError('InvalidParameterValueException', 'The role defined for the function cannot be assumed by Lambda.'); return { FunctionName: 'f' }; } });
    await expect(createWithRetry({ FunctionName: 'f' }, { sleep: async () => {} })).resolves.toEqual({ FunctionName: 'f' });
    expect(n).toBe(3);
  });
});
