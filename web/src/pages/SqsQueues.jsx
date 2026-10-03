import React, { useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Spinner, ErrorBox, Empty, useToast, copyText } from '../components/ui.jsx';
import { pool } from '../lib/s3.js';
import { sqs, queueNameFromUrl, sqsPath, isFifo, getQueueAttributes, queueCounts, fmtEpoch, fmtSeconds, encryptionLabel, parseRedrivePolicy, queueNameFromArn } from '../lib/sqs.js';

export default function SqsHome({ onCreate }) {
  const { conn } = useApp();
  if (!conn) return <SqsWelcome />;
  return <QueueList onCreate={onCreate} />;
}

function SqsWelcome() {
  return (
    <div className="page">
      <div className="hero">
        <h1>📨 Amazon SQS</h1>
        <p className="muted">Create queues, send, poll and delete messages, and redrive dead-letter queues without the AWS console.</p>
      </div>
      <div className="card">
        <h3>Get started</h3>
        <ol className="steps">
          <li>Open <a href="#/connections">Connections</a> to add an AWS profile, or a custom endpoint (LocalStack, ElasticMQ).</li>
          <li>Pick the connection and region in the top bar.</li>
          <li>Choose a queue on the left to send and receive messages.</li>
        </ol>
      </div>
    </div>
  );
}

/** Purges a queue after confirmation. Returns true when purged. */
export async function confirmPurge(url, toast) {
  const name = queueNameFromUrl(url);
  if (!window.confirm(`Purge all messages from "${name}"?\nThis cannot be undone. Purging can take up to 60 seconds.`)) return false;
  try {
    await sqs('PurgeQueue', { QueueUrl: url });
    toast(`Purging ${name}`);
    return true;
  } catch (e) {
    toast(errorText(e), 'error');
    return false;
  }
}

/** Deletes a queue after the user types its name. Returns true when deleted. */
export async function confirmDelete(url, toast) {
  const name = queueNameFromUrl(url);
  const typed = window.prompt(`Type the queue name "${name}" to permanently delete it and all its messages.`);
  if (typed !== name) return false;
  try {
    await sqs('DeleteQueue', { QueueUrl: url });
    toast(`Deleted ${name}`);
    return true;
  } catch (e) {
    toast(errorText(e), 'error');
    return false;
  }
}

const ATTR_LIMIT = 300;

function QueueList({ onCreate }) {
  const { queues, queuesState, reloadQueues, info } = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [attrs, setAttrs] = useState({});
  const [sort, setSort] = useState({ by: 'name', dir: 1 });
  const q = filter.trim().toLowerCase();

  // Attributes for the first queues (one GetQueueAttributes call each).
  useEffect(() => {
    const ctl = new AbortController();
    setAttrs({});
    pool(queues.slice(0, ATTR_LIMIT), 6, async (url) => {
      try {
        const a = await getQueueAttributes(url);
        if (!ctl.signal.aborted) setAttrs((m) => ({ ...m, [url]: a }));
      } catch (e) {
        if (!ctl.signal.aborted) setAttrs((m) => ({ ...m, [url]: { $error: errorText(e) } }));
      }
    }, ctl.signal).catch(() => {});
    return () => ctl.abort();
  }, [queues]);

  const val = (url) => {
    const a = attrs[url] || {};
    const c = queueCounts(a);
    return { name: queueNameFromUrl(url).toLowerCase(), available: c.available, inFlight: c.inFlight, created: Number(a.CreatedTimestamp || 0) }[sort.by];
  };
  const shown = queues
    .filter((u) => queueNameFromUrl(u).toLowerCase().includes(q))
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
  const refreshOne = async (url) => setAttrs({ ...attrs, [url]: await getQueueAttributes(url).catch((e) => ({ $error: errorText(e) })) });

  return (
    <div className="page">
      <div className="page-head">
        <h2>📨 Queues <span className="muted count">({q ? `${shown.length} of ` : ''}{queues.length}{queuesState.more ? '+' : ''})</span></h2>
        <span className="muted ellipsis">{info.label} · {info.region}{info.endpoint ? ` · ${info.endpoint}` : ''}</span>
        <div className="push-right row-gap">
          <input placeholder="Filter queues…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" autoFocus />
          <button className="btn" onClick={reloadQueues}>↻ Refresh</button>
          <button className="btn btn-primary" onClick={onCreate}>＋ Create queue</button>
        </div>
      </div>
      {queues.length > ATTR_LIMIT && <div className="alert alert-info small">Message counts are loaded for the first {ATTR_LIMIT} queues only.</div>}
      <ErrorBox error={queuesState.error} />
      {queuesState.loading && <Spinner />}
      {!queuesState.loading && !queuesState.error && !queues.length && <Empty>No queues in this region. <button className="btn btn-sm" onClick={onCreate}>Create queue</button></Empty>}
      {shown.length > 0 && (
        <div className="grid-wrap bucket-wrap">
          <table className="grid lg-table sqs-table">
            <thead>
              <tr>
                {th('name', 'Name', 'col-name')}
                <th className="col-type">Type</th>
                {th('available', 'Available', 'col-num')}
                {th('inFlight', 'In flight', 'col-num')}
                <th className="col-num">Delayed</th>
                <th className="col-misc">Details</th>
                {th('created', 'Created', 'col-created')}
                <th className="col-act" />
              </tr>
            </thead>
            <tbody>
              {shown.map((url) => {
                const name = queueNameFromUrl(url);
                const a = attrs[url];
                const c = queueCounts(a);
                const dlq = parseRedrivePolicy(a?.RedrivePolicy);
                const loading = !a && queues.indexOf(url) < ATTR_LIMIT;
                return (
                  <tr key={url}>
                    <td className="col-name" title={url}>
                      <a href={`#${sqsPath(name)}`}>{name}</a>
                    </td>
                    <td className="col-type">{isFifo(name) ? <span className="badge">FIFO</span> : <span className="muted">Standard</span>}</td>
                    {a?.$error ? (
                      <td colSpan={4} className="text-bad small ellipsis" title={a.$error}>{a.$error}</td>
                    ) : (
                      <>
                        <td className="col-num">{loading ? <Spinner /> : a ? <strong className={c.available ? '' : 'muted'}>{c.available}</strong> : '—'}</td>
                        <td className="col-num">{a ? c.inFlight : '—'}</td>
                        <td className="col-num">{a ? c.delayed : '—'}</td>
                        <td className="col-misc small muted">
                          {a && (
                            <>
                              {dlq && <span className="badge" title={dlq.deadLetterTargetArn}>DLQ → {queueNameFromArn(dlq.deadLetterTargetArn)}</span>}
                              {encryptionLabel(a) !== 'None' && <span className="badge" title={encryptionLabel(a)}>🔒</span>}
                              <span title="Visibility timeout"> ⏱ {fmtSeconds(a.VisibilityTimeout)}</span>
                            </>
                          )}
                        </td>
                      </>
                    )}
                    <td className="col-created">{a ? fmtEpoch(a.CreatedTimestamp, true) : '—'}</td>
                    <td className="row-actions col-act">
                      <a className="btn btn-xs" href={`#${sqsPath(name)}`}>Send & receive</a>
                      <button className="btn btn-xs" title="Refresh counts" onClick={() => refreshOne(url)}>↻</button>
                      <button className="btn btn-xs" title="Copy URL" onClick={() => copyText(url).then(() => toast('Queue URL copied'))}>⧉</button>
                      <button className="btn btn-xs" onClick={async () => (await confirmPurge(url, toast)) && refreshOne(url)}>Purge</button>
                      <button className="btn btn-xs btn-danger" onClick={async () => (await confirmDelete(url, toast)) && reloadQueues()}>Delete</button>
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
