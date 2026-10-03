import React from 'react';
import { ExprCtx, SK_OPS, buildCondition, buildProjection, indexesOf, keysOf, toAV } from '../lib/dynamo.js';
import { ConditionRows } from './builders.jsx';
import { Select } from './ui.jsx';

export const initialQueryState = () => ({
  mode: 'scan', index: '', pk: '', skOp: '=', sk: '', sk2: '', filters: [], projection: '',
  limit: '100', forward: true, consistent: false, segments: '',
});

export function buildQueryScanInput(desc, s, { includeLimit = true } = {}) {
  const ctx = new ExprCtx();
  const input = { TableName: desc.TableName };
  if (s.index) input.IndexName = s.index;
  if (s.mode === 'query') {
    const k = keysOf(desc, s.index);
    if (s.pk === '') throw new Error(`Partition key "${k.pk}" value is required for Query`);
    let kc = `${ctx.name(k.pk)} = ${ctx.value(toAV(k.pkType, s.pk))}`;
    if (k.sk && s.sk !== '') {
      const n = ctx.name(k.sk);
      const v = (x) => ctx.value(toAV(k.skType, x));
      if (s.skOp === 'between') kc += ` AND ${n} BETWEEN ${v(s.sk)} AND ${v(s.sk2)}`;
      else if (s.skOp === 'begins_with') kc += ` AND begins_with(${n}, ${v(s.sk)})`;
      else kc += ` AND ${n} ${s.skOp} ${v(s.sk)}`;
    }
    input.KeyConditionExpression = kc;
    if (!s.forward) input.ScanIndexForward = false;
  }
  const filter = buildCondition(s.filters, ctx);
  if (filter) input.FilterExpression = filter;
  const proj = buildProjection(s.projection, ctx);
  if (proj) input.ProjectionExpression = proj;
  if (includeLimit && Number(s.limit) > 0) input.Limit = Number(s.limit);
  if (s.consistent) input.ConsistentRead = true;
  ctx.apply(input);
  return { op: s.mode === 'query' ? 'Query' : 'Scan', input };
}

export default function QueryScanForm({ desc, state: s, setState, compact }) {
  const set = (patch) => setState({ ...s, ...patch });
  const idx = indexesOf(desc);
  const k = keysOf(desc, s.index);
  const isGsi = idx.find((i) => i.IndexName === s.index)?.kind === 'GSI';
  return (
    <div className="qs-form">
      <div className="qs-top">
        <div className="seg">
          {['scan', 'query'].map((m) => (
            <button key={m} className={s.mode === m ? 'active' : ''} onClick={() => set({ mode: m })}>
              {m === 'scan' ? 'Scan' : 'Query'}
            </button>
          ))}
        </div>
        <Select
          value={s.index}
          onChange={(v) => set({ index: v, consistent: false })}
          options={[['', `Table: ${desc.TableName}`], ...idx.map((i) => [i.IndexName, `${i.kind}: ${i.IndexName}`])]}
        />
        <label className="check">
          <input type="checkbox" checked={s.consistent} disabled={isGsi} onChange={(e) => set({ consistent: e.target.checked })} /> Strongly consistent
        </label>
        {s.mode === 'query' && (
          <label className="check">
            <input type="checkbox" checked={!s.forward} onChange={(e) => set({ forward: !e.target.checked })} /> Descending
          </label>
        )}
      </div>

      {s.mode === 'query' && (
        <div className="builder">
          <div className="builder-row">
            <span className="join-label">Partition</span>
            <span className="key-name">{k.pk} <span className="badge">{k.pkType}</span></span>
            <span className="op-static">=</span>
            <input value={s.pk} placeholder="value" onChange={(e) => set({ pk: e.target.value })} />
          </div>
          {k.sk && (
            <div className="builder-row">
              <span className="join-label">Sort</span>
              <span className="key-name">{k.sk} <span className="badge">{k.skType}</span></span>
              <Select value={s.skOp} onChange={(v) => set({ skOp: v })} options={SK_OPS} />
              <input value={s.sk} placeholder="value (optional)" onChange={(e) => set({ sk: e.target.value })} />
              {s.skOp === 'between' && <input value={s.sk2} placeholder="and" onChange={(e) => set({ sk2: e.target.value })} />}
            </div>
          )}
        </div>
      )}

      <ConditionRows rows={s.filters} onChange={(filters) => set({ filters })} title="Filter" />

      <div className={compact ? 'grid-2' : 'qs-extra'}>
        <label className="field">
          <span className="field-label">Projection (attributes, comma-separated)</span>
          <input value={s.projection} placeholder="all attributes" onChange={(e) => set({ projection: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Page size (Limit)</span>
          <input type="number" min="1" value={s.limit} onChange={(e) => set({ limit: e.target.value })} />
        </label>
      </div>
    </div>
  );
}
