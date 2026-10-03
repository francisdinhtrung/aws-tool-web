import React, { useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Spinner, ErrorBox, Empty, Modal, Field, Select, useToast, copyText } from '../components/ui.jsx';
import { fmtBytes } from '../lib/s3.js';
import { logs, logsGroupPath, insightsPath, retentionLabel, RETENTION_DAYS, fmtTime } from '../lib/logs.js';
import { useUtc } from '../components/LogsCommon.jsx';

export default function LogsHome() {
  const { conn } = useApp();
  if (!conn) return <LogsWelcome />;
  return <LogGroupList />;
}

function LogsWelcome() {
  return (
    <div className="page">
      <div className="hero">
        <h1>📜 CloudWatch Logs</h1>
        <p className="muted">Search, tail and analyse CloudWatch log groups without the AWS console.</p>
      </div>
      <div className="card">
        <h3>Get started</h3>
        <ol className="steps">
          <li>Open <a href="#/connections">Connections</a> to add an AWS profile, or a custom endpoint (LocalStack).</li>
          <li>Pick the connection and region in the top bar.</li>
          <li>Choose a log group on the left to search and live-tail its events, or open <a href="#/logs/insights">Logs Insights</a> to query several groups.</li>
        </ol>
      </div>
    </div>
  );
}

export function RetentionModal({ group, onClose, onSaved }) {
  const [days, setDays] = useState(String(group.retentionInDays || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    try {
      if (days) await logs('PutRetentionPolicy', { logGroupName: group.logGroupName, retentionInDays: Number(days) });
      else await logs('DeleteRetentionPolicy', { logGroupName: group.logGroupName });
      onSaved(Number(days) || undefined);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Retention: ${group.logGroupName}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save'}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Keep events for" hint="Older events are deleted by CloudWatch. Longer retention costs more storage.">
        <Select value={days} onChange={setDays} options={[['', 'Never expire'], ...RETENTION_DAYS.map((d) => [String(d), `${d} days (${retentionLabel(d)})`])]} />
      </Field>
    </Modal>
  );
}

function LogGroupList() {
  const { logGroups, logGroupsState, reloadLogGroups, logFavorites, toggleLogFavorite, info } = useApp();
  const [utc] = useUtc();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState({ by: 'name', dir: 1 });
  const [retention, setRetention] = useState(null);
  const toast = useToast();
  const q = filter.trim().toLowerCase();
  const val = (g) => ({ name: g.logGroupName.toLowerCase(), stored: g.storedBytes || 0, created: g.creationTime || 0, retention: g.retentionInDays || 1e9 })[sort.by];
  const shown = logGroups
    .filter((g) => g.logGroupName.toLowerCase().includes(q))
    .sort((a, b) => {
      const fa = logFavorites.includes(a.logGroupName) ? 0 : 1;
      const fb = logFavorites.includes(b.logGroupName) ? 0 : 1;
      if (fa !== fb) return fa - fb;
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
        <h2>📜 Log groups <span className="muted count">({q ? `${shown.length} of ` : ''}{logGroups.length}{logGroupsState.more ? '+' : ''})</span></h2>
        <span className="muted ellipsis">{info.label} · {info.region}{info.endpoint ? ` · ${info.endpoint}` : ''}</span>
        <div className="push-right row-gap">
          <input placeholder="Filter log groups…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" autoFocus />
          <button className="btn" onClick={reloadLogGroups}>↻ Refresh</button>
          <a className="btn btn-primary" href="#/logs/insights">🔎 Logs Insights</a>
        </div>
      </div>
      {logGroupsState.more && <div className="alert alert-info small">Only the first {logGroups.length} log groups are listed. Use the sidebar search to find others by name.</div>}
      <ErrorBox error={logGroupsState.error} />
      {logGroupsState.loading && <Spinner />}
      {!logGroupsState.loading && !logGroupsState.error && !logGroups.length && <Empty>No log groups in this region.</Empty>}
      {shown.length > 0 && (
        <div className="grid-wrap bucket-wrap">
          <table className="grid lg-table">
            <thead>
              <tr>
                <th className="col-fav" aria-label="Favorite" />
                {th('name', 'Name', 'col-name')}
                {th('retention', 'Retention', 'col-ret')}
                {th('stored', 'Stored', 'col-stored')}
                {th('created', 'Created', 'col-created')}
                <th className="col-act" />
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => {
                const fav = logFavorites.includes(g.logGroupName);
                return (
                  <tr key={g.logGroupName}>
                    <td className="col-fav">
                      <button className={`star${fav ? ' on' : ''}`} onClick={() => toggleLogFavorite(g.logGroupName)} title={fav ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={fav}>
                        {fav ? '★' : '☆'}
                      </button>
                    </td>
                    <td className="col-name" title={g.logGroupName}>
                      <a href={`#${logsGroupPath(g.logGroupName)}`}>{g.logGroupName}</a>
                      {g.logGroupClass && g.logGroupClass !== 'STANDARD' && <span className="badge">{g.logGroupClass}</span>}
                    </td>
                    <td className="col-ret">{retentionLabel(g.retentionInDays)}</td>
                    <td className="col-stored">{g.storedBytes === undefined ? '—' : fmtBytes(g.storedBytes)}</td>
                    <td className="col-created">{fmtTime(g.creationTime, utc, true)}</td>
                    <td className="row-actions col-act">
                      <a className="btn btn-xs" href={`#${logsGroupPath(g.logGroupName)}`}>View logs</a>
                      <a className="btn btn-xs" href={`#${insightsPath({ groups: g.logGroupName })}`}>Insights</a>
                      <button className="btn btn-xs" onClick={() => setRetention(g)}>Retention</button>
                      <button className="btn btn-xs" title="Copy ARN" onClick={() => copyText(g.arn || g.logGroupName).then(() => toast('ARN copied'))}>⧉</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {retention && (
        <RetentionModal
          group={retention}
          onClose={() => setRetention(null)}
          onSaved={() => {
            setRetention(null);
            toast('Retention updated');
            reloadLogGroups();
          }}
        />
      )}
    </div>
  );
}
