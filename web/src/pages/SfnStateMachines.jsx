import React, { useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Spinner, ErrorBox, Empty, useToast, copyText } from '../components/ui.jsx';
import { StartExecutionModal } from '../components/SfnModals.jsx';
import { sfn, sfnPath, fmtDate } from '../lib/sfn.js';

export default function SfnHome({ onCreate }) {
  const { conn } = useApp();
  if (!conn) return <SfnWelcome />;
  return <MachineList onCreate={onCreate} />;
}

function SfnWelcome() {
  return (
    <div className="page">
      <div className="hero">
        <h1>⛓ AWS Step Functions</h1>
        <p className="muted">Design workflows with a live graph, start and follow executions state by state, test single states, and manage versions and aliases.</p>
      </div>
      <div className="card">
        <h3>Get started</h3>
        <ol className="steps">
          <li>Open <a href="#/connections">Connections</a> to add an AWS profile, or a custom endpoint (LocalStack, Step Functions Local).</li>
          <li>Pick the connection and region in the top bar.</li>
          <li>Choose a state machine on the left to see its executions and definition.</li>
        </ol>
      </div>
    </div>
  );
}

/** Deletes a state machine after the user types its name. Returns true when deleted. */
export async function confirmDeleteMachine(m, toast) {
  const typed = window.prompt(`Type the state machine name "${m.name}" to delete it.\nRunning executions continue until they finish; versions and aliases are deleted too.`);
  if (typed !== m.name) return false;
  try {
    await sfn('DeleteStateMachine', { stateMachineArn: m.stateMachineArn });
    toast(`Deleting ${m.name}`);
    return true;
  } catch (e) {
    toast(errorText(e), 'error');
    return false;
  }
}

function MachineList({ onCreate }) {
  const { machines, machinesState, reloadMachines, info } = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [type, setType] = useState('');
  const [sort, setSort] = useState({ by: 'name', dir: 1 });
  const [starting, setStarting] = useState(null);
  const q = filter.trim().toLowerCase();

  const val = (m) => (sort.by === 'created' ? new Date(m.creationDate || 0).getTime() : sort.by === 'type' ? m.type : m.name.toLowerCase());
  const shown = machines
    .filter((m) => m.name.toLowerCase().includes(q) && (!type || m.type === type))
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
        <h2>⛓ State machines <span className="muted count">({q || type ? `${shown.length} of ` : ''}{machines.length}{machinesState.more ? '+' : ''})</span></h2>
        <span className="muted ellipsis">{info.label} · {info.region}{info.endpoint ? ` · ${info.endpoint}` : ''}</span>
        <div className="push-right row-gap">
          <input placeholder="Filter state machines…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" autoFocus />
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type filter">
            <option value="">All types</option>
            <option value="STANDARD">Standard</option>
            <option value="EXPRESS">Express</option>
          </select>
          <button className="btn" onClick={reloadMachines}>↻ Refresh</button>
          <button className="btn btn-primary" onClick={onCreate}>＋ Create state machine</button>
        </div>
      </div>
      <ErrorBox error={machinesState.error} />
      {machinesState.loading && <Spinner />}
      {!machinesState.loading && !machinesState.error && !machines.length && <Empty>No state machines in this region. <button className="btn btn-sm" onClick={onCreate}>Create state machine</button></Empty>}
      {shown.length > 0 && (
        <div className="grid-wrap bucket-wrap">
          <table className="grid lg-table sfn-table">
            <thead>
              <tr>
                {th('name', 'Name', 'col-name')}
                {th('type', 'Type', 'col-type')}
                {th('created', 'Created', 'col-created')}
                <th className="col-act" />
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.stateMachineArn}>
                  <td className="col-name" title={m.stateMachineArn}><a href={`#${sfnPath(m.name)}`}>{m.name}</a></td>
                  <td className="col-type">{m.type === 'EXPRESS' ? <span className="badge">Express</span> : <span className="muted">Standard</span>}</td>
                  <td className="col-created">{fmtDate(m.creationDate)}</td>
                  <td className="row-actions col-act">
                    <button className="btn btn-xs" onClick={() => setStarting(m)}>▶ Start execution</button>
                    <button className="btn btn-xs" title="Copy ARN" onClick={() => copyText(m.stateMachineArn).then(() => toast('ARN copied'))}>⧉</button>
                    <button className="btn btn-xs btn-danger" onClick={async () => (await confirmDeleteMachine(m, toast)) && reloadMachines()}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {starting && <StartExecutionModal machine={starting} targets={[[starting.stateMachineArn, starting.name]]} onClose={() => setStarting(null)} />}
    </div>
  );
}
