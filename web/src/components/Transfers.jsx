import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { uploadBlob, fmtBytes } from '../lib/s3.js';
import { errorText, getConn } from '../api.js';

const Ctx = createContext(null);
export const useTransfers = () => useContext(Ctx);

const UPLOAD_CONCURRENCY = 3;
let seq = 0;

/**
 * Background task queue for S3: uploads (with byte progress) and batch jobs (copy / move / delete) with item progress.
 * Lives above the router so transfers survive navigation.
 */
export function TransfersProvider({ children }) {
  const [tasks, setTasks] = useState([]);
  const [version, setVersion] = useState(0);
  const queue = useRef([]);
  const running = useRef(0);
  const aborts = useRef(new Map());

  const patch = useCallback((id, p) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...(typeof p === 'function' ? p(t) : p) } : t))), []);
  const finish = useCallback(
    (id, p) => {
      aborts.current.delete(id);
      patch(id, p);
      setVersion((v) => v + 1);
    },
    [patch],
  );

  const pump = useCallback(() => {
    while (running.current < UPLOAD_CONCURRENCY && queue.current.length) {
      const job = queue.current.shift();
      running.current++;
      patch(job.id, { status: 'running', started: Date.now() });
      const { promise, abort } = uploadBlob(job.bucket, job.key, job.file, (loaded) => patch(job.id, { loaded }), job.conn);
      aborts.current.set(job.id, abort);
      promise
        .then(() => finish(job.id, (t) => ({ status: 'done', loaded: t.total, ended: Date.now() })))
        .catch((e) => finish(job.id, { status: e.message === 'Cancelled' ? 'cancelled' : 'error', error: errorText(e), ended: Date.now() }))
        .finally(() => {
          running.current--;
          pump();
        });
    }
  }, [patch, finish]);

  // files: [{ file: Blob, key }]
  const upload = useCallback(
    (bucket, files) => {
      const conn = getConn(); // pin the connection: switching it later must not redirect queued uploads
      const fresh = files.map(({ file, key }) => ({
        id: `t${++seq}`, kind: 'upload', label: key, bucket, key, file, conn, total: file.size, loaded: 0, status: 'queued',
      }));
      setTasks((ts) => [...ts, ...fresh.map(({ file, conn: _c, ...t }) => t)]);
      fresh.forEach((t) => aborts.current.set(t.id, () => {
        queue.current = queue.current.filter((q) => q.id !== t.id);
        finish(t.id, { status: 'cancelled' });
      }));
      queue.current.push(...fresh);
      pump();
    },
    [pump, finish],
  );

  // run(progress, signal) where progress(done, total). Resolves with the run result.
  const job = useCallback(
    async (kind, label, run) => {
      const id = `t${++seq}`;
      const ctl = new AbortController();
      aborts.current.set(id, () => ctl.abort());
      setTasks((ts) => [...ts, { id, kind, label, total: 0, loaded: 0, status: 'running', started: Date.now(), items: true }]);
      try {
        const out = await run((loaded, total) => patch(id, { loaded, total }), ctl.signal);
        finish(id, (t) => ({ status: 'done', loaded: t.total || t.loaded, ended: Date.now() }));
        return out;
      } catch (e) {
        finish(id, { status: ctl.signal.aborted ? 'cancelled' : 'error', error: errorText(e), ended: Date.now() });
        throw e;
      }
    },
    [patch, finish],
  );

  const cancel = useCallback((id) => aborts.current.get(id)?.(), []);
  const cancelAll = useCallback(() => [...aborts.current.values()].forEach((f) => f()), []);
  const clearFinished = useCallback(() => setTasks((ts) => ts.filter((t) => t.status === 'running' || t.status === 'queued')), []);

  // Internal clipboard for copy / cut & paste between folders and buckets.
  const [clip, setClip] = useState(null);

  const value = useMemo(
    () => ({ tasks, version, upload, job, cancel, cancelAll, clearFinished, clip, setClip }),
    [tasks, version, upload, job, cancel, cancelAll, clearFinished, clip],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const STATUS = { queued: 'Queued', running: 'Running', done: 'Done', error: 'Failed', cancelled: 'Cancelled' };
const KIND = { upload: '⬆', copy: '⧉', move: '➜', delete: '🗑', download: '⬇' };

export function TransfersDock() {
  const { tasks, cancel, cancelAll, clearFinished } = useTransfers();
  const [open, setOpen] = useState(true);
  if (!tasks.length) return null;
  const active = tasks.filter((t) => t.status === 'running' || t.status === 'queued');
  const failed = tasks.filter((t) => t.status === 'error').length;
  const up = tasks.filter((t) => t.kind === 'upload');
  const bytes = up.reduce((s, t) => s + (t.total || 0), 0);
  const done = up.reduce((s, t) => s + (t.status === 'done' ? t.total : t.loaded || 0), 0);
  return (
    <div className={`dock${open ? ' open' : ''}`}>
      <div className="dock-head" onClick={() => setOpen(!open)}>
        <strong>Tasks</strong>
        <span className="muted small">
          {active.length ? `${active.length} active` : 'All finished'}
          {failed ? ` · ${failed} failed` : ''}
          {bytes ? ` · ${fmtBytes(done)} / ${fmtBytes(bytes)}` : ''}
        </span>
        {bytes > 0 && <div className="progress dock-total"><div style={{ width: `${Math.round((done / bytes) * 100)}%` }} /></div>}
        <span className="push-right row-gap" onClick={(e) => e.stopPropagation()}>
          {active.length > 0 && <button className="btn btn-xs" onClick={cancelAll}>Cancel all</button>}
          <button className="btn btn-xs" onClick={clearFinished}>Clear finished</button>
          <button className="icon-btn" onClick={() => setOpen(!open)} aria-label="Toggle tasks">{open ? '▾' : '▴'}</button>
        </span>
      </div>
      {open && (
        <div className="dock-body">
          <table className="grid grid-plain dock-table">
            <tbody>
              {[...tasks].reverse().map((t) => {
                const pct = t.total ? Math.round(((t.status === 'done' ? t.total : t.loaded) / t.total) * 100) : t.status === 'done' ? 100 : 0;
                return (
                  <tr key={t.id} className={`task-${t.status}`}>
                    <td className="dock-kind">{KIND[t.kind]}</td>
                    <td className="dock-label" title={t.error || t.label}>
                      {t.label}
                      {t.error && <div className="text-bad small">{t.error}</div>}
                    </td>
                    <td className="dock-bar">
                      <div className="progress"><div style={{ width: `${pct}%` }} className={t.status === 'running' && !t.total ? 'indeterminate' : ''} /></div>
                    </td>
                    <td className="muted small dock-size">
                      {t.items ? (t.total ? `${t.loaded} / ${t.total}` : t.loaded || '') : `${fmtBytes(t.status === 'done' ? t.total : t.loaded)} / ${fmtBytes(t.total)}`}
                    </td>
                    <td className={`small dock-status s-${t.status}`}>{STATUS[t.status]}</td>
                    <td className="dock-act">
                      {(t.status === 'running' || t.status === 'queued') && (
                        <button className="icon-btn" title="Cancel" onClick={() => cancel(t.id)}>×</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
