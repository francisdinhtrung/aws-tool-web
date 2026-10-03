import React from 'react';
import { KEY_TYPES } from '../lib/dynamo.js';
import { Select, Field } from './ui.jsx';

const keyTypeOpts = KEY_TYPES.map((t) => [t, { S: 'String', N: 'Number', B: 'Binary' }[t]]);

export function KeyAttrInput({ label, value, onChange, optional }) {
  return (
    <Field label={label}>
      <div className="input-group">
        <input
          value={value?.AttributeName || ''}
          placeholder={optional ? '(optional)' : 'attribute name'}
          onChange={(e) => onChange(e.target.value || optional ? { AttributeName: e.target.value, AttributeType: value?.AttributeType || 'S' } : undefined)}
        />
        <Select value={value?.AttributeType || 'S'} onChange={(t) => onChange({ AttributeName: value?.AttributeName || '', AttributeType: t })} options={keyTypeOpts} />
      </div>
    </Field>
  );
}

export const emptyDef = () => ({
  TableName: '',
  KeyAttributes: { PartitionKey: { AttributeName: 'pk', AttributeType: 'S' }, SortKey: { AttributeName: 'sk', AttributeType: 'S' } },
  NonKeyAttributes: [],
  GlobalSecondaryIndexes: [],
  TableData: [],
  DataAccess: { MySql: {} },
  BillingMode: 'PAY_PER_REQUEST',
});

// Clean optional empty sort keys before sending to AWS / saving.
export function normalizeDef(def) {
  const d = structuredClone(def);
  if (!d.KeyAttributes.SortKey?.AttributeName) delete d.KeyAttributes.SortKey;
  d.GlobalSecondaryIndexes = (d.GlobalSecondaryIndexes || []).map((g) => {
    if (!g.KeyAttributes.SortKey?.AttributeName) delete g.KeyAttributes.SortKey;
    return g;
  });
  if (d.LocalSecondaryIndexes) {
    d.LocalSecondaryIndexes = d.LocalSecondaryIndexes.filter((l) => l.IndexName && l.KeyAttributes?.SortKey?.AttributeName);
    if (!d.LocalSecondaryIndexes.length) delete d.LocalSecondaryIndexes;
  }
  return d;
}

export function validateDef(def) {
  if (!/^[a-zA-Z0-9_.-]{3,255}$/.test(def.TableName || '')) return 'Table name must be 3-255 chars: letters, digits, _ . -';
  if (!def.KeyAttributes?.PartitionKey?.AttributeName) return 'Partition key is required';
  const types = new Map();
  const check = (k) => {
    if (!k?.AttributeName) return null;
    if (types.has(k.AttributeName) && types.get(k.AttributeName) !== k.AttributeType) return `Attribute "${k.AttributeName}" used with different types`;
    types.set(k.AttributeName, k.AttributeType);
    return null;
  };
  for (const k of [def.KeyAttributes.PartitionKey, def.KeyAttributes.SortKey]) {
    const e = check(k);
    if (e) return e;
  }
  const names = new Set();
  for (const g of [...(def.GlobalSecondaryIndexes || []), ...(def.LocalSecondaryIndexes || [])]) {
    if (!/^[a-zA-Z0-9_.-]{3,255}$/.test(g.IndexName || '')) return `Index name "${g.IndexName || ''}" is invalid (3-255 chars)`;
    if (names.has(g.IndexName)) return `Duplicate index name "${g.IndexName}"`;
    names.add(g.IndexName);
    for (const k of [g.KeyAttributes?.PartitionKey, g.KeyAttributes?.SortKey]) {
      const e = check(k);
      if (e) return e;
    }
  }
  return null;
}

function IndexEditor({ index, onChange, onRemove, lsi, tablePk }) {
  const ka = index.KeyAttributes || {};
  const proj = index.Projection || { ProjectionType: 'ALL' };
  return (
    <div className="card card-sub">
      <div className="card-sub-head">
        <strong>{lsi ? 'Local' : 'Global'} secondary index</strong>
        <button className="icon-btn" onClick={onRemove}>×</button>
      </div>
      <div className="grid-3">
        <Field label="Index name">
          <input value={index.IndexName || ''} onChange={(e) => onChange({ ...index, IndexName: e.target.value })} />
        </Field>
        {lsi ? (
          <Field label="Partition key">
            <input value={tablePk?.AttributeName || ''} disabled />
          </Field>
        ) : (
          <KeyAttrInput label="Partition key" value={ka.PartitionKey} onChange={(v) => onChange({ ...index, KeyAttributes: { ...ka, PartitionKey: v } })} />
        )}
        <KeyAttrInput label="Sort key" optional={!lsi} value={ka.SortKey} onChange={(v) => onChange({ ...index, KeyAttributes: { ...ka, SortKey: v } })} />
      </div>
      <div className="grid-2">
        <Field label="Projection">
          <Select value={proj.ProjectionType} onChange={(t) => onChange({ ...index, Projection: { ProjectionType: t, ...(t === 'INCLUDE' ? { NonKeyAttributes: proj.NonKeyAttributes || [] } : {}) } })} options={['ALL', 'KEYS_ONLY', 'INCLUDE']} />
        </Field>
        {proj.ProjectionType === 'INCLUDE' && (
          <Field label="Included attributes (comma-separated)">
            <input
              value={(proj.NonKeyAttributes || []).join(', ')}
              onChange={(e) => onChange({ ...index, Projection: { ...proj, NonKeyAttributes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
            />
          </Field>
        )}
      </div>
    </div>
  );
}

// live: show options only meaningful when creating a real table (LSI, table class, streams, deletion protection)
export default function TableDefEditor({ def, onChange, live }) {
  const set = (patch) => onChange({ ...def, ...patch });
  const ka = def.KeyAttributes || {};
  const tp = def.ProvisionedCapacitySettings?.ProvisionedThroughput || { ReadCapacityUnits: 5, WriteCapacityUnits: 5 };
  const setTp = (patch) => set({ ProvisionedCapacitySettings: { ...(def.ProvisionedCapacitySettings || {}), ProvisionedThroughput: { ...tp, ...patch } } });
  return (
    <div className="def-editor">
      <div className="grid-3">
        <Field label="Table name">
          <input value={def.TableName} onChange={(e) => set({ TableName: e.target.value })} placeholder="MyTable" autoFocus />
        </Field>
        <KeyAttrInput label="Partition key" value={ka.PartitionKey} onChange={(v) => set({ KeyAttributes: { ...ka, PartitionKey: v || { AttributeName: '', AttributeType: 'S' } } })} />
        <KeyAttrInput label="Sort key" optional value={ka.SortKey} onChange={(v) => set({ KeyAttributes: { ...ka, SortKey: v } })} />
      </div>
      <div className="grid-3">
        <Field label="Capacity mode">
          <Select value={def.BillingMode || 'PAY_PER_REQUEST'} onChange={(v) => set({ BillingMode: v })} options={[['PAY_PER_REQUEST', 'On-demand'], ['PROVISIONED', 'Provisioned']]} />
        </Field>
        {def.BillingMode === 'PROVISIONED' && (
          <>
            <Field label="Read capacity units">
              <input type="number" min="1" value={tp.ReadCapacityUnits} onChange={(e) => setTp({ ReadCapacityUnits: Number(e.target.value) })} />
            </Field>
            <Field label="Write capacity units">
              <input type="number" min="1" value={tp.WriteCapacityUnits} onChange={(e) => setTp({ WriteCapacityUnits: Number(e.target.value) })} />
            </Field>
          </>
        )}
      </div>
      {live && (
        <div className="grid-3">
          <Field label="Table class">
            <Select value={def.TableClass || 'STANDARD'} onChange={(v) => set({ TableClass: v })} options={[['STANDARD', 'Standard'], ['STANDARD_INFREQUENT_ACCESS', 'Standard-IA']]} />
          </Field>
          <Field label="DynamoDB Streams">
            <Select value={def.StreamViewType || ''} onChange={(v) => set({ StreamViewType: v || undefined })} options={[['', 'Disabled'], 'KEYS_ONLY', 'NEW_IMAGE', 'OLD_IMAGE', 'NEW_AND_OLD_IMAGES']} />
          </Field>
          <label className="check check-field">
            <input type="checkbox" checked={Boolean(def.DeletionProtectionEnabled)} onChange={(e) => set({ DeletionProtectionEnabled: e.target.checked })} /> Deletion protection
          </label>
        </div>
      )}

      {(def.GlobalSecondaryIndexes || []).map((g, i) => (
        <IndexEditor
          key={i}
          index={g}
          onChange={(v) => set({ GlobalSecondaryIndexes: def.GlobalSecondaryIndexes.map((x, j) => (j === i ? v : x)) })}
          onRemove={() => set({ GlobalSecondaryIndexes: def.GlobalSecondaryIndexes.filter((_, j) => j !== i) })}
        />
      ))}
      {(def.LocalSecondaryIndexes || []).map((g, i) => (
        <IndexEditor
          key={`l${i}`}
          lsi
          tablePk={ka.PartitionKey}
          index={g}
          onChange={(v) => set({ LocalSecondaryIndexes: def.LocalSecondaryIndexes.map((x, j) => (j === i ? v : x)) })}
          onRemove={() => set({ LocalSecondaryIndexes: def.LocalSecondaryIndexes.filter((_, j) => j !== i) })}
        />
      ))}
      <div className="row-gap">
        <button
          className="btn btn-sm"
          onClick={() =>
            set({
              GlobalSecondaryIndexes: [
                ...(def.GlobalSecondaryIndexes || []),
                { IndexName: `GSI${(def.GlobalSecondaryIndexes || []).length + 1}`, KeyAttributes: { PartitionKey: { AttributeName: '', AttributeType: 'S' } }, Projection: { ProjectionType: 'ALL' } },
              ],
            })
          }
        >
          + Global secondary index
        </button>
        {live && (
          <button
            className="btn btn-sm"
            onClick={() =>
              set({
                LocalSecondaryIndexes: [
                  ...(def.LocalSecondaryIndexes || []),
                  { IndexName: `LSI${(def.LocalSecondaryIndexes || []).length + 1}`, KeyAttributes: { SortKey: { AttributeName: '', AttributeType: 'S' } }, Projection: { ProjectionType: 'ALL' } },
                ],
              })
            }
          >
            + Local secondary index
          </button>
        )}
      </div>
    </div>
  );
}
