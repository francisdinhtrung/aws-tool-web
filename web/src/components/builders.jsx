// Reusable form pieces: condition rows, update rows, key inputs, attribute rows editor.
import React from 'react';
import {
  COND_OPS, NO_VALUE_OPS, UPDATE_ACTIONS, VALUE_TYPES, TYPE_LABELS, AV_TYPES,
  avType, toPlain, fromPlain, toAV, isAttributeValue,
} from '../lib/dynamo.js';
import { Select, nextId } from './ui.jsx';

const typeOptions = VALUE_TYPES.map((t) => [t, TYPE_LABELS[t]]);

function ValueInput({ type, value, onChange, placeholder = 'value' }) {
  if (type === 'NULL') return <span className="muted small value-null">null</span>;
  if (type === 'BOOL') return <Select value={value || 'true'} onChange={onChange} options={['true', 'false']} />;
  return <input value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={type === 'JSON' || type === 'PLAIN' ? 'mono' : ''} />;
}

export function ConditionRows({ rows, onChange, title = 'Filter', attrPlaceholder = 'attribute name' }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="builder">
      {rows.map((r, i) => (
        <div className="builder-row" key={r.id}>
          {i === 0 ? <span className="join-label">{title}</span> : <Select className="join" value={r.join || 'AND'} onChange={(v) => set(i, { join: v })} options={['AND', 'OR']} />}
          <input value={r.attr} placeholder={attrPlaceholder} onChange={(e) => set(i, { attr: e.target.value })} />
          <Select value={r.op} onChange={(v) => set(i, { op: v })} options={COND_OPS} />
          {!NO_VALUE_OPS.has(r.op) && r.op !== 'attribute_type' && !String(r.op).startsWith('size') && (
            <Select value={r.type} onChange={(v) => set(i, { type: v })} options={typeOptions} />
          )}
          {r.op === 'attribute_type' && <Select value={r.value || 'S'} onChange={(v) => set(i, { value: v })} options={AV_TYPES} />}
          {!NO_VALUE_OPS.has(r.op) && r.op !== 'attribute_type' && <ValueInput type={String(r.op).startsWith('size') ? 'N' : r.type} value={r.value} onChange={(v) => set(i, { value: v })} />}
          {r.op === 'between' && <ValueInput type={r.type} value={r.value2} placeholder="and" onChange={(v) => set(i, { value2: v })} />}
          <button className="icon-btn" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn btn-xs" onClick={() => onChange([...rows, newCondRow()])}>+ Add {title === 'Condition' ? 'condition' : `${title.toLowerCase()} condition`}</button>
    </div>
  );
}
export const newCondRow = () => ({ id: nextId(), join: 'AND', attr: '', op: '=', type: 'S', value: '', value2: '' });

export function UpdateRows({ rows, onChange }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="builder">
      {rows.map((r, i) => (
        <div className="builder-row" key={r.id}>
          <Select value={r.action} onChange={(v) => set(i, { action: v })} options={UPDATE_ACTIONS} />
          <input value={r.attr} placeholder="attribute path (a.b[0])" onChange={(e) => set(i, { attr: e.target.value })} />
          {r.action !== 'remove' && (
            <>
              <Select value={r.type} onChange={(v) => set(i, { type: v })} options={typeOptions} />
              <ValueInput type={r.type} value={r.value} onChange={(v) => set(i, { value: v })} />
            </>
          )}
          <button className="icon-btn" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn btn-xs" onClick={() => onChange([...rows, newUpdateRow()])}>+ Add update action</button>
    </div>
  );
}
export const newUpdateRow = () => ({ id: nextId(), action: 'set', attr: '', type: 'S', value: '' });

// Inputs for the primary key of a table description.
export function KeyInputs({ keys, value, onChange }) {
  const { pk, sk, pkType, skType } = keys;
  if (!pk) return <div className="muted small">Select a table</div>;
  return (
    <div className="grid-2">
      <label className="field">
        <span className="field-label">{pk} <span className="badge">PK · {pkType}</span></span>
        <input value={value[pk] ?? ''} onChange={(e) => onChange({ ...value, [pk]: e.target.value })} placeholder="partition key value" />
      </label>
      {sk && (
        <label className="field">
          <span className="field-label">{sk} <span className="badge">SK · {skType}</span></span>
          <input value={value[sk] ?? ''} onChange={(e) => onChange({ ...value, [sk]: e.target.value })} placeholder="sort key value" />
        </label>
      )}
    </div>
  );
}
export function keyFromInputs(keys, value) {
  const out = {};
  if (!keys.pk) throw new Error('Select a table');
  for (const [n, t] of [[keys.pk, keys.pkType], [keys.sk, keys.skType]]) {
    if (!n) continue;
    if (value[n] === undefined || value[n] === '') throw new Error(`Key attribute "${n}" is required`);
    out[n] = toAV(t, value[n]);
  }
  return out;
}

// --- Attribute rows (form item editor) ------------------------------------------------
const ROW_TYPES = [...AV_TYPES, 'RAW'];
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function avToRow(name, av) {
  const t = avType(av);
  const row = { id: nextId(), name, type: t, value: '' };
  if (t === 'S' || t === 'N' || t === 'B') row.value = av[t];
  else if (t === 'BOOL') row.value = String(av.BOOL);
  else if (t === 'SS' || t === 'NS' || t === 'BS') row.value = JSON.stringify(av[t]);
  else if (t === 'M' || t === 'L') {
    const plain = toPlain(av);
    if (deepEq(fromPlain(plain), av)) row.value = JSON.stringify(plain, null, 2);
    else Object.assign(row, { type: 'RAW', value: JSON.stringify(av, null, 2) });
  }
  return row;
}

export function rowToAV(row) {
  const where = `attribute "${row.name}"`;
  try {
    switch (row.type) {
      case 'M': {
        const v = JSON.parse(row.value || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected a JSON object');
        return fromPlain(v);
      }
      case 'L': {
        const v = JSON.parse(row.value || '[]');
        if (!Array.isArray(v)) throw new Error('expected a JSON array');
        return fromPlain(v);
      }
      case 'RAW': {
        const v = JSON.parse(row.value);
        if (!isAttributeValue(v)) throw new Error('expected DynamoDB JSON like {"S":"x"}');
        return v;
      }
      case 'SS':
      case 'NS':
      case 'BS': {
        const av = toAV(row.type, row.value);
        if (!av[row.type].length) throw new Error('sets cannot be empty');
        if (new Set(av[row.type]).size !== av[row.type].length) throw new Error('sets cannot contain duplicates');
        return av;
      }
      default:
        return toAV(row.type, row.value);
    }
  } catch (e) {
    throw new Error(`${where}: ${e.message}`);
  }
}

export function rowsToItem(rows) {
  const item = {};
  for (const r of rows) {
    const n = r.name.trim();
    if (!n) continue;
    if (item[n]) throw new Error(`Duplicate attribute "${n}"`);
    item[n] = rowToAV({ ...r, name: n });
  }
  return item;
}

export function itemToRows(item, keyNames = [], keyTypes = {}) {
  const rows = keyNames.map((k) => (item?.[k] ? { ...avToRow(k, item[k]), locked: true } : { id: nextId(), name: k, type: keyTypes[k] || 'S', value: '', locked: true }));
  for (const [k, v] of Object.entries(item || {})) if (!keyNames.includes(k)) rows.push(avToRow(k, v));
  return rows;
}

export function AttributeRows({ rows, onChange, lockKeyValues }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const multiline = (t) => ['M', 'L', 'RAW'].includes(t);
  return (
    <div className="attr-rows">
      <div className="attr-row attr-head">
        <span>Attribute</span>
        <span>Type</span>
        <span>Value</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div className="attr-row" key={r.id}>
          <input value={r.name} disabled={r.locked} placeholder="name" onChange={(e) => set(i, { name: e.target.value })} />
          <Select
            value={r.type}
            disabled={r.locked}
            onChange={(v) => set(i, { type: v, value: v === 'BOOL' ? 'true' : multiline(v) && !multiline(r.type) ? (v === 'L' ? '[]' : v === 'M' ? '{}' : '{"S": ""}') : r.value })}
            options={(r.locked ? ['S', 'N', 'B'] : ROW_TYPES).map((t) => [t, t === 'RAW' ? 'DynamoDB JSON' : `${t} · ${TYPE_LABELS[t]}`])}
          />
          {r.type === 'NULL' ? (
            <span className="muted small value-null">null</span>
          ) : r.type === 'BOOL' ? (
            <Select value={r.value} onChange={(v) => set(i, { value: v })} options={['true', 'false']} />
          ) : multiline(r.type) || String(r.value).length > 80 ? (
            <textarea className="mono" rows={Math.min(10, String(r.value).split('\n').length + 1)} value={r.value} onChange={(e) => set(i, { value: e.target.value })} spellCheck={false} />
          ) : (
            <input
              value={r.value}
              disabled={r.locked && lockKeyValues}
              placeholder={['SS', 'NS', 'BS'].includes(r.type) ? '["a","b"] or a, b' : r.type === 'B' ? 'base64' : ''}
              onChange={(e) => set(i, { value: e.target.value })}
            />
          )}
          {r.locked ? <span className="badge" title="Key attribute">key</span> : <button className="icon-btn" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>}
        </div>
      ))}
      <button className="btn btn-xs" onClick={() => onChange([...rows, { id: nextId(), name: '', type: 'S', value: '' }])}>+ Add attribute</button>
    </div>
  );
}
