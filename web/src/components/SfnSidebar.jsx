import React, { useState } from 'react';
import { Spinner } from './ui.jsx';
import { sfnPath } from '../lib/sfn.js';

export default function SfnSidebar({ conn, machines, state, reload, current, page, onCreate }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const shown = machines.filter((m) => m.name.toLowerCase().includes(q));

  return (
    <>
      <nav className="nav">
        <a href="#/sfn" className={page === 'home' ? 'active' : ''}>⛓ State machines</a>
        <a href="#/sfn/activities" className={page === 'activities' ? 'active' : ''}>⚑ Activities</a>
        <a href="#/connections" className={page === 'connections' ? 'active' : ''}>⚙ Connections</a>
      </nav>
      <div className="side-head">
        <span>State machines {conn && <span className="muted">({machines.length}{state.more ? '+' : ''})</span>}</span>
        <span>
          <button className="icon-btn" title="Refresh" onClick={reload} disabled={!conn}>↻</button>
          <button className="icon-btn" title="Create state machine" onClick={onCreate} disabled={!conn}>＋</button>
        </span>
      </div>
      {conn && <input className="side-filter" placeholder="Filter state machines…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter state machines" />}
      <div className="table-list bucket-list">
        {!conn && <div className="muted small pad">Select a connection to list state machines.</div>}
        {state.loading && <div className="pad"><Spinner /></div>}
        {state.error && <div className="side-error">{state.error}</div>}
        {shown.map((m) => (
          <a key={m.name} href={`#${sfnPath(m.name)}`} className={current === m.name ? 'active' : ''} title={`${m.name} · ${m.type}`}>
            {m.name}
            {m.type === 'EXPRESS' && <span className="badge">Express</span>}
          </a>
        ))}
        {conn && state.loaded && !state.loading && !state.error && !shown.length && <div className="muted small pad">{q ? 'No matching state machines.' : 'No state machines.'}</div>}
      </div>
    </>
  );
}
