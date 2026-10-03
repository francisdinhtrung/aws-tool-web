import { api } from '../api.js';

export const sfn = (op, input = {}) => api(`/api/sfn/op/${op}`, { method: 'POST', body: input });

// --- Names, ARNs, routes ---------------------------------------------------------------------
export const sfnPath = (name) => (name ? `/sfn/machine/${encodeURIComponent(name)}` : '/sfn');
export const executionPath = (arn) => `/sfn/execution/${encodeURIComponent(arn)}`;
export const arnName = (arn) => String(arn || '').split(':').pop();
/** arn:aws:states:r:acct:stateMachine:name[:version|alias] -> name */
export const machineNameFromArn = (arn) => String(arn || '').split(':')[6] || '';
/** arn:aws:states:r:acct:execution:machine:exec -> exec */
export const execNameFromArn = (arn) => String(arn || '').split(':')[7] || arnName(arn);
/** Execution ARN for a state machine ARN and an execution name. */
export const executionArn = (machineArn, name) => `${String(machineArn).replace(':stateMachine:', ':execution:')}:${name}`;
export const NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function nameError(name) {
  if (!name) return 'Name is required';
  if (!NAME_RE.test(name)) return 'Up to 80 letters, digits, hyphens and underscores';
  return '';
}

export async function listAllStateMachines({ max = 5000 } = {}) {
  const machines = [];
  let nextToken;
  do {
    const out = await sfn('ListStateMachines', { maxResults: 1000, ...(nextToken ? { nextToken } : {}) });
    machines.push(...(out.stateMachines || []));
    nextToken = out.nextToken;
  } while (nextToken && machines.length < max);
  return { machines: machines.sort((a, b) => a.name.localeCompare(b.name)), more: Boolean(nextToken) };
}

/** Follows nextToken for list operations ("versions", "aliases", "activities"...). */
export async function listAll(op, input, key, max = 1000) {
  const items = [];
  let nextToken;
  do {
    const out = await sfn(op, { ...input, ...(nextToken ? { nextToken } : {}) });
    items.push(...(out[key] || []));
    nextToken = out.nextToken;
  } while (nextToken && items.length < max);
  return items;
}

// --- Formatting ------------------------------------------------------------------------------
export const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—');

/** 1234 -> "1.23 s", 95000 -> "1m 35s". */
export function fmtElapsed(ms) {
  if (ms === undefined || ms === null || Number.isNaN(Number(ms)) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const parts = [];
  let rest = Math.floor(s);
  for (const [size, unit] of [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']]) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return parts.slice(0, 2).join(' ');
}

export const duration = (start, stop, now = Date.now()) => (start ? (stop ? new Date(stop) : new Date(now)) - new Date(start) : undefined);

// Execution and state statuses -> badge kind.
const STATUS_KIND = { RUNNING: 'warn', SUCCEEDED: 'ok', FAILED: 'bad', TIMED_OUT: 'bad', ABORTED: 'bad', PENDING_REDRIVE: 'warn' };
export const statusKind = (s) => STATUS_KIND[s] || '';
export const EXECUTION_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED', 'PENDING_REDRIVE'];
export const statusLabel = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function prettyJson(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

/** Error message for a JSON text, or '' when it parses. Empty text is valid when `allowEmpty`. */
export function jsonError(text, allowEmpty = true) {
  if (!String(text ?? '').trim()) return allowEmpty ? '' : 'Required';
  try {
    JSON.parse(text);
    return '';
  } catch (e) {
    return e.message;
  }
}

// --- Definitions (Amazon States Language) -----------------------------------------------------
export function parseDefinition(text) {
  try {
    const d = typeof text === 'string' ? JSON.parse(text) : text;
    return d && typeof d === 'object' && d.States && typeof d.States === 'object' ? d : null;
  } catch {
    return null;
  }
}

/** Nested graphs of a Parallel (branches) or Map (ItemProcessor / legacy Iterator) state. */
export function childGraphs(state = {}) {
  if (state.Type === 'Parallel') return (state.Branches || []).map((b, i) => ({ label: `Branch ${i + 1}`, graph: b }));
  if (state.Type === 'Map') {
    const g = state.ItemProcessor || state.Iterator;
    return g ? [{ label: state.ItemProcessor?.ProcessorConfig?.Mode === 'DISTRIBUTED' ? 'Distributed map' : 'Iteration', graph: g }] : [];
  }
  return [];
}

/** Outgoing transitions of a state: [{ to, kind: 'next'|'choice'|'default'|'catch', label }]. */
export function transitions(state = {}) {
  const out = [];
  if (state.Type === 'Choice') {
    (state.Choices || []).forEach((c, i) => c.Next && out.push({ to: c.Next, kind: 'choice', label: choiceLabel(c) || `Rule ${i + 1}` }));
    if (state.Default) out.push({ to: state.Default, kind: 'default', label: 'Default' });
  } else if (state.Next) out.push({ to: state.Next, kind: 'next' });
  for (const c of state.Catch || []) if (c.Next) out.push({ to: c.Next, kind: 'catch', label: (c.ErrorEquals || []).join(', ') || 'Catch' });
  return out;
}

export const isTerminal = (state = {}) => state.End === true || state.Type === 'Succeed' || state.Type === 'Fail';

const CMP = [
  ['StringEquals', '=='], ['StringEqualsPath', '=='], ['NumericEquals', '=='], ['NumericEqualsPath', '=='], ['BooleanEquals', '=='], ['BooleanEqualsPath', '=='], ['TimestampEquals', '=='],
  ['NumericLessThan', '<'], ['NumericLessThanPath', '<'], ['StringLessThan', '<'], ['TimestampLessThan', '<'],
  ['NumericGreaterThan', '>'], ['NumericGreaterThanPath', '>'], ['StringGreaterThan', '>'], ['TimestampGreaterThan', '>'],
  ['NumericLessThanEquals', '<='], ['StringLessThanEquals', '<='], ['TimestampLessThanEquals', '<='],
  ['NumericGreaterThanEquals', '>='], ['StringGreaterThanEquals', '>='], ['TimestampGreaterThanEquals', '>='],
  ['StringMatches', 'matches'],
];

/** Short human text for a Choice rule: `$.status == "ok"`, `not (...)`, `a and b`. */
export function choiceLabel(rule) {
  if (!rule || typeof rule !== 'object') return '';
  if (rule.Condition) return String(rule.Condition); // JSONata
  if (rule.Not) return `not (${choiceLabel(rule.Not)})`;
  if (rule.And) return rule.And.map(choiceLabel).join(' and ');
  if (rule.Or) return rule.Or.map(choiceLabel).join(' or ');
  for (const [k, op] of CMP) if (k in rule) return `${rule.Variable} ${op} ${JSON.stringify(rule[k])}`;
  for (const k of ['IsPresent', 'IsNull', 'IsString', 'IsNumeric', 'IsBoolean', 'IsTimestamp']) if (k in rule) return `${rule.Variable} ${rule[k] ? '' : 'not '}${k.slice(2).toLowerCase()}`.replace('  ', ' ');
  return '';
}

/** What a Task state calls: "lambda:invoke", "dynamodb:putItem", "activity", or the raw ARN. */
export function taskResource(state = {}) {
  const r = String(state.Resource || '');
  let m = /^arn:aws[\w-]*:states:::(?:aws-sdk:)?([^.:]+?)[:.]([^.:]+)(?:\.\w+)?$/.exec(r);
  if (m) return `${m[1]}:${m[2]}`;
  m = /^arn:aws[\w-]*:states:[^:]*:[^:]*:activity:(.+)$/.exec(r);
  if (m) return `activity:${m[1]}`;
  m = /^arn:aws[\w-]*:lambda:[^:]*:[^:]*:function:([^:]+)/.exec(r);
  if (m) return `lambda:${m[1]}`;
  return r;
}

/** Names of all states, nested ones included: Map { name -> { state, path } }. */
export function allStates(def, path = []) {
  const out = new Map();
  for (const [name, st] of Object.entries(def?.States || {})) {
    out.set(name, { state: st, path });
    childGraphs(st).forEach((c) => {
      for (const [n, v] of allStates(c.graph, [...path, name])) out.set(n, v);
    });
  }
  return out;
}

/** Static checks the UI can do without calling AWS (ValidateStateMachineDefinition does the rest). */
export function lintDefinition(def) {
  const problems = [];
  const check = (g, where) => {
    const states = g?.States || {};
    const names = Object.keys(states);
    if (!g?.StartAt) problems.push(`${where}: missing StartAt`);
    else if (!states[g.StartAt]) problems.push(`${where}: StartAt "${g.StartAt}" is not a state`);
    for (const [name, st] of Object.entries(states)) {
      if (!st?.Type) problems.push(`${name}: missing Type`);
      for (const t of transitions(st)) if (!states[t.to]) problems.push(`${name}: transition to unknown state "${t.to}"`);
      if (!isTerminal(st) && st?.Type !== 'Choice' && !st?.Next) problems.push(`${name}: needs Next or "End": true`);
      childGraphs(st).forEach((c) => check(c.graph, `${name} › ${c.label}`));
    }
    // Unreachable states
    const seen = new Set();
    const walk = (n) => {
      if (!states[n] || seen.has(n)) return;
      seen.add(n);
      transitions(states[n]).forEach((t) => walk(t.to));
    };
    walk(g?.StartAt);
    for (const n of names) if (!seen.has(n)) problems.push(`${n}: not reachable from StartAt`);
  };
  if (!def) return ['Definition is not valid JSON with a "States" object'];
  check(def, 'Definition');
  return problems;
}

// --- Graph layout -------------------------------------------------------------------------------
// Vertical layered layout: every state sits in the row of its longest path from StartAt (back edges ignored).
// Parallel / Map states are containers whose nested graphs are laid out side by side.
const NODE_W = 170;
const NODE_H = 38;
const GAP_X = 28;
const GAP_Y = 46;
const PAD = 14;
const HEAD = 26;
const MARK = 14; // start / end marker diameter

/**
 * Lays out a definition. Returns { width, height, nodes, edges } with absolute coordinates.
 * nodes: { id, name, type, x, y, w, h, container?, label? , marker?: 'start'|'end' }
 * edges: { from, to, kind, label, points: [x1, y1, x2, y2], back }
 */
export function layoutDefinition(def) {
  const nodes = [];
  const edges = [];
  const box = layoutGraph(def, 'root');
  place(box, 0, 0, nodes, edges);
  return { width: box.w, height: box.h, nodes, edges };
}

function layoutGraph(g, scope) {
  const states = g?.States || {};
  const names = Object.keys(states);
  // Back edges via DFS from StartAt; then longest-path ranks on the remaining DAG.
  const back = new Set();
  const order = [];
  const state = {};
  const dfs = (n) => {
    state[n] = 1;
    for (const t of transitions(states[n])) {
      if (!states[t.to]) continue;
      if (state[t.to] === 1) back.add(`${n}>${t.to}`);
      else if (!state[t.to]) dfs(t.to);
    }
    state[n] = 2;
    order.push(n);
  };
  if (states[g?.StartAt]) dfs(g.StartAt);
  for (const n of names) if (!state[n]) dfs(n); // unreachable states still get drawn
  order.reverse();
  const rank = {};
  for (const n of order) rank[n] ??= 0;
  for (const n of order) {
    for (const t of transitions(states[n])) {
      if (!states[t.to] || back.has(`${n}>${t.to}`)) continue;
      rank[t.to] = Math.max(rank[t.to] ?? 0, rank[n] + 1);
    }
  }
  const boxes = {};
  for (const n of names) {
    const children = childGraphs(states[n]).map((c) => ({ ...c, box: layoutGraph(c.graph, `${scope}/${n}`) }));
    if (children.length) {
      const w = children.reduce((s, c) => s + c.box.w, 0) + GAP_X * (children.length - 1) + PAD * 2;
      const h = Math.max(...children.map((c) => c.box.h)) + HEAD + PAD + 18;
      boxes[n] = { w: Math.max(w, NODE_W + PAD * 2), h, children };
    } else boxes[n] = { w: NODE_W, h: NODE_H };
  }
  const rows = [];
  for (const n of order) (rows[rank[n] + 1] ||= []).push(n);
  for (let i = 1; i < rows.length; i++) rows[i] ||= [];
  rows[0] = ['__start'];
  rows.push(['__end']);
  boxes.__start = { w: MARK, h: MARK };
  boxes.__end = { w: MARK, h: MARK };
  const rowW = rows.map((r) => r.reduce((s, n) => s + boxes[n].w, 0) + GAP_X * Math.max(0, r.length - 1));
  const rowH = rows.map((r) => Math.max(0, ...r.map((n) => boxes[n].h)));
  const w = Math.max(NODE_W, ...rowW) + PAD * 2;
  const pos = {};
  let y = PAD;
  rows.forEach((r, i) => {
    let x = (w - rowW[i]) / 2;
    for (const n of r) {
      pos[n] = { x, y: y + (rowH[i] - boxes[n].h) / 2 };
      x += boxes[n].w + GAP_X;
    }
    y += rowH[i] + (i < rows.length - 1 && rowH[i] ? GAP_Y : 0);
  });
  const links = [];
  if (states[g?.StartAt]) links.push({ from: '__start', to: g.StartAt, kind: 'next' });
  for (const n of names) {
    for (const t of transitions(states[n])) if (states[t.to]) links.push({ from: n, to: t.to, kind: t.kind, label: t.label, back: back.has(`${n}>${t.to}`) });
    if (isTerminal(states[n])) links.push({ from: n, to: '__end', kind: 'next' });
  }
  return { w, h: y + PAD, scope, states, boxes, pos, links };
}

function place(box, ox, oy, nodes, edges) {
  const abs = (n) => ({ x: ox + box.pos[n].x, y: oy + box.pos[n].y, w: box.boxes[n].w, h: box.boxes[n].h });
  for (const n of Object.keys(box.pos)) {
    const a = abs(n);
    if (n === '__start' || n === '__end') {
      nodes.push({ id: `${box.scope}:${n}`, marker: n.slice(2), ...a });
      continue;
    }
    const st = box.states[n];
    const b = box.boxes[n];
    nodes.push({ id: n, name: n, type: st.Type, container: Boolean(b.children), ...a });
    if (b.children) {
      let cx = a.x + PAD;
      const top = a.y + HEAD;
      for (const c of b.children) {
        nodes.push({ id: `${box.scope}/${n}:${c.label}`, label: c.label, x: cx, y: top, w: c.box.w, h: c.box.h, group: true });
        place(c.box, cx, top, nodes, edges);
        cx += c.box.w + GAP_X;
      }
    }
  }
  const idOf = (n) => (n.startsWith('__') ? `${box.scope}:${n}` : n);
  for (const l of box.links) {
    const s = abs(l.from);
    const t = abs(l.to);
    const points = [s.x + s.w / 2, s.y + s.h, t.x + t.w / 2, t.y];
    edges.push({ ...l, from: idOf(l.from), to: idOf(l.to), points, back: l.back || t.y <= s.y });
  }
}

/** SVG path for an edge: a smooth curve down, or a loop around the right side for back edges. */
export function edgePath({ points: [x1, y1, x2, y2], back }) {
  if (back) {
    const side = Math.max(x1, x2) + NODE_W / 2 + 20;
    return `M ${x1} ${y1} C ${x1} ${y1 + 30}, ${side} ${y1 + 30}, ${side} ${(y1 + y2) / 2} S ${x2} ${y2 - 30}, ${x2} ${y2}`;
  }
  const dy = Math.max(20, (y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

// --- Execution history ---------------------------------------------------------------------------
const FAIL_RE = /(Failed|TimedOut|Aborted)$/;

/** Detail object of a history event, whatever its type (`taskFailedEventDetails`, ...). */
export function eventDetails(e = {}) {
  for (const [k, v] of Object.entries(e)) if (k.endsWith('EventDetails') && v && typeof v === 'object') return v;
  return null;
}

/**
 * Turns GetExecutionHistory events into one row per state visit and a status per state name.
 * Status: running | succeeded | failed | caught | cancelled.
 */
export function analyzeHistory(events = []) {
  const steps = [];
  const open = []; // steps still running, most recent last
  const status = {};
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const e of events) {
    const d = eventDetails(e) || {};
    const t = e.type || '';
    if (t.endsWith('StateEntered')) {
      const step = { name: d.name, type: t.replace(/StateEntered$/, ''), entered: e.timestamp, input: d.input, status: 'running', enteredId: e.id, events: [e] };
      steps.push(step);
      open.push(step);
      status[d.name] = 'running';
      continue;
    }
    if (t.endsWith('StateExited')) {
      const i = findOpen(open, d.name);
      if (i < 0) continue;
      const step = open.splice(i, 1)[0];
      step.exited = e.timestamp;
      step.output = d.output;
      step.status = step.status === 'failed' ? 'caught' : 'succeeded';
      step.events.push(e);
      status[step.name] = step.status;
      continue;
    }
    // Attach the event to the state it belongs to (walk previousEventId back to a StateEntered event).
    const owner = ownerStep(e, byId, open);
    if (owner) owner.events.push(e);
    if (t === 'ExecutionAborted' || t === 'ExecutionTimedOut') {
      for (const s of open) {
        s.status = t === 'ExecutionAborted' ? 'cancelled' : 'failed';
        status[s.name] = s.status;
      }
    } else if (FAIL_RE.test(t) && !t.startsWith('Execution')) {
      const s = owner || open[open.length - 1];
      if (s) {
        s.status = 'failed';
        s.error = d.error;
        s.cause = d.cause;
        status[s.name] = 'failed';
      }
    } else if (t === 'ExecutionFailed') {
      const s = open[open.length - 1];
      if (s && s.status === 'running') {
        s.status = 'failed';
        status[s.name] = 'failed';
      }
      for (const s2 of open) if (s2.status === 'failed') status[s2.name] = 'failed';
    }
  }
  const first = events[0];
  const last = events[events.length - 1];
  const end = events.find((e) => /^Execution(Succeeded|Failed|Aborted|TimedOut)$/.test(e.type));
  const endDetails = end ? eventDetails(end) || {} : {};
  return {
    steps,
    status,
    started: first?.timestamp,
    ended: end?.timestamp,
    lastEvent: last?.timestamp,
    error: endDetails.error,
    cause: endDetails.cause,
  };
}

function findOpen(open, name) {
  for (let i = open.length - 1; i >= 0; i--) if (open[i].name === name) return i;
  return -1;
}

function ownerStep(e, byId, open) {
  let p = byId.get(e.previousEventId);
  for (let hops = 0; p && hops < 50; hops++) {
    if (p.type?.endsWith('StateEntered')) return open.find((s) => s.enteredId === p.id) || null;
    if (p.type?.endsWith('StateExited')) return null;
    p = byId.get(p.previousEventId);
  }
  return null;
}

/** Fetches the whole history (up to `max` events). */
export async function getHistory(executionArn, { max = 25000, reverse = false } = {}) {
  const events = [];
  let nextToken;
  do {
    const out = await sfn('GetExecutionHistory', { executionArn, maxResults: 1000, reverseOrder: reverse, includeExecutionData: true, ...(nextToken ? { nextToken } : {}) });
    events.push(...(out.events || []));
    nextToken = out.nextToken;
  } while (nextToken && events.length < max);
  return { events, more: Boolean(nextToken) };
}

// --- Templates ------------------------------------------------------------------------------------
const def = (o) => JSON.stringify(o, null, 2);

export const TEMPLATES = [
  {
    id: 'hello',
    label: 'Hello world (Pass, Choice, Wait)',
    definition: def({
      Comment: 'A Hello World example of the Amazon States Language',
      StartAt: 'Pass',
      States: {
        Pass: { Type: 'Pass', Result: { IsHelloWorldExample: true }, Next: 'Hello World example?' },
        'Hello World example?': {
          Type: 'Choice',
          Choices: [
            { Variable: '$.IsHelloWorldExample', BooleanEquals: true, Next: 'Yes' },
            { Variable: '$.IsHelloWorldExample', BooleanEquals: false, Next: 'No' },
          ],
          Default: 'Yes',
        },
        Yes: { Type: 'Pass', Next: 'Wait 3 sec' },
        No: { Type: 'Fail', Cause: 'Not Hello World' },
        'Wait 3 sec': { Type: 'Wait', Seconds: 3, Next: 'Parallel State' },
        'Parallel State': {
          Type: 'Parallel',
          Next: 'Hello World',
          Branches: [
            { StartAt: 'Hello', States: { Hello: { Type: 'Pass', End: true } } },
            { StartAt: 'World', States: { World: { Type: 'Pass', End: true } } },
          ],
        },
        'Hello World': { Type: 'Pass', End: true },
      },
    }),
  },
  {
    id: 'lambda',
    label: 'Invoke a Lambda function with retry and catch',
    definition: def({
      Comment: 'Invoke a Lambda function, retry on transient errors and handle failures',
      StartAt: 'Invoke function',
      States: {
        'Invoke function': {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          Parameters: { FunctionName: 'arn:aws:lambda:REGION:ACCOUNT:function:NAME', 'Payload.$': '$' },
          OutputPath: '$.Payload',
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException'], IntervalSeconds: 1, MaxAttempts: 3, BackoffRate: 2 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'Handle failure' }],
          Next: 'Done',
        },
        'Handle failure': { Type: 'Fail', Error: 'FunctionFailed', Cause: 'The Lambda function failed' },
        Done: { Type: 'Succeed' },
      },
    }),
  },
  {
    id: 'map',
    label: 'Process items with Map',
    definition: def({
      Comment: 'Process every element of $.items',
      StartAt: 'Process items',
      States: {
        'Process items': {
          Type: 'Map',
          ItemsPath: '$.items',
          MaxConcurrency: 5,
          ItemProcessor: {
            ProcessorConfig: { Mode: 'INLINE' },
            StartAt: 'Transform',
            States: { Transform: { Type: 'Pass', Parameters: { 'value.$': '$', processed: true }, End: true } },
          },
          ResultPath: '$.results',
          End: true,
        },
      },
    }),
  },
  {
    id: 'sqs',
    label: 'Send a message to SQS and wait for a callback',
    definition: def({
      StartAt: 'Send to queue',
      States: {
        'Send to queue': {
          Type: 'Task',
          Resource: 'arn:aws:states:::sqs:sendMessage.waitForTaskToken',
          Parameters: { QueueUrl: 'https://sqs.REGION.amazonaws.com/ACCOUNT/QUEUE', MessageBody: { 'input.$': '$', 'taskToken.$': '$$.Task.Token' } },
          TimeoutSeconds: 3600,
          End: true,
        },
      },
    }),
  },
  {
    id: 'blank',
    label: 'Blank',
    definition: def({ StartAt: 'Start', States: { Start: { Type: 'Pass', End: true } } }),
  },
];

export const STATE_TYPES = ['Task', 'Pass', 'Choice', 'Wait', 'Succeed', 'Fail', 'Parallel', 'Map'];

/** IAM trust policy for a Step Functions execution role. */
export const TRUST_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'states.amazonaws.com' }, Action: 'sts:AssumeRole' }],
});

/** Logging configuration from a form: { level, includeExecutionData, logGroupArn }. */
export function buildLogging({ level = 'OFF', includeExecutionData = false, logGroupArn = '' } = {}) {
  const out = { level, includeExecutionData: Boolean(includeExecutionData) };
  if (level !== 'OFF' && logGroupArn) {
    const arn = /:\*$/.test(logGroupArn) ? logGroupArn : `${logGroupArn}:*`;
    out.destinations = [{ cloudWatchLogsLogGroup: { logGroupArn: arn } }];
  }
  return out;
}

/** Log group name of a logging configuration, if any (arn:aws:logs:r:a:log-group:NAME:*). */
export function logGroupName(loggingConfiguration) {
  const arn = loggingConfiguration?.destinations?.[0]?.cloudWatchLogsLogGroup?.logGroupArn;
  const m = /:log-group:(.+?)(?::\*)?$/.exec(arn || '');
  return m ? m[1] : '';
}

/** Recent execution inputs, per state machine (localStorage). */
const RECENT_KEY = 'ddbs.sfn.inputs';
export function recentInputs(machine) {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '{}')[machine] || [];
  } catch {
    return [];
  }
}
export function rememberInput(machine, input) {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}');
    all[machine] = [input, ...(all[machine] || []).filter((x) => x !== input)].slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

/** Random execution name like the console's (a UUID). */
export const newExecutionName = () =>
  globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => ((Math.random() * 16) | (c === 'x' ? 0 : 8)).toString(16));

/** Tag changes between two maps: { set, remove } in Step Functions' list format. */
export function tagChanges(orig = {}, next = {}) {
  return {
    set: Object.entries(next).filter(([k, v]) => orig[k] !== v).map(([key, value]) => ({ key, value })),
    remove: Object.keys(orig).filter((k) => !(k in next)),
  };
}
