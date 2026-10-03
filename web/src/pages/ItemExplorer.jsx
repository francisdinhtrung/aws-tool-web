import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ddb, errorText } from '../api.js';
import { useApp } from '../context.js';
import QueryScanForm, { buildQueryScanInput, initialQueryState } from '../components/QueryScanForm.jsx';
import ResultsGrid from '../components/ResultsGrid.jsx';
import ItemEditor from '../components/ItemEditor.jsx';
import { ErrorBox, Spinner, Tabs, CodeBlock, Modal, download, useToast } from '../components/ui.jsx';
import { keysOf, tableKeyNames, stableKey, pickKey, itemToPlain, itemsToCsv, genCode, CODE_LANGS } from '../lib/dynamo.js';
import { batchWrite, deleteRequests } from '../lib/ops.js';

export default function ItemExplorer({ desc }) {
  const { info } = useApp();
  const toast = useToast();
  const keyNames = tableKeyNames(desc);
  const k = keysOf(desc);
  const [qs, setQs] = useState(initialQueryState);
  const [items, setItems] = useState([]);
  const [lastKey, setLastKey] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [editing, setEditing] = useState(null); // {item, isNew}
  const [view, setView] = useState('table');
  const [codeFor, setCodeFor] = useState(null);
  const [codeLang, setCodeLang] = useState('python');
  const lastInput = useRef(null);

  const run = useCallback(
    async (more = false) => {
      setLoading(true);
      setError(null);
      try {
        let op, input;
        if (more && lastInput.current) ({ op, input } = lastInput.current);
        else ({ op, input } = buildQueryScanInput(desc, qs));
        lastInput.current = { op, input };
        const req = { ...input, ReturnConsumedCapacity: 'TOTAL', ...(more && lastKey ? { ExclusiveStartKey: lastKey } : {}) };
        const out = await ddb(op, req);
        setItems((prev) => (more ? [...prev, ...(out.Items || [])] : out.Items || []));
        if (!more) setSelected(new Set());
        setLastKey(out.LastEvaluatedKey || null);
        setStats((s) => ({
          op,
          count: (more ? s?.count || 0 : 0) + (out.Count || 0),
          scanned: (more ? s?.scanned || 0 : 0) + (out.ScannedCount || 0),
          rcu: (more ? s?.rcu || 0 : 0) + (out.ConsumedCapacity?.CapacityUnits || 0),
          ms: out.$elapsed,
        }));
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [desc, qs, lastKey],
  );

  // initial scan
  useEffect(() => {
    run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desc.TableName]);

  const save = async (item, isNew, original) => {
    await ddb('PutItem', {
      TableName: desc.TableName,
      Item: item,
      ...(isNew ? { ConditionExpression: `attribute_not_exists(#pk)`, ExpressionAttributeNames: { '#pk': k.pk } } : {}),
    });
    toast(isNew ? 'Item created' : 'Item saved');
    setEditing(null);
    setItems((prev) => {
      if (isNew) return [item, ...prev];
      const key = stableKey(original, keyNames);
      return prev.map((it) => (stableKey(it, keyNames) === key ? item : it));
    });
  };

  const deleteSelected = async () => {
    const targets = items.filter((it) => selected.has(stableKey(it, keyNames)));
    if (!targets.length) return;
    if (!window.confirm(`Delete ${targets.length} item(s) from ${desc.TableName}? This cannot be undone.`)) return;
    setLoading(true);
    try {
      await batchWrite(desc.TableName, deleteRequests(targets.map((it) => pickKey(it, keyNames))));
      setItems((prev) => prev.filter((it) => !selected.has(stableKey(it, keyNames))));
      setSelected(new Set());
      toast(`Deleted ${targets.length} item(s)`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  const deleteOne = async (it) => {
    if (!window.confirm('Delete this item?')) return;
    try {
      await ddb('DeleteItem', { TableName: desc.TableName, Key: pickKey(it, keyNames) });
      setItems((prev) => prev.filter((x) => stableKey(x, keyNames) !== stableKey(it, keyNames)));
      toast('Item deleted');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const exportResults = (fmt) => {
    const list = selected.size ? items.filter((it) => selected.has(stableKey(it, keyNames))) : items;
    const base = `${desc.TableName}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    if (fmt === 'csv') download(`${base}.csv`, itemsToCsv(list, keyNames), 'text/csv');
    else if (fmt === 'json') download(`${base}.json`, JSON.stringify(list.map(itemToPlain), null, 2));
    else download(`${base}.ddb.json`, JSON.stringify(list, null, 2));
  };

  const showCode = () => {
    try {
      setCodeFor(buildQueryScanInput(desc, qs));
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="explorer">
      <div className="card">
        <QueryScanForm desc={desc} state={qs} setState={setQs} />
        <div className="row-gap mt">
          <button className="btn btn-primary" onClick={() => run(false)} disabled={loading}>
            {loading ? <Spinner /> : qs.mode === 'query' ? 'Run query' : 'Run scan'}
          </button>
          <button className="btn" onClick={() => setQs(initialQueryState())}>Reset</button>
          <button className="btn" onClick={showCode}>Generate code</button>
        </div>
      </div>

      <ErrorBox error={error} onClose={() => setError(null)} />

      <div className="results-bar">
        <div className="row-gap">
          <button className="btn btn-primary btn-sm" onClick={() => setEditing({ item: null, isNew: true })}>+ Create item</button>
          <button className="btn btn-sm btn-danger" disabled={!selected.size} onClick={deleteSelected}>Delete{selected.size ? ` (${selected.size})` : ''}</button>
          <select className="btn-sm" value="" onChange={(e) => e.target.value && exportResults(e.target.value)}>
            <option value="">Export {selected.size ? 'selected' : 'results'}…</option>
            <option value="csv">CSV</option>
            <option value="json">JSON (plain)</option>
            <option value="ddb">DynamoDB JSON</option>
          </select>
        </div>
        <div className="row-gap">
          {stats && (
            <span className="muted small">
              {stats.op}: {stats.count} items{stats.scanned !== stats.count ? ` (scanned ${stats.scanned})` : ''} · {stats.rcu} RCU · {stats.ms} ms
            </span>
          )}
          <Tabs small tabs={[['table', 'Table'], ['json', 'JSON'], ['ddbjson', 'DynamoDB JSON']]} value={view} onChange={setView} />
        </div>
      </div>

      <ResultsGrid
        items={items}
        keyNames={keyNames}
        selected={selected}
        onSelect={setSelected}
        view={view}
        onOpen={(it) => setEditing({ item: it, isNew: false })}
        onRowAction={(it) => (
          <>
            <button className="btn btn-xs" onClick={() => setEditing({ item: it, isNew: true, duplicate: true })}>Duplicate</button>
            <button className="btn btn-xs btn-danger" onClick={() => deleteOne(it)}>Delete</button>
          </>
        )}
      />
      {lastKey && (
        <div className="center mt">
          <button className="btn" onClick={() => run(true)} disabled={loading}>{loading ? <Spinner /> : 'Load more'}</button>
        </div>
      )}

      {editing && (
        <ItemEditor
          title={editing.duplicate ? 'Duplicate item' : undefined}
          item={editing.item}
          isNew={editing.isNew}
          keyNames={keyNames}
          keyTypes={k.types}
          onClose={() => setEditing(null)}
          onSave={(it) => save(it, editing.isNew, editing.item)}
        />
      )}

      {codeFor && (
        <Modal title={`${codeFor.op} code`} size="lg" onClose={() => setCodeFor(null)}>
          <Tabs small tabs={CODE_LANGS} value={codeLang} onChange={setCodeLang} />
          <CodeBlock code={genCode(codeFor.op, codeFor.input, codeLang, info)} maxHeight="60vh" />
        </Modal>
      )}
    </div>
  );
}
