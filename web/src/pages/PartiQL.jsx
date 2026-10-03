import React, { useState } from 'react';
import { ddb, errorText } from '../api.js';
import { useApp } from '../context.js';
import ResultsGrid from '../components/ResultsGrid.jsx';
import { Tabs, Spinner, ErrorBox, CodeBlock, useLocalStorage, download } from '../components/ui.jsx';
import { genCode, CODE_LANGS, itemsToCsv, itemToPlain } from '../lib/dynamo.js';

// Split on semicolons that are outside quotes.
function splitStatements(text) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of text) {
    if (q) {
      if (ch === q) q = null;
    } else if (ch === "'" || ch === '"') q = ch;
    else if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export default function PartiQL() {
  const { tables, info } = useApp();
  const [text, setText] = useLocalStorage('ddbs.partiql.draft', '');
  const [history, setHistory] = useLocalStorage('ddbs.partiql.history', []);
  const [mode, setMode] = useState('single');
  const [consistent, setConsistent] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [view, setView] = useState('table');
  const [codeLang, setCodeLang] = useState(null);

  const buildRequest = () => {
    const stmts = splitStatements(text);
    if (!stmts.length) throw new Error('Enter a statement');
    if (mode === 'single') {
      if (stmts.length > 1) throw new Error('Multiple statements found. Choose "Batch" or "Transaction" mode.');
      return ['ExecuteStatement', { Statement: stmts[0], ...(consistent ? { ConsistentRead: true } : {}) }];
    }
    if (mode === 'transaction') return ['ExecuteTransaction', { TransactStatements: stmts.map((Statement) => ({ Statement })) }];
    return ['BatchExecuteStatement', { Statements: stmts.map((Statement) => ({ Statement, ...(consistent ? { ConsistentRead: true } : {}) })) }];
  };

  const run = async (nextToken) => {
    let op, input;
    try {
      [op, input] = buildRequest();
    } catch (e) {
      return setResult({ error: e.message });
    }
    setRunning(true);
    try {
      const out = await ddb(op, nextToken ? { ...input, NextToken: nextToken } : input);
      setResult((prev) => ({
        op,
        out,
        input,
        ms: out.$elapsed,
        items: nextToken && prev?.items ? [...prev.items, ...(out.Items || [])] : out.Items || null,
      }));
      if (!nextToken) setHistory((h) => [{ text, mode, at: Date.now() }, ...h.filter((x) => x.text !== text)].slice(0, 50));
    } catch (e) {
      setResult({ error: errorText(e) });
    } finally {
      setRunning(false);
    }
  };

  let codeInput = null;
  try {
    codeInput = buildRequest();
  } catch {
    /* invalid */
  }

  return (
    <div className="page">
      <div className="page-head"><h2>PartiQL editor</h2></div>
      <div className="partiql-layout">
        <div>
          <div className="card">
            <textarea
              className="mono partiql-input"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              placeholder={`SELECT * FROM "${tables[0] || 'MyTable'}" WHERE pk = 'USER#1'\n\nINSERT INTO "MyTable" VALUE {'pk': 'a', 'sk': 'b', 'n': 1}\nUPDATE "MyTable" SET n = n + 1 WHERE pk = 'a' AND sk = 'b'\nDELETE FROM "MyTable" WHERE pk = 'a' AND sk = 'b'`}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run();
              }}
            />
            <div className="row-gap mt wrap">
              <button className="btn btn-primary" onClick={() => run()} disabled={running}>{running ? <Spinner /> : 'Run ⌘↵'}</button>
              <div className="seg">
                {[['single', 'Single'], ['batch', 'Batch'], ['transaction', 'Transaction']].map(([m, l]) => (
                  <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{l}</button>
                ))}
              </div>
              {mode !== 'transaction' && (
                <label className="check"><input type="checkbox" checked={consistent} onChange={(e) => setConsistent(e.target.checked)} /> Strongly consistent</label>
              )}
              <select value="" onChange={(e) => e.target.value && setCodeLang(e.target.value)}>
                <option value="">Generate code…</option>
                {CODE_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <span className="muted small">Separate multiple statements with ";"</span>
            </div>
          </div>

          {codeLang && codeInput && (
            <div className="card">
              <div className="card-head">
                <h4>{CODE_LANGS.find((c) => c[0] === codeLang)[1]}</h4>
                <button className="icon-btn" onClick={() => setCodeLang(null)}>×</button>
              </div>
              <CodeBlock code={genCode(codeInput[0], codeInput[1], codeLang, info)} />
            </div>
          )}

          {result?.error && <ErrorBox error={result.error} />}
          {result?.out && (
            <div className="card">
              <div className="results-bar">
                <span className="muted small">
                  {result.op} · {result.ms} ms{result.items ? ` · ${result.items.length} items` : ''}
                </span>
                <div className="row-gap">
                  {result.items?.length > 0 && (
                    <>
                      <button className="btn btn-xs" onClick={() => download('partiql.csv', itemsToCsv(result.items), 'text/csv')}>CSV</button>
                      <button className="btn btn-xs" onClick={() => download('partiql.json', JSON.stringify(result.items.map(itemToPlain), null, 2))}>JSON</button>
                    </>
                  )}
                  <Tabs small tabs={[['table', 'Table'], ['json', 'JSON'], ['raw', 'Raw response']]} value={view} onChange={setView} />
                </div>
              </div>
              {view === 'raw' || !result.items ? (
                <CodeBlock code={JSON.stringify(result.out, null, 2)} maxHeight="60vh" />
              ) : (
                <ResultsGrid items={result.items} view={view} />
              )}
              {result.out.NextToken && (
                <div className="center mt">
                  <button className="btn" onClick={() => run(result.out.NextToken)} disabled={running}>Load more</button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="card history">
          <h4>History</h4>
          {!history.length && <div className="muted small">Executed statements appear here.</div>}
          {history.map((h) => (
            <button
              key={h.at}
              className="history-item"
              onClick={() => {
                setText(h.text);
                setMode(h.mode);
              }}
              title={h.text}
            >
              <code>{h.text.length > 120 ? `${h.text.slice(0, 120)}…` : h.text}</code>
              <span className="muted small">{new Date(h.at).toLocaleString()} · {h.mode}</span>
            </button>
          ))}
          {history.length > 0 && <button className="btn btn-xs" onClick={() => setHistory([])}>Clear history</button>}
        </div>
      </div>
    </div>
  );
}
