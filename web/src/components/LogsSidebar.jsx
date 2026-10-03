import React, { useEffect, useState } from 'react';
import { Spinner } from './ui.jsx';
import { listLogGroups, logsGroupPath } from '../lib/logs.js';
import { errorText } from '../api.js';

function GroupLink({ name, current, fav }) {
  return (
    <a href={`#${logsGroupPath(name)}`} className={current === name ? 'active' : ''} title={name}>
      {fav && <span className="side-star" aria-hidden>★ </span>}
      {name}
    </a>
  );
}

export default function LogsSidebar({ conn, groups, state, reload, favorites, current, page }) {
  const [filter, setFilter] = useState('');
  const [remote, setRemote] = useState({ q: '', groups: [], loading: false, error: null });
  const q = filter.trim();
  const local = groups.filter((g) => g.logGroupName.toLowerCase().includes(q.toLowerCase()));

  // Only part of the groups is loaded: also ask the server (logGroupNamePattern is a case-sensitive substring).
  useEffect(() => {
    if (!q || !state.more) return setRemote({ q: '', groups: [], loading: false, error: null });
    setRemote((r) => ({ ...r, loading: true }));
    const t = setTimeout(async () => {
      try {
        const { groups: found } = await listLogGroups({ pattern: q, max: 200 });
        setRemote({ q, groups: found, loading: false, error: null });
      } catch (e) {
        setRemote({ q, groups: [], loading: false, error: errorText(e) });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q, state.more]);

  const names = [...new Set([...local.map((g) => g.logGroupName), ...(remote.q === q ? remote.groups.map((g) => g.logGroupName) : [])])];
  const favs = favorites.filter((f) => f.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <nav className="nav">
        <a href="#/logs" className={page === 'home' ? 'active' : ''}>📜 Log groups</a>
        <a href="#/logs/insights" className={page === 'insights' ? 'active' : ''}>🔎 Logs Insights</a>
        <a href="#/connections" className={page === 'connections' ? 'active' : ''}>⚙ Connections</a>
      </nav>
      <div className="side-head">
        <span>Log groups {conn && <span className="muted">({groups.length}{state.more ? '+' : ''})</span>}</span>
        <span>
          <button className="icon-btn" title="Refresh" onClick={reload} disabled={!conn}>↻</button>
        </span>
      </div>
      {conn && <input className="side-filter" placeholder="Filter log groups…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter log groups" />}
      <div className="table-list bucket-list">
        {!conn && <div className="muted small pad">Select a connection to list log groups.</div>}
        {favs.length > 0 && (
          <>
            <div className="side-sub">Favorites</div>
            {favs.map((n) => <GroupLink key={`f:${n}`} name={n} current={current} fav />)}
            <div className="side-sub">All groups</div>
          </>
        )}
        {state.loading && <div className="pad"><Spinner /></div>}
        {state.error && <div className="side-error">{state.error}</div>}
        {names.map((n) => <GroupLink key={n} name={n} current={current} />)}
        {remote.loading && <div className="pad"><Spinner /></div>}
        {remote.error && <div className="side-error">{remote.error}</div>}
        {conn && state.loaded && !state.loading && !state.error && !names.length && !remote.loading && (
          <div className="muted small pad">{q ? 'No matching log groups.' : 'No log groups.'}</div>
        )}
        {state.more && !q && <div className="muted small pad">Showing first {groups.length}. Type to search all.</div>}
      </div>
    </>
  );
}
