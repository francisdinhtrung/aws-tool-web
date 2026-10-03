import React, { useCallback, useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { Spinner, ErrorBox, Field, Select, JsonArea, CodeBlock, useToast, useLocalStorage, Tabs } from './ui.jsx';
import { invokeFunction, parseReport, prettyJson, isJson, EVENT_TEMPLATES, TEMPLATE_LABELS, fmtMs, logGroupOf } from '../lib/lambda.js';
import { logsGroupPath } from '../lib/logs.js';

const INVOCATION_TYPES = [
  ['RequestResponse', 'Synchronous (RequestResponse)'],
  ['Event', 'Asynchronous (Event)'],
  ['DryRun', 'Dry run (check permissions)'],
];

const tpl = (id) => JSON.stringify(EVENT_TEMPLATES[id], null, 2);

/** Colors log tail lines by kind (START/END/REPORT, errors). */
function LogTail({ text }) {
  const lines = String(text || '').split('\n');
  return (
    <pre className="code fn-logs">
      {lines.map((l, i) => (
        <div key={i} className={/^(START|END|REPORT|INIT_START) /.test(l) ? 'muted' : /\b(ERROR|Error|Exception|Traceback|Task timed out)\b/.test(l) ? 'text-bad' : /\bWARN/.test(l) ? 'text-warn' : ''}>{l || ' '}</div>
      ))}
    </pre>
  );
}

export function InvocationResult({ r, cfg }) {
  const [tab, setTab] = useState('response');
  const rep = parseReport(r.LogResult);
  const failed = Boolean(r.FunctionError) || r.StatusCode >= 300;
  const group = logGroupOf(cfg);
  return (
    <div className={`card fn-result ${failed ? 'fn-result-bad' : 'fn-result-ok'}`} aria-label="Invocation result">
      <div className="card-head">
        <h3>
          {r.InvocationType === 'Event' ? '⏱ Queued' : r.InvocationType === 'DryRun' ? '✓ Dry run passed' : failed ? `✗ Failed${r.FunctionError ? ` (${r.FunctionError})` : ''}` : '✓ Succeeded'}
          <span className="muted small"> · HTTP {r.StatusCode}{r.ExecutedVersion ? ` · version ${r.ExecutedVersion}` : ''} · {new Date(r.at).toLocaleTimeString()}</span>
        </h3>
        {r.RequestId && <a className="btn btn-xs" href={`#${logsGroupPath(group, { q: `"${r.RequestId}"`, range: '1h' })}`}>Open in CloudWatch Logs</a>}
      </div>
      {rep && (
        <div className="sqs-stats">
          <div className="sqs-stat"><div className="sqs-stat-label">Duration</div><div className="sqs-stat-value strong">{fmtMs(rep.duration)}</div></div>
          <div className="sqs-stat"><div className="sqs-stat-label">Billed</div><div className="sqs-stat-value">{fmtMs(rep.billed)}</div></div>
          <div className="sqs-stat"><div className="sqs-stat-label">Memory used</div><div className="sqs-stat-value">{rep.maxMemory ?? '—'} / {rep.memorySize ?? '—'} MB</div></div>
          <div className="sqs-stat" title="Present on cold starts only"><div className="sqs-stat-label">Init (cold start)</div><div className="sqs-stat-value">{rep.initDuration ? fmtMs(rep.initDuration) : '—'}</div></div>
          <div className="sqs-stat"><div className="sqs-stat-label">Round trip</div><div className="sqs-stat-value">{fmtMs(r.elapsed)}</div></div>
        </div>
      )}
      {r.RequestId && <div className="muted small">Request ID <code>{r.RequestId}</code></div>}
      {r.InvocationType === 'RequestResponse' && (
        <>
          <Tabs small tabs={[['response', 'Response'], ['logs', 'Log output (last 4 KB)']]} value={tab} onChange={setTab} />
          {tab === 'response' && <CodeBlock code={prettyJson(r.Payload) || '(empty)'} maxHeight="50vh" />}
          {tab === 'logs' && <LogTail text={r.LogResult} />}
        </>
      )}
    </div>
  );
}

export default function TestTab({ name, cfg, qualifier }) {
  const toast = useToast();
  const [saved, setSaved] = useLocalStorage(`ddbs.lambda.events.${name}`, {});
  const [eventName, setEventName] = useState(() => Object.keys(saved)[0] || 'test');
  const [payload, setPayload] = useState(() => saved[Object.keys(saved)[0]] ?? tpl('hello-world'));
  const [type, setType] = useState('RequestResponse');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [shown, setShown] = useState(0);
  const names = Object.keys(saved).sort();

  const run = useCallback(async () => {
    if (busy) return;
    setError(null);
    if (payload.trim() && !isJson(payload)) return setError('The event is not valid JSON');
    setBusy(true);
    const started = Date.now();
    try {
      const out = await invokeFunction({ FunctionName: name, Payload: payload.trim() || '{}', InvocationType: type, ...(qualifier ? { Qualifier: qualifier } : {}) });
      const r = { ...out, InvocationType: type, at: Date.now(), elapsed: Date.now() - started, event: eventName };
      setHistory((h) => [r, ...h].slice(0, 20));
      setShown(0);
      if (type === 'Event') toast('Invocation queued');
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  }, [busy, payload, name, type, qualifier, eventName, toast]);

  useEffect(() => {
    const f = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [run]);

  const save = () => {
    const n = eventName.trim();
    if (!n) return toast('Name the event first', 'error');
    if (!isJson(payload)) return toast('The event is not valid JSON', 'error');
    setSaved({ ...saved, [n]: payload });
    toast(`Saved event "${n}"`);
  };
  const remove = () => {
    if (!(eventName in saved) || !window.confirm(`Delete saved event "${eventName}"?`)) return;
    const { [eventName]: _, ...rest } = saved; // eslint-disable-line no-unused-vars
    setSaved(rest);
  };
  const format = () => (isJson(payload) ? setPayload(prettyJson(payload)) : toast('The event is not valid JSON', 'error'));
  const result = history[shown];

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Test event</h3>
          <span className="muted small">Saved in this browser · Ctrl/⌘ + Enter to invoke</span>
        </div>
        <ErrorBox error={error} onClose={() => setError(null)} />
        <div className="grid-3">
          <Field label="Saved events">
            <Select
              value={eventName in saved ? eventName : ''}
              onChange={(n) => {
                if (!n) return;
                setEventName(n);
                setPayload(saved[n]);
              }}
              options={[['', names.length ? '— choose —' : '— none saved —'], ...names]}
              aria-label="Saved events"
            />
          </Field>
          <Field label="Template">
            <Select value="" onChange={(id) => id && setPayload(tpl(id))} options={[['', '— insert a template —'], ...Object.entries(TEMPLATE_LABELS)]} aria-label="Template" />
          </Field>
          <Field label="Event name"><input value={eventName} onChange={(e) => setEventName(e.target.value)} aria-label="Event name" /></Field>
        </div>
        <Field label="Event JSON">
          <JsonArea value={payload} onChange={setPayload} rows={14} />
        </Field>
        <div className="row-gap wrap">
          <Select value={type} onChange={setType} options={INVOCATION_TYPES} aria-label="Invocation type" />
          <button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? <Spinner /> : `▶ Invoke${qualifier ? ` ${qualifier}` : ''}`}</button>
          <button className="btn" onClick={save}>Save event</button>
          {eventName in saved && <button className="btn" onClick={remove}>Delete event</button>}
          <button className="btn" onClick={format}>Format JSON</button>
        </div>
      </div>
      {result && <InvocationResult r={result} cfg={cfg} />}
      {history.length > 1 && (
        <div className="card">
          <div className="card-head"><h3>This session</h3></div>
          <table className="grid grid-plain">
            <thead><tr><th>Time</th><th>Event</th><th>Type</th><th>Result</th><th>Duration</th><th /></tr></thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={h.at} className={i === shown ? 'selected' : ''}>
                  <td className="small">{new Date(h.at).toLocaleTimeString()}</td>
                  <td className="small">{h.event}</td>
                  <td className="small">{h.InvocationType}</td>
                  <td>{h.FunctionError ? <span className="badge badge-bad">{h.FunctionError}</span> : <span className="badge badge-ok">{h.StatusCode}</span>}</td>
                  <td className="small">{fmtMs(parseReport(h.LogResult)?.duration)}</td>
                  <td><button className="btn btn-xs" onClick={() => setShown(i)}>Show</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
