import React, { useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Spinner, ErrorBox, Empty, useToast, copyText } from '../components/ui.jsx';
import { lambda, lambdaPath, fmtBytes, fmtMemory, fmtTimeout, parseLastModified, fmtDate, stateOf } from '../lib/lambda.js';

export default function LambdaHome({ onCreate }) {
  const { conn } = useApp();
  if (!conn) return <LambdaWelcome />;
  return <FunctionList onCreate={onCreate} />;
}

function LambdaWelcome() {
  return (
    <div className="page">
      <div className="hero">
        <h1>λ AWS Lambda</h1>
        <p className="muted">Create, edit, test, configure and monitor Lambda functions without the AWS console.</p>
      </div>
      <div className="card">
        <h3>Get started</h3>
        <ol className="steps">
          <li>Open <a href="#/connections">Connections</a> to add an AWS profile, or a custom endpoint (LocalStack).</li>
          <li>Pick the connection and region in the top bar.</li>
          <li>Choose a function on the left to edit its code, run test events and change its configuration.</li>
        </ol>
      </div>
    </div>
  );
}

/** Deletes a function after the user types its name. Returns true when deleted. */
export async function confirmDeleteFunction(name, toast) {
  const typed = window.prompt(`Type the function name "${name}" to permanently delete it, with all its versions, aliases and triggers.`);
  if (typed !== name) return false;
  try {
    await lambda('DeleteFunction', { FunctionName: name });
    toast(`Deleted ${name}`);
    return true;
  } catch (e) {
    toast(errorText(e), 'error');
    return false;
  }
}

export function StateBadge({ cfg }) {
  const s = stateOf(cfg);
  if (s.kind === 'ok') return null;
  return <span className={`badge badge-${s.kind}`} title={s.reason}>{s.label}</span>;
}

function AccountSummary() {
  const [a, setA] = useState(null);
  useEffect(() => {
    lambda('GetAccountSettings').then(setA).catch(() => setA(false));
  }, []);
  if (!a) return null;
  const used = a.AccountUsage?.TotalCodeSize;
  const limit = a.AccountLimit?.TotalCodeSize;
  return (
    <div className="sqs-stats">
      <div className="sqs-stat"><div className="sqs-stat-label">Functions</div><div className="sqs-stat-value strong">{a.AccountUsage?.FunctionCount ?? '—'}</div></div>
      <div className="sqs-stat" title="Account concurrency limit"><div className="sqs-stat-label">Concurrency limit</div><div className="sqs-stat-value">{a.AccountLimit?.ConcurrentExecutions ?? '—'}</div></div>
      <div className="sqs-stat" title="Concurrency not reserved by any function"><div className="sqs-stat-label">Unreserved</div><div className="sqs-stat-value">{a.AccountLimit?.UnreservedConcurrentExecutions ?? '—'}</div></div>
      <div className="sqs-stat" title="Code storage used / limit"><div className="sqs-stat-label">Code storage</div><div className="sqs-stat-value">{fmtBytes(used)}{limit ? ` / ${fmtBytes(limit)}` : ''}</div></div>
    </div>
  );
}

function FunctionList({ onCreate }) {
  const { functions, functionsState, reloadFunctions, info } = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [runtime, setRuntime] = useState('');
  const [sort, setSort] = useState({ by: 'name', dir: 1 });
  const q = filter.trim().toLowerCase();
  const runtimes = [...new Set(functions.map((f) => f.Runtime || (f.PackageType === 'Image' ? 'Image' : '')).filter(Boolean))].sort();

  const val = (f) =>
    ({
      name: f.FunctionName.toLowerCase(),
      runtime: f.Runtime || '',
      memory: f.MemorySize || 0,
      timeout: f.Timeout || 0,
      size: f.CodeSize || 0,
      modified: parseLastModified(f.LastModified)?.getTime() || 0,
    })[sort.by];
  const shown = functions
    .filter((f) => (!q || f.FunctionName.toLowerCase().includes(q) || (f.Description || '').toLowerCase().includes(q)) && (!runtime || (f.Runtime || 'Image') === runtime))
    .sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  const th = (by, label, cls) => (
    <th className={cls} onClick={() => setSort((s) => ({ by, dir: s.by === by ? -s.dir : 1 }))} aria-sort={sort.by === by ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      {label} {sort.by === by && (sort.dir > 0 ? '▲' : '▼')}
    </th>
  );

  return (
    <div className="page">
      <div className="page-head">
        <h2>λ Functions <span className="muted count">({q || runtime ? `${shown.length} of ` : ''}{functions.length}{functionsState.more ? '+' : ''})</span></h2>
        <span className="muted ellipsis">{info.label} · {info.region}{info.endpoint ? ` · ${info.endpoint}` : ''}</span>
        <div className="push-right row-gap">
          <input placeholder="Filter by name or description…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" autoFocus />
          {runtimes.length > 1 && (
            <select value={runtime} onChange={(e) => setRuntime(e.target.value)} aria-label="Runtime filter">
              <option value="">All runtimes</option>
              {runtimes.map((r) => <option key={r}>{r}</option>)}
            </select>
          )}
          <button className="btn" onClick={reloadFunctions}>↻ Refresh</button>
          <button className="btn btn-primary" onClick={onCreate}>＋ Create function</button>
        </div>
      </div>
      <AccountSummary />
      <ErrorBox error={functionsState.error} />
      {functionsState.loading && <Spinner />}
      {!functionsState.loading && !functionsState.error && !functions.length && <Empty>No functions in this region. <button className="btn btn-sm" onClick={onCreate}>Create function</button></Empty>}
      {shown.length > 0 && (
        <div className="grid-wrap bucket-wrap">
          <table className="grid lg-table fn-table">
            <thead>
              <tr>
                {th('name', 'Function name', 'col-name')}
                {th('runtime', 'Runtime', 'col-rt')}
                {th('memory', 'Memory', 'col-num')}
                {th('timeout', 'Timeout', 'col-num')}
                {th('size', 'Code size', 'col-num')}
                <th className="col-arch">Arch</th>
                {th('modified', 'Last modified', 'col-created')}
                <th className="col-act" />
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => (
                <tr key={f.FunctionArn || f.FunctionName}>
                  <td className="col-name" title={f.FunctionArn}>
                    <a href={`#${lambdaPath(f.FunctionName)}`}>{f.FunctionName}</a> <StateBadge cfg={f} />
                    {f.Description && <div className="muted small ellipsis" title={f.Description}>{f.Description}</div>}
                  </td>
                  <td className="col-rt">{f.PackageType === 'Image' ? <span className="badge">Image</span> : f.Runtime || '—'}</td>
                  <td className="col-num">{fmtMemory(f.MemorySize)}</td>
                  <td className="col-num">{fmtTimeout(f.Timeout)}</td>
                  <td className="col-num">{f.PackageType === 'Image' ? '—' : fmtBytes(f.CodeSize)}</td>
                  <td className="col-arch small">{(f.Architectures || ['x86_64']).join(', ')}</td>
                  <td className="col-created small">{fmtDate(parseLastModified(f.LastModified))}</td>
                  <td className="row-actions col-act">
                    <a className="btn btn-xs" href={`#${lambdaPath(f.FunctionName)}`}>Open</a>
                    <button className="btn btn-xs" title="Copy ARN" onClick={() => copyText(f.FunctionArn).then(() => toast('ARN copied'))}>⧉</button>
                    <button className="btn btn-xs btn-danger" onClick={async () => (await confirmDeleteFunction(f.FunctionName, toast)) && reloadFunctions()}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
