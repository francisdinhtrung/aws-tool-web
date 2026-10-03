import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { errorText } from '../api.js';
import { Field, Select, Spinner, ErrorBox, Empty, JsonArea, useToast, copyText } from './ui.jsx';
import { KeyValueRows } from './SqsModals.jsx';
import SfnGraph from './SfnGraph.jsx';
import { RolePicker, LoggingFields } from './SfnModals.jsx';
import {
  sfn, executionPath, fmtDate, fmtElapsed, duration, statusKind, statusLabel, EXECUTION_STATUSES, arnName,
  prettyJson, jsonError, parseDefinition, lintDefinition, allStates, buildLogging, logGroupName, taskResource, tagChanges,
} from '../lib/sfn.js';
import { logsGroupPath } from '../lib/logs.js';

export function StatusBadge({ status }) {
  return <span className={`badge badge-${statusKind(status)}`}>{statusLabel(status)}</span>;
}

// --- Executions ---------------------------------------------------------------------------------------
export function ExecutionsTab({ machine, onStart, reloadKey }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const express = machine.type === 'EXPRESS';

  const load = useCallback(
    async (token) => {
      setBusy(true);
      setError(null);
      try {
        const out = await sfn('ListExecutions', { stateMachineArn: machine.stateMachineArn, maxResults: 100, ...(status ? { statusFilter: status } : {}), ...(token ? { nextToken: token } : {}) });
        setItems((old) => [...(token ? old || [] : []), ...(out.executions || [])]);
        setNext(out.nextToken || null);
      } catch (e) {
        setItems([]);
        setError(errorText(e));
      }
      setBusy(false);
    },
    [machine.stateMachineArn, status],
  );

  useEffect(() => {
    if (!express) load();
  }, [load, express, reloadKey]);

  const stop = async (x) => {
    const cause = window.prompt(`Stop execution "${x.name}"?\nOptional cause:`, '');
    if (cause === null) return;
    try {
      await sfn('StopExecution', { executionArn: x.executionArn, ...(cause ? { cause } : {}) });
      toast(`Stopped ${x.name}`);
      load();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  if (express) {
    const group = logGroupName(machine.loggingConfiguration);
    return (
      <div className="card">
        <p>Express workflows do not keep an execution history in Step Functions: executions are recorded in CloudWatch Logs.</p>
        {group ? (
          <a className="btn" href={`#${logsGroupPath(group, { range: '1h' })}`}>📜 Open the log group {group}</a>
        ) : (
          <div className="muted small">Logging is off. Enable it in the Configuration tab to record executions.</div>
        )}
        <div className="mt-s"><button className="btn btn-primary" onClick={() => onStart()}>▶ Start execution</button></div>
      </div>
    );
  }

  const q = filter.trim().toLowerCase();
  const shown = (items || []).filter((x) => x.name.toLowerCase().includes(q));
  return (
    <div className="card">
      <div className="card-head">
        <h3>Executions {items && <span className="muted small">({items.length}{next ? '+' : ''})</span>}</h3>
        <div className="row-gap wrap">
          <input placeholder="Filter by name…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter executions" />
          <Select value={status} onChange={setStatus} options={[['', 'All statuses'], ...EXECUTION_STATUSES.map((s) => [s, statusLabel(s)])]} aria-label="Status filter" />
          <button className="btn btn-sm" onClick={() => load()} disabled={busy}>↻ Refresh</button>
          <button className="btn btn-sm btn-primary" onClick={() => onStart()}>▶ Start execution</button>
        </div>
      </div>
      <ErrorBox error={error} />
      {!items && <Spinner />}
      {items && !items.length && !error && <Empty>No executions{status ? ` with status ${statusLabel(status).toLowerCase()}` : ''}.</Empty>}
      {shown.length > 0 && (
        <table className="grid sfn-exec-table">
          <thead>
            <tr><th>Name</th><th>Status</th><th>Started</th><th>Ended</th><th className="col-num">Duration</th><th>Version / alias</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((x) => (
              <tr key={x.executionArn}>
                <td className="col-name ellipsis" title={x.executionArn}><a href={`#${executionPath(x.executionArn)}`}>{x.name}</a>{x.redriveCount > 0 && <span className="badge" title="Redrive count">↻ {x.redriveCount}</span>}</td>
                <td><StatusBadge status={x.status} /></td>
                <td>{fmtDate(x.startDate)}</td>
                <td>{fmtDate(x.stopDate)}</td>
                <td className="col-num">{fmtElapsed(duration(x.startDate, x.stopDate))}</td>
                <td className="small muted">{x.stateMachineAliasArn ? `alias ${arnName(x.stateMachineAliasArn)}` : x.stateMachineVersionArn ? `v${arnName(x.stateMachineVersionArn)}` : '—'}</td>
                <td className="row-actions">
                  <button className="btn btn-xs" title="Copy ARN" onClick={() => copyText(x.executionArn).then(() => toast('ARN copied'))}>⧉</button>
                  {x.status === 'RUNNING' && <button className="btn btn-xs btn-danger" onClick={() => stop(x)}>Stop</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && <button className="btn btn-sm mt-s" onClick={() => load(next)} disabled={busy}>{busy ? <Spinner /> : 'Load more'}</button>}
    </div>
  );
}

// --- Definition -----------------------------------------------------------------------------------------
export function DefinitionTab({ machine, refresh, onTestState }) {
  const toast = useToast();
  const [text, setText] = useState(() => prettyJson(machine.definition));
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [publish, setPublish] = useState(false);
  const [versionDescription, setVersionDescription] = useState('');
  const original = prettyJson(machine.definition);
  const dirty = text !== original;
  const def = parseDefinition(text);
  const syntax = jsonError(text, false);
  const states = useMemo(() => (def ? allStates(def) : new Map()), [def]);
  const sel = states.get(selected);

  useEffect(() => {
    setText(prettyJson(machine.definition));
  }, [machine.definition]);

  const validate = async () => {
    setBusy('validate');
    setResult(null);
    const local = def ? lintDefinition(def) : [syntax || 'Missing "States"'];
    try {
      const out = await sfn('ValidateStateMachineDefinition', { definition: text, type: machine.type });
      setResult({ local, remote: out });
    } catch (e) {
      setResult({ local, remoteError: errorText(e) });
    }
    setBusy('');
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      if (syntax) throw new Error(`Definition is not valid JSON: ${syntax}`);
      await sfn('UpdateStateMachine', { stateMachineArn: machine.stateMachineArn, definition: text, ...(publish ? { publish: true, ...(versionDescription ? { versionDescription } : {}) } : {}) });
      toast(publish ? 'Saved and published a new version' : 'Definition saved');
      setPublish(false);
      setVersionDescription('');
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy('');
  };

  useEffect(() => {
    const f = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (dirty && !busy) save();
      }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  });

  return (
    <div className="card">
      <div className="card-head">
        <h3>Definition {dirty && <span className="badge badge-warn">unsaved</span>}</h3>
        <div className="row-gap wrap">
          <button className="btn btn-sm" onClick={() => setText(prettyJson(text))} disabled={Boolean(syntax)}>Format</button>
          <button className="btn btn-sm" onClick={validate} disabled={Boolean(busy)}>{busy === 'validate' ? <Spinner /> : '✓ Validate'}</button>
          <button className="btn btn-sm" onClick={() => setText(original)} disabled={!dirty}>Revert</button>
          <label className="check small"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish version</label>
          {publish && <input placeholder="Version description" value={versionDescription} onChange={(e) => setVersionDescription(e.target.value)} aria-label="Version description" />}
          <button className="btn btn-sm btn-primary" onClick={save} disabled={!dirty || Boolean(busy) || Boolean(syntax)} title="Ctrl+S">{busy === 'save' ? <Spinner /> : 'Save'}</button>
        </div>
      </div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      {result && <ValidationResult result={result} onClose={() => setResult(null)} />}
      <div className="sfn-split">
        <div>
          <JsonArea value={text} onChange={setText} rows={28} />
          {syntax && <div className="text-bad small">{syntax}</div>}
        </div>
        <div className="sfn-preview">
          <SfnGraph definition={text} selected={selected} onSelect={setSelected} />
          {sel && (
            <div className="card card-sub">
              <div className="card-sub-head">
                <strong>{selected}</strong>
                <span className="badge">{sel.state.Type}</span>
                {sel.state.Type === 'Task' && <code className="small ellipsis">{taskResource(sel.state)}</code>}
                <span className="push-right row-gap">
                  <button className="btn btn-xs" onClick={() => onTestState(selected)}>🧪 Test this state</button>
                  <button className="icon-btn" onClick={() => setSelected('')} aria-label="Close state">×</button>
                </span>
              </div>
              {sel.path.length > 0 && <div className="muted small">Inside {sel.path.join(' › ')}</div>}
              <pre className="code sfn-state-json">{JSON.stringify(sel.state, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ValidationResult({ result, onClose }) {
  const diags = result.remote?.diagnostics || [];
  const ok = !result.local.length && !result.remoteError && result.remote?.result !== 'FAIL';
  return (
    <div className={`alert ${ok ? 'alert-info' : 'alert-error'} small`}>
      <button className="icon-btn push-right" onClick={onClose} aria-label="Close" style={{ float: 'right' }}>×</button>
      {ok && <div>✓ The definition is valid{result.remote ? ' (ValidateStateMachineDefinition: OK)' : ''}.</div>}
      {result.local.map((p) => <div key={p}>• {p}</div>)}
      {diags.map((d, i) => (
        <div key={i}>• <strong>{d.severity}</strong> {d.code}: {d.message}{d.location ? ` (${d.location})` : ''}</div>
      ))}
      {result.remoteError && <div className="muted">Server validation unavailable: {result.remoteError}</div>}
    </div>
  );
}

// --- Test state ----------------------------------------------------------------------------------------------
export function TestStateTab({ machine, initialState }) {
  const def = useMemo(() => parseDefinition(machine.definition), [machine.definition]);
  const states = useMemo(() => (def ? allStates(def) : new Map()), [def]);
  const names = [...states.keys()];
  const [name, setName] = useState(initialState && states.has(initialState) ? initialState : names[0] || '');
  const [stateText, setStateText] = useState('');
  const [input, setInput] = useState('{}');
  const [roleArn, setRoleArn] = useState(machine.roleArn || '');
  const [level, setLevel] = useState('DEBUG');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (initialState && states.has(initialState)) setName(initialState);
  }, [initialState, states]);
  useEffect(() => {
    setStateText(states.get(name) ? JSON.stringify(states.get(name).state, null, 2) : '');
    setResult(null);
  }, [name, states]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const se = jsonError(stateText, false);
      if (se) throw new Error(`State definition: ${se}`);
      const ie = jsonError(input);
      if (ie) throw new Error(`Input: ${ie}`);
      setResult(await sfn('TestState', { definition: stateText, roleArn, input: input.trim() || '{}', inspectionLevel: level }));
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  if (!names.length) return <Empty>The definition has no states.</Empty>;
  const insp = result?.inspectionData;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Test a single state</h3>
        <span className="muted small">TestState runs one state with your input and the role's permissions, without creating an execution.</span>
      </div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className="grid-3">
        <Field label="State"><Select value={name} onChange={setName} options={names.map((n) => [n, `${n} (${states.get(n).state.Type})`])} aria-label="State" /></Field>
        <Field label="Role ARN" hint="Used to call the services of a Task state."><input value={roleArn} onChange={(e) => setRoleArn(e.target.value)} aria-label="Test role ARN" /></Field>
        <Field label="Inspection level"><Select value={level} onChange={setLevel} options={[['INFO', 'Info'], ['DEBUG', 'Debug (data flow)'], ['TRACE', 'Trace (HTTP Task request/response)']]} aria-label="Inspection level" /></Field>
      </div>
      <div className="grid-2">
        <Field label="State definition" hint={jsonError(stateText, false) ? <span className="text-bad">{jsonError(stateText, false)}</span> : 'Edit freely: the saved definition is not changed.'}>
          <JsonArea value={stateText} onChange={setStateText} rows={14} />
        </Field>
        <Field label="Input (JSON)" hint={jsonError(input) ? <span className="text-bad">{jsonError(input)}</span> : null}>
          <JsonArea value={input} onChange={setInput} rows={14} />
        </Field>
      </div>
      <button className="btn btn-primary" onClick={run} disabled={busy || !roleArn}>{busy ? <Spinner /> : '▶ Test state'}</button>
      {result && (
        <div className="card card-sub">
          <div className="card-sub-head">
            <strong>Result</strong>
            <span className={`badge badge-${result.status === 'SUCCEEDED' ? 'ok' : result.status === 'FAILED' ? 'bad' : 'warn'}`}>{result.status}</span>
            {result.nextState && <span className="muted small">Next state: <strong>{result.nextState}</strong></span>}
          </div>
          {(result.error || result.cause) && <ErrorBox error={`${result.error || 'Error'}${result.cause ? `: ${result.cause}` : ''}`} />}
          {result.output !== undefined && (
            <Field label="Output"><JsonArea value={prettyJson(result.output)} readOnly rows={8} /></Field>
          )}
          {insp && (
            <div className="sfn-inspection">
              {[
                ['input', 'Input'], ['afterInputPath', 'After InputPath'], ['afterParameters', 'After Parameters'], ['result', 'Result'],
                ['afterResultSelector', 'After ResultSelector'], ['afterResultPath', 'After ResultPath'], ['variables', 'Variables'],
              ].filter(([k]) => insp[k] !== undefined).map(([k, label]) => (
                <Field key={k} label={label}><pre className="code">{prettyJson(insp[k])}</pre></Field>
              ))}
              {insp.request && <Field label="HTTP request"><pre className="code">{JSON.stringify(insp.request, null, 2)}</pre></Field>}
              {insp.response && <Field label="HTTP response"><pre className="code">{JSON.stringify(insp.response, null, 2)}</pre></Field>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Versions & aliases -----------------------------------------------------------------------------------
export function VersionsTab({ machine, versions, aliases, reloadVersions }) {
  const toast = useToast();
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // alias being created / edited
  const [error, setError] = useState(null);

  const publish = async () => {
    setBusy(true);
    try {
      const out = await sfn('PublishStateMachineVersion', { stateMachineArn: machine.stateMachineArn, ...(desc ? { description: desc } : {}), ...(machine.revisionId ? { revisionId: machine.revisionId } : {}) });
      toast(`Published version ${arnName(out.stateMachineVersionArn)}`);
      setDesc('');
      await reloadVersions();
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };

  const delVersion = async (v) => {
    if (!window.confirm(`Delete version ${arnName(v.stateMachineVersionArn)}?\nVersions referenced by an alias cannot be deleted.`)) return;
    try {
      await sfn('DeleteStateMachineVersion', { stateMachineVersionArn: v.stateMachineVersionArn });
      toast('Version deleted');
      await reloadVersions();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const delAlias = async (a) => {
    if (!window.confirm(`Delete alias "${a.name}"?`)) return;
    try {
      await sfn('DeleteStateMachineAlias', { stateMachineAliasArn: a.stateMachineAliasArn });
      toast('Alias deleted');
      await reloadVersions();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const saveAlias = async (a) => {
    setError(null);
    try {
      const routingConfiguration = a.routes.filter((r) => r.version).map((r) => ({ stateMachineVersionArn: r.version, weight: Number(r.weight) }));
      if (!routingConfiguration.length) throw new Error('Pick at least one version');
      if (routingConfiguration.reduce((s, r) => s + r.weight, 0) !== 100) throw new Error('Weights must add up to 100');
      if (a.arn) await sfn('UpdateStateMachineAlias', { stateMachineAliasArn: a.arn, routingConfiguration, description: a.description });
      else await sfn('CreateStateMachineAlias', { name: a.name, routingConfiguration, ...(a.description ? { description: a.description } : {}) });
      toast(a.arn ? 'Alias updated' : 'Alias created');
      setEditing(null);
      await reloadVersions();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const versionOptions = [['', '— version —'], ...versions.map((v) => [v.stateMachineVersionArn, `Version ${arnName(v.stateMachineVersionArn)}${v.description ? ` – ${v.description}` : ''}`])];
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Versions <span className="muted small">({versions.length})</span></h3>
          <div className="row-gap">
            <input placeholder="Description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="New version description" />
            <button className="btn btn-sm btn-primary" onClick={publish} disabled={busy}>{busy ? <Spinner /> : 'Publish version'}</button>
          </div>
        </div>
        <div className="muted small">A version is an immutable snapshot of the current definition and configuration.</div>
        {versions.length > 0 ? (
          <table className="grid mt-s">
            <thead><tr><th>Version</th><th>Description</th><th>Created</th><th /></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.stateMachineVersionArn}>
                  <td><strong>{arnName(v.stateMachineVersionArn)}</strong></td>
                  <td className="muted">{v.description || '—'}</td>
                  <td>{fmtDate(v.creationDate)}</td>
                  <td className="row-actions">
                    <button className="btn btn-xs" onClick={() => copyText(v.stateMachineVersionArn).then(() => toast('ARN copied'))}>⧉ ARN</button>
                    <button className="btn btn-xs btn-danger" onClick={() => delVersion(v)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>No published versions.</Empty>}
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Aliases <span className="muted small">({aliases.length})</span></h3>
          <button className="btn btn-sm btn-primary" onClick={() => setEditing({ name: '', description: '', routes: [{ version: versions[0]?.stateMachineVersionArn || '', weight: 100 }] })} disabled={!versions.length}>＋ Create alias</button>
        </div>
        <div className="muted small">An alias points to one version, or splits executions between two versions by weight (canary).</div>
        {editing && <AliasForm value={editing} onChange={setEditing} versionOptions={versionOptions} onSave={saveAlias} onCancel={() => { setEditing(null); setError(null); }} error={error} machineArn={machine.stateMachineArn} />}
        {aliases.length > 0 ? (
          <table className="grid mt-s">
            <thead><tr><th>Alias</th><th>Routing</th><th>Description</th><th /></tr></thead>
            <tbody>
              {aliases.map((a) => (
                <tr key={a.stateMachineAliasArn}>
                  <td><strong>{a.name}</strong></td>
                  <td>{(a.routingConfiguration || []).map((r) => `v${arnName(r.stateMachineVersionArn)} ${r.weight}%`).join(' · ') || '—'}</td>
                  <td className="muted">{a.description || '—'}</td>
                  <td className="row-actions">
                    <button className="btn btn-xs" onClick={() => setEditing({ arn: a.stateMachineAliasArn, name: a.name, description: a.description || '', routes: (a.routingConfiguration || []).map((r) => ({ version: r.stateMachineVersionArn, weight: r.weight })) })}>Edit</button>
                    <button className="btn btn-xs" onClick={() => copyText(a.stateMachineAliasArn).then(() => toast('ARN copied'))}>⧉ ARN</button>
                    <button className="btn btn-xs btn-danger" onClick={() => delAlias(a)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : !editing && <Empty>No aliases.</Empty>}
      </div>
    </>
  );
}

function AliasForm({ value, onChange, versionOptions, onSave, onCancel, error }) {
  const set = (p) => onChange({ ...value, ...p });
  const setRoute = (i, p) => set({ routes: value.routes.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  return (
    <div className="card card-sub">
      <ErrorBox error={error} />
      <div className="grid-2">
        <Field label="Alias name"><input value={value.name} onChange={(e) => set({ name: e.target.value.trim() })} disabled={Boolean(value.arn)} aria-label="Alias name" /></Field>
        <Field label="Description"><input value={value.description} onChange={(e) => set({ description: e.target.value })} aria-label="Alias description" /></Field>
      </div>
      {value.routes.map((r, i) => (
        <div className="row-gap mt-s" key={i}>
          <Select value={r.version} onChange={(version) => setRoute(i, { version })} options={versionOptions} aria-label={`Route ${i + 1} version`} />
          <input type="number" min={0} max={100} value={r.weight} onChange={(e) => setRoute(i, { weight: e.target.value })} aria-label={`Route ${i + 1} weight`} style={{ width: 80 }} />
          <span className="muted">%</span>
          {value.routes.length > 1 && <button className="icon-btn" onClick={() => set({ routes: value.routes.filter((_, j) => j !== i) })} aria-label="Remove route">×</button>}
        </div>
      ))}
      <div className="row-gap mt-s">
        {value.routes.length < 2 && <button className="btn btn-xs" onClick={() => set({ routes: [...value.routes.map((r) => ({ ...r, weight: 90 })), { version: '', weight: 10 }] })}>+ Add a second version (canary)</button>}
        <span className="push-right" />
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-primary" onClick={() => onSave(value)} disabled={!value.name}>Save alias</button>
      </div>
    </div>
  );
}

// --- Configuration -----------------------------------------------------------------------------------------
export function ConfigTab({ machine, refresh }) {
  const toast = useToast();
  const [role, setRole] = useState({ mode: 'arn', arn: machine.roleArn || '' });
  const lc = machine.loggingConfiguration || {};
  const [logging, setLogging] = useState({ level: lc.level || 'OFF', includeExecutionData: Boolean(lc.includeExecutionData), logGroupArn: lc.destinations?.[0]?.cloudWatchLogsLogGroup?.logGroupArn || '' });
  const [tracing, setTracing] = useState(Boolean(machine.tracingConfiguration?.enabled));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!role.arn) throw new Error('Choose an execution role');
      if (logging.level !== 'OFF' && !logging.logGroupArn) throw new Error('Logging needs a CloudWatch Logs log group ARN');
      await sfn('UpdateStateMachine', { stateMachineArn: machine.stateMachineArn, roleArn: role.arn, loggingConfiguration: buildLogging(logging), tracingConfiguration: { enabled: tracing } });
      toast('Configuration saved');
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const group = logGroupName(machine.loggingConfiguration);
  return (
    <>
      <div className="card">
        <div className="card-head"><h3>Details</h3></div>
        <dl className="kv">
          <dt>ARN</dt><dd><code>{machine.stateMachineArn}</code></dd>
          <dt>Type</dt><dd>{machine.type}</dd>
          <dt>Status</dt><dd>{machine.status || '—'}</dd>
          <dt>Created</dt><dd>{fmtDate(machine.creationDate)}</dd>
          <dt>Revision</dt><dd>{machine.revisionId || '—'}</dd>
          {machine.description && <><dt>Description</dt><dd>{machine.description}</dd></>}
          {machine.encryptionConfiguration?.type && <><dt>Encryption</dt><dd>{machine.encryptionConfiguration.type}{machine.encryptionConfiguration.kmsKeyId ? ` (${machine.encryptionConfiguration.kmsKeyId})` : ''}</dd></>}
          <dt>Log group</dt><dd>{group ? <a href={`#${logsGroupPath(group, { range: '1h' })}`}>{group}</a> : '—'}</dd>
        </dl>
      </div>
      <div className="card">
        <div className="card-head"><h3>Permissions, logging & tracing</h3></div>
        <ErrorBox error={error} onClose={() => setError(null)} />
        <RolePicker value={role} onChange={setRole} name={machine.name} allowCreate={false} />
        <h4>Logging</h4>
        <LoggingFields value={logging} onChange={setLogging} />
        <label className="check"><input type="checkbox" checked={tracing} onChange={(e) => setTracing(e.target.checked)} /> Enable X-Ray tracing</label>
        <div className="mt-s"><button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save configuration'}</button></div>
      </div>
    </>
  );
}

// --- Tags ------------------------------------------------------------------------------------------------------
export function TagsTab({ machine }) {
  const toast = useToast();
  const arn = machine.stateMachineArn;
  const [orig, setOrig] = useState(null);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = Object.fromEntries(((await sfn('ListTagsForResource', { resourceArn: arn })).tags || []).map((x) => [x.key, x.value]));
      setOrig(t);
      setRows(Object.entries(t).map(([key, value]) => ({ key, value })));
    } catch (e) {
      setError(errorText(e));
      setOrig({});
    }
  }, [arn]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
      const { set, remove } = tagChanges(orig, next);
      if (remove.length) await sfn('UntagResource', { resourceArn: arn, tagKeys: remove });
      if (set.length) await sfn('TagResource', { resourceArn: arn, tags: set });
      toast('Tags saved');
      await load();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  if (!orig) return <Spinner />;
  return (
    <div className="card">
      <div className="card-head"><h3>Tags</h3></div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <KeyValueRows rows={rows} onChange={setRows} />
      <button className="btn btn-primary mt-s" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save tags'}</button>
    </div>
  );
}

