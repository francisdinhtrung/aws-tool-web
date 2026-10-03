import { describe, it, expect, beforeEach } from 'vitest';
import {
  machineNameFromArn, execNameFromArn, executionArn, executionPath, nameError, fmtElapsed, statusKind, statusLabel, jsonError,
  parseDefinition, transitions, choiceLabel, taskResource, allStates, lintDefinition, layoutDefinition, edgePath,
  analyzeHistory, eventDetails, buildLogging, logGroupName, recentInputs, rememberInput, tagChanges, TEMPLATES,
} from './sfn.js';

const SM = 'arn:aws:states:us-east-1:123:stateMachine:orders';
const EX = 'arn:aws:states:us-east-1:123:execution:orders:run-1';

describe('names and ARNs', () => {
  it('parses state machine and execution ARNs', () => {
    expect(machineNameFromArn(SM)).toBe('orders');
    expect(machineNameFromArn(`${SM}:live`)).toBe('orders');
    expect(machineNameFromArn(EX)).toBe('orders');
    expect(execNameFromArn(EX)).toBe('run-1');
    expect(executionArn(SM, 'run-1')).toBe(EX);
    expect(executionPath(EX)).toBe(`/sfn/execution/${encodeURIComponent(EX)}`);
  });

  it('validates names', () => {
    expect(nameError('')).toMatch(/required/);
    expect(nameError('a b')).toMatch(/letters/);
    expect(nameError('x'.repeat(81))).toMatch(/letters/);
    expect(nameError('order-flow_1')).toBe('');
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(fmtElapsed(undefined)).toBe('—');
    expect(fmtElapsed(250)).toBe('250 ms');
    expect(fmtElapsed(1234)).toBe('1.23 s');
    expect(fmtElapsed(95000)).toBe('1m 35s');
    expect(fmtElapsed(90061000)).toBe('1d 1h');
  });

  it('maps statuses to labels and badge kinds', () => {
    expect(statusKind('SUCCEEDED')).toBe('ok');
    expect(statusKind('TIMED_OUT')).toBe('bad');
    expect(statusKind('RUNNING')).toBe('warn');
    expect(statusLabel('TIMED_OUT')).toBe('Timed out');
    expect(statusLabel('PENDING_REDRIVE')).toBe('Pending redrive');
  });

  it('reports JSON errors', () => {
    expect(jsonError('')).toBe('');
    expect(jsonError('', false)).toBe('Required');
    expect(jsonError('{"a":1}')).toBe('');
    expect(jsonError('{a')).not.toBe('');
  });
});

const DEF = {
  StartAt: 'Check',
  States: {
    Check: {
      Type: 'Choice',
      Choices: [
        { Variable: '$.ok', BooleanEquals: true, Next: 'Work' },
        { And: [{ Variable: '$.n', NumericGreaterThan: 5 }, { Not: { Variable: '$.x', IsPresent: true } }], Next: 'Fail' },
      ],
      Default: 'Wait',
    },
    Wait: { Type: 'Wait', Seconds: 1, Next: 'Check' },
    Work: {
      Type: 'Parallel',
      Branches: [
        { StartAt: 'A', States: { A: { Type: 'Task', Resource: 'arn:aws:states:::lambda:invoke', End: true } } },
        { StartAt: 'B', States: { B: { Type: 'Pass', End: true } } },
      ],
      Catch: [{ ErrorEquals: ['States.ALL'], Next: 'Fail' }],
      Next: 'Done',
    },
    Done: { Type: 'Succeed' },
    Fail: { Type: 'Fail' },
  },
};

describe('definitions', () => {
  it('parses only objects with States', () => {
    expect(parseDefinition('{"StartAt":"a"}')).toBeNull();
    expect(parseDefinition('nope')).toBeNull();
    expect(parseDefinition(JSON.stringify(DEF)).StartAt).toBe('Check');
  });

  it('lists transitions of Choice, Next and Catch', () => {
    expect(transitions(DEF.States.Check).map((t) => [t.to, t.kind])).toEqual([['Work', 'choice'], ['Fail', 'choice'], ['Wait', 'default']]);
    expect(transitions(DEF.States.Work).map((t) => [t.to, t.kind, t.label])).toEqual([['Done', 'next', undefined], ['Fail', 'catch', 'States.ALL']]);
  });

  it('describes choice rules', () => {
    expect(choiceLabel(DEF.States.Check.Choices[0])).toBe('$.ok == true');
    expect(choiceLabel(DEF.States.Check.Choices[1])).toBe('$.n > 5 and not ($.x present)');
    expect(choiceLabel({ Condition: '{% $states.input.ok %}', Next: 'x' })).toBe('{% $states.input.ok %}');
  });

  it('describes task resources', () => {
    expect(taskResource({ Resource: 'arn:aws:states:::lambda:invoke' })).toBe('lambda:invoke');
    expect(taskResource({ Resource: 'arn:aws:states:::sqs:sendMessage.waitForTaskToken' })).toBe('sqs:sendMessage');
    expect(taskResource({ Resource: 'arn:aws:states:::aws-sdk:dynamodb:putItem' })).toBe('dynamodb:putItem');
    expect(taskResource({ Resource: 'arn:aws:states:us-east-1:1:activity:approve' })).toBe('activity:approve');
    expect(taskResource({ Resource: 'arn:aws:lambda:us-east-1:1:function:resize' })).toBe('lambda:resize');
  });

  it('collects nested states with their path', () => {
    const s = allStates(DEF);
    expect([...s.keys()]).toEqual(['Check', 'Wait', 'Work', 'A', 'B', 'Done', 'Fail']);
    expect(s.get('A').path).toEqual(['Work']);
  });

  it('lints unknown targets, missing Next and unreachable states', () => {
    expect(lintDefinition(DEF)).toEqual([]);
    const bad = { StartAt: 'X', States: { A: { Type: 'Pass', Next: 'Nope' }, B: { Type: 'Task' } } };
    expect(lintDefinition(bad)).toEqual([
      'Definition: StartAt "X" is not a state',
      'A: transition to unknown state "Nope"',
      'B: needs Next or "End": true',
      'A: not reachable from StartAt',
      'B: not reachable from StartAt',
    ]);
    expect(lintDefinition(null)[0]).toMatch(/not valid/);
  });

  it('every template is a valid definition', () => {
    for (const t of TEMPLATES) expect(lintDefinition(parseDefinition(t.definition))).toEqual([]);
  });
});

describe('layout', () => {
  it('places states in rows by longest path, with containers and back edges', () => {
    const { nodes, edges, width, height } = layoutDefinition(DEF);
    const byId = Object.fromEntries(nodes.filter((n) => n.name).map((n) => [n.name, n]));
    expect(Object.keys(byId).sort()).toEqual(['A', 'B', 'Check', 'Done', 'Fail', 'Wait', 'Work']);
    expect(byId.Check.y).toBeLessThan(byId.Work.y);
    expect(byId.Work.y).toBeLessThan(byId.Done.y);
    expect(byId.Fail.y).toBe(byId.Done.y); // Fail is reached from Check and from Work's Catch: longest path wins
    expect(byId.Work.container).toBe(true);
    // Nested states sit inside their container
    for (const n of [byId.A, byId.B]) {
      expect(n.x).toBeGreaterThanOrEqual(byId.Work.x);
      expect(n.x + n.w).toBeLessThanOrEqual(byId.Work.x + byId.Work.w);
      expect(n.y).toBeGreaterThan(byId.Work.y);
    }
    const loop = edges.find((e) => e.from === 'Wait' && e.to === 'Check');
    expect(loop.back).toBe(true);
    expect(edgePath(loop)).toMatch(/^M .* S /);
    expect(edges.find((e) => e.from === 'Work' && e.to === 'Fail').kind).toBe('catch');
    expect(nodes.filter((n) => n.marker === 'start')).toHaveLength(3); // root + 2 branches
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(byId.Fail.y);
  });
});

const ev = (id, type, details, prev = id - 1) => ({ id, previousEventId: prev, type, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(), ...details });

describe('history', () => {
  it('builds steps and statuses, with caught failures', () => {
    const events = [
      ev(1, 'ExecutionStarted', { executionStartedEventDetails: { input: '{}' } }, 0),
      ev(2, 'PassStateEntered', { stateEnteredEventDetails: { name: 'Prep', input: '{}' } }),
      ev(3, 'PassStateExited', { stateExitedEventDetails: { name: 'Prep', output: '{"a":1}' } }),
      ev(4, 'TaskStateEntered', { stateEnteredEventDetails: { name: 'Call', input: '{"a":1}' } }),
      ev(5, 'TaskScheduled', { taskScheduledEventDetails: { resource: 'invoke' } }),
      ev(6, 'TaskStarted', { taskStartedEventDetails: {} }),
      ev(7, 'TaskFailed', { taskFailedEventDetails: { error: 'Boom', cause: 'bad' } }),
      ev(8, 'TaskStateExited', { stateExitedEventDetails: { name: 'Call', output: '{"error":{}}' } }),
      ev(9, 'FailStateEntered', { stateEnteredEventDetails: { name: 'Oops', input: '{}' } }),
      ev(10, 'ExecutionFailed', { executionFailedEventDetails: { error: 'Final', cause: 'c' } }),
    ];
    const a = analyzeHistory(events);
    expect(a.steps.map((s) => [s.name, s.status])).toEqual([['Prep', 'succeeded'], ['Call', 'caught'], ['Oops', 'failed']]);
    expect(a.status).toEqual({ Prep: 'succeeded', Call: 'caught', Oops: 'failed' });
    expect(a.steps[1]).toMatchObject({ error: 'Boom', cause: 'bad', type: 'Task', output: '{"error":{}}' });
    expect(a.steps[1].events.map((e) => e.id)).toEqual([4, 5, 6, 7, 8]);
    expect(a.error).toBe('Final');
    expect(a.ended).toBe(events[9].timestamp);
    expect(eventDetails(events[6])).toEqual({ error: 'Boom', cause: 'bad' });
  });

  it('marks running and aborted states', () => {
    const base = [
      ev(1, 'ExecutionStarted', {}, 0),
      ev(2, 'WaitStateEntered', { stateEnteredEventDetails: { name: 'Sleep' } }),
    ];
    expect(analyzeHistory(base).status).toEqual({ Sleep: 'running' });
    expect(analyzeHistory([...base, ev(3, 'ExecutionAborted', {})]).status).toEqual({ Sleep: 'cancelled' });
    expect(analyzeHistory([...base, ev(3, 'ExecutionTimedOut', {})]).status).toEqual({ Sleep: 'failed' });
  });
});

describe('configuration helpers', () => {
  it('builds logging configurations', () => {
    expect(buildLogging({ level: 'OFF' })).toEqual({ level: 'OFF', includeExecutionData: false });
    const arn = 'arn:aws:logs:us-east-1:1:log-group:/aws/vendedlogs/states/x';
    const l = buildLogging({ level: 'ALL', includeExecutionData: true, logGroupArn: arn });
    expect(l.destinations[0].cloudWatchLogsLogGroup.logGroupArn).toBe(`${arn}:*`);
    expect(buildLogging({ level: 'ERROR', logGroupArn: `${arn}:*` }).destinations[0].cloudWatchLogsLogGroup.logGroupArn).toBe(`${arn}:*`);
    expect(logGroupName(l)).toBe('/aws/vendedlogs/states/x');
    expect(logGroupName({})).toBe('');
  });

  it('computes tag changes', () => {
    expect(tagChanges({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' })).toEqual({ set: [{ key: 'b', value: '3' }, { key: 'c', value: '4' }], remove: [] });
    expect(tagChanges({ a: '1' }, {})).toEqual({ set: [], remove: ['a'] });
  });

  describe('recent inputs', () => {
    beforeEach(() => localStorage.clear());
    it('keeps the 10 most recent unique inputs per state machine', () => {
      for (let i = 0; i < 12; i++) rememberInput('m', `{"i":${i}}`);
      rememberInput('m', '{"i":5}');
      const r = recentInputs('m');
      expect(r).toHaveLength(10);
      expect(r[0]).toBe('{"i":5}');
      expect(r.filter((x) => x === '{"i":5}')).toHaveLength(1);
      expect(recentInputs('other')).toEqual([]);
    });
  });
});
