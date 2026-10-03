import React, { useEffect, useMemo, useState } from 'react';
import { ddb, errorText } from '../api.js';
import { useApp } from '../context.js';
import { Select, Field, Tabs, CodeBlock, ErrorBox, Spinner, JsonArea, nextId } from '../components/ui.jsx';
import { AttributeRows, ConditionRows, UpdateRows, KeyInputs, keyFromInputs, itemToRows, rowsToItem, newUpdateRow } from '../components/builders.jsx';
import QueryScanForm, { buildQueryScanInput, initialQueryState } from '../components/QueryScanForm.jsx';
import ResultsGrid from '../components/ResultsGrid.jsx';
import { ExprCtx, buildCondition, buildUpdate, buildProjection, keysOf, tableKeyNames, genCode, CODE_LANGS, VALUE_TYPES, TYPE_LABELS, toAV } from '../lib/dynamo.js';
import { describeTable } from '../lib/ops.js';

const GROUPS = [
  ['Item operations', ['GetItem', 'PutItem', 'UpdateItem', 'DeleteItem']],
  ['Read', ['Query', 'Scan']],
  ['Batch', ['BatchGetItem', 'BatchWriteItem']],
  ['Transactions', ['TransactGetItems', 'TransactWriteItems']],
  ['PartiQL', ['ExecuteStatement', 'BatchExecuteStatement', 'ExecuteTransaction']],
];

function useDesc(table) {
  const [desc, setDesc] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    setDesc(null);
    setError(null);
    if (table) {
      describeTable(table)
        .then((d) => live && setDesc(d))
        .catch((e) => live && setError(errorText(e)));
    }
    return () => {
      live = false;
    };
  }, [table]);
  return [desc, error];
}

const newSingle = (op) => ({ op, table: '', key: {}, rows: [], updates: op === 'Update' ? [newUpdateRow()] : [], conds: [], projection: '', consistent: false, returnValues: 'NONE' });

function buildSingle(s, desc, nested) {
  if (!s.table) throw new Error('Select a table');
  if (!desc) throw new Error('Loading table…');
  const keys = keysOf(desc);
  const ctx = new ExprCtx();
  const input = nested === 'batch' ? {} : { TableName: s.table };
  if (s.op === 'Put') input.Item = rowsToItem(s.rows);
  else input.Key = keyFromInputs(keys, s.key);
  if (s.op === 'Put') {
    for (const k of tableKeyNames(desc)) {
      const v = input.Item[k];
      if (!v || Object.values(v)[0] === '') throw new Error(`Key attribute "${k}" is required`);
    }
  }
  if (s.op === 'Get') {
    const p = buildProjection(s.projection, ctx);
    if (p) input.ProjectionExpression = p;
    if (s.consistent && !nested) input.ConsistentRead = true;
  }
  if (s.op === 'Update') {
    const u = buildUpdate(s.updates, ctx);
    if (!u) throw new Error('Add at least one update action');
    input.UpdateExpression = u;
  }
  if (['Put', 'Update', 'Delete', 'ConditionCheck'].includes(s.op) && nested !== 'batch') {
    const c = buildCondition(s.conds, ctx);
    if (c) input.ConditionExpression = c;
    else if (s.op === 'ConditionCheck') throw new Error('ConditionCheck requires a condition');
  }
  if (!nested && ['Put', 'Update', 'Delete'].includes(s.op) && s.returnValues !== 'NONE') input.ReturnValues = s.returnValues;
  if (nested === 'transact' && s.returnValues === 'ALL_OLD' && s.op !== 'Get') input.ReturnValuesOnConditionCheckFailure = 'ALL_OLD';
  return ctx.apply(input);
}

function SingleForm({ s, setS, tables, nested, onInput, ops }) {
  const [desc, descError] = useDesc(s.table);
  const keys = keysOf(desc);
  const result = useMemo(() => {
    try {
      return { input: buildSingle(s, desc, nested) };
    } catch (e) {
      return { error: e.message };
    }
  }, [s, desc, nested]);
  useEffect(() => onInput(result), [result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialise item rows with the key attributes when the table changes.
  useEffect(() => {
    if (desc && s.op === 'Put' && !s.rows.length) setS({ ...s, rows: itemToRows(null, tableKeyNames(desc), keys.types) });
  }, [desc, s.op]); // eslint-disable-line react-hooks/exhaustive-deps

  const retOpts = s.op === 'Update' ? ['NONE', 'ALL_OLD', 'UPDATED_OLD', 'ALL_NEW', 'UPDATED_NEW'] : ['NONE', 'ALL_OLD'];
  return (
    <div className="single-form">
      <div className="grid-2">
        {ops && (
          <Field label="Action">
            <Select value={s.op} onChange={(op) => setS({ ...newSingle(op), table: s.table, key: s.key })} options={ops} />
          </Field>
        )}
        <Field label="Table">
          <Select value={s.table} onChange={(table) => setS({ ...s, table, key: {}, rows: [] })} options={[['', '— select table —'], ...tables]} />
        </Field>
      </div>
      <ErrorBox error={descError} />
      {desc && s.op !== 'Put' && <KeyInputs keys={keys} value={s.key} onChange={(key) => setS({ ...s, key })} />}
      {desc && s.op === 'Put' && <AttributeRows rows={s.rows} onChange={(rows) => setS({ ...s, rows })} />}
      {desc && s.op === 'Update' && (
        <>
          <h5>Update expression</h5>
          <UpdateRows rows={s.updates} onChange={(updates) => setS({ ...s, updates })} />
        </>
      )}
      {desc && ['Put', 'Update', 'Delete', 'ConditionCheck'].includes(s.op) && nested !== 'batch' && (
        <ConditionRows rows={s.conds} onChange={(conds) => setS({ ...s, conds })} title="Condition" />
      )}
      {desc && s.op === 'Get' && nested !== 'batch' && (
        <div className="grid-2">
          <Field label="Projection (comma-separated)"><input value={s.projection} onChange={(e) => setS({ ...s, projection: e.target.value })} placeholder="all attributes" /></Field>
          {!nested && <label className="check check-field"><input type="checkbox" checked={s.consistent} onChange={(e) => setS({ ...s, consistent: e.target.checked })} /> Strongly consistent read</label>}
        </div>
      )}
      {desc && !nested && ['Put', 'Update', 'Delete'].includes(s.op) && (
        <Field label="Return values"><Select value={s.returnValues} onChange={(returnValues) => setS({ ...s, returnValues })} options={retOpts} /></Field>
      )}
      {desc && nested === 'transact' && s.op !== 'Get' && (
        <label className="check"><input type="checkbox" checked={s.returnValues === 'ALL_OLD'} onChange={(e) => setS({ ...s, returnValues: e.target.checked ? 'ALL_OLD' : 'NONE' })} /> Return item on condition failure</label>
      )}
    </div>
  );
}

function QueryForm({ s, setS, tables, onInput }) {
  const [desc, descError] = useDesc(s.table);
  const result = useMemo(() => {
    if (!s.table) return { error: 'Select a table' };
    if (!desc) return { error: 'Loading table…' };
    try {
      return { input: buildQueryScanInput(desc, s).input };
    } catch (e) {
      return { error: e.message };
    }
  }, [s, desc]);
  useEffect(() => onInput(result), [result]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Field label="Table">
        <Select value={s.table} onChange={(table) => setS({ ...initialQueryState(), mode: s.mode, table })} options={[['', '— select table —'], ...tables]} />
      </Field>
      <ErrorBox error={descError} />
      {desc && <QueryScanForm desc={desc} state={s} setState={setS} compact />}
    </>
  );
}

const MULTI = {
  BatchGetItem: { ops: [['Get', 'Get']], nested: 'batch', max: 100 },
  BatchWriteItem: { ops: [['Put', 'Put request'], ['Delete', 'Delete request']], nested: 'batch', max: 25 },
  TransactGetItems: { ops: [['Get', 'Get']], nested: 'transact', max: 100 },
  TransactWriteItems: { ops: [['Put', 'Put'], ['Update', 'Update'], ['Delete', 'Delete'], ['ConditionCheck', 'Condition check']], nested: 'transact', max: 100 },
};

function MultiForm({ op, list, setList, tables, onInput }) {
  const cfg = MULTI[op];
  const [inputs, setInputs] = useState({});
  useEffect(() => {
    const errs = list.map((s, i) => (inputs[s.id]?.error ? `#${i + 1}: ${inputs[s.id].error}` : null)).filter(Boolean);
    if (!list.length) return onInput({ error: 'Add at least one action' });
    if (errs.length || list.some((s) => !inputs[s.id])) return onInput({ error: errs.join('\n') || 'Loading…' });
    const parts = list.map((s) => ({ s, input: inputs[s.id].input }));
    let input;
    if (op === 'TransactWriteItems' || op === 'TransactGetItems') {
      input = { TransactItems: parts.map(({ s, input: x }) => ({ [s.op]: x })) };
    } else if (op === 'BatchGetItem') {
      const RequestItems = {};
      for (const { s, input: x } of parts) {
        RequestItems[s.table] = RequestItems[s.table] || { Keys: [] };
        RequestItems[s.table].Keys.push(x.Key);
      }
      input = { RequestItems };
    } else {
      const RequestItems = {};
      for (const { s, input: x } of parts) {
        RequestItems[s.table] = RequestItems[s.table] || [];
        RequestItems[s.table].push(s.op === 'Put' ? { PutRequest: { Item: x.Item } } : { DeleteRequest: { Key: x.Key } });
      }
      input = { RequestItems };
    }
    onInput({ input });
  }, [inputs, list, op]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => setList([...list, { ...newSingle(cfg.ops[0][0]), id: nextId(), table: list[list.length - 1]?.table || '' }]);
  return (
    <div>
      {list.map((s, i) => (
        <div className="card card-sub" key={s.id}>
          <div className="card-sub-head">
            <strong>Action #{i + 1}</strong>
            <button className="icon-btn" onClick={() => setList(list.filter((x) => x.id !== s.id))}>×</button>
          </div>
          <SingleForm
            s={s}
            setS={(n) => setList(list.map((x) => (x.id === s.id ? { ...n, id: s.id } : x)))}
            tables={tables}
            nested={cfg.nested}
            ops={cfg.ops.length > 1 ? cfg.ops : null}
            onInput={(r) => setInputs((p) => ({ ...p, [s.id]: r }))}
          />
        </div>
      ))}
      <button className="btn btn-sm" onClick={add} disabled={list.length >= cfg.max}>+ Add action</button>
      <span className="muted small"> max {cfg.max}</span>
    </div>
  );
}

function PartiqlForm({ op, s, setS, onInput }) {
  useEffect(() => {
    try {
      const params = (p) => (p || []).filter((x) => x.type).map((x) => toAV(x.type, x.value));
      if (op === 'ExecuteStatement') {
        if (!s.statements[0]?.text.trim()) throw new Error('Enter a statement');
        const input = { Statement: s.statements[0].text.trim() };
        const p = params(s.statements[0].params);
        if (p.length) input.Parameters = p;
        if (s.consistent) input.ConsistentRead = true;
        if (Number(s.limit) > 0) input.Limit = Number(s.limit);
        return onInput({ input });
      }
      const list = s.statements.filter((x) => x.text.trim()).map((x) => {
        const o = { Statement: x.text.trim() };
        const p = params(x.params);
        if (p.length) o.Parameters = p;
        return o;
      });
      if (!list.length) throw new Error('Enter at least one statement');
      onInput({ input: op === 'ExecuteTransaction' ? { TransactStatements: list } : { Statements: list } });
    } catch (e) {
      onInput({ error: e.message });
    }
  }, [s, op]); // eslint-disable-line react-hooks/exhaustive-deps
  const statements = op === 'ExecuteStatement' ? s.statements.slice(0, 1) : s.statements;
  const setStmt = (i, patch) => setS({ ...s, statements: s.statements.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div>
      {statements.map((st, i) => (
        <div className="card card-sub" key={st.id}>
          {op !== 'ExecuteStatement' && (
            <div className="card-sub-head">
              <strong>Statement #{i + 1}</strong>
              <button className="icon-btn" onClick={() => setS({ ...s, statements: s.statements.filter((_, j) => j !== i) })}>×</button>
            </div>
          )}
          <textarea className="mono" rows={4} value={st.text} onChange={(e) => setStmt(i, { text: e.target.value })} placeholder={`SELECT * FROM "MyTable" WHERE pk = ?`} spellCheck={false} />
          <div className="builder">
            {(st.params || []).map((p, j) => (
              <div className="builder-row" key={j}>
                <span className="join-label">? #{j + 1}</span>
                <Select value={p.type} onChange={(type) => setStmt(i, { params: st.params.map((x, k) => (k === j ? { ...x, type } : x)) })} options={VALUE_TYPES.map((t) => [t, TYPE_LABELS[t]])} />
                <input value={p.value} onChange={(e) => setStmt(i, { params: st.params.map((x, k) => (k === j ? { ...x, value: e.target.value } : x)) })} />
                <button className="icon-btn" onClick={() => setStmt(i, { params: st.params.filter((_, k) => k !== j) })}>×</button>
              </div>
            ))}
            <button className="btn btn-xs" onClick={() => setStmt(i, { params: [...(st.params || []), { type: 'S', value: '' }] })}>+ Parameter</button>
          </div>
        </div>
      ))}
      {op !== 'ExecuteStatement' && <button className="btn btn-sm" onClick={() => setS({ ...s, statements: [...s.statements, { id: nextId(), text: '', params: [] }] })}>+ Add statement</button>}
      {op === 'ExecuteStatement' && (
        <div className="grid-2">
          <Field label="Limit"><input type="number" value={s.limit} onChange={(e) => setS({ ...s, limit: e.target.value })} /></Field>
          <label className="check check-field"><input type="checkbox" checked={s.consistent} onChange={(e) => setS({ ...s, consistent: e.target.checked })} /> Strongly consistent</label>
        </div>
      )}
    </div>
  );
}

const SINGLE_MAP = { GetItem: 'Get', PutItem: 'Put', UpdateItem: 'Update', DeleteItem: 'Delete' };
// Stable reference: a fresh [] per render would re-trigger MultiForm's effect forever.
const NO_ACTIONS = [];

export default function OperationBuilder() {
  const { tables, info } = useApp();
  const [op, setOp] = useState('GetItem');
  const [single, setSingle] = useState(() => newSingle('Get'));
  const [qs, setQs] = useState(() => ({ ...initialQueryState(), table: '' }));
  const [multi, setMulti] = useState({});
  const [pq, setPq] = useState({ statements: [{ id: nextId(), text: '', params: [] }], limit: '', consistent: false });
  const [built, setBuilt] = useState({ error: 'Select a table' });
  const [rawMode, setRawMode] = useState(false);
  const [raw, setRaw] = useState('');
  const [tab, setTab] = useState('request');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);

  const pickOp = (o) => {
    setOp(o);
    setRawMode(false);
    setResult(null);
    setBuilt({ error: 'Loading…' });
    if (SINGLE_MAP[o]) setSingle((s) => ({ ...newSingle(SINGLE_MAP[o]), table: s.table }));
    if (o === 'Query' || o === 'Scan') setQs((s) => ({ ...s, mode: o === 'Query' ? 'query' : 'scan' }));
  };

  const finalInput = () => {
    if (rawMode) return JSON.parse(raw);
    if (built.error) throw new Error(built.error);
    return built.input;
  };

  const execute = async () => {
    let input;
    try {
      input = finalInput();
    } catch (e) {
      return setResult({ error: e.message });
    }
    setRunning(true);
    try {
      const out = await ddb(op, input);
      setResult({ out, ms: out.$elapsed });
      setTab('response');
    } catch (e) {
      setResult({ error: errorText(e) });
      setTab('response');
    } finally {
      setRunning(false);
    }
  };

  let preview;
  try {
    preview = JSON.stringify(finalInput(), null, 2);
  } catch (e) {
    preview = `// ${e.message}`;
  }

  const items = result?.out?.Items || (result?.out?.Item ? [result.out.Item] : null) || (result?.out?.Responses && Array.isArray(result.out.Responses) ? result.out.Responses.map((r) => r.Item).filter(Boolean) : null);
  const batchItems = result?.out?.Responses && !Array.isArray(result.out.Responses) ? Object.values(result.out.Responses).flat() : null;

  return (
    <div className="page ops-page">
      <div className="page-head"><h2>Operation builder</h2></div>
      <div className="ops-layout">
        <div className="ops-list card">
          {GROUPS.map(([g, list]) => (
            <div key={g}>
              <div className="ops-group">{g}</div>
              {list.map((o) => (
                <button key={o} className={op === o ? 'active' : ''} onClick={() => pickOp(o)}>{o}</button>
              ))}
            </div>
          ))}
        </div>
        <div className="ops-main">
          <div className="card">
            <div className="card-head">
              <h3>{op}</h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={rawMode}
                  onChange={(e) => {
                    if (e.target.checked) setRaw(preview.startsWith('//') ? '{\n  \n}' : preview);
                    setRawMode(e.target.checked);
                  }}
                />{' '}
                Edit request JSON directly
              </label>
            </div>
            {rawMode ? (
              <JsonArea value={raw} onChange={setRaw} rows={18} />
            ) : SINGLE_MAP[op] ? (
              <SingleForm s={single} setS={setSingle} tables={tables} onInput={setBuilt} />
            ) : op === 'Query' || op === 'Scan' ? (
              <QueryForm s={qs} setS={setQs} tables={tables} onInput={setBuilt} />
            ) : MULTI[op] ? (
              <MultiForm key={op} op={op} list={multi[op] || NO_ACTIONS} setList={(l) => setMulti((m) => ({ ...m, [op]: l }))} tables={tables} onInput={setBuilt} />
            ) : (
              <PartiqlForm op={op} s={pq} setS={setPq} onInput={setBuilt} />
            )}
            <div className="row-gap mt">
              <button className="btn btn-primary" onClick={execute} disabled={running}>{running ? <Spinner /> : 'Run'}</button>
              {!rawMode && built.error && <span className="muted small">{built.error.split('\n')[0]}</span>}
            </div>
          </div>

          <div className="card">
            <Tabs small tabs={[['request', 'Request'], ['response', 'Response'], ...CODE_LANGS]} value={tab} onChange={setTab} />
            {tab === 'request' && <CodeBlock code={preview} maxHeight="50vh" />}
            {tab === 'response' &&
              (!result ? (
                <div className="muted">Run the operation to see the response.</div>
              ) : result.error ? (
                <ErrorBox error={result.error} />
              ) : (
                <>
                  <div className="muted small mb">Completed in {result.ms} ms</div>
                  {(items || batchItems) && <ResultsGrid items={items || batchItems} keyNames={[]} />}
                  <CodeBlock code={JSON.stringify(result.out, null, 2)} maxHeight="50vh" />
                </>
              ))}
            {CODE_LANGS.some(([l]) => l === tab) &&
              (() => {
                try {
                  return <CodeBlock code={genCode(op, finalInput(), tab, info)} maxHeight="50vh" />;
                } catch (e) {
                  return <div className="muted">{e.message}</div>;
                }
              })()}
          </div>
          {result?.out && op === 'GetItem' && !result.out.Item && <div className="muted">Item not found.</div>}
        </div>
      </div>
    </div>
  );
}
