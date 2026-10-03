import React, { useMemo, useState } from 'react';
import { avType, columnsOf, displayValue, itemToPlain, stableKey } from '../lib/dynamo.js';
import { Empty } from './ui.jsx';

// items: AttributeValue maps. keyNames: primary key (row identity). firstCols: columns pinned first.
export default function ResultsGrid({ items, keyNames = [], firstCols, selected, onSelect, onOpen, onRowAction, view = 'table' }) {
  const [sort, setSort] = useState(null);
  const cols = useMemo(() => columnsOf(items, firstCols || keyNames), [items, firstCols, keyNames]);
  const rows = useMemo(() => {
    if (!sort) return items;
    const val = (it) => {
      const av = it[sort.col];
      if (!av) return null;
      return avType(av) === 'N' ? Number(av.N) : displayValue(av, 1000);
    };
    return [...items].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * (sort.dir === 'asc' ? 1 : -1);
    });
  }, [items, sort]);

  if (!items.length) return <Empty>No items</Empty>;

  if (view === 'json' || view === 'ddbjson') {
    return <pre className="code results-json">{JSON.stringify(view === 'json' ? items.map(itemToPlain) : items, null, 2)}</pre>;
  }

  const allSelected = selected && items.length > 0 && items.every((it) => selected.has(stableKey(it, keyNames)));
  const toggleAll = () => {
    const next = new Set(selected);
    for (const it of items) {
      const k = stableKey(it, keyNames);
      if (allSelected) next.delete(k);
      else next.add(k);
    }
    onSelect(next);
  };

  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            {selected && (
              <th className="check-col">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
            )}
            {cols.map((c) => (
              <th
                key={c}
                onClick={() => setSort((s) => (s?.col === c ? (s.dir === 'asc' ? { col: c, dir: 'desc' } : null) : { col: c, dir: 'asc' }))}
                className={keyNames.includes(c) ? 'key-col' : ''}
              >
                {c}
                {sort?.col === c && (sort.dir === 'asc' ? ' ▲' : ' ▼')}
              </th>
            ))}
            {onRowAction && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((it, i) => {
            const k = stableKey(it, keyNames);
            return (
              <tr key={`${k}:${i}`} className={selected?.has(k) ? 'selected' : ''} onDoubleClick={() => onOpen?.(it)}>
                {selected && (
                  <td className="check-col">
                    <input
                      type="checkbox"
                      checked={selected.has(k)}
                      onChange={() => {
                        const next = new Set(selected);
                        if (next.has(k)) next.delete(k);
                        else next.add(k);
                        onSelect(next);
                      }}
                    />
                  </td>
                )}
                {cols.map((c, ci) => {
                  const av = it[c];
                  const t = avType(av);
                  return (
                    <td key={c} className={`t-${t || 'none'}`} title={av ? `${t}: ${displayValue(av, 2000)}` : ''}>
                      {ci === 0 && onOpen ? (
                        <button className="link" onClick={() => onOpen(it)}>{av ? displayValue(av, 80) : '—'}</button>
                      ) : av ? (
                        displayValue(av, 80)
                      ) : (
                        ''
                      )}
                    </td>
                  );
                })}
                {onRowAction && <td className="row-actions">{onRowAction(it)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
