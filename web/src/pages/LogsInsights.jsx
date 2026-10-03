import React, { useEffect, useMemo, useRef, useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Spinner, ErrorBox, Tabs, CodeBlock, useToast, copyText, download, useLocalStorage } from '../components/ui.jsx';
import { TimeRangePicker, JsonTree, useUtc, useOutsideClose } from '../components/LogsCommon.jsx';
import { fmtBytes } from '../lib/s3.js';
import {
  logs, listLogGroups, resolveRange, rangeToParams, rangeFromParams, replaceHashQuery, insightsPath, logsGroupPath, QUERY_TEMPLATES,
  insightsTable, chartSpec, queryStatusDone, fmtTime, fmtDuration, parseJsonMessage, toCsv,
} from '../lib/logs.js';

const MAX_GROUPS = 50;
const POLL_MS = 1000;
const DEFAULT_QUERY = QUERY_TEMPLATES[0][1];

const readQuery = () => new URLSearchParams(window.location.hash.split('?')[1] || '');
const isTimeCol = (c) => c === '@timestamp' || c === '@ingestionTime' || /^bin\(/i.test(c);
// Insights returns "2024-05-01 12:00:00.000" (UTC); some emulators return epoch milliseconds.
const parseInsightsTime = (v) => (/^\d{11,}$/.test(String(v)) ? Number(v) : Date.parse(`${String(v).replace(' ', 'T')}Z`));

export default function LogsInsights() {
  const { conn } = useApp();
  const toast = useToast();
  const initial = useMemo(readQuery, []);
  const [utc, setUtc] = useUtc();
  const [draft, setDraft] = useLocalStorage('ddbs.logs.insights.draft', DEFAULT_QUERY);
  const [query, setQuery] = useState(() => initial.get('q') || draft || DEFAULT_QUERY);
  const [groups, setGroups] = useState(() => (initial.get('groups') ? initial.get('groups').split(',').filter(Boolean).slice(0, MAX_GROUPS) : []));
  const [range, setRange] = useState(() => rangeFromParams(initial, { rel: '1h' }));
  const [history, setHistory] = useLocalStorage('ddbs.logs.insights.history', []);
  const [saved, setSaved] = useLocalStorage('ddbs.logs.insights.saved', []);
  const [run, setRun] = useState(null); // { id, status, results, statistics, error, started, window }
  const [view, setView] = useState('table');
  const [fields, setFields] = useState([]);
  const editorRef = useRef();
  const pollRef = useRef(null);
  const runRef = useRef(null);
  runRef.current = run;

  useEffect(() => setDraft(query), [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Field names discovered in the first selected group (click to insert).
  useEffect(() => {
    setFields([]);
    if (!groups.length || !conn) return;
    logs('GetLogGroupFields', { logGroupName: groups[0] })
      .then((o) => setFields((o.logGroupFields || []).sort((a, b) => (b.percent || 0) - (a.percent || 0)).slice(0, 40)))
      .catch(() => {});
  }, [groups[0], conn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop a running query when leaving the page.
  useEffect(
    () => () => {
      clearTimeout(pollRef.current);
      const r = runRef.current;
      if (r?.id && !queryStatusDone(r.status)) logs('StopQuery', { queryId: r.id }).catch(() => {});
    },
    [],
  );

  const poll = (id) => {
    pollRef.current = setTimeout(async () => {
      try {
        const out = await logs('GetQueryResults', { queryId: id });
        setRun((r) => (r?.id === id ? { ...r, status: out.status, results: out.results || [], statistics: out.statistics, ms: Date.now() - r.started } : r));
        if (!queryStatusDone(out.status)) poll(id);
      } catch (e) {
        setRun((r) => (r?.id === id ? { ...r, status: 'Failed', error: errorText(e) } : r));
      }
    }, POLL_MS);
  };

  const start = async () => {
    if (!groups.length) return setRun({ error: 'Select at least one log group.' });
    if (!query.trim()) return setRun({ error: 'Enter a query.' });
    clearTimeout(pollRef.current);
    const prev = runRef.current;
    if (prev?.id && !queryStatusDone(prev.status)) logs('StopQuery', { queryId: prev.id }).catch(() => {});
    const win = resolveRange(range);
    replaceHashQuery(insightsPath(), { groups: groups.join(','), ...rangeToParams(range), q: query });
    setRun({ status: 'Starting', results: [], started: Date.now(), window: win });
    try {
      const out = await logs('StartQuery', {
        logGroupNames: groups,
        startTime: Math.floor(win.startTime / 1000),
        endTime: Math.ceil(win.endTime / 1000),
        queryString: query,
      });
      setRun((r) => ({ ...r, id: out.queryId, status: 'Scheduled' }));
      setHistory((h) => [{ q: query, groups, at: Date.now() }, ...h.filter((x) => x.q !== query)].slice(0, 40));
      poll(out.queryId);
    } catch (e) {
      setRun({ error: errorText(e) });
    }
  };

  const stop = async () => {
    clearTimeout(pollRef.current);
    if (run?.id) await logs('StopQuery', { queryId: run.id }).catch(() => {});
    setRun((r) => ({ ...r, status: 'Cancelled' }));
  };

  const insert = (text) => {
    const el = editorRef.current;
    if (!el) return setQuery((q) => q + text);
    const { selectionStart: s, selectionEnd: e } = el;
    const next = query.slice(0, s) + text + query.slice(e);
    setQuery(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + text.length, s + text.length);
    });
  };

  const saveQuery = () => {
    const name = window.prompt('Name for this query', query.split('\n')[0].slice(0, 60));
    if (!name) return;
    setSaved((list) => [{ name, q: query }, ...list.filter((x) => x.name !== name)]);
    toast('Query saved');
  };

  const running = run && run.id !== undefined && !queryStatusDone(run.status);
  const starting = run?.status === 'Starting';
  const { columns, rows } = useMemo(() => insightsTable(run?.results), [run?.results]);
  const chart = useMemo(() => chartSpec(columns, rows), [columns, rows]);
  const spanDays = (() => {
    const w = resolveRange(range);
    return (w.endTime - w.startTime) / 86400000;
  })();

  useEffect(() => {
    if (chart && view === 'table' && run?.status === 'Complete') setView('chart');
    if (!chart && view === 'chart') setView('table');
  }, [chart, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="page-head">
        <h2>🔎 Logs Insights</h2>
        <span className="muted small">Query one or more log groups with the CloudWatch Logs Insights language.</span>
      </div>
      <div className="insights-layout">
        <div className="min0">
          <div className="card">
            <div className="ins-top">
              <GroupPicker value={groups} onChange={setGroups} />
              <TimeRangePicker value={range} onChange={setRange} utc={utc} onUtc={setUtc} />
            </div>
            <div className="ins-editor">
              <textarea
                ref={editorRef}
                className="mono ins-input"
                rows={7}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                aria-label="Query"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    start();
                  }
                }}
              />
            </div>
            {fields.length > 0 && (
              <div className="ins-fields">
                <span className="muted small">Fields:</span>
                {fields.map((f) => (
                  <button key={f.name} className="chip-btn" onClick={() => insert(f.name)} title={`${f.percent ?? '?'}% of events · click to insert`}>
                    {f.name}
                  </button>
                ))}
              </div>
            )}
            <div className="row-gap mt wrap">
              {running || starting ? (
                <button className="btn btn-danger" onClick={stop} disabled={starting}>■ Cancel</button>
              ) : (
                <button className="btn btn-primary" onClick={start}>Run query ⌘↵</button>
              )}
              <TemplateMenu label="Templates" items={QUERY_TEMPLATES.map(([name, q]) => ({ name, q }))} onPick={(q) => setQuery(q)} />
              <TemplateMenu
                label={`Saved (${saved.length})`}
                items={saved}
                onPick={(q) => setQuery(q)}
                onDelete={(name) => setSaved((l) => l.filter((x) => x.name !== name))}
                empty="No saved queries yet."
              />
              <button className="btn btn-sm" onClick={saveQuery} disabled={!query.trim()}>☆ Save</button>
              <a className="small" href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html" target="_blank" rel="noreferrer">Query syntax ↗</a>
              {spanDays > 7 && <span className="alert-warn small pill">Large range ({Math.round(spanDays)} days): Insights bills per GB scanned.</span>}
            </div>
          </div>

          {run?.error && <ErrorBox error={run.error} />}
          {run && !run.error && (
            <div className="card">
              <div className="results-bar">
                <span className="small">
                  <StatusBadge status={run.status} /> {run.ms !== undefined && <span className="muted">{fmtDuration(run.ms)}</span>}
                  {run.statistics && (
                    <span className="muted">
                      {' '}· {rows.length} rows · {Math.round(run.statistics.recordsMatched || 0).toLocaleString()} matched of {Math.round(run.statistics.recordsScanned || 0).toLocaleString()} scanned · {fmtBytes(run.statistics.bytesScanned || 0)} scanned
                    </span>
                  )}
                </span>
                <div className="row-gap">
                  {rows.length > 0 && (
                    <>
                      <button className="btn btn-xs" onClick={() => download('insights.csv', toCsv(columns, rows), 'text/csv')}>CSV</button>
                      <button className="btn btn-xs" onClick={() => download('insights.json', JSON.stringify(rows.map(({ '@ptr': _p, ...r }) => r), null, 2))}>JSON</button>
                    </>
                  )}
                  <Tabs small tabs={[['table', 'Logs'], ...(chart ? [['chart', 'Visualization']] : []), ['raw', 'Raw']]} value={view} onChange={setView} />
                </div>
              </div>
              {(running || starting) && !rows.length && <div className="ev-empty"><Spinner /> {run.status}…</div>}
              {run.status === 'Complete' && !rows.length && <div className="ev-empty">No results. Try a wider time range or another filter.</div>}
              {view === 'raw' && <CodeBlock code={JSON.stringify(rows, null, 2)} maxHeight="60vh" />}
              {view === 'chart' && chart && <LineChart spec={chart} utc={utc} />}
              {view === 'table' && rows.length > 0 && <ResultsTable columns={columns} rows={rows} utc={utc} groups={groups} />}
            </div>
          )}
        </div>

        <div className="card history">
          <h4>History</h4>
          {!history.length && <div className="muted small">Executed queries appear here.</div>}
          {history.map((h) => (
            <button
              key={h.at}
              className="history-item"
              onClick={() => {
                setQuery(h.q);
                if (h.groups?.length) setGroups(h.groups);
              }}
              title={h.q}
            >
              <code>{h.q.length > 160 ? `${h.q.slice(0, 160)}…` : h.q}</code>
              <span className="muted small">{new Date(h.at).toLocaleString()} · {h.groups?.length || 0} group{h.groups?.length === 1 ? '' : 's'}</span>
            </button>
          ))}
          {history.length > 0 && <button className="btn btn-xs" onClick={() => setHistory([])}>Clear history</button>}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const cls = status === 'Complete' ? 'badge-ok' : ['Failed', 'Timeout', 'Cancelled', 'Unknown'].includes(status) ? 'badge-bad' : 'badge-warn';
  return (
    <span className={`badge ${cls}`}>
      {!queryStatusDone(status) && <Spinner />} {status}
    </span>
  );
}

function TemplateMenu({ label, items, onPick, onDelete, empty }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, setOpen);
  return (
    <div className="dropdown" ref={ref}>
      <button className="btn btn-sm" onClick={() => setOpen(!open)}>{label} ▾</button>
      {open && (
        <div className="dropdown-menu tpl-menu">
          {!items.length && <div className="muted small pad">{empty}</div>}
          {items.map((t) => (
            <div key={t.name} className="tpl-item">
              <button
                onClick={() => {
                  onPick(t.q);
                  setOpen(false);
                }}
                title={t.q}
              >
                <strong>{t.name}</strong>
                <code className="tpl-q">{t.q.replace(/\n/g, ' ')}</code>
              </button>
              {onDelete && <button className="icon-btn" title="Delete" onClick={() => onDelete(t.name)}>×</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Log group multi-select ---------------------------------------------------------------------
function GroupPicker({ value, onChange }) {
  const { logGroups, logGroupsState, logFavorites, reloadLogGroups, conn } = useApp();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState([]);
  const [active, setActive] = useState(0);
  const ref = useOutsideClose(open, setOpen);
  const q = text.trim();

  useEffect(() => {
    if (conn && !logGroupsState.loaded && !logGroupsState.loading) reloadLogGroups();
  }, [conn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!q || !logGroupsState.more) return setRemote([]);
    const t = setTimeout(() => listLogGroups({ pattern: q, max: 100 }).then((r) => setRemote(r.groups.map((g) => g.logGroupName))).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [q, logGroupsState.more]);

  const all = logGroups.map((g) => g.logGroupName);
  const options = useMemo(() => {
    const lq = q.toLowerCase();
    const base = q ? [...new Set([...all.filter((n) => n.toLowerCase().includes(lq)), ...remote])] : [...logFavorites, ...all.filter((n) => !logFavorites.includes(n))];
    return base.filter((n) => !value.includes(n)).slice(0, 50);
  }, [q, all, remote, logFavorites, value]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (name) => {
    if (!name || value.includes(name) || value.length >= MAX_GROUPS) return;
    onChange([...value, name]);
    setText('');
    setActive(0);
  };

  return (
    <div className="group-picker dropdown" ref={ref}>
      <div className="gp-box" onClick={() => setOpen(true)}>
        {value.map((g) => (
          <span key={g} className="chip chip-x" title={g}>
            <span className="ellipsis-s">{g}</span>
            <button className="icon-btn" onClick={(e) => (e.stopPropagation(), onChange(value.filter((x) => x !== g)))} aria-label={`Remove ${g}`}>×</button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, options.length - 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            else if (e.key === 'Enter') (e.preventDefault(), add(options[active] || (q.startsWith('/') ? q : '')));
            else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
          placeholder={value.length ? 'Add log group…' : 'Select log groups (type to search)…'}
          aria-label="Log groups"
        />
      </div>
      {open && (
        <div className="dropdown-menu gp-menu">
          {value.length >= MAX_GROUPS && <div className="muted small pad">Maximum {MAX_GROUPS} log groups.</div>}
          {!options.length && <div className="muted small pad">{logGroupsState.loading ? 'Loading…' : 'No matching log groups.'}</div>}
          {options.map((n, i) => (
            <button key={n} className={i === active ? 'hl' : ''} onMouseEnter={() => setActive(i)} onClick={() => add(n)} title={n}>
              {logFavorites.includes(n) && <span className="side-star">★ </span>}
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Results ------------------------------------------------------------------------------------
function ResultsTable({ columns, rows, utc, groups }) {
  const [open, setOpen] = useState(null);
  const [limit, setLimit] = useState(500);
  const toast = useToast();
  const cell = (c, v) => {
    if (v === undefined) return '';
    if (isTimeCol(c)) {
      const t = parseInsightsTime(v);
      return Number.isNaN(t) ? v : fmtTime(t, utc);
    }
    return v;
  };
  const groupOf = (r) => (r['@log'] ? r['@log'].replace(/^\d+:/, '') : groups.length === 1 ? groups[0] : null);

  return (
    <div className="grid-wrap ins-grid">
      <table className="grid">
        <thead>
          <tr>
            <th className="check-col" />
            {columns.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r, i) => {
            const isOpen = open === i;
            const g = groupOf(r);
            const ts = r['@timestamp'] ? parseInsightsTime(r['@timestamp']) : NaN;
            const msgJson = r['@message'] ? parseJsonMessage(r['@message']) : null;
            return (
              <React.Fragment key={i}>
                <tr className={isOpen ? 'selected' : ''} onClick={() => !window.getSelection?.().toString() && setOpen(isOpen ? null : i)} style={{ cursor: 'pointer' }}>
                  <td className="check-col muted">{isOpen ? '▾' : '▸'}</td>
                  {columns.map((c) => (
                    <td key={c} className={c === '@message' ? 'ins-msg mono' : isTimeCol(c) ? 'mono small' : ''} title={r[c]}>
                      {cell(c, r[c])}
                    </td>
                  ))}
                </tr>
                {isOpen && (
                  <tr className="ins-detail-row">
                    <td />
                    <td colSpan={columns.length}>
                      <div className="ev-detail">
                        <div className="ev-detail-bar">
                          <button className="btn btn-xs" onClick={() => copyText(JSON.stringify(r, null, 2)).then(() => toast('Row copied'))}>Copy row</button>
                          {r['@message'] && <button className="btn btn-xs" onClick={() => copyText(r['@message']).then(() => toast('Message copied'))}>Copy message</button>}
                          {g && r['@logStream'] && !Number.isNaN(ts) && (
                            <a className="btn btn-xs" href={`#${logsGroupPath(g, { start: ts - 60000, end: ts + 60000, streams: r['@logStream'] })}`}>Open stream around this time</a>
                          )}
                        </div>
                        {msgJson && (
                          <div className="ev-json">
                            {msgJson.prefix && <div className="ev-prefix mono small">{msgJson.prefix}</div>}
                            <JsonTree value={msgJson.json} />
                          </div>
                        )}
                        <dl className="kv ev-kv">
                          {Object.entries(r)
                            .filter(([k]) => k !== '@ptr')
                            .map(([k, v]) => (
                              <React.Fragment key={k}>
                                <dt>{k}</dt>
                                <dd className="mono small pre-wrap">{cell(k, v)}</dd>
                              </React.Fragment>
                            ))}
                        </dl>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.length > limit && (
        <div className="center pad">
          <button className="btn btn-sm" onClick={() => setLimit((l) => l + 500)}>Show more ({rows.length - limit} hidden)</button>
        </div>
      )}
    </div>
  );
}

const SERIES_CLASSES = ['s0', 's1', 's2', 's3', 's4', 's5'];

function LineChart({ spec, utc }) {
  const { points, series } = spec;
  const [hover, setHover] = useState(null);
  const W = 1000;
  const H = 260;
  const P = { l: 56, r: 12, t: 12, b: 28 };
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const max = Math.max(1, ...points.flatMap((p) => p.v));
  const x = (t) => P.l + (t1 === t0 ? (W - P.l - P.r) / 2 : ((t - t0) / (t1 - t0)) * (W - P.l - P.r));
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const single = points.length === 1;
  const fmtN = (n) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(n.toFixed(2)).toString());
  const hp = hover !== null ? points[hover] : null;
  return (
    <div className="chart">
      <div className="legend">
        {series.map((s, i) => (
          <span key={s}><i className={`sw ${SERIES_CLASSES[i % 6]}`} /> {s}</span>
        ))}
        <span className="muted small push-right">
          {hp ? `${fmtTime(hp.t, utc, true)} · ${series.map((s, i) => `${s}: ${fmtN(hp.v[i])}`).join(' · ')}` : 'Hover the chart for values'}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="Query results chart" onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={P.l} x2={W - P.r} y1={y(max * f)} y2={y(max * f)} className="grid-line" />
            <text x={P.l - 6} y={y(max * f) + 4} textAnchor="end" className="axis-label">{fmtN(max * f)}</text>
          </g>
        ))}
        <text x={P.l} y={H - 8} className="axis-label">{fmtTime(t0, utc, true)}</text>
        <text x={W - P.r} y={H - 8} textAnchor="end" className="axis-label">{fmtTime(t1, utc, true)}</text>
        {series.map((s, si) => (
          <g key={s} className={`series ${SERIES_CLASSES[si % 6]}`}>
            {!single && <polyline fill="none" points={points.map((p) => `${x(p.t)},${y(p.v[si])}`).join(' ')} />}
            {points.map((p, i) => (
              <circle key={i} cx={x(p.t)} cy={y(p.v[si])} r={hover === i || single || points.length < 40 ? 3 : 0} />
            ))}
          </g>
        ))}
        {hp && <line x1={x(hp.t)} x2={x(hp.t)} y1={P.t} y2={H - P.b} className="hover-line" />}
        {points.map((p, i) => {
          const prev = i ? x(points[i - 1].t) : P.l;
          const next = i < points.length - 1 ? x(points[i + 1].t) : W - P.r;
          const a = (prev + x(p.t)) / 2;
          const b = (x(p.t) + next) / 2;
          return <rect key={i} x={i ? a : P.l} y={P.t} width={Math.max(1, (i < points.length - 1 ? b : W - P.r) - (i ? a : P.l))} height={H - P.t - P.b} fill="transparent" onMouseEnter={() => setHover(i)} />;
        })}
      </svg>
    </div>
  );
}
