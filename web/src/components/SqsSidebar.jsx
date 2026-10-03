import React, { useState } from 'react';
import { Spinner } from './ui.jsx';
import { queueNameFromUrl, sqsPath, isFifo } from '../lib/sqs.js';

export default function SqsSidebar({ conn, queues, state, reload, current, page, onCreate }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const names = queues.map(queueNameFromUrl).filter((n) => n.toLowerCase().includes(q));

  return (
    <>
      <nav className="nav">
        <a href="#/sqs" className={page === 'home' ? 'active' : ''}>📨 Queues</a>
        <a href="#/connections" className={page === 'connections' ? 'active' : ''}>⚙ Connections</a>
      </nav>
      <div className="side-head">
        <span>Queues {conn && <span className="muted">({queues.length}{state.more ? '+' : ''})</span>}</span>
        <span>
          <button className="icon-btn" title="Refresh" onClick={reload} disabled={!conn}>↻</button>
          <button className="icon-btn" title="Create queue" onClick={onCreate} disabled={!conn}>＋</button>
        </span>
      </div>
      {conn && <input className="side-filter" placeholder="Filter queues…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter queues" />}
      <div className="table-list bucket-list">
        {!conn && <div className="muted small pad">Select a connection to list queues.</div>}
        {state.loading && <div className="pad"><Spinner /></div>}
        {state.error && <div className="side-error">{state.error}</div>}
        {names.map((n) => (
          <a key={n} href={`#${sqsPath(n)}`} className={current === n ? 'active' : ''} title={n}>
            {n}
            {isFifo(n) && <span className="badge">FIFO</span>}
          </a>
        ))}
        {conn && state.loaded && !state.loading && !state.error && !names.length && <div className="muted small pad">{q ? 'No matching queues.' : 'No queues.'}</div>}
      </div>
    </>
  );
}
