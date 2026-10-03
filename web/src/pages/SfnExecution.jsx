import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Tabs, Spinner, ErrorBox, Empty, JsonArea, useToast, copyText, download } from '../components/ui.jsx';
import { Stat } from './LambdaFunction.jsx';
import SfnGraph from '../components/SfnGraph.jsx';
import { StartExecutionModal } from '../components/SfnModals.jsx';
import { StatusBadge } from '../components/SfnTabs.jsx';
import {
  sfn, getHistory, analyzeHistory, eventDetails, sfnPath, machineNameFromArn, execNameFromArn, arnName,
  fmtDate, fmtElapsed, duration, prettyJson, statusLabel,
} from '../lib/sfn.js';

const TABS = [
  ['steps', 'Steps'],
  ['events', 'Event history'],
  ['io', 'Input & output'],
  ['maps', 'Map runs'],
];

const STEP_KIND = { succeeded: 'ok', failed: 'bad', caught: 'warn', running: 'warn', cancelled: 'bad' };

export default function SfnExecution({ arn }) {
  const { machines } = useApp();
  const toast = useToast();
  const [exec, setExec] = useState(null);
  const [definition, setDefinition] = useState(null);
  const [history, setHistory] = useState({ events: [], more: false });
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('steps');
  const [selected, setSelected] = useState('');
  const [rerun, setRerun] = useState(false);
  const [mapRuns, setMapRuns] = useState(null);
  const timer = useRef(null);
  const alive = useRef(true);
  const machineName = machineNameFromArn(arn);
  const machine = machines.find((m) => m.name === machineName);

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const [e, h] = await Promise.all([sfn('DescribeExecution', { executionArn: arn }), getHistory(arn)]);
      if (!alive.current) return;
      setExec(e);
      setHistory(h);
      setError(null);
      if (e.status === 'RUNNING') timer.current = setTimeout(load, 3000);
    } catch (e) {
      setError(errorText(e));
    }
  }, [arn]);

  useEffect(() => {
    alive.current = true;
    load();
    // The definition the execution actually ran (it may differ from the current one).
    sfn('DescribeStateMachineForExecution', { executionArn: arn })
      .then((d) => setDefinition(d.definition))
      .catch(() => {});
    sfn('ListMapRuns', { executionArn: arn, maxResults: 100 })
      .then((m) => setMapRuns(m.mapRuns || []))
      .catch(() => setMapRuns([]));
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, [arn, load]);

  const analysis = useMemo(() => analyzeHistory(history.events), [history.events]);

  if (error && !exec) return <div className="page"><h2 className="lv-title">{execNameFromArn(arn)}</h2><ErrorBox error={error} /></div>;
  if (!exec) return <div className="page"><Spinner /></div>;

  const running = exec.status === 'RUNNING';
  const stop = async () => {
    const cause = window.prompt(`Stop execution "${exec.name}"?\nOptional cause:`, '');
    if (cause === null) return;
    try {
      await sfn('StopExecution', { executionArn: arn, ...(cause ? { cause } : {}) });
      toast('Execution stopped');
      load();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const redrive = async () => {
    if (!window.confirm('Redrive this execution from the state that failed? Successful states are not run again.')) return;
    try {
      await sfn('RedriveExecution', { executionArn: arn });
      toast('Execution redriven');
      load();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const steps = analysis.steps;
  const selSteps = selected ? steps.filter((s) => s.name === selected) : [];
  const failedStep = [...steps].reverse().find((s) => s.status === 'failed');
  const tabs = TABS.filter(([id]) => id !== 'maps' || mapRuns?.length);
  const startMachine = machine || { name: machineName, type: 'STANDARD', stateMachineArn: exec.stateMachineArn };

  return (
    <div className="page sqs-page">
      <div className="crumbs small muted">
        <a href={`#${sfnPath(machineName)}`}>⛓ {machineName}</a> › Executions
      </div>
      <div className="page-head">
        <h2 className="lv-title" title={arn}>{exec.name}</h2>
        <StatusBadge status={exec.status} />
        {running && <Spinner />}
        <div className="push-right row-gap wrap">
          {running && <button className="btn btn-sm btn-danger" onClick={stop}>■ Stop</button>}
          {exec.redriveStatus === 'REDRIVABLE' && <button className="btn btn-sm" onClick={redrive}>↻ Redrive</button>}
          <button className="btn btn-sm" onClick={() => setRerun(true)}>▶ New execution (same input)</button>
          <button className="btn btn-sm" title="Copy ARN" onClick={() => copyText(arn).then(() => toast('ARN copied'))}>⧉ ARN</button>
          <button className="btn btn-sm" onClick={() => download(`${exec.name}-history.json`, JSON.stringify({ execution: exec, events: history.events }, null, 2))}>⤓ Export</button>
          <button className="btn btn-sm" onClick={load}>↻ Refresh</button>
        </div>
      </div>
      <div className="sqs-stats">
        <Stat label="Status" value={statusLabel(exec.status)} strong />
        <Stat label="Started" value={fmtDate(exec.startDate)} />
        <Stat label="Ended" value={fmtDate(exec.stopDate)} />
        <Stat label="Duration" value={fmtElapsed(duration(exec.startDate, exec.stopDate))} />
        <Stat label="State transitions" value={steps.length} hint="States entered" />
        <Stat label="Events" value={`${history.events.length}${history.more ? '+' : ''}`} />
        {exec.redriveCount > 0 && <Stat label="Redrives" value={exec.redriveCount} hint={fmtDate(exec.redriveDate)} />}
        {(exec.stateMachineAliasArn || exec.stateMachineVersionArn) && (
          <Stat label="Ran" value={exec.stateMachineAliasArn ? `Alias ${arnName(exec.stateMachineAliasArn)}` : `Version ${arnName(exec.stateMachineVersionArn)}`} />
        )}
      </div>
      {(exec.error || exec.cause) && (
        <div className="alert alert-error">
          <pre>
            <strong>{exec.error || 'Error'}</strong>
            {failedStep ? ` in state "${failedStep.name}"` : ''}
            {exec.cause ? `\n${prettyJson(exec.cause)}` : ''}
          </pre>
          {failedStep && <button className="btn btn-xs" onClick={() => setSelected(failedStep.name)}>Show state</button>}
        </div>
      )}

      <div className="sfn-exec-split">
        <div className="card sfn-exec-graph">
          {definition ? <SfnGraph definition={definition} status={analysis.status} selected={selected} onSelect={setSelected} /> : <Spinner />}
        </div>
        <div className="card sfn-exec-detail">
          {!selected && <div className="muted small">Select a state in the graph or the steps table to see its input, output and events.</div>}
          {selected && (
            <>
              <div className="card-head">
                <h4 className="ellipsis">{selected}</h4>
                <button className="icon-btn" onClick={() => setSelected('')} aria-label="Close state">×</button>
              </div>
              {!selSteps.length && <div className="muted small">This state did not run.</div>}
              {selSteps.slice(-5).map((s, i) => (
                <StepDetail key={s.enteredId} step={s} index={selSteps.length > 1 ? selSteps.length - Math.min(5, selSteps.length) + i + 1 : 0} />
              ))}
              {selSteps.length > 5 && <div className="muted small">Showing the last 5 of {selSteps.length} runs.</div>}
            </>
          )}
        </div>
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'steps' && <StepsTable steps={steps} selected={selected} onSelect={setSelected} />}
      {tab === 'events' && <EventsTable events={history.events} more={history.more} />}
      {tab === 'io' && (
        <div className="grid-2">
          <div className="card"><h4>Input</h4><JsonArea value={prettyJson(exec.input)} readOnly rows={16} /></div>
          <div className="card"><h4>Output</h4>{exec.output !== undefined ? <JsonArea value={prettyJson(exec.output)} readOnly rows={16} /> : <div className="muted small">{running ? 'Still running.' : 'No output.'}</div>}</div>
        </div>
      )}
      {tab === 'maps' && <MapRuns runs={mapRuns || []} />}
      {rerun && <StartExecutionModal machine={startMachine} targets={[[exec.stateMachineAliasArn || exec.stateMachineVersionArn || exec.stateMachineArn, 'Same target']]} initialInput={exec.input} onClose={() => setRerun(false)} />}
    </div>
  );
}

function StepDetail({ step, index }) {
  return (
    <div className="card card-sub">
      <div className="card-sub-head">
        <span>{index ? `Run ${index} · ` : ''}<span className={`badge badge-${STEP_KIND[step.status]}`}>{step.status}</span></span>
        <span className="muted small">{fmtElapsed(duration(step.entered, step.exited))}</span>
      </div>
      {(step.error || step.cause) && <ErrorBox error={`${step.error || 'Error'}${step.cause ? `: ${prettyJson(step.cause)}` : ''}`} />}
      <div className="field-label">Input</div>
      <pre className="code sfn-io">{prettyJson(step.input) || '—'}</pre>
      <div className="field-label">Output</div>
      <pre className="code sfn-io">{step.output !== undefined ? prettyJson(step.output) : '—'}</pre>
      <details>
        <summary className="small muted">{step.events.length} events</summary>
        <ul className="sfn-step-events small">
          {step.events.map((e) => <li key={e.id}><code>{e.id}</code> {e.type} <span className="muted">{fmtDate(e.timestamp)}</span></li>)}
        </ul>
      </details>
    </div>
  );
}

function StepsTable({ steps, selected, onSelect }) {
  const [filter, setFilter] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);
  const q = filter.trim().toLowerCase();
  const shown = steps.filter((s) => s.name.toLowerCase().includes(q) && (!onlyFailed || s.status === 'failed' || s.status === 'caught'));
  if (!steps.length) return <Empty>No state has run yet.</Empty>;
  return (
    <div className="card">
      <div className="row-gap mb-s">
        <input placeholder="Filter states…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter steps" />
        <label className="check small"><input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} /> Failed / caught only</label>
      </div>
      <table className="grid sfn-steps">
        <thead><tr><th>#</th><th>State</th><th>Type</th><th>Status</th><th>Started</th><th className="col-num">Duration</th></tr></thead>
        <tbody>
          {shown.map((s) => (
            <tr key={s.enteredId} className={selected === s.name ? 'selected' : ''} onClick={() => onSelect(s.name)}>
              <td className="muted">{steps.indexOf(s) + 1}</td>
              <td><button className="link-btn">{s.name}</button></td>
              <td className="muted">{s.type}</td>
              <td><span className={`badge badge-${STEP_KIND[s.status]}`}>{s.status}</span>{s.error && <span className="text-bad small"> {s.error}</span>}</td>
              <td>{fmtDate(s.entered)}</td>
              <td className="col-num">{fmtElapsed(duration(s.entered, s.exited))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventsTable({ events, more }) {
  const [open, setOpen] = useState({});
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const start = events[0] ? new Date(events[0].timestamp).getTime() : 0;
  const shown = events.filter((e) => !q || e.type.toLowerCase().includes(q) || JSON.stringify(eventDetails(e) || {}).toLowerCase().includes(q));
  return (
    <div className="card">
      <div className="row-gap mb-s">
        <input placeholder="Filter events (type or content)…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter events" />
        <span className="muted small">{shown.length} of {events.length}{more ? '+ (history truncated)' : ''}</span>
      </div>
      <table className="grid sfn-events">
        <thead><tr><th>ID</th><th>Type</th><th>Step</th><th>Timestamp</th><th className="col-num">Elapsed</th></tr></thead>
        <tbody>
          {shown.map((e) => {
            const d = eventDetails(e);
            const bad = /(Failed|TimedOut|Aborted)$/.test(e.type);
            return (
              <React.Fragment key={e.id}>
                <tr onClick={() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))} className={bad ? 'text-bad' : ''}>
                  <td>{d ? (open[e.id] ? '▾' : '▸') : ''} {e.id}</td>
                  <td>{e.type}</td>
                  <td>{d?.name || d?.resource || ''}</td>
                  <td>{fmtDate(e.timestamp)}</td>
                  <td className="col-num">{fmtElapsed(new Date(e.timestamp).getTime() - start)}</td>
                </tr>
                {open[e.id] && d && (
                  <tr className="sub-row"><td colSpan={5}><pre className="code">{JSON.stringify(expandJson(d), null, 2)}</pre></td></tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** input / output / cause fields are JSON strings: show them as objects. */
function expandJson(d) {
  const out = { ...d };
  for (const k of ['input', 'output', 'cause', 'parameters']) {
    if (typeof out[k] === 'string') {
      try {
        out[k] = JSON.parse(out[k]);
      } catch {
        /* keep as text */
      }
    }
  }
  return out;
}

function MapRuns({ runs }) {
  const [details, setDetails] = useState({});
  useEffect(() => {
    runs.forEach((r) =>
      sfn('DescribeMapRun', { mapRunArn: r.mapRunArn })
        .then((d) => setDetails((m) => ({ ...m, [r.mapRunArn]: d })))
        .catch(() => {}),
    );
  }, [runs]);
  return (
    <div className="card">
      <table className="grid">
        <thead><tr><th>Map run</th><th>Status</th><th>Started</th><th>Items (succeeded / failed / total)</th><th>Max concurrency</th></tr></thead>
        <tbody>
          {runs.map((r) => {
            const d = details[r.mapRunArn];
            const c = d?.itemCounts;
            return (
              <tr key={r.mapRunArn}>
                <td className="ellipsis" title={r.mapRunArn}>{arnName(r.mapRunArn)}</td>
                <td>{d ? <StatusBadge status={d.status} /> : <Spinner />}</td>
                <td>{fmtDate(r.startDate)}</td>
                <td>{c ? `${c.succeeded} / ${c.failed} / ${c.total}` : '—'}</td>
                <td>{d?.maxConcurrency ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
