import React, { useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Modal, Field, Select, Spinner, ErrorBox } from './ui.jsx';
import { sqs, queueNameFromUrl, isFifo, queueNameError, NUMERIC_ATTRS, DEFAULT_ATTRS, attrErrors, fmtSeconds, buildRedrivePolicy, ATTR_TYPES } from '../lib/sqs.js';

/** Inputs for the numeric queue attributes. `values` holds strings. */
export function AttrFields({ values, onChange, errors = {} }) {
  return (
    <div className="grid-2">
      {NUMERIC_ATTRS.map(([k, label, min, max, unit]) => (
        <Field key={k} label={label} hint={errors[k] ? <span className="text-bad">{errors[k]}</span> : `${unit}${values[k] !== '' && k !== 'MaximumMessageSize' ? ` · ${fmtSeconds(values[k])}` : ''}`}>
          <input type="number" min={min} max={max} value={values[k] ?? ''} onChange={(e) => onChange({ ...values, [k]: e.target.value })} aria-label={label} />
        </Field>
      ))}
    </div>
  );
}

/** Dead-letter queue picker: lists queues of the same type (FIFO / standard) except `self`. */
export function DlqPicker({ value, onChange, fifo, self }) {
  const { queues } = useApp();
  const options = (queues || []).map(queueNameFromUrl).filter((n) => n !== self && isFifo(n) === fifo);
  return (
    <Select
      value={value}
      onChange={onChange}
      aria-label="Dead-letter queue"
      options={[['', options.length ? '— select a queue —' : `— no ${fifo ? 'FIFO' : 'standard'} queue available —`], ...options]}
    />
  );
}

export const arnOf = async (name) => {
  const url = (await sqs('GetQueueUrl', { QueueName: name })).QueueUrl;
  return (await sqs('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['QueueArn'] })).Attributes?.QueueArn;
};

/** Editable key / value rows, used for tags. */
export function KeyValueRows({ rows, onChange, keyLabel = 'Key', valueLabel = 'Value' }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv-rows">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input placeholder={keyLabel} aria-label={`${keyLabel} ${i + 1}`} value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
          <input placeholder={valueLabel} aria-label={`${valueLabel} ${i + 1}`} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button className="icon-btn" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn btn-xs" onClick={() => onChange([...rows, { key: '', value: '' }])}>+ Add</button>
    </div>
  );
}

/** Message attribute rows: name, data type, value. */
export function MessageAttrRows({ rows, onChange }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv-rows">
      {rows.map((r, i) => (
        <div className="kv-row kv-row-3" key={i}>
          <input placeholder="Name" aria-label={`Attribute name ${i + 1}`} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
          <Select value={r.type} onChange={(type) => set(i, { type })} options={ATTR_TYPES} aria-label={`Attribute type ${i + 1}`} />
          <input placeholder={r.type === 'Binary' ? 'base64' : 'Value'} aria-label={`Attribute value ${i + 1}`} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button className="icon-btn" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn btn-xs" onClick={() => onChange([...rows, { name: '', type: 'String', value: '' }])}>+ Add attribute</button>
    </div>
  );
}

export function CreateQueueModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [fifo, setFifo] = useState(false);
  const [attrs, setAttrs] = useState(DEFAULT_ATTRS);
  const [cbd, setCbd] = useState(false);
  const [highThroughput, setHighThroughput] = useState(false);
  const [enc, setEnc] = useState('sqs');
  const [kmsKey, setKmsKey] = useState('alias/aws/sqs');
  const [dlq, setDlq] = useState('');
  const [maxReceive, setMaxReceive] = useState('5');
  const [tags, setTags] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const base = name.trim().replace(/\.fifo$/, '');
  const nameErr = name ? queueNameError(base, fifo) : '';
  const errs = attrErrors(attrs);

  const create = async () => {
    const ne = queueNameError(base, fifo);
    if (ne) return setError(ne);
    if (Object.keys(errs).length) return setError(Object.values(errs)[0]);
    setBusy(true);
    setError(null);
    try {
      const Attributes = { ...attrs };
      if (fifo) {
        Attributes.FifoQueue = 'true';
        if (cbd) Attributes.ContentBasedDeduplication = 'true';
        if (highThroughput) Object.assign(Attributes, { DeduplicationScope: 'messageGroup', FifoThroughputLimit: 'perMessageGroupId' });
      }
      if (enc === 'sqs') Attributes.SqsManagedSseEnabled = 'true';
      else if (enc === 'kms') Attributes.KmsMasterKeyId = kmsKey.trim();
      else Attributes.SqsManagedSseEnabled = 'false';
      if (dlq) Attributes.RedrivePolicy = buildRedrivePolicy(await arnOf(dlq), maxReceive);
      const QueueName = fifo ? `${base}.fifo` : base;
      const tagMap = Object.fromEntries(tags.filter((t) => t.key.trim()).map((t) => [t.key.trim(), t.value]));
      await sqs('CreateQueue', { QueueName, Attributes, ...(Object.keys(tagMap).length ? { tags: tagMap } : {}) });
      onCreated(QueueName);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Create queue"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={create} disabled={busy || !base}>{busy ? <Spinner /> : 'Create queue'}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="seg" role="radiogroup" aria-label="Queue type">
        <button className={!fifo ? 'active' : ''} aria-pressed={!fifo} onClick={() => setFifo(false)}>Standard</button>
        <button className={fifo ? 'active' : ''} aria-pressed={fifo} onClick={() => { setFifo(true); setDlq(''); }}>FIFO</button>
      </div>
      <div className="muted small mt-s">
        {fifo ? 'Exactly-once processing, strict ordering per message group.' : 'At-least-once delivery, best-effort ordering, nearly unlimited throughput.'}
      </div>
      <Field label="Name" hint={nameErr ? <span className="text-bad">{nameErr}</span> : fifo ? 'The .fifo suffix is added automatically.' : 'Up to 80 characters: letters, digits, - and _.'}>
        <div className="row-gap">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Queue name" autoFocus className="grow" />
          {fifo && <span className="muted mono">.fifo</span>}
        </div>
      </Field>

      <h4>Configuration</h4>
      <AttrFields values={attrs} onChange={setAttrs} errors={errs} />
      {fifo && (
        <div className="row-gap wrap">
          <label className="check"><input type="checkbox" checked={cbd} onChange={(e) => setCbd(e.target.checked)} /> Content-based deduplication</label>
          <label className="check"><input type="checkbox" checked={highThroughput} onChange={(e) => setHighThroughput(e.target.checked)} /> High throughput FIFO</label>
        </div>
      )}

      <h4>Encryption</h4>
      <div className="grid-2">
        <Field label="Server-side encryption">
          <Select value={enc} onChange={setEnc} options={[['sqs', 'SSE-SQS (Amazon SQS key)'], ['kms', 'SSE-KMS (AWS KMS key)'], ['none', 'Disabled']]} aria-label="Encryption" />
        </Field>
        {enc === 'kms' && (
          <Field label="KMS key" hint="Key ID, ARN or alias">
            <input value={kmsKey} onChange={(e) => setKmsKey(e.target.value)} aria-label="KMS key" />
          </Field>
        )}
      </div>

      <h4>Dead-letter queue</h4>
      <div className="grid-2">
        <Field label="Send undeliverable messages to" hint="Optional. Must be a queue of the same type.">
          <DlqPicker value={dlq} onChange={setDlq} fifo={fifo} />
        </Field>
        {dlq && (
          <Field label="Maximum receives" hint="1 – 1000. After this many receives a message moves to the DLQ.">
            <input type="number" min={1} max={1000} value={maxReceive} onChange={(e) => setMaxReceive(e.target.value)} aria-label="Maximum receives" />
          </Field>
        )}
      </div>

      <h4>Tags</h4>
      <KeyValueRows rows={tags} onChange={setTags} />
    </Modal>
  );
}
