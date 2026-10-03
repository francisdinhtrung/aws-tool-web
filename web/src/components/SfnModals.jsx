import React, { useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { useApp, navigate } from '../context.js';
import { Modal, Field, Select, Spinner, ErrorBox, JsonArea } from './ui.jsx';
import { KeyValueRows } from './SqsModals.jsx';
import SfnGraph from './SfnGraph.jsx';
import { lambdaIam } from '../lib/lambda.js';
import {
  sfn, TEMPLATES, TRUST_POLICY, nameError, jsonError, prettyJson, parseDefinition, lintDefinition, buildLogging,
  recentInputs, rememberInput, newExecutionName, executionPath, statusKind, statusLabel, fmtElapsed, duration,
} from '../lib/sfn.js';

const trustsStates = (r) => {
  try {
    const doc = typeof r.AssumeRolePolicyDocument === 'string' ? JSON.parse(decodeURIComponent(r.AssumeRolePolicyDocument)) : r.AssumeRolePolicyDocument;
    return JSON.stringify(doc).includes('states.');
  } catch {
    return true; // unknown: keep it in the list
  }
};

/** Roles that Step Functions can assume (trust policy mentions states.amazonaws.com). IAM goes through the Lambda IAM proxy. */
export function useStatesRoles() {
  const [roles, setRoles] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const all = [];
      let Marker;
      try {
        do {
          const out = await lambdaIam('ListRoles', { MaxItems: 1000, ...(Marker ? { Marker } : {}) });
          all.push(...(out.Roles || []));
          Marker = out.IsTruncated ? out.Marker : undefined;
        } while (Marker && all.length < 5000);
        if (live) setRoles(all.filter(trustsStates).sort((a, b) => a.RoleName.localeCompare(b.RoleName)));
      } catch (e) {
        if (live) {
          setRoles([]);
          setError(errorText(e));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return { roles, error };
}

const LAMBDA_ROLE_POLICY = 'arn:aws:iam::aws:policy/service-role/AWSLambdaRole';

/** Creates "StepFunctions-<name>-role-xxxxx", optionally allowed to invoke Lambda functions. */
export async function createStatesRole(name, { lambda = true } = {}) {
  const RoleName = `StepFunctions-${name}-role-${Math.random().toString(36).slice(2, 8)}`.slice(0, 64);
  const out = await lambdaIam('CreateRole', { RoleName, AssumeRolePolicyDocument: TRUST_POLICY, Path: '/service-role/', Description: `Execution role for state machine ${name}` });
  if (lambda) await lambdaIam('AttachRolePolicy', { RoleName, PolicyArn: LAMBDA_ROLE_POLICY });
  return out.Role.Arn;
}

/** A new IAM role takes a few seconds before Step Functions can assume it: retry meanwhile. */
export async function createMachineWithRetry(input, { tries = 8, delay = 2500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await sfn('CreateStateMachine', input);
    } catch (e) {
      if (i >= tries - 1 || !/authorized to assume|cannot be assumed|unable to assume/i.test(e.message || '')) throw e;
      await sleep(delay);
    }
  }
}

/** Role picker: create / existing / ARN. `value` = { mode, arn, lambda }. */
export function RolePicker({ value, onChange, name, allowCreate = true }) {
  const { roles, error } = useStatesRoles();
  const set = (p) => onChange({ ...value, ...p });
  return (
    <>
      <div className="seg" role="radiogroup" aria-label="Execution role">
        {allowCreate && <button className={value.mode === 'new' ? 'active' : ''} aria-pressed={value.mode === 'new'} onClick={() => set({ mode: 'new' })}>Create a new role</button>}
        <button className={value.mode === 'existing' ? 'active' : ''} aria-pressed={value.mode === 'existing'} onClick={() => set({ mode: 'existing' })}>Use an existing role</button>
        <button className={value.mode === 'arn' ? 'active' : ''} aria-pressed={value.mode === 'arn'} onClick={() => set({ mode: 'arn' })}>Enter role ARN</button>
      </div>
      {value.mode === 'new' && (
        <div className="muted small mt-s">
          Creates <code>StepFunctions-{name || '<name>'}-role-xxxxxx</code> trusted by <code>states.amazonaws.com</code>. Needs <code>iam:CreateRole</code>.
          <label className="check mt-s">
            <input type="checkbox" checked={value.lambda !== false} onChange={(e) => set({ lambda: e.target.checked })} /> Allow invoking Lambda functions (<code>AWSLambdaRole</code>)
          </label>
        </div>
      )}
      {value.mode === 'existing' && (
        <Field label="Role" hint={error ? <span className="text-bad">{error}</span> : 'Roles whose trust policy allows states.amazonaws.com.'}>
          {roles === null ? <Spinner /> : <Select value={value.arn} onChange={(arn) => set({ arn })} options={[['', roles.length ? '— select a role —' : '— no role found —'], ...roles.map((r) => [r.Arn, r.RoleName])]} aria-label="Role" />}
        </Field>
      )}
      {value.mode === 'arn' && (
        <Field label="Role ARN"><input value={value.arn} onChange={(e) => set({ arn: e.target.value })} aria-label="Role ARN" placeholder="arn:aws:iam::123456789012:role/my-role" /></Field>
      )}
    </>
  );
}

export function CreateStateMachineModal({ onClose, onCreated }) {
  const { conn } = useApp();
  const local = conn?.kind === 'endpoint';
  const [name, setName] = useState('');
  const [type, setType] = useState('STANDARD');
  const [template, setTemplate] = useState('hello');
  const [definition, setDefinition] = useState(TEMPLATES[0].definition);
  const [role, setRole] = useState({ mode: local ? 'arn' : 'new', arn: local ? 'arn:aws:iam::000000000000:role/stepfunctions-role' : '', lambda: true });
  const [logging, setLogging] = useState({ level: 'OFF', includeExecutionData: false, logGroupArn: '' });
  const [tracing, setTracing] = useState(false);
  const [tags, setTags] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const nameErr = name ? nameError(name) : '';
  const def = parseDefinition(definition);
  const problems = def ? lintDefinition(def) : [jsonError(definition, false) || 'The definition needs a "States" object'];

  const pickTemplate = (id) => {
    setTemplate(id);
    setDefinition(TEMPLATES.find((t) => t.id === id).definition);
  };

  const create = async () => {
    setError(null);
    try {
      const err = nameError(name);
      if (err) throw new Error(`Name: ${err}`);
      if (!def) throw new Error(`Definition: ${problems[0]}`);
      if (role.mode !== 'new' && !role.arn) throw new Error('Choose an execution role');
      if (logging.level !== 'OFF' && !logging.logGroupArn) throw new Error('Logging needs a CloudWatch Logs log group ARN');
      let roleArn = role.arn;
      if (role.mode === 'new') {
        setBusy('Creating execution role…');
        roleArn = await createStatesRole(name, { lambda: role.lambda !== false });
      }
      setBusy('Creating state machine…');
      const tagList = tags.filter((t) => t.key.trim()).map((t) => ({ key: t.key.trim(), value: t.value }));
      await createMachineWithRetry({
        name,
        type,
        definition,
        roleArn,
        ...(logging.level !== 'OFF' ? { loggingConfiguration: buildLogging(logging) } : {}),
        ...(tracing ? { tracingConfiguration: { enabled: true } } : {}),
        ...(tagList.length ? { tags: tagList } : {}),
      });
      onCreated(name);
    } catch (e) {
      setError(errorText(e));
      setBusy('');
    }
  };

  return (
    <Modal
      title="Create state machine"
      size="lg"
      onClose={onClose}
      footer={
        <>
          {busy && <span className="muted small push-right">{busy}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={create} disabled={Boolean(busy) || !name}>{busy ? <Spinner /> : 'Create state machine'}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid-2">
        <Field label="Name" hint={nameErr ? <span className="text-bad">{nameErr}</span> : 'Up to 80 characters: letters, digits, - and _.'}>
          <input value={name} onChange={(e) => setName(e.target.value.trim())} aria-label="State machine name" autoFocus />
        </Field>
        <Field label="Type" hint={type === 'EXPRESS' ? 'Up to 5 minutes, at-least-once, history in CloudWatch Logs only.' : 'Up to 1 year, exactly-once, full execution history.'}>
          <Select value={type} onChange={setType} options={[['STANDARD', 'Standard'], ['EXPRESS', 'Express']]} aria-label="Type" />
        </Field>
      </div>
      <Field label="Template">
        <Select value={template} onChange={pickTemplate} options={TEMPLATES.map((t) => [t.id, t.label])} aria-label="Template" />
      </Field>
      <div className="sfn-split">
        <Field label="Definition (Amazon States Language)" hint={problems.length ? <span className="text-bad">{problems[0]}{problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}</span> : 'Looks valid.'}>
          <JsonArea value={definition} onChange={setDefinition} rows={18} />
        </Field>
        <div className="sfn-preview"><SfnGraph definition={definition} /></div>
      </div>

      <h4>Permissions</h4>
      <RolePicker value={role} onChange={setRole} name={name} allowCreate={!local} />

      <h4>Logging & tracing</h4>
      <LoggingFields value={logging} onChange={setLogging} />
      <label className="check"><input type="checkbox" checked={tracing} onChange={(e) => setTracing(e.target.checked)} /> Enable X-Ray tracing</label>

      <h4>Tags</h4>
      <KeyValueRows rows={tags} onChange={setTags} />
    </Modal>
  );
}

export function LoggingFields({ value, onChange }) {
  const set = (p) => onChange({ ...value, ...p });
  return (
    <div className="grid-3">
      <Field label="Log level">
        <Select value={value.level} onChange={(level) => set({ level })} options={['OFF', 'ALL', 'ERROR', 'FATAL']} aria-label="Log level" />
      </Field>
      {value.level !== 'OFF' && (
        <>
          <Field label="Log group ARN" hint="arn:aws:logs:region:account:log-group:/aws/vendedlogs/states/name">
            <input value={value.logGroupArn} onChange={(e) => set({ logGroupArn: e.target.value })} aria-label="Log group ARN" />
          </Field>
          <label className="check check-field">
            <input type="checkbox" checked={value.includeExecutionData} onChange={(e) => set({ includeExecutionData: e.target.checked })} /> Include execution data
          </label>
        </>
      )}
    </div>
  );
}

/**
 * Starts an execution. `targets` = [[arn, label]] (state machine, versions, aliases).
 * Standard executions open the execution page; Express ones can run synchronously and show the result here.
 */
export function StartExecutionModal({ machine, targets, initialInput, onClose, onStarted }) {
  const express = machine.type === 'EXPRESS';
  const [target, setTarget] = useState(targets[0]?.[0] || machine.stateMachineArn);
  const [name, setName] = useState(() => newExecutionName());
  const [input, setInput] = useState(() => prettyJson(initialInput) || recentInputs(machine.name)[0] || '{\n  "Comment": "Insert your JSON here"\n}');
  const [sync, setSync] = useState(express);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const recent = recentInputs(machine.name);
  const inputErr = jsonError(input);
  const nameErr = name ? nameError(name) : '';

  const start = async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      if (inputErr) throw new Error(`Input is not valid JSON: ${inputErr}`);
      if (nameErr) throw new Error(`Name: ${nameErr}`);
      const body = { stateMachineArn: target, input: input.trim() || '{}', ...(name ? { name } : {}) };
      rememberInput(machine.name, input);
      if (express && sync) {
        setResult(await sfn('StartSyncExecution', body));
        setName(newExecutionName());
      } else {
        const out = await sfn('StartExecution', body);
        onStarted?.(out.executionArn);
        if (!express) navigate(executionPath(out.executionArn));
        else setResult({ executionArn: out.executionArn, started: true });
      }
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  return (
    <Modal
      title={`Start execution · ${machine.name}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
          <button className="btn btn-primary" onClick={start} disabled={busy || Boolean(inputErr)}>{busy ? <Spinner /> : 'Start execution'}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid-2">
        <Field label="Name" hint={nameErr ? <span className="text-bad">{nameErr}</span> : express ? 'Optional.' : 'Unique for 90 days. Optional.'}>
          <div className="row-gap">
            <input value={name} onChange={(e) => setName(e.target.value.trim())} aria-label="Execution name" />
            <button className="btn btn-sm" title="New random name" onClick={() => setName(newExecutionName())}>↻</button>
          </div>
        </Field>
        {targets.length > 1 && (
          <Field label="Run" hint="The state machine ($LATEST), a published version or an alias.">
            <Select value={target} onChange={setTarget} options={targets} aria-label="Target" />
          </Field>
        )}
      </div>
      {express && (
        <label className="check">
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> Wait for the result (synchronous Express execution)
        </label>
      )}
      <Field label="Input (JSON)" hint={inputErr ? <span className="text-bad">{inputErr}</span> : null}>
        <JsonArea value={input} onChange={setInput} rows={12} />
      </Field>
      <div className="row-gap wrap">
        <button className="btn btn-xs" onClick={() => setInput(prettyJson(input))} disabled={Boolean(inputErr)}>Format</button>
        {recent.length > 0 && (
          <select value="" onChange={(e) => e.target.value !== '' && setInput(recent[Number(e.target.value)])} aria-label="Recent inputs">
            <option value="">Recent inputs…</option>
            {recent.map((r, i) => <option key={i} value={i}>{r.replace(/\s+/g, ' ').slice(0, 70)}</option>)}
          </select>
        )}
      </div>
      {result && <SyncResult result={result} />}
    </Modal>
  );
}

function SyncResult({ result }) {
  if (result.started) return <div className="alert alert-info small mt-s">Started <code>{result.executionArn}</code>. Express executions are recorded in CloudWatch Logs when logging is enabled.</div>;
  return (
    <div className="card card-sub">
      <div className="card-sub-head">
        <strong>Result</strong>
        <span className={`badge badge-${statusKind(result.status)}`}>{statusLabel(result.status)}</span>
        <span className="muted small">{fmtElapsed(duration(result.startDate, result.stopDate))}{result.billingDetails ? ` · billed ${result.billingDetails.billedDurationInMilliseconds} ms, ${result.billingDetails.billedMemoryUsedInMB} MB` : ''}</span>
      </div>
      {(result.error || result.cause) && <ErrorBox error={`${result.error || 'Error'}${result.cause ? `: ${result.cause}` : ''}`} />}
      {result.output !== undefined && <JsonArea value={prettyJson(result.output)} readOnly rows={8} />}
    </div>
  );
}
