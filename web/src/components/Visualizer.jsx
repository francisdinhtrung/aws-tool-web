import React, { useMemo, useState } from 'react';
import { avType, displayValue } from '../lib/dynamo.js';
import { Select, Empty } from './ui.jsx';

const PALETTE = ['#4c6ef5', '#12b886', '#f76707', '#ae3ec9', '#e64980', '#1098ad', '#82c91e', '#fab005', '#7950f2', '#fa5252'];
const TYPE_ATTRS = ['type', 'Type', 'TYPE', 'entityType', 'EntityType', 'entity', 'Entity', '_type', '__typename', 'kind'];

const keyStr = (av) => (av ? displayValue(av, 500) : '');
const prefixOf = (s) => {
  const m = String(s).match(/^([^#|:]+)[#|:]/);
  return m ? m[1] : String(s);
};

/**
 * Aggregate view, NoSQL Workbench style.
 * pk/sk: table key names. gsis: [{IndexName, KeyAttributes:{PartitionKey:{AttributeName}, SortKey?}}]
 * facets: Workbench facets [{FacetName, KeyAttributeAlias:{PartitionKeyAlias, SortKeyAlias}, NonKeyAttributes:[]}]
 */
export default function Visualizer({ pk, sk, items, gsis = [], facets = [], maxRows = 1000 }) {
  const [view, setView] = useState('');
  const [facetName, setFacetName] = useState('');
  const allAttrs = useMemo(() => {
    const s = new Set();
    items.forEach((it) => Object.keys(it).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [items]);
  const defaultColor = TYPE_ATTRS.find((a) => allAttrs.includes(a)) || 'skprefix';
  const [colorBy, setColorBy] = useState(defaultColor);

  const gsi = gsis.find((g) => g.IndexName === view);
  const keys = gsi ? { pk: gsi.KeyAttributes?.PartitionKey?.AttributeName, sk: gsi.KeyAttributes?.SortKey?.AttributeName } : { pk, sk };
  const facet = !gsi && facets.find((f) => f.FacetName === facetName);

  const groups = useMemo(() => {
    let list = items.filter((it) => it[keys.pk] && (!keys.sk || !gsi || it[keys.sk]));
    if (facet?.NonKeyAttributes?.length) list = list.filter((it) => facet.NonKeyAttributes.every((a) => a in it));
    const map = new Map();
    for (const it of list.slice(0, maxRows)) {
      const k = keyStr(it[keys.pk]);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(it);
    }
    const cmp = (a, b) => {
      const x = a[keys.sk];
      const y = b[keys.sk];
      if (avType(x) === 'N' && avType(y) === 'N') return Number(x.N) - Number(y.N);
      return keyStr(x).localeCompare(keyStr(y));
    };
    return [...map].map(([k, rows]) => [k, keys.sk ? rows.sort(cmp) : rows]).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items, keys.pk, keys.sk, gsi, facet, maxRows]);

  const colors = useMemo(() => {
    const m = new Map();
    return (it) => {
      let v;
      if (colorBy === 'none') return null;
      if (colorBy === 'skprefix') v = prefixOf(keyStr(it[keys.sk || keys.pk]));
      else if (colorBy === 'pkprefix') v = prefixOf(keyStr(it[keys.pk]));
      else v = it[colorBy] ? keyStr(it[colorBy]) : '(none)';
      if (!m.has(v)) m.set(v, PALETTE[m.size % PALETTE.length]);
      return { v, c: m.get(v), map: m };
    };
  }, [colorBy, keys.pk, keys.sk]);

  const attrsFor = (it) => {
    let names = Object.keys(it).filter((k) => k !== keys.pk && k !== keys.sk);
    if (facet?.NonKeyAttributes?.length) names = names.filter((n) => facet.NonKeyAttributes.includes(n));
    return names.sort();
  };

  // Compute colors once for legend
  const legend = new Map();
  groups.forEach(([, rows]) => rows.forEach((it) => {
    const c = colors(it);
    if (c) legend.set(c.v, c.c);
  }));

  const pkLabel = facet?.KeyAttributeAlias?.PartitionKeyAlias || keys.pk;
  const skLabel = facet?.KeyAttributeAlias?.SortKeyAlias || keys.sk;

  return (
    <div className="viz">
      <div className="toolbar">
        <Select value={view} onChange={setView} options={[['', 'Table (aggregate view)'], ...gsis.map((g) => [g.IndexName, `GSI: ${g.IndexName}`])]} />
        {!gsi && facets.length > 0 && (
          <Select value={facetName} onChange={setFacetName} options={[['', 'All facets'], ...facets.map((f) => [f.FacetName, `Facet: ${f.FacetName}`])]} />
        )}
        <span className="muted small">Color by</span>
        <Select
          value={colorBy}
          onChange={setColorBy}
          options={[['skprefix', 'Sort key prefix'], ['pkprefix', 'Partition key prefix'], ['none', 'None'], ...allAttrs.map((a) => [a, `Attribute: ${a}`])]}
        />
        <span className="muted small">
          {groups.length} partitions · {groups.reduce((n, [, r]) => n + r.length, 0)} items
        </span>
      </div>
      {colorBy !== 'none' && legend.size > 0 && legend.size <= 30 && (
        <div className="legend">
          {[...legend].map(([v, c]) => (
            <span key={v}>
              <i style={{ background: c }} />
              {v}
            </span>
          ))}
        </div>
      )}
      {!groups.length ? (
        <Empty>No items {gsi ? 'projected into this index' : ''}</Empty>
      ) : (
        <div className="grid-wrap">
          <table className="viz-table">
            <thead>
              <tr>
                <th colSpan={keys.sk ? 2 : 1} className="viz-pk-head">Primary key</th>
                <th rowSpan={2} className="viz-attr-head">Attributes</th>
              </tr>
              <tr>
                <th className="viz-pk-head">Partition key: {pkLabel}</th>
                {keys.sk && <th className="viz-pk-head">Sort key: {skLabel}</th>}
              </tr>
            </thead>
            <tbody>
              {groups.map(([k, rows]) =>
                rows.map((it, i) => {
                  const c = colors(it);
                  const attrs = attrsFor(it);
                  return (
                    <tr key={`${k}:${i}`} className={i === 0 ? 'viz-group-start' : ''}>
                      {i === 0 && (
                        <td rowSpan={rows.length} className="viz-pk">
                          {k}
                        </td>
                      )}
                      {keys.sk && (
                        <td className="viz-sk" style={c ? { borderLeft: `4px solid ${c.c}` } : undefined}>
                          {keyStr(it[keys.sk])}
                        </td>
                      )}
                      <td className="viz-attrs">
                        <div className="viz-attr-list">
                          {attrs.map((a) => (
                            <div key={a} className="viz-attr">
                              <span className="viz-attr-name">{a}</span>
                              <span className="viz-attr-val" title={displayValue(it[a], 2000)}>{displayValue(it[a], 60)}</span>
                            </div>
                          ))}
                          {!attrs.length && <span className="muted small">—</span>}
                        </div>
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
