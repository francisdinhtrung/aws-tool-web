import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import SfnHome from './SfnStateMachines.jsx';
import SfnStateMachine from './SfnStateMachine.jsx';
import SfnExecution from './SfnExecution.jsx';
import SfnActivities from './SfnActivities.jsx';
import { CreateStateMachineModal, createMachineWithRetry } from '../components/SfnModals.jsx';
import { renderWithApp, mockBackend, awsError } from '../test/utils.jsx';

const op = (name) => `POST /api/sfn/op/${name}`;
const ARN = 'arn:aws:states:us-east-1:000000000000:stateMachine:orders';
const EX = 'arn:aws:states:us-east-1:000000000000:execution:orders:run-1';
const DEF = JSON.stringify({
  StartAt: 'Prep',
  States: {
    Prep: { Type: 'Pass', Next: 'Call' },
    Call: { Type: 'Task', Resource: 'arn:aws:states:::lambda:invoke', Catch: [{ ErrorEquals: ['States.ALL'], Next: 'Oops' }], End: true },
    Oops: { Type: 'Fail', Error: 'Failed' },
  },
});
const MACHINE = {
  name: 'orders', stateMachineArn: ARN, type: 'STANDARD', status: 'ACTIVE', definition: DEF,
  roleArn: 'arn:aws:iam::000000000000:role/sfn-role', creationDate: '2026-01-01T00:00:00.000Z', loggingConfiguration: { level: 'OFF', includeExecutionData: false },
};
const ctx = {
  machines: [MACHINE, { name: 'fast', stateMachineArn: `${ARN.replace('orders', 'fast')}`, type: 'EXPRESS', creationDate: '2026-02-01T00:00:00.000Z' }],
  machinesState: { loaded: true },
  reloadMachines: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  window.location.hash = '';
});

const setupMachine = (handlers = {}, tab) => {
  if (tab) localStorage.setItem('ddbs.sfn.tab', JSON.stringify(tab));
  const api = mockBackend({
    [op('DescribeStateMachine')]: (b) => (b.stateMachineArn === ARN ? MACHINE : { ...MACHINE, description: `desc ${b.stateMachineArn.split(':').pop()}` }),
    [op('ListStateMachineVersions')]: { stateMachineVersions: [{ stateMachineVersionArn: `${ARN}:1`, creationDate: '2026-01-02T00:00:00Z' }] },
    [op('ListStateMachineAliases')]: { stateMachineAliases: [{ stateMachineAliasArn: `${ARN}:live` }] },
    [op('DescribeStateMachineAlias')]: { name: 'live', routingConfiguration: [{ stateMachineVersionArn: `${ARN}:1`, weight: 100 }] },
    [op('ListExecutions')]: (b) => ({
      executions: [
        { name: 'run-1', executionArn: EX, status: b.statusFilter || 'SUCCEEDED', startDate: '2026-01-03T00:00:00Z', stopDate: '2026-01-03T00:00:02Z' },
        { name: 'run-2', executionArn: `${EX.slice(0, -1)}2`, status: 'RUNNING', startDate: '2026-01-03T00:00:00Z' },
      ],
    }),
    ...handlers,
  });
  return { api, ...renderWithApp(<SfnStateMachine name="orders" />, ctx) };
};

describe('<SfnHome>', () => {
  it('lists, filters and deletes state machines', async () => {
    const api = mockBackend({});
    vi.spyOn(window, 'prompt').mockReturnValueOnce('nope').mockReturnValueOnce('orders');
    renderWithApp(<SfnHome onCreate={vi.fn()} />, ctx);
    expect(screen.getByRole('link', { name: 'orders' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type filter'), { target: { value: 'EXPRESS' } });
    expect(screen.queryByRole('link', { name: 'orders' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'fast' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type filter'), { target: { value: '' } });
    const row = screen.getByRole('link', { name: 'orders' }).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(window.prompt).toHaveBeenCalledTimes(1));
    expect(api.calls(op('DeleteStateMachine'))).toEqual([]);
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.calls(op('DeleteStateMachine'))).toEqual([{ stateMachineArn: ARN }]));
    expect(ctx.reloadMachines).toHaveBeenCalled();
  });

  it('shows the welcome page without a connection', () => {
    renderWithApp(<SfnHome onCreate={vi.fn()} />, { ...ctx, conn: null });
    expect(screen.getByText('⛓ AWS Step Functions')).toBeInTheDocument();
  });
});

describe('<SfnStateMachine>', () => {
  it('lists executions, filters by status and stops a running one', async () => {
    const { api } = setupMachine({}, 'executions');
    expect(await screen.findByRole('link', { name: 'run-1' })).toHaveAttribute('href', `#/sfn/execution/${encodeURIComponent(EX)}`);
    expect(screen.getByText('2.00 s')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'FAILED' } });
    await waitFor(() => expect(api.calls(op('ListExecutions')).at(-1)).toEqual({ stateMachineArn: ARN, maxResults: 100, statusFilter: 'FAILED' }));
    vi.spyOn(window, 'prompt').mockReturnValue('manual');
    const row = (await screen.findByRole('link', { name: 'run-2' })).closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.calls(op('StopExecution'))).toEqual([{ executionArn: `${EX.slice(0, -1)}2`, cause: 'manual' }]));
  });

  it('starts an execution with JSON input and opens it', async () => {
    const { api } = setupMachine({ [op('StartExecution')]: { executionArn: EX } }, 'executions');
    await screen.findByRole('link', { name: 'run-1' });
    fireEvent.click(screen.getAllByRole('button', { name: '▶ Start execution' })[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Execution name'), { target: { value: 'my-run' } });
    const input = dialog.querySelector('textarea');
    fireEvent.change(input, { target: { value: '{bad' } });
    expect(within(dialog).getByRole('button', { name: 'Start execution' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '{"orderId": 7}' } });
    fireEvent.change(within(dialog).getByLabelText('Target'), { target: { value: `${ARN}:live` } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start execution' }));
    await waitFor(() => expect(api.calls(op('StartExecution'))).toEqual([{ stateMachineArn: `${ARN}:live`, input: '{"orderId": 7}', name: 'my-run' }]));
    await waitFor(() => expect(window.location.hash).toBe(`#/sfn/execution/${encodeURIComponent(encodeURIComponent(EX))}`));
    expect(JSON.parse(localStorage.getItem('ddbs.sfn.inputs')).orders[0]).toBe('{"orderId": 7}');
  });

  it('edits, validates and saves the definition with a published version', async () => {
    const { api } = setupMachine({ [op('ValidateStateMachineDefinition')]: { result: 'OK', diagnostics: [] } }, 'definition');
    await screen.findByRole('img', { name: 'Workflow graph' });
    expect(document.querySelector('[data-state="Call"]')).toBeTruthy();
    const editor = document.querySelector('.sfn-split textarea');
    const next = JSON.stringify({ ...JSON.parse(DEF), Comment: 'v2' }, null, 2);
    fireEvent.change(editor, { target: { value: next } });
    expect(screen.getByText('unsaved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '✓ Validate' }));
    expect(await screen.findByText(/The definition is valid/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Publish version'));
    fireEvent.change(screen.getByLabelText('Version description'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls(op('UpdateStateMachine'))).toEqual([{ stateMachineArn: ARN, definition: next, publish: true, versionDescription: 'second' }]));
  });

  it('opens a state from the graph and tests it with TestState', async () => {
    const { api } = setupMachine({ [op('TestState')]: { status: 'SUCCEEDED', output: '{"ok":true}', inspectionData: { input: '{}', afterParameters: '{"x":1}' } } }, 'definition');
    await screen.findByRole('img', { name: 'Workflow graph' });
    fireEvent.click(document.querySelector('[data-state="Call"]'));
    expect(screen.getByText('lambda:invoke')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '🧪 Test this state' }));
    expect(await screen.findByText('Test a single state')).toBeInTheDocument();
    expect(screen.getByLabelText('State')).toHaveValue('Call');
    fireEvent.click(screen.getByRole('button', { name: '▶ Test state' }));
    await waitFor(() => expect(api.calls(op('TestState'))).toHaveLength(1));
    expect(api.calls(op('TestState'))[0]).toMatchObject({ roleArn: MACHINE.roleArn, input: '{}', inspectionLevel: 'DEBUG' });
    expect(JSON.parse(api.calls(op('TestState'))[0].definition).Resource).toBe('arn:aws:states:::lambda:invoke');
    expect(await screen.findByText('After Parameters')).toBeInTheDocument();
  });

  it('publishes versions and creates a canary alias', async () => {
    const { api } = setupMachine({ [op('PublishStateMachineVersion')]: { stateMachineVersionArn: `${ARN}:2` } }, 'versions');
    expect(await screen.findByText('desc 1')).toBeInTheDocument();
    expect(screen.getByText('v1 100%')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New version description'), { target: { value: 'hotfix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));
    await waitFor(() => expect(api.calls(op('PublishStateMachineVersion'))).toEqual([{ stateMachineArn: ARN, description: 'hotfix' }]));
    fireEvent.click(screen.getByRole('button', { name: '＋ Create alias' }));
    fireEvent.change(screen.getByLabelText('Alias name'), { target: { value: 'beta' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add a second version (canary)' }));
    fireEvent.change(screen.getByLabelText('Route 2 version'), { target: { value: `${ARN}:1` } });
    fireEvent.change(screen.getByLabelText('Route 2 weight'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
    expect(await screen.findByText('Weights must add up to 100')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Route 1 weight'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
    await waitFor(() =>
      expect(api.calls(op('CreateStateMachineAlias'))).toEqual([{ name: 'beta', routingConfiguration: [{ stateMachineVersionArn: `${ARN}:1`, weight: 80 }, { stateMachineVersionArn: `${ARN}:1`, weight: 20 }] }]),
    );
  });

  it('saves logging and tracing configuration and tags', async () => {
    const { api } = setupMachine({ [op('ListTagsForResource')]: { tags: [{ key: 'team', value: 'a' }] } }, 'config');
    fireEvent.change(await screen.findByLabelText('Log level'), { target: { value: 'ALL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(await screen.findByText(/needs a CloudWatch Logs log group ARN/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Log group ARN'), { target: { value: 'arn:aws:logs:us-east-1:0:log-group:/sfn/orders' } });
    fireEvent.click(screen.getByLabelText('Enable X-Ray tracing'));
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(api.calls(op('UpdateStateMachine'))).toHaveLength(1));
    expect(api.calls(op('UpdateStateMachine'))[0]).toEqual({
      stateMachineArn: ARN,
      roleArn: MACHINE.roleArn,
      loggingConfiguration: { level: 'ALL', includeExecutionData: false, destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: 'arn:aws:logs:us-east-1:0:log-group:/sfn/orders:*' } }] },
      tracingConfiguration: { enabled: true },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Tags' }));
    fireEvent.change(await screen.findByLabelText('Value 1'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tags' }));
    await waitFor(() => expect(api.calls(op('TagResource'))).toEqual([{ resourceArn: ARN, tags: [{ key: 'team', value: 'b' }] }]));
  });

  it('points Express workflows to CloudWatch Logs', async () => {
    mockBackend({ [op('DescribeStateMachine')]: { ...MACHINE, type: 'EXPRESS', loggingConfiguration: { level: 'ALL', destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: 'arn:aws:logs:us-east-1:0:log-group:/sfn/fast:*' } }] } } });
    localStorage.setItem('ddbs.sfn.tab', JSON.stringify('executions'));
    renderWithApp(<SfnStateMachine name="orders" />, ctx);
    expect(await screen.findByText(/Express workflows do not keep an execution history/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the log group \/sfn\/fast/ })).toHaveAttribute('href', '#/logs/group/%2Fsfn%2Ffast?range=1h');
  });

  it('reports a state machine missing from the list', () => {
    renderWithApp(<SfnStateMachine name="ghost" />, ctx);
    expect(screen.getByText(/"ghost" was not found/)).toBeInTheDocument();
  });
});

const ev = (id, type, details, prev = id - 1) => ({ id, previousEventId: prev, type, timestamp: `2026-01-03T00:00:0${id}.000Z`, ...details });
const HISTORY = [
  ev(1, 'ExecutionStarted', { executionStartedEventDetails: { input: '{"a":1}' } }, 0),
  ev(2, 'PassStateEntered', { stateEnteredEventDetails: { name: 'Prep', input: '{"a":1}' } }),
  ev(3, 'PassStateExited', { stateExitedEventDetails: { name: 'Prep', output: '{"a":2}' } }),
  ev(4, 'TaskStateEntered', { stateEnteredEventDetails: { name: 'Call', input: '{"a":2}' } }),
  ev(5, 'TaskFailed', { taskFailedEventDetails: { error: 'Lambda.Unknown', cause: 'boom' } }),
  ev(6, 'ExecutionFailed', { executionFailedEventDetails: { error: 'Lambda.Unknown', cause: 'boom' } }),
];

describe('<SfnExecution>', () => {
  const setupExec = (handlers = {}) => {
    const api = mockBackend({
      [op('DescribeExecution')]: { name: 'run-1', executionArn: EX, stateMachineArn: ARN, status: 'FAILED', input: '{"a":1}', startDate: '2026-01-03T00:00:01Z', stopDate: '2026-01-03T00:00:06Z', error: 'Lambda.Unknown', cause: 'boom', redriveStatus: 'REDRIVABLE' },
      [op('GetExecutionHistory')]: { events: HISTORY },
      [op('DescribeStateMachineForExecution')]: { definition: DEF },
      [op('ListMapRuns')]: { mapRuns: [] },
      ...handlers,
    });
    return { api, ...renderWithApp(<SfnExecution arn={EX} />, ctx) };
  };

  it('colors the graph from the history and shows a state', async () => {
    setupExec();
    await screen.findByRole('img', { name: 'Workflow graph' });
    await waitFor(() => expect(document.querySelector('[data-state="Call"]').getAttribute('class')).toMatch(/st-failed/));
    expect(document.querySelector('[data-state="Prep"]').getAttribute('class')).toMatch(/st-succeeded/);
    expect(document.querySelector('[data-state="Oops"]').getAttribute('class')).not.toMatch(/st-/);
    expect(screen.getByText(/in state "Call"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show state' }));
    const detail = document.querySelector('.sfn-exec-detail');
    expect(within(detail).getByText('Call')).toBeInTheDocument();
    expect(within(detail).getByText(/"a": 2/)).toBeInTheDocument();
    expect(within(detail).getByText(/Lambda.Unknown: boom/)).toBeInTheDocument();
  });

  it('lists steps and events, and redrives', async () => {
    const { api } = setupExec();
    const steps = await screen.findByRole('table');
    expect(within(steps).getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByRole('tab', { name: 'Event history' }));
    fireEvent.change(screen.getByLabelText('Filter events'), { target: { value: 'failed' } });
    expect(screen.getByText('TaskFailed')).toBeInTheDocument();
    expect(screen.queryByText('PassStateEntered')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('TaskFailed'));
    expect(screen.getByText(/"error": "Lambda.Unknown"/)).toBeInTheDocument();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '↻ Redrive' }));
    await waitFor(() => expect(api.calls(op('RedriveExecution'))).toEqual([{ executionArn: EX }]));
  });

  it('starts a new execution with the same input', async () => {
    const { api } = setupExec({ [op('StartExecution')]: { executionArn: `${EX}-2` } });
    fireEvent.click(await screen.findByRole('button', { name: '▶ New execution (same input)' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('textarea').value).toBe('{\n  "a": 1\n}');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start execution' }));
    await waitFor(() => expect(api.calls(op('StartExecution'))[0]).toMatchObject({ stateMachineArn: ARN, input: '{\n  "a": 1\n}' }));
  });
});

describe('<SfnActivities>', () => {
  it('creates and deletes activities', async () => {
    const api = mockBackend({ [op('ListActivities')]: { activities: [{ name: 'approve', activityArn: 'arn:aws:states:us-east-1:0:activity:approve', creationDate: '2026-01-01T00:00:00Z' }] } });
    renderWithApp(<SfnActivities />, ctx);
    expect(await screen.findByText('approve')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Activity name'), { target: { value: 'ship' } });
    fireEvent.click(screen.getByRole('button', { name: '＋ Create activity' }));
    await waitFor(() => expect(api.calls(op('CreateActivity'))).toEqual([{ name: 'ship' }]));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.calls(op('DeleteActivity'))).toEqual([{ activityArn: 'arn:aws:states:us-east-1:0:activity:approve' }]));
  });
});

describe('<CreateStateMachineModal>', () => {
  it('creates a state machine from a template with an existing role ARN', async () => {
    const api = mockBackend({ 'POST /api/lambda/iam/ListRoles': { Roles: [] }, [op('CreateStateMachine')]: { stateMachineArn: ARN } });
    const onCreated = vi.fn();
    renderWithApp(<CreateStateMachineModal onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('State machine name'), { target: { value: 'flow' } });
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'map' } });
    expect(screen.getByText('Looks valid.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'EXPRESS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create state machine' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('flow'));
    const body = api.calls(op('CreateStateMachine'))[0];
    expect(body).toMatchObject({ name: 'flow', type: 'EXPRESS', roleArn: 'arn:aws:iam::000000000000:role/stepfunctions-role' });
    expect(JSON.parse(body.definition).States['Process items'].Type).toBe('Map');
  });

  it('flags an invalid definition', () => {
    mockBackend({ 'POST /api/lambda/iam/ListRoles': { Roles: [] } });
    renderWithApp(<CreateStateMachineModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(document.querySelector('.sfn-split textarea'), { target: { value: '{"StartAt":"A","States":{"A":{"Type":"Pass","Next":"B"}}}' } });
    expect(screen.getByText(/transition to unknown state "B"/)).toBeInTheDocument();
  });

  it('retries while a new role cannot be assumed yet', async () => {
    let n = 0;
    mockBackend({
      [op('CreateStateMachine')]: () => {
        if (++n < 3) throw awsError('AccessDeniedException', 'Neither the global service principal states.amazonaws.com, nor the regional one is authorized to assume the provided role.');
        return { stateMachineArn: ARN };
      },
    });
    const out = await createMachineWithRetry({ name: 'x' }, { sleep: async () => {} });
    expect(out.stateMachineArn).toBe(ARN);
    expect(n).toBe(3);
  });
});
