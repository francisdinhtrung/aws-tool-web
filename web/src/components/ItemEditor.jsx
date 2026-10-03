import React, { useState } from 'react';
import { Modal, Tabs, JsonArea, ErrorBox, Spinner } from './ui.jsx';
import { AttributeRows, itemToRows, rowsToItem } from './builders.jsx';
import { itemToPlain, itemFromPlain, isDdbJsonItem } from '../lib/dynamo.js';
import { errorText } from '../api.js';

// keyNames: table primary key attribute names; keyTypes: { name: 'S'|'N'|'B' }
export default function ItemEditor({ title, item, keyNames = [], keyTypes = {}, isNew, onSave, onClose }) {
  const [tab, setTab] = useState('form');
  const [rows, setRows] = useState(() => itemToRows(item, keyNames, keyTypes));
  const [json, setJson] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const current = () => {
    if (tab === 'form') return rowsToItem(rows);
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Item must be a JSON object');
    if (tab === 'ddb') {
      if (Object.keys(obj).length && !isDdbJsonItem(obj)) throw new Error('Not valid DynamoDB JSON. Every attribute must look like {"S": "..."}');
      return obj;
    }
    return itemFromPlain(obj);
  };

  const switchTab = (next) => {
    if (next === tab) return;
    try {
      const it = current();
      if (next === 'form') {
        if (!isNew) {
          for (const k of keyNames) {
            if (JSON.stringify(it[k]) !== JSON.stringify(item?.[k])) throw new Error(`Key attribute "${k}" cannot be changed for an existing item`);
          }
        }
        setRows(itemToRows(it, keyNames, keyTypes));
      } else setJson(JSON.stringify(next === 'ddb' ? it : itemToPlain(it), null, 2));
      setError(null);
      setTab(next);
    } catch (e) {
      setError(e.message);
    }
  };

  const save = async () => {
    let it;
    try {
      it = current();
      for (const k of keyNames) if (!it[k]) throw new Error(`Key attribute "${k}" is required`);
      if (!isNew) {
        for (const k of keyNames) {
          if (JSON.stringify(it[k]) !== JSON.stringify(item?.[k])) throw new Error(`Key attribute "${k}" cannot be changed. Use "Duplicate" to create a copy with a new key.`);
        }
      }
    } catch (e) {
      return setError(e.message);
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(it);
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={title || (isNew ? 'Create item' : 'Edit item')}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <Spinner /> : isNew ? 'Create item' : 'Save changes'}
          </button>
        </>
      }
    >
      <Tabs tabs={[['form', 'Form'], ['ddb', 'DynamoDB JSON'], ['plain', 'Plain JSON']]} value={tab} onChange={switchTab} small />
      <ErrorBox error={error} onClose={() => setError(null)} />
      {tab === 'form' ? (
        <AttributeRows rows={rows} onChange={setRows} lockKeyValues={!isNew} />
      ) : (
        <>
          {tab === 'plain' && <div className="muted small">Plain JSON: numbers → N, strings → S, arrays → L, objects → M. Sets and binary are not preserved; use DynamoDB JSON for exact types.</div>}
          <JsonArea value={json} onChange={setJson} rows={20} />
        </>
      )}
    </Modal>
  );
}
