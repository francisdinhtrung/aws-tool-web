import React, { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../api.js';
import { useApp, navigate } from '../context.js';
import { Tabs, Spinner, ErrorBox, Empty, Field, Select, JsonArea, CodeBlock, useToast, copyText, download, useLocalStorage } from '../components/ui.jsx';
import { AttrFields, DlqPicker, KeyValueRows, MessageAttrRows, arnOf } from '../components/SqsModals.jsx';
import { confirmPurge, confirmDelete } from './SqsQueues.jsx';
import {
  sqs, getQueueUrl, getQueueAttributes, queueCounts, isFifo, fmtEpoch, fmtSeconds, encryptionLabel, byteLength, prettyBody, parseJsonSafe,
  buildSendInput, sendCopies, pollMessages, deleteMessages, releaseMessages, messagesForExport, fromMessageAttributes,
  NUMERIC_ATTRS, attrErrors, changedAttrs, parseRedrivePolicy, buildRedrivePolicy, parseRedriveAllow, buildRedriveAllow,
  queueNameFromArn, queueNameFromUrl, sqsPath,
} from '../lib/sqs.js';

function KV({ rows }) {
  return (
    <dl className="kv">
      {rows.filter(Boolean).map(([k, v]) => (
        <React.Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

const TABS = [
  ['messages', 'Send & receive'],
  ['settings', 'Settings'],
  ['dlq', 'Dead-letter queue'],
  ['policy', 'Access policy'],
  ['tags', 'Tags'],
];

export default function SqsQueue({ name }) {
  const { reloadQueues } = useApp();
  const toast = useToast();
  const [url, setUrl] = useState(null);
  const [attrs, setAttrs] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useLocalStorage('ddbs.sqs.tab', 'messages');
  const [draft, setDraft] = useState(null); // message copied into the send form
  const fifo = isFifo(name);

  const refresh = useCallback(async (u = url) => {
    if (!u) return;
    try {
      setAttrs(await getQueueAttributes(u));
    } catch (e) {
      setError(errorText(e));
    }
  }, [url]);

  useEffect(() => {
    let live = true;
    getQueueUrl(name)
      .then((u) => {
        if (!live) return;
        setUrl(u);
        return getQueueAttributes(u).then((a) => live && setAttrs(a));
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [name]);

  if (error && !attrs) return <div className="page"><h2 className="lv-title">📨 {name}</h2><ErrorBox error={error} /></div>;
  if (!url || !attrs) return <div className="page"><Spinner /></div>;

  const c = queueCounts(attrs);
  const dlq = parseRedrivePolicy(attrs.RedrivePolicy);

  return (
    <div className="page sqs-page">
      <div className="page-head">
        <h2 className="lv-title" title={url}>📨 {name}</h2>
        {fifo && <span className="badge">FIFO</span>}
        {dlq && (
          <a className="badge badge-btn" href={`#${sqsPath(queueNameFromArn(dlq.deadLetterTargetArn))}`} title={dlq.deadLetterTargetArn}>
            DLQ → {queueNameFromArn(dlq.deadLetterTargetArn)}
          </a>
        )}
        <div className="push-right row-gap wrap">
          <button className="btn btn-sm" title="Copy URL" onClick={() => copyText(url).then(() => toast('Queue URL copied'))}>⧉ URL</button>
          <button className="btn btn-sm" title="Copy ARN" onClick={() => copyText(attrs.QueueArn).then(() => toast('ARN copied'))}>⧉ ARN</button>
          <button className="btn btn-sm" onClick={() => refresh()}>↻ Refresh</button>
          <button className="btn btn-sm" onClick={async () => (await confirmPurge(url, toast)) && refresh()}>Purge</button>
          <button className="btn btn-sm btn-danger" onClick={async () => { if (await confirmDelete(url, toast)) { reloadQueues(); navigate('/sqs'); } }}>Delete</button>
        </div>
      </div>
      <div className="sqs-stats">
        <Stat label="Available" value={c.available} hint="ApproximateNumberOfMessages" strong />
        <Stat label="In flight" value={c.inFlight} hint="Received but not deleted (invisible)" />
        <Stat label="Delayed" value={c.delayed} hint="Not yet available because of a delay" />
        <Stat label="Visibility timeout" value={fmtSeconds(attrs.VisibilityTimeout)} />
        <Stat label="Retention" value={fmtSeconds(attrs.MessageRetentionPeriod)} />
        <Stat label="Encryption" value={encryptionLabel(attrs)} />
      </div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'messages' && <MessagesTab url={url} attrs={attrs} fifo={fifo} onChanged={refresh} draft={draft} setDraft={setDraft} />}
      {tab === 'settings' && <SettingsTab url={url} attrs={attrs} fifo={fifo} onSaved={refresh} />}
      {tab === 'dlq' && <DlqTab url={url} name={name} attrs={attrs} fifo={fifo} onSaved={refresh} />}
      {tab === 'policy' && <PolicyTab url={url} attrs={attrs} onSaved={refresh} />}
      {tab === 'tags' && <TagsTab url={url} />}
    </div>
  );
}

function Stat({ label, value, hint, strong }) {
  return (
    <div className="sqs-stat" title={hint}>
      <div className="sqs-stat-label">{label}</div>
      <div className={`sqs-stat-value${strong ? ' strong' : ''}`}>{value}</div>
    </div>
  );
}

// --- Send & receive -----------------------------------------------------------------------------
const emptyForm = { body: '', delay: '', groupId: '', dedupId: '', attrs: [], count: '1' };

function SendPanel({ url, fifo, attrs, onSent, draft, clearDraft }) {
  const toast = useToast();
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const needsDedup = fifo && attrs.ContentBasedDeduplication !== 'true';

  useEffect(() => {
    if (!draft) return;
    setForm({ ...emptyForm, body: draft.Body, groupId: draft.Attributes?.MessageGroupId || '', attrs: fromMessageAttributes(draft.MessageAttributes) });
    clearDraft();
  }, [draft, clearDraft]);

  const send = async () => {
    setError(null);
    let input;
    try {
      input = buildSendInput(url, form, fifo);
      if (needsDedup && !input.MessageDeduplicationId) throw new Error('Deduplication ID is required: content-based deduplication is off for this queue');
    } catch (e) {
      return setError(e.message);
    }
    const count = Math.max(1, Math.min(1000, Number(form.count) || 1));
    setBusy(true);
    try {
      if (count === 1) {
        const out = await sqs('SendMessage', input);
        setLast(out);
        toast(`Sent message ${out.MessageId}`);
      } else {
        const { sent, failed } = await sendCopies(input, count);
        setLast(null);
        if (failed.length) setError(`${failed.length} failed: ${failed[0].Code} ${failed[0].Message || ''}`);
        toast(`Sent ${sent} messages`, failed.length ? 'error' : 'ok');
      }
      onSent();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const formatBody = () => {
    const v = parseJsonSafe(form.body);
    if (v === undefined) return toast('Body is not valid JSON', 'error');
    set({ body: JSON.stringify(v, null, 2) });
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Send message</h3>
        <span className="muted small">{byteLength(form.body).toLocaleString()} / {Number(attrs.MaximumMessageSize || 262144).toLocaleString()} bytes</span>
      </div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <Field label="Message body">
        <JsonArea value={form.body} onChange={(body) => set({ body })} rows={8} placeholder='{"orderId": 42}' />
      </Field>
      <div className="row-gap wrap">
        <button className="btn btn-xs" onClick={formatBody}>Format JSON</button>
        <button className="btn btn-xs" onClick={() => setForm(emptyForm)}>Clear</button>
      </div>
      <div className="grid-3 mt-s">
        {fifo ? (
          <>
            <Field label="Message group ID" hint="Messages in the same group are delivered in order.">
              <input value={form.groupId} onChange={(e) => set({ groupId: e.target.value })} aria-label="Message group ID" />
            </Field>
            <Field label={`Deduplication ID${needsDedup ? '' : ' (optional)'}`} hint={needsDedup ? 'Required: content-based deduplication is off.' : 'Empty = hash of the body.'}>
              <input value={form.dedupId} onChange={(e) => set({ dedupId: e.target.value })} aria-label="Deduplication ID" />
            </Field>
          </>
        ) : (
          <Field label="Delivery delay" hint={`0 – 900 seconds. Queue default: ${attrs.DelaySeconds || 0}s`}>
            <input type="number" min={0} max={900} value={form.delay} onChange={(e) => set({ delay: e.target.value })} placeholder={attrs.DelaySeconds || '0'} aria-label="Delivery delay" />
          </Field>
        )}
        <Field label="Copies" hint="Send the same message N times (batches of 10).">
          <input type="number" min={1} max={1000} value={form.count} onChange={(e) => set({ count: e.target.value })} aria-label="Copies" />
        </Field>
      </div>
      <div className="field">
        <span className="field-label">Message attributes</span>
        <MessageAttrRows rows={form.attrs} onChange={(a) => set({ attrs: a })} />
      </div>
      <div className="row-gap mt-s">
        <button className="btn btn-primary" onClick={send} disabled={busy}>{busy ? <Spinner /> : 'Send message'}</button>
        {last && <span className="muted small">Last: <code>{last.MessageId}</code>{last.SequenceNumber && ` · seq ${last.SequenceNumber}`}</span>}
      </div>
    </div>
  );
}

function MessagesTab({ url, attrs, fifo, onChanged, draft, setDraft }) {
  const toast = useToast();
  const [opts, setOpts] = useLocalStorage('ddbs.sqs.poll', { max: 10, seconds: 10, visibility: 30 });
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [open, setOpen] = useState(null);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const ctl = useRef(null);
  const clearDraft = useCallback(() => setDraft(null), [setDraft]);

  useEffect(() => () => ctl.current?.abort(), []);

  const poll = async () => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setPolling(true);
    setError(null);
    setSelected(new Set());
    setOpen(null);
    setMessages([]);
    try {
      const out = await pollMessages(url, {
        max: Math.max(1, Math.min(1000, Number(opts.max) || 10)),
        seconds: Math.max(1, Math.min(300, Number(opts.seconds) || 10)),
        visibility: Math.max(0, Math.min(43200, Number(opts.visibility) || 0)),
        signal: c.signal,
        onBatch: (m) => !c.signal.aborted && setMessages(m),
      });
      if (!c.signal.aborted) {
        setMessages(out);
        if (!out.length) toast('No messages available');
      }
    } catch (e) {
      if (!c.signal.aborted) setError(errorText(e));
    }
    if (ctl.current === c) setPolling(false);
    onChanged();
  };
  const stop = () => {
    ctl.current?.abort();
    setPolling(false);
  };

  const q = filter.trim().toLowerCase();
  const shown = messages.filter((m) => !q || String(m.Body).toLowerCase().includes(q) || m.MessageId.includes(q));
  const picked = messages.filter((m) => selected.has(m.MessageId));
  const target = picked.length ? picked : [];

  const remove = async (list) => {
    if (!list.length || !window.confirm(`Delete ${list.length} message${list.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    try {
      const failed = await deleteMessages(url, list);
      const gone = new Set(list.map((m) => m.MessageId).filter((id) => !failed.some((f) => f.MessageId === id)));
      setMessages((ms) => ms.filter((m) => !gone.has(m.MessageId)));
      setSelected(new Set());
      if (open && gone.has(open)) setOpen(null);
      if (failed.length) setError(`${failed.length} not deleted: ${failed[0].Code} ${failed[0].Message || ''}\nThe receipt handle expires when the visibility timeout ends; poll again.`);
      else toast(`Deleted ${gone.size} message${gone.size === 1 ? '' : 's'}`);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const release = async (list) => {
    if (!list.length) return;
    try {
      const failed = await releaseMessages(url, list);
      const done = new Set(list.map((m) => m.MessageId).filter((id) => !failed.some((f) => f.MessageId === id)));
      setMessages((ms) => ms.filter((m) => !done.has(m.MessageId)));
      setSelected(new Set());
      if (open && done.has(open)) setOpen(null);
      if (failed.length) setError(`${failed.length} not released: ${failed[0].Code} ${failed[0].Message || ''}`);
      else toast(`Returned ${done.size} message${done.size === 1 ? '' : 's'} to the queue`);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOn = shown.length > 0 && shown.every((m) => selected.has(m.MessageId));
  const openMsg = messages.find((m) => m.MessageId === open);

  return (
    <>
      <SendPanel url={url} fifo={fifo} attrs={attrs} onSent={onChanged} draft={draft} clearDraft={clearDraft} />
      <div className="card">
        <div className="card-head">
          <h3>Receive messages</h3>
        </div>
        <div className="row-gap wrap sqs-poll">
          <Field label="Max messages" inline>
            <input type="number" min={1} max={1000} value={opts.max} onChange={(e) => setOpts({ ...opts, max: e.target.value })} aria-label="Max messages" />
          </Field>
          <Field label="Poll for (s)" inline>
            <input type="number" min={1} max={300} value={opts.seconds} onChange={(e) => setOpts({ ...opts, seconds: e.target.value })} aria-label="Poll duration" />
          </Field>
          <Field label="Visibility timeout (s)" inline>
            <input type="number" min={0} max={43200} value={opts.visibility} onChange={(e) => setOpts({ ...opts, visibility: e.target.value })} aria-label="Visibility timeout" />
          </Field>
          {polling ? (
            <button className="btn btn-danger" onClick={stop}>■ Stop polling</button>
          ) : (
            <button className="btn btn-primary" onClick={poll}>Poll for messages</button>
          )}
          {polling && <span className="muted small"><Spinner /> Polling… {messages.length} received</span>}
        </div>
        <div className="muted small">
          Received messages are hidden from other consumers for the visibility timeout and their receive count goes up
          {parseRedrivePolicy(attrs.RedrivePolicy) ? ` (after ${parseRedrivePolicy(attrs.RedrivePolicy).maxReceiveCount} receives they move to the DLQ)` : ''}.
          Use visibility timeout 0 to peek.
        </div>
        <ErrorBox error={error} onClose={() => setError(null)} />

        {messages.length > 0 && (
          <>
            <div className="row-gap wrap sqs-toolbar">
              <span className="small"><strong>{messages.length}</strong> message{messages.length === 1 ? '' : 's'}{picked.length ? ` · ${picked.length} selected` : ''}</span>
              <input placeholder="Find in body / ID…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find in messages" />
              <div className="push-right row-gap">
                <button className="btn btn-sm" disabled={!target.length} onClick={() => release(target)} title="Make visible again (visibility timeout 0)">↩ Return to queue</button>
                <button className="btn btn-sm btn-danger" disabled={!target.length} onClick={() => remove(target)}>Delete</button>
                <button className="btn btn-sm" onClick={() => download(`${queueNameFromUrl(url)}-messages.json`, JSON.stringify(messagesForExport(picked.length ? picked : messages), null, 2))}>Export JSON</button>
              </div>
            </div>
            <div className="grid-wrap">
              <table className="grid sqs-msgs">
                <thead>
                  <tr>
                    <th className="col-check"><input type="checkbox" aria-label="Select all" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(shown.map((m) => m.MessageId)))} /></th>
                    <th>Message ID</th>
                    <th>Sent</th>
                    <th className="col-num">Size</th>
                    <th className="col-num">Receives</th>
                    {fifo && <th>Group</th>}
                    <th>Body</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((m) => (
                    <tr key={m.MessageId} className={open === m.MessageId ? 'selected' : ''} onClick={() => setOpen(open === m.MessageId ? null : m.MessageId)}>
                      <td className="col-check" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`Select ${m.MessageId}`} checked={selected.has(m.MessageId)} onChange={() => toggle(m.MessageId)} />
                      </td>
                      <td className="mono small">{m.MessageId}</td>
                      <td className="small">{fmtEpoch(m.Attributes?.SentTimestamp)}</td>
                      <td className="col-num small">{byteLength(m.Body).toLocaleString()} B</td>
                      <td className="col-num">{m.Attributes?.ApproximateReceiveCount || '—'}</td>
                      {fifo && <td className="small">{m.Attributes?.MessageGroupId}</td>}
                      <td className="mono small ellipsis sqs-body-cell">{m.Body}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {!polling && !messages.length && <Empty>Poll to see the messages in this queue.</Empty>}
      </div>
      {openMsg && (
        <MessageDetail
          m={openMsg}
          onClose={() => setOpen(null)}
          onDelete={() => remove([openMsg])}
          onRelease={() => release([openMsg])}
          onResend={() => {
            setDraft(openMsg);
            window.scrollTo?.({ top: 0, behavior: 'smooth' });
          }}
        />
      )}
    </>
  );
}

function MessageDetail({ m, onClose, onDelete, onRelease, onResend }) {
  const [tab, setTab] = useState('body');
  const sys = m.Attributes || {};
  const msgAttrs = fromMessageAttributes(m.MessageAttributes);
  const ref = useRef(null);
  useEffect(() => ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), [m.MessageId]);
  return (
    <div className="card sqs-detail" aria-label="Message details" ref={ref}>
      <div className="card-head">
        <h3 className="ellipsis">Message <code>{m.MessageId}</code></h3>
        <div className="row-gap">
          <button className="btn btn-xs" onClick={onResend} title="Copy body and attributes into the send form">Copy to send form</button>
          <button className="btn btn-xs" onClick={onRelease}>↩ Return to queue</button>
          <button className="btn btn-xs btn-danger" onClick={onDelete}>Delete</button>
          <button className="icon-btn" onClick={onClose} aria-label="Close details">×</button>
        </div>
      </div>
      <Tabs small tabs={[['body', 'Body'], ['attrs', `Attributes (${msgAttrs.length})`], ['details', 'Details']]} value={tab} onChange={setTab} />
      {tab === 'body' && <CodeBlock code={prettyBody(m.Body)} maxHeight="50vh" />}
      {tab === 'attrs' &&
        (msgAttrs.length ? (
          <table className="grid grid-plain">
            <thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead>
            <tbody>
              {msgAttrs.map((a) => (
                <tr key={a.name}><td><strong>{a.name}</strong></td><td>{a.type}</td><td className="mono small pre-wrap">{a.value}</td></tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted small">No message attributes.</div>
        ))}
      {tab === 'details' && (
        <KV
          rows={[
            ['Message ID', <code key="id">{m.MessageId}</code>],
            ['MD5 of body', <code key="md5">{m.MD5OfBody}</code>],
            ['Sent', fmtEpoch(sys.SentTimestamp)],
            ['First received', fmtEpoch(sys.ApproximateFirstReceiveTimestamp)],
            ['Receive count', sys.ApproximateReceiveCount],
            ['Sender ID', sys.SenderId],
            sys.MessageGroupId && ['Message group ID', sys.MessageGroupId],
            sys.MessageDeduplicationId && ['Deduplication ID', sys.MessageDeduplicationId],
            sys.SequenceNumber && ['Sequence number', sys.SequenceNumber],
            sys.DeadLetterQueueSourceArn && ['DLQ source', sys.DeadLetterQueueSourceArn],
            sys.AWSTraceHeader && ['Trace header', sys.AWSTraceHeader],
            ['Receipt handle', <code key="rh" className="small">{m.ReceiptHandle}</code>],
          ]}
        />
      )}
    </div>
  );
}

// --- Settings ------------------------------------------------------------------------------------
function SettingsTab({ url, attrs, fifo, onSaved }) {
  const toast = useToast();
  const pick = () => ({
    ...Object.fromEntries(NUMERIC_ATTRS.map(([k]) => [k, attrs[k] ?? ''])),
    ...(fifo ? { ContentBasedDeduplication: attrs.ContentBasedDeduplication || 'false', DeduplicationScope: attrs.DeduplicationScope || 'queue', FifoThroughputLimit: attrs.FifoThroughputLimit || 'perQueue' } : {}),
  });
  const [values, setValues] = useState(pick);
  const [enc, setEnc] = useState(attrs.KmsMasterKeyId ? 'kms' : attrs.SqsManagedSseEnabled === 'true' ? 'sqs' : 'none');
  const [kmsKey, setKmsKey] = useState(attrs.KmsMasterKeyId || 'alias/aws/sqs');
  const [kmsReuse, setKmsReuse] = useState(attrs.KmsDataKeyReusePeriodSeconds || '300');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const errs = attrErrors(values);

  useEffect(() => setValues(pick()), [attrs]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (Object.keys(errs).length) return setError(Object.values(errs)[0]);
    const next = { ...values };
    if (enc === 'sqs') Object.assign(next, { SqsManagedSseEnabled: 'true', KmsMasterKeyId: '' });
    else if (enc === 'kms') Object.assign(next, { KmsMasterKeyId: kmsKey.trim(), KmsDataKeyReusePeriodSeconds: kmsReuse });
    else Object.assign(next, { SqsManagedSseEnabled: 'false', KmsMasterKeyId: '' });
    const Attributes = changedAttrs(next, attrs);
    if (!Object.keys(Attributes).length) return toast('Nothing changed');
    setBusy(true);
    setError(null);
    try {
      await sqs('SetQueueAttributes', { QueueUrl: url, Attributes });
      toast('Queue updated. Changes can take up to a minute to apply.');
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  return (
    <div className="grid-2 cards">
      <div className="card">
        <div className="card-head"><h3>Configuration</h3></div>
        <ErrorBox error={error} onClose={() => setError(null)} />
        <AttrFields values={values} onChange={setValues} errors={errs} />
        {fifo && (
          <div className="grid-3">
            <Field label="Content-based deduplication">
              <Select value={values.ContentBasedDeduplication} onChange={(v) => setValues({ ...values, ContentBasedDeduplication: v })} options={[['false', 'Disabled'], ['true', 'Enabled']]} aria-label="Content-based deduplication" />
            </Field>
            <Field label="Deduplication scope">
              <Select value={values.DeduplicationScope} onChange={(v) => setValues({ ...values, DeduplicationScope: v })} options={['queue', 'messageGroup']} aria-label="Deduplication scope" />
            </Field>
            <Field label="FIFO throughput limit">
              <Select value={values.FifoThroughputLimit} onChange={(v) => setValues({ ...values, FifoThroughputLimit: v })} options={['perQueue', 'perMessageGroupId']} aria-label="FIFO throughput limit" />
            </Field>
          </div>
        )}
        <h4>Encryption</h4>
        <div className="grid-3">
          <Field label="Server-side encryption">
            <Select value={enc} onChange={setEnc} options={[['sqs', 'SSE-SQS'], ['kms', 'SSE-KMS'], ['none', 'Disabled']]} aria-label="Encryption" />
          </Field>
          {enc === 'kms' && (
            <>
              <Field label="KMS key"><input value={kmsKey} onChange={(e) => setKmsKey(e.target.value)} aria-label="KMS key" /></Field>
              <Field label="Data key reuse (s)" hint="60 – 86400"><input type="number" value={kmsReuse} onChange={(e) => setKmsReuse(e.target.value)} aria-label="Data key reuse" /></Field>
            </>
          )}
        </div>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save'}</button>
      </div>
      <div className="card">
        <div className="card-head"><h3>Details</h3></div>
        <KV
          rows={[
            ['URL', <code key="u">{url}</code>],
            ['ARN', <code key="a">{attrs.QueueArn}</code>],
            ['Type', fifo ? 'FIFO' : 'Standard'],
            ['Created', fmtEpoch(attrs.CreatedTimestamp, true)],
            ['Last modified', fmtEpoch(attrs.LastModifiedTimestamp, true)],
            ['Messages available', attrs.ApproximateNumberOfMessages],
            ['Messages in flight', attrs.ApproximateNumberOfMessagesNotVisible],
            ['Messages delayed', attrs.ApproximateNumberOfMessagesDelayed],
            ['Encryption', encryptionLabel(attrs)],
          ]}
        />
        <details className="mt-s">
          <summary className="small muted">All attributes (JSON)</summary>
          <CodeBlock code={JSON.stringify(attrs, null, 2)} maxHeight="40vh" />
        </details>
      </div>
    </div>
  );
}

// --- Dead-letter queue ---------------------------------------------------------------------------
function DlqTab({ url, name, attrs, fifo, onSaved }) {
  const toast = useToast();
  const current = parseRedrivePolicy(attrs.RedrivePolicy);
  const [target, setTarget] = useState(current ? queueNameFromArn(current.deadLetterTargetArn) : '');
  const [maxReceive, setMaxReceive] = useState(String(current?.maxReceiveCount || 5));
  const allow = parseRedriveAllow(attrs.RedriveAllowPolicy);
  const [perm, setPerm] = useState(allow.redrivePermission);
  const [allowArns, setAllowArns] = useState(allow.sourceQueueArns.join('\n'));
  const [sources, setSources] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [redrive, setRedrive] = useState({ dest: '', rate: '' });

  const loadSources = useCallback(async () => {
    try {
      const out = await sqs('ListDeadLetterSourceQueues', { QueueUrl: url, MaxResults: 1000 });
      setSources(out.queueUrls || []);
    } catch (e) {
      setSources([]);
      setError(errorText(e));
    }
  }, [url]);
  const loadTasks = useCallback(async () => {
    try {
      const out = await sqs('ListMessageMoveTasks', { SourceArn: attrs.QueueArn, MaxResults: 10 });
      setTasks(out.Results || []);
    } catch (e) {
      setTasks({ error: errorText(e) });
    }
  }, [attrs.QueueArn]);

  useEffect(() => {
    loadSources();
  }, [loadSources]);
  useEffect(() => {
    if (sources?.length) loadTasks();
  }, [sources, loadTasks]);

  const saveRedrive = async (remove) => {
    setBusy(true);
    setError(null);
    try {
      let policy = '';
      if (!remove) {
        if (!target) throw new Error('Choose a dead-letter queue');
        const n = Number(maxReceive);
        if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('Maximum receives must be between 1 and 1000');
        policy = buildRedrivePolicy(await arnOf(target), n);
      }
      await sqs('SetQueueAttributes', { QueueUrl: url, Attributes: { RedrivePolicy: policy } });
      toast(remove ? 'Dead-letter queue removed' : 'Dead-letter queue saved');
      if (remove) setTarget('');
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const saveAllow = async () => {
    setBusy(true);
    setError(null);
    try {
      const arns = allowArns.split(/[\s,]+/).filter(Boolean);
      if (perm === 'byQueue' && !arns.length) throw new Error('List at least one source queue ARN');
      await sqs('SetQueueAttributes', { QueueUrl: url, Attributes: { RedriveAllowPolicy: buildRedriveAllow({ redrivePermission: perm, sourceQueueArns: arns }) } });
      toast('Redrive allow policy saved');
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const startRedrive = async () => {
    const what = redrive.dest ? `to ${redrive.dest}` : 'back to their source queues';
    if (!window.confirm(`Move all messages from "${name}" ${what}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const input = { SourceArn: attrs.QueueArn };
      if (redrive.dest) input.DestinationArn = await arnOf(redrive.dest);
      if (redrive.rate) input.MaxNumberOfMessagesPerSecond = Number(redrive.rate);
      await sqs('StartMessageMoveTask', input);
      toast('Redrive started');
      loadTasks();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  const cancelTask = async (t) => {
    try {
      await sqs('CancelMessageMoveTask', { TaskHandle: t.TaskHandle });
      toast('Redrive cancelled');
      loadTasks();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const isDlq = sources?.length > 0;
  const running = Array.isArray(tasks) && tasks.some((t) => t.Status === 'RUNNING');

  return (
    <>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className="grid-2 cards">
        <div className="card">
          <div className="card-head"><h3>Dead-letter queue of this queue</h3></div>
          <div className="muted small">Messages that are received more than <em>maximum receives</em> times without being deleted move to this queue.</div>
          <div className="grid-2 mt-s">
            <Field label="Dead-letter queue"><DlqPicker value={target} onChange={setTarget} fifo={fifo} self={name} /></Field>
            <Field label="Maximum receives" hint="1 – 1000">
              <input type="number" min={1} max={1000} value={maxReceive} onChange={(e) => setMaxReceive(e.target.value)} aria-label="Maximum receives" />
            </Field>
          </div>
          <div className="row-gap">
            <button className="btn btn-primary" onClick={() => saveRedrive(false)} disabled={busy || !target}>Save</button>
            {current && <button className="btn" onClick={() => saveRedrive(true)} disabled={busy}>Remove dead-letter queue</button>}
            {current && <a className="btn" href={`#${sqsPath(queueNameFromArn(current.deadLetterTargetArn))}`}>Open DLQ</a>}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Redrive allow policy</h3></div>
          <div className="muted small">Which source queues may use this queue as their dead-letter queue.</div>
          <Field label="Allow">
            <Select value={perm} onChange={setPerm} options={[['allowAll', 'All queues'], ['byQueue', 'Only specified queues'], ['denyAll', 'No queues']]} aria-label="Redrive permission" />
          </Field>
          {perm === 'byQueue' && (
            <Field label="Source queue ARNs" hint="One per line, up to 10.">
              <textarea className="mono" rows={3} value={allowArns} onChange={(e) => setAllowArns(e.target.value)} aria-label="Source queue ARNs" />
            </Field>
          )}
          <button className="btn btn-primary" onClick={saveAllow} disabled={busy}>Save</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Source queues {sources && <span className="muted">({sources.length})</span>}</h3>
          <button className="btn btn-sm" onClick={loadSources}>↻</button>
        </div>
        {!sources && <Spinner />}
        {sources && !sources.length && <div className="muted small">No queue uses this queue as its dead-letter queue.</div>}
        {sources?.map((u) => (
          <div key={u}><a href={`#${sqsPath(queueNameFromUrl(u))}`}>{queueNameFromUrl(u)}</a></div>
        ))}
      </div>

      {isDlq && (
        <div className="card">
          <div className="card-head">
            <h3>Start DLQ redrive</h3>
            <button className="btn btn-sm" onClick={loadTasks}>↻</button>
          </div>
          <div className="muted small">Moves the messages of this dead-letter queue back to their source queues (or another queue) with <code>StartMessageMoveTask</code>.</div>
          <div className="grid-3 mt-s">
            <Field label="Destination">
              <Select
                value={redrive.dest}
                onChange={(dest) => setRedrive({ ...redrive, dest })}
                options={[['', 'Source queue(s) of each message'], ...sources.map(queueNameFromUrl)]}
                aria-label="Redrive destination"
              />
            </Field>
            <Field label="Max messages / second" hint="Empty = optimized by SQS (up to 500)">
              <input type="number" min={1} max={500} value={redrive.rate} onChange={(e) => setRedrive({ ...redrive, rate: e.target.value })} aria-label="Max messages per second" />
            </Field>
          </div>
          <button className="btn btn-primary" onClick={startRedrive} disabled={busy || running}>{running ? 'A redrive is running' : 'Start redrive'}</button>
          {tasks?.error && <div className="text-bad small mt-s">{tasks.error}</div>}
          {Array.isArray(tasks) && tasks.length > 0 && (
            <table className="grid grid-plain mt-s">
              <thead><tr><th>Status</th><th>Started</th><th>Moved</th><th>Destination</th><th /></tr></thead>
              <tbody>
                {tasks.map((t, i) => (
                  <tr key={t.TaskHandle || i}>
                    <td><span className={`badge${t.Status === 'COMPLETED' ? ' badge-ok' : t.Status === 'FAILED' ? ' badge-bad' : ''}`}>{t.Status}</span>{t.FailureReason && <span className="text-bad small"> {t.FailureReason}</span>}</td>
                    <td className="small">{fmtEpoch(t.StartedTimestamp)}</td>
                    <td>{t.ApproximateNumberOfMessagesMoved ?? 0}{t.ApproximateNumberOfMessagesToMove ? ` / ${t.ApproximateNumberOfMessagesToMove}` : ''}</td>
                    <td className="small">{t.DestinationArn ? queueNameFromArn(t.DestinationArn) : 'Source queues'}</td>
                    <td>{t.Status === 'RUNNING' && t.TaskHandle && <button className="btn btn-xs" onClick={() => cancelTask(t)}>Cancel</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}

// --- Access policy -------------------------------------------------------------------------------
function PolicyTab({ url, attrs, onSaved }) {
  const toast = useToast();
  const fmt = (p) => (p ? JSON.stringify(parseJsonSafe(p) ?? p, null, 2) : '');
  const [text, setText] = useState(fmt(attrs.Policy));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setError(null);
    if (text.trim() && parseJsonSafe(text) === undefined) return setError('Policy is not valid JSON');
    setBusy(true);
    try {
      await sqs('SetQueueAttributes', { QueueUrl: url, Attributes: { Policy: text.trim() ? JSON.stringify(JSON.parse(text)) : '' } });
      toast(text.trim() ? 'Policy saved' : 'Policy removed');
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  const example = () =>
    setText(
      JSON.stringify(
        {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'AllowSnsTopic',
              Effect: 'Allow',
              Principal: { Service: 'sns.amazonaws.com' },
              Action: 'sqs:SendMessage',
              Resource: attrs.QueueArn,
              Condition: { ArnEquals: { 'aws:SourceArn': 'arn:aws:sns:REGION:ACCOUNT:topic-name' } },
            },
          ],
        },
        null,
        2,
      ),
    );
  return (
    <div className="card">
      <div className="card-head">
        <h3>Access policy</h3>
        <div className="row-gap">
          <button className="btn btn-xs" onClick={example}>Example: allow SNS topic</button>
          <button className="btn btn-xs" onClick={() => setText(fmt(attrs.Policy))}>Reset</button>
        </div>
      </div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <JsonArea value={text} onChange={setText} rows={18} placeholder="No policy. Only the queue owner can access it." />
      <div className="row-gap mt-s">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save policy'}</button>
        <span className="muted small">Empty = remove the policy.</span>
      </div>
    </div>
  );
}

// --- Tags --------------------------------------------------------------------------------------
function TagsTab({ url }) {
  const toast = useToast();
  const [orig, setOrig] = useState(null);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = (await sqs('ListQueueTags', { QueueUrl: url })).Tags || {};
      setOrig(t);
      setRows(Object.entries(t).map(([key, value]) => ({ key, value })));
    } catch (e) {
      setError(errorText(e));
      setOrig({});
    }
  }, [url]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
      const removed = Object.keys(orig).filter((k) => !(k in next));
      const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => orig[k] !== v));
      if (removed.length) await sqs('UntagQueue', { QueueUrl: url, TagKeys: removed });
      if (Object.keys(changed).length) await sqs('TagQueue', { QueueUrl: url, Tags: changed });
      toast('Tags saved');
      await load();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  if (!orig) return <Spinner />;
  return (
    <div className="card">
      <div className="card-head"><h3>Tags</h3></div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <KeyValueRows rows={rows} onChange={setRows} />
      <button className="btn btn-primary mt-s" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save tags'}</button>
    </div>
  );
}
