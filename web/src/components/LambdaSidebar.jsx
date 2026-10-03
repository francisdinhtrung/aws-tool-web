import React, { useState } from 'react';
import { Spinner } from './ui.jsx';
import { lambdaPath } from '../lib/lambda.js';

export default function LambdaSidebar({ conn, functions, state, reload, current, page, onCreate }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const shown = functions.filter((f) => f.FunctionName.toLowerCase().includes(q));

  return (
    <>
      <nav className="nav">
        <a href="#/lambda" className={page === 'home' ? 'active' : ''}>λ Functions</a>
        <a href="#/lambda/layers" className={page === 'layers' ? 'active' : ''}>▤ Layers</a>
        <a href="#/connections" className={page === 'connections' ? 'active' : ''}>⚙ Connections</a>
      </nav>
      <div className="side-head">
        <span>Functions {conn && <span className="muted">({functions.length}{state.more ? '+' : ''})</span>}</span>
        <span>
          <button className="icon-btn" title="Refresh" onClick={reload} disabled={!conn}>↻</button>
          <button className="icon-btn" title="Create function" onClick={onCreate} disabled={!conn}>＋</button>
        </span>
      </div>
      {conn && <input className="side-filter" placeholder="Filter functions…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter functions" />}
      <div className="table-list bucket-list">
        {!conn && <div className="muted small pad">Select a connection to list functions.</div>}
        {state.loading && <div className="pad"><Spinner /></div>}
        {state.error && <div className="side-error">{state.error}</div>}
        {shown.map((f) => (
          <a key={f.FunctionName} href={`#${lambdaPath(f.FunctionName)}`} className={current === f.FunctionName ? 'active' : ''} title={`${f.FunctionName}${f.Runtime ? ` · ${f.Runtime}` : ''}`}>
            {f.FunctionName}
          </a>
        ))}
        {conn && state.loaded && !state.loading && !state.error && !shown.length && <div className="muted small pad">{q ? 'No matching functions.' : 'No functions.'}</div>}
      </div>
    </>
  );
}
