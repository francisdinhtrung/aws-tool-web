import React, { useCallback, useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Spinner, ErrorBox, Empty, useToast, copyText } from '../components/ui.jsx';
import { sfn, listAll, fmtDate, nameError } from '../lib/sfn.js';

/** Activities: tasks performed by your own workers (GetActivityTask / SendTaskSuccess). */
export default function SfnActivities() {
  const { conn } = useApp();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems((await listAll('ListActivities', { maxResults: 1000 }, 'activities')).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      setItems([]);
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (conn) load();
  }, [conn, load]);

  const create = async () => {
    setBusy(true);
    try {
      await sfn('CreateActivity', { name });
      toast(`Created activity ${name}`);
      setName('');
      await load();
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };

  const remove = async (a) => {
    if (!window.confirm(`Delete activity "${a.name}"?\nState machines that use it will fail when they reach it.`)) return;
    try {
      await sfn('DeleteActivity', { activityArn: a.activityArn });
      toast(`Deleted ${a.name}`);
      await load();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  if (!conn) return <div className="page"><Empty>Select a connection to list activities.</Empty></div>;
  const err = name ? nameError(name) : '';
  return (
    <div className="page">
      <div className="page-head">
        <h2>⚑ Activities {items && <span className="muted count">({items.length})</span>}</h2>
        <div className="push-right row-gap">
          <input placeholder="New activity name" value={name} onChange={(e) => setName(e.target.value.trim())} aria-label="Activity name" title={err} />
          <button className="btn btn-primary" onClick={create} disabled={!name || Boolean(err) || busy}>{busy ? <Spinner /> : '＋ Create activity'}</button>
          <button className="btn" onClick={load}>↻ Refresh</button>
        </div>
      </div>
      <div className="muted small fn-desc">An activity task is done by a worker you run: it polls <code>GetActivityTask</code> and answers with <code>SendTaskSuccess</code> / <code>SendTaskFailure</code>. Use the ARN as the <code>Resource</code> of a Task state.</div>
      <ErrorBox error={error} />
      {!items && <Spinner />}
      {items && !items.length && !error && <Empty>No activities.</Empty>}
      {items?.length > 0 && (
        <table className="grid lg-table">
          <thead><tr><th>Name</th><th>ARN</th><th>Created</th><th /></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.activityArn}>
                <td><strong>{a.name}</strong></td>
                <td><code className="small">{a.activityArn}</code></td>
                <td>{fmtDate(a.creationDate)}</td>
                <td className="row-actions">
                  <button className="btn btn-xs" onClick={() => copyText(a.activityArn).then(() => toast('ARN copied'))}>⧉ ARN</button>
                  <button className="btn btn-xs btn-danger" onClick={() => remove(a)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
