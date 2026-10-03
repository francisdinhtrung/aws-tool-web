import React, { useCallback, useEffect, useState } from 'react';
import { api, ddb, errorText } from '../api.js';
import { useApp, navigate } from '../context.js';
import { Tabs, Spinner, ErrorBox, Field, Select, Modal, useToast, FileButton, readFileText, download, Empty, nextId, CodeBlock } from '../components/ui.jsx';
import TableDefEditor, { emptyDef, normalizeDef, validateDef } from '../components/TableDefEditor.jsx';
import ResultsGrid from '../components/ResultsGrid.jsx';
import ItemEditor from '../components/ItemEditor.jsx';
import Visualizer from '../components/Visualizer.jsx';
import { AV_TYPES, TYPE_LABELS, createTableInput, descToDef, inferNonKeyAttributes, cloudFormation, stableKey, itemsToCsv, csvToItems, parseJsonItems } from '../lib/dynamo.js';
import { describeTable, batchWrite, putRequests, tableExists, waitForActive } from '../lib/ops.js';

const now = () => new Date().toISOString();
const newModel = (name = 'New data model') => ({
  ModelName: name,
  ModelMetadata: { Author: '', DateCreated: now(), DateLastModified: now(), Description: '', AWSService: 'Amazon DynamoDB', Version: '3.0' },
  DataModel: [],
});

// Accept Workbench exports (v2/v3) and bare arrays of table definitions.
function normalizeModel(m) {
  if (Array.isArray(m)) m = { ...newModel('Imported model'), DataModel: m };
  if (!m || !Array.isArray(m.DataModel)) throw new Error('Not a NoSQL Workbench data model (missing "DataModel")');
  m.ModelMetadata = { ...newModel().ModelMetadata, ...(m.ModelMetadata || {}) };
  m.DataModel = m.DataModel.map((t) => ({
    ...t,
    KeyAttributes: t.KeyAttributes || { PartitionKey: { AttributeName: 'pk', AttributeType: 'S' } },
    NonKeyAttributes: t.NonKeyAttributes || [],
    GlobalSecondaryIndexes: t.GlobalSecondaryIndexes || [],
    TableFacets: t.TableFacets || [],
    TableData: t.TableData || [],
    DataAccess: t.DataAccess || { MySql: {} },
    BillingMode: t.BillingMode || 'PROVISIONED',
  }));
  return m;
}

function ModelList() {
  const toast = useToast();
  const [models, setModels] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api('/api/models').then(setModels).catch((e) => setError(errorText(e))), []);
  useEffect(() => {
    load();
  }, [load]);
  const create = async (model) => {
    try {
      const { id } = await api('/api/models', { method: 'POST', body: model });
      navigate(`/modeler/${id}`);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const importFile = async (file) => {
    try {
      const m = normalizeModel(JSON.parse(await readFileText(file)));
      await create(m);
      toast(`Imported ${m.ModelName}`);
    } catch (e) {
      toast(`Import failed: ${e.message}`, 'error');
    }
  };
  return (
    <div className="page">
      <div className="page-head">
        <h2>Data modeler</h2>
        <div className="row-gap">
          <FileButton accept=".json" onFile={importFile} className="btn btn-sm">Import Workbench model…</FileButton>
          <button className="btn btn-primary btn-sm" onClick={() => create(newModel())}>+ New data model</button>
        </div>
      </div>
      <ErrorBox error={error} />
      {!models ? (
        <Spinner />
      ) : !models.length ? (
        <Empty>No data models yet. Create one or import a model exported from NoSQL Workbench.</Empty>
      ) : (
        <div className="feature-grid">
          {models.map((m) => (
            <a key={m.id} className="card feature" href={`#/modeler/${m.id}`}>
              <h4>{m.name}</h4>
              <p>{m.description || <span className="muted">No description</span>}</p>
              <p className="muted small">{m.tables} table(s) · {m.updated ? new Date(m.updated).toLocaleString() : ''}</p>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function AttributesEditor({ def, onChange }) {
  const list = def.NonKeyAttributes || [];
  const set = (l) => onChange({ ...def, NonKeyAttributes: l });
  return (
    <div className="builder">
      {list.map((a, i) => (
        <div className="builder-row" key={i}>
          <input value={a.AttributeName} placeholder="attribute name" onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, AttributeName: e.target.value } : x)))} />
          <Select value={a.AttributeType} onChange={(t) => set(list.map((x, j) => (j === i ? { ...x, AttributeType: t } : x)))} options={AV_TYPES.map((t) => [t, `${t} · ${TYPE_LABELS[t]}`])} />
          <button className="icon-btn" onClick={() => set(list.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="row-gap">
        <button className="btn btn-xs" onClick={() => set([...list, { AttributeName: '', AttributeType: 'S' }])}>+ Add attribute</button>
        <button className="btn btn-xs" onClick={() => set(inferNonKeyAttributes(def))}>Infer from sample data</button>
      </div>
    </div>
  );
}

function FacetsEditor({ def, onChange }) {
  const facets = def.TableFacets || [];
  const set = (l) => onChange({ ...def, TableFacets: l });
  const attrNames = (def.NonKeyAttributes || []).map((a) => a.AttributeName).filter(Boolean);
  return (
    <div>
      <p className="muted small">Facets describe the entity types stored in the table (single-table design), with aliases for the generic key names.</p>
      {facets.map((f, i) => {
        const upd = (patch) => set(facets.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div className="card card-sub" key={i}>
            <div className="card-sub-head">
              <strong>{f.FacetName || 'Facet'}</strong>
              <button className="icon-btn" onClick={() => set(facets.filter((_, j) => j !== i))}>×</button>
            </div>
            <div className="grid-3">
              <Field label="Facet name"><input value={f.FacetName || ''} onChange={(e) => upd({ FacetName: e.target.value })} /></Field>
              <Field label={`Partition key alias (${def.KeyAttributes.PartitionKey.AttributeName})`}>
                <input value={f.KeyAttributeAlias?.PartitionKeyAlias || ''} onChange={(e) => upd({ KeyAttributeAlias: { ...f.KeyAttributeAlias, PartitionKeyAlias: e.target.value } })} />
              </Field>
              {def.KeyAttributes.SortKey?.AttributeName && (
                <Field label={`Sort key alias (${def.KeyAttributes.SortKey.AttributeName})`}>
                  <input value={f.KeyAttributeAlias?.SortKeyAlias || ''} onChange={(e) => upd({ KeyAttributeAlias: { ...f.KeyAttributeAlias, SortKeyAlias: e.target.value } })} />
                </Field>
              )}
            </div>
            <div className="field-label">Attributes in this facet</div>
            <div className="chips">
              {attrNames.map((a) => (
                <label key={a} className="check chip-check">
                  <input
                    type="checkbox"
                    checked={(f.NonKeyAttributes || []).includes(a)}
                    onChange={(e) => upd({ NonKeyAttributes: e.target.checked ? [...(f.NonKeyAttributes || []), a] : (f.NonKeyAttributes || []).filter((x) => x !== a) })}
                  />
                  {a}
                </label>
              ))}
              {!attrNames.length && <span className="muted small">Define non-key attributes first.</span>}
            </div>
          </div>
        );
      })}
      <button
        className="btn btn-sm"
        onClick={() => set([...facets, { FacetName: `Facet${facets.length + 1}`, KeyAttributeAlias: { PartitionKeyAlias: '', SortKeyAlias: '' }, TableData: [], NonKeyAttributes: [], DataAccess: { MySql: {} } }])}
      >
        + Add facet
      </button>
    </div>
  );
}

function SampleData({ def, onChange }) {
  const toast = useToast();
  const keyNames = [def.KeyAttributes.PartitionKey.AttributeName, def.KeyAttributes.SortKey?.AttributeName].filter(Boolean);
  const keyTypes = Object.fromEntries([def.KeyAttributes.PartitionKey, def.KeyAttributes.SortKey].filter((k) => k?.AttributeName).map((k) => [k.AttributeName, k.AttributeType]));
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const data = def.TableData || [];

  const save = async (item, original) => {
    const k = stableKey(item, keyNames);
    const clash = data.some((it) => stableKey(it, keyNames) === k && it !== original);
    if (clash) throw new Error('An item with this primary key already exists in the sample data');
    onChange({ ...def, TableData: original ? data.map((it) => (it === original ? item : it)) : [...data, item] });
    setEditing(null);
  };
  const addFile = async (file) => {
    try {
      const text = await readFileText(file);
      const items = /\.csv$/i.test(file.name) ? csvToItems(text) : parseJsonItems(text);
      onChange({ ...def, TableData: [...data, ...items] });
      toast(`Added ${items.length} items`);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return (
    <div>
      <div className="row-gap mb">
        <button className="btn btn-primary btn-sm" onClick={() => setEditing({ item: null })}>+ Add item</button>
        <FileButton accept=".json,.csv,.jsonl" onFile={addFile} className="btn btn-sm">Import CSV / JSON…</FileButton>
        <button className="btn btn-sm" disabled={!data.length} onClick={() => download(`${def.TableName}.csv`, itemsToCsv(data, keyNames), 'text/csv')}>Export CSV</button>
        <button
          className="btn btn-sm btn-danger"
          disabled={!selected.size}
          onClick={() => {
            onChange({ ...def, TableData: data.filter((it) => !selected.has(stableKey(it, keyNames))) });
            setSelected(new Set());
          }}
        >
          Delete{selected.size ? ` (${selected.size})` : ''}
        </button>
        <span className="muted small">{data.length} items</span>
      </div>
      <ResultsGrid items={data} keyNames={keyNames} selected={selected} onSelect={setSelected} onOpen={(it) => setEditing({ item: it })} />
      {editing && (
        <ItemEditor
          item={editing.item}
          isNew={!editing.item}
          keyNames={keyNames}
          keyTypes={keyTypes}
          onClose={() => setEditing(null)}
          onSave={(it) => save(it, editing.item)}
        />
      )}
    </div>
  );
}

function CommitModal({ model, onClose }) {
  const { conn, info, reloadTables } = useApp();
  const [sel, setSel] = useState(() => Object.fromEntries(model.DataModel.map((t) => [t.TableName, { create: true, data: true }])));
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const add = (line, kind = '') => setLog((l) => [...l, { line, kind, id: nextId() }]);

  const run = async () => {
    setBusy(true);
    setLog([]);
    for (const raw of model.DataModel) {
      const s = sel[raw.TableName];
      if (!s || (!s.create && !s.data)) continue;
      const def = normalizeDef(raw);
      try {
        const err = validateDef(def);
        if (err) throw new Error(err);
        const exists = await tableExists(def.TableName);
        if (s.create) {
          if (exists) add(`${def.TableName}: already exists, skipping creation`, 'warn');
          else {
            add(`${def.TableName}: creating table…`);
            await ddb('CreateTable', createTableInput(def));
            await waitForActive(def.TableName);
            add(`${def.TableName}: ACTIVE`, 'ok');
          }
        } else if (!exists) throw new Error('table does not exist');
        if (s.data && def.TableData?.length) {
          add(`${def.TableName}: writing ${def.TableData.length} items…`);
          await batchWrite(def.TableName, putRequests(def.TableData));
          add(`${def.TableName}: ${def.TableData.length} items written`, 'ok');
        }
      } catch (e) {
        add(`${def.TableName}: ${errorText(e)}`, 'bad');
      }
    }
    add('Done.', 'ok');
    reloadTables();
    setBusy(false);
  };

  return (
    <Modal title="Commit data model to DynamoDB" size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" disabled={busy || !conn} onClick={run}>{busy ? <Spinner /> : 'Commit'}</button></>}>
      {!conn ? (
        <div className="alert alert-error">Select a connection in the top bar first.</div>
      ) : (
        <p>Target: <strong>{info.label}</strong> {info.endpoint ? `(${info.endpoint})` : `(${info.region})`}</p>
      )}
      <table className="grid grid-plain">
        <thead><tr><th>Table</th><th>Create table</th><th>Write sample data</th></tr></thead>
        <tbody>
          {model.DataModel.map((t) => (
            <tr key={t.TableName}>
              <td>{t.TableName}</td>
              <td><input type="checkbox" checked={sel[t.TableName]?.create} onChange={(e) => setSel({ ...sel, [t.TableName]: { ...sel[t.TableName], create: e.target.checked } })} /></td>
              <td><input type="checkbox" checked={sel[t.TableName]?.data} onChange={(e) => setSel({ ...sel, [t.TableName]: { ...sel[t.TableName], data: e.target.checked } })} /> {t.TableData?.length || 0} items</td>
            </tr>
          ))}
        </tbody>
      </table>
      {log.length > 0 && (
        <pre className="code log">
          {log.map((l) => <div key={l.id} className={`log-${l.kind}`}>{l.line}</div>)}
        </pre>
      )}
    </Modal>
  );
}

function ImportFromDynamo({ onImport, onClose }) {
  const { conn, tables } = useApp();
  const [sel, setSel] = useState(new Set());
  const [sample, setSample] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const defs = [];
      for (const name of sel) {
        const def = descToDef(await describeTable(name, { force: true }));
        if (sample > 0) {
          const out = await ddb('Scan', { TableName: name, Limit: Number(sample) });
          def.TableData = out.Items || [];
        }
        def.NonKeyAttributes = inferNonKeyAttributes(def);
        def.TableFacets = [];
        defs.push(def);
      }
      onImport(defs);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Import tables from DynamoDB" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !sel.size} onClick={run}>{busy ? <Spinner /> : `Import ${sel.size} table(s)`}</button></>}>
      {!conn && <div className="alert alert-error">Select a connection first.</div>}
      <ErrorBox error={error} />
      <Field label="Sample items per table"><input type="number" min="0" max="1000" value={sample} onChange={(e) => setSample(e.target.value)} /></Field>
      <div className="check-list">
        {tables.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={sel.has(t)} onChange={() => { const n = new Set(sel); if (n.has(t)) n.delete(t); else n.add(t); setSel(n); }} /> {t}
          </label>
        ))}
        {!tables.length && <span className="muted">No tables in the current connection.</span>}
      </div>
    </Modal>
  );
}

function ModelEditor({ id }) {
  const toast = useToast();
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [tableIdx, setTableIdx] = useState(0);
  const [tab, setTab] = useState('schema');
  const [modal, setModal] = useState(null);

  useEffect(() => {
    api(`/api/models/${id}`)
      .then((m) => setModel(normalizeModel(m)))
      .catch((e) => setError(errorText(e)));
  }, [id]);

  const update = (m) => {
    setModel(m);
    setDirty(true);
  };
  const save = useCallback(async () => {
    const m = { ...model, ModelMetadata: { ...model.ModelMetadata, DateLastModified: now() } };
    try {
      await api(`/api/models/${id}`, { method: 'PUT', body: m });
      setModel(m);
      setDirty(false);
      toast('Model saved');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }, [model, id, toast]);

  useEffect(() => {
    const f = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirty) save();
      }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [dirty, save]);

  useEffect(() => {
    const f = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [dirty]);

  if (error) return <div className="page"><ErrorBox error={error} /><a href="#/modeler">← Back</a></div>;
  if (!model) return <div className="page"><Spinner /></div>;

  const def = model.DataModel[tableIdx];
  const setDef = (d) => update({ ...model, DataModel: model.DataModel.map((t, i) => (i === tableIdx ? d : t)) });
  const addTable = (d) => {
    update({ ...model, DataModel: [...model.DataModel, d] });
    setTableIdx(model.DataModel.length);
    setTab('schema');
  };
  const removeTable = () => {
    if (!window.confirm(`Remove table ${def.TableName} from the model?`)) return;
    update({ ...model, DataModel: model.DataModel.filter((_, i) => i !== tableIdx) });
    setTableIdx(0);
  };
  const delModel = async () => {
    if (!window.confirm(`Delete data model "${model.ModelName}"?`)) return;
    await api(`/api/models/${id}`, { method: 'DELETE' });
    navigate('/modeler');
  };
  const exportName = (model.ModelName || 'model').replace(/[^\w.-]+/g, '_');
  const defError = def && validateDef(normalizeDef(def));

  return (
    <div className="page">
      <div className="page-head">
        <a href="#/modeler" className="muted">← Models</a>
        <input className="title-input" value={model.ModelName} onChange={(e) => update({ ...model, ModelName: e.target.value })} />
        {dirty && <span className="badge badge-warn">unsaved</span>}
        <div className="row-gap push-right wrap">
          <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty}>Save ⌘S</button>
          <select
            className="btn-sm"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'json') download(`${exportName}.json`, JSON.stringify(model, null, 2));
              if (v === 'cfn') download(`${exportName}.cfn.json`, JSON.stringify(cloudFormation(model), null, 2));
              if (v === 'cfnview') setModal('cfn');
            }}
          >
            <option value="">Export…</option>
            <option value="json">NoSQL Workbench model (.json)</option>
            <option value="cfn">CloudFormation template (.json)</option>
            <option value="cfnview">View CloudFormation</option>
          </select>
          <button className="btn btn-sm" onClick={() => setModal('import')}>Import from DynamoDB</button>
          <button className="btn btn-sm" onClick={() => setModal('commit')} disabled={!model.DataModel.length}>Commit to DynamoDB</button>
          <button className="btn btn-sm btn-danger" onClick={delModel}>Delete model</button>
        </div>
      </div>
      <Field label="Description">
        <input value={model.ModelMetadata.Description || ''} onChange={(e) => update({ ...model, ModelMetadata: { ...model.ModelMetadata, Description: e.target.value } })} />
      </Field>

      <div className="modeler-layout">
        <div className="card modeler-tables">
          <div className="ops-group">Tables</div>
          {model.DataModel.map((t, i) => (
            <button key={i} className={i === tableIdx ? 'active' : ''} onClick={() => setTableIdx(i)}>
              {t.TableName || '(unnamed)'}
              <span className="muted small"> · {t.TableData?.length || 0}</span>
            </button>
          ))}
          <button className="btn btn-sm mt" onClick={() => addTable({ ...emptyDef(), TableName: `Table${model.DataModel.length + 1}`, TableFacets: [] })}>+ Add table</button>
        </div>
        <div className="modeler-main">
          {!def ? (
            <Empty>Add a table to start modeling.</Empty>
          ) : (
            <>
              <Tabs tabs={[['schema', 'Schema'], ['facets', `Facets (${def.TableFacets?.length || 0})`], ['data', `Sample data (${def.TableData?.length || 0})`], ['viz', 'Visualizer']]} value={tab} onChange={setTab} />
              <div className="card">
                {defError && tab === 'schema' && <div className="alert alert-warn">{defError}</div>}
                {tab === 'schema' && (
                  <>
                    <TableDefEditor def={def} onChange={setDef} />
                    <h4>Non-key attributes</h4>
                    <AttributesEditor def={def} onChange={setDef} />
                    <div className="danger-zone">
                      <button className="btn btn-sm btn-danger" onClick={removeTable}>Remove table from model</button>
                    </div>
                  </>
                )}
                {tab === 'facets' && <FacetsEditor def={def} onChange={setDef} />}
                {tab === 'data' && <SampleData def={def} onChange={setDef} />}
                {tab === 'viz' && (
                  <Visualizer
                    pk={def.KeyAttributes.PartitionKey.AttributeName}
                    sk={def.KeyAttributes.SortKey?.AttributeName}
                    items={def.TableData || []}
                    gsis={(def.GlobalSecondaryIndexes || []).filter((g) => g.KeyAttributes?.PartitionKey?.AttributeName)}
                    facets={def.TableFacets || []}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {modal === 'commit' && <CommitModal model={model} onClose={() => setModal(null)} />}
      {modal === 'import' && (
        <ImportFromDynamo
          onClose={() => setModal(null)}
          onImport={(defs) => {
            update({ ...model, DataModel: [...model.DataModel, ...defs] });
            setModal(null);
            toast(`Imported ${defs.length} table(s)`);
          }}
        />
      )}
      {modal === 'cfn' && (
        <Modal title="CloudFormation template" size="lg" onClose={() => setModal(null)}>
          <CodeBlock code={JSON.stringify(cloudFormation(model), null, 2)} maxHeight="65vh" />
        </Modal>
      )}
    </div>
  );
}

export default function Modeler({ id }) {
  return id ? <ModelEditor key={id} id={id} /> : <ModelList />;
}
