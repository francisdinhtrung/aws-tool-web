import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorText } from '../api.js';
import { useApp } from '../context.js';
import { Spinner, ErrorBox, Modal, useToast, copyText, download, useLocalStorage } from '../components/ui.jsx';
import { TimeRangePicker, Highlight, LevelTag, JsonTree, Histogram, useUtc, useOutsideClose } from '../components/LogsCommon.jsx';
import { RetentionModal } from './LogGroups.jsx';
import { fmtBytes } from '../lib/s3.js';
import {
  logs, enrichEvent, resolveRange, rangeToParams, rangeFromParams, replaceHashQuery, logsGroupPath, insightsPath, patternTerms,
  FILTER_EXAMPLES, histogram, fmtTime, timeAgo, retentionLabel, eventsToCsv, eventsToJson, eventsToText, LEVELS, fmtDuration,
} from '../lib/logs.js';

const BATCH = 1000; // events collected per "Run" / "Load more"
const MAX_REQUESTS = 15; // FilterLogEvents calls per batch (sparse matches can return many empty pages)
const MAX_EVENTS = 20000;
const LIVE_MAX = 5000;
const LIVE_EVERY = 2500;
const RENDER_STEP = 500;

const readQuery = () => new URLSearchParams(window.location.hash.split('?')[1] || '');

function mergeEvents(prev, next, cap) {
  const seen = new Set(prev.map((e) => e.id));
  const out = prev.concat(next.filter((e) => !seen.has(e.id) && seen.add(e.id)));
  out.sort((a, b) => a.timestamp - b.timestamp);
  return cap && out.length > cap ? out.slice(out.length - cap) : out;
}

export default function LogViewer({ group }) {
  const { logGroups, logFavorites, toggleLogFavorite, reloadLogGroups } = useApp();
  const toast = useToast();
  const initial = useMemo(readQuery, []);
  const [utc, setUtc] = useUtc();
  const [range, setRange] = useState(() => rangeFromParams(initial));
  const [pattern, setPattern] = useState(initial.get('q') || '');
  const [streams, setStreams] = useState(() => (initial.get('streams') ? initial.get('streams').split(',').filter(Boolean) : []));
  const [applied, setApplied] = useState(null); // { pattern, streams, window } of the loaded results
  const [events, setEvents] = useState([]);
  const [nextToken, setNextToken] = useState(null);
  const [status, setStatus] = useState({ loading: false, error: null, ms: 0, requests: 0 });
  const [live, setLive] = useState(false);
  const [prefs, setPrefs] = useLocalStorage('ddbs.logs.view', { wrap: false, stream: true, newest: false, compact: true });
  const [levels, setLevels] = useState([]);
  const [find, setFind] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);
  const [panel, setPanel] = useState(streams.length > 0);
  const [context, setContext] = useState(null);
  const [retention, setRetention] = useState(false);
  const [meta, setMeta] = useState(null);
  const seq = useRef(0);
  const searchRef = useRef();
  const listRef = useRef();
  const stick = useRef(true);

  const groupInfo = meta || logGroups.find((g) => g.logGroupName === group);
  const fav = logFavorites.includes(group);

  useEffect(() => {
    if (logGroups.some((g) => g.logGroupName === group)) return;
    logs('DescribeLogGroups', { logGroupNamePrefix: group, limit: 5 })
      .then((o) => setMeta((o.logGroups || []).find((g) => g.logGroupName === group) || null))
      .catch(() => {});
  }, [group, logGroups]);

  const syncUrl = (r, p, s) => replaceHashQuery(logsGroupPath(group), { ...rangeToParams(r), q: p, streams: s.join(',') });

  const request = (win, p, s, token) =>
    logs('FilterLogEvents', {
      logGroupName: group,
      startTime: win.startTime,
      endTime: win.endTime,
      limit: BATCH,
      ...(p.trim() ? { filterPattern: p.trim() } : {}),
      ...(s.length ? { logStreamNames: s } : {}),
      ...(token ? { nextToken: token } : {}),
    });

  // Search: collect up to BATCH events (following nextToken) for the current range / pattern / streams.
  const run = useCallback(
    async ({ more = false, r = range, p = pattern, s = streams } = {}) => {
      const id = ++seq.current;
      const win = more ? applied.window : resolveRange(r);
      const pat = more ? applied.pattern : p;
      const strs = more ? applied.streams : s;
      if (!more) {
        setLive(false);
        setEvents([]);
        setExpanded(new Set());
        setRenderLimit(RENDER_STEP);
        setNextToken(null);
        setApplied({ pattern: pat, streams: strs, window: win });
        syncUrl(r, pat, strs);
      }
      setStatus((st) => ({ ...st, loading: true, error: null }));
      const started = Date.now();
      let token = more ? nextToken : undefined;
      let got = [];
      let requests = 0;
      try {
        do {
          const out = await request(win, pat, strs, token);
          if (id !== seq.current) return;
          got = got.concat((out.events || []).map(enrichEvent));
          token = out.nextToken || null;
          requests++;
        } while (token && got.length < BATCH && requests < MAX_REQUESTS);
        setEvents((prev) => mergeEvents(more ? prev : [], got, MAX_EVENTS));
        setNextToken(token);
        setStatus((st) => ({ loading: false, error: null, ms: Date.now() - started, requests: (more ? st.requests : 0) + requests }));
      } catch (e) {
        if (id !== seq.current) return;
        setStatus((st) => ({ ...st, loading: false, error: errorText(e) }));
      }
    },
    [group, range, pattern, streams, applied, nextToken], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live tail: poll FilterLogEvents for new events; overlap the window so late-ingested events are not missed.
  useEffect(() => {
    if (!live) return undefined;
    const id = ++seq.current;
    const pat = pattern;
    const strs = streams;
    let since = Date.now() - 60000;
    let timer;
    let first = true;
    setApplied({ pattern: pat, streams: strs, window: null });
    setNextToken(null);
    setStatus({ loading: true, error: null, ms: 0, requests: 0 });
    syncUrl(range, pat, strs);
    const poll = async () => {
      const startedAt = Date.now();
      try {
        let token;
        let got = [];
        let n = 0;
        do {
          const out = await request({ startTime: since - 30000, endTime: startedAt }, pat, strs, token);
          if (id !== seq.current) return;
          got = got.concat((out.events || []).map(enrichEvent));
          token = out.nextToken;
          n++;
        } while (token && n < 5);
        if (got.length) setEvents((prev) => mergeEvents(first ? [] : prev, got, LIVE_MAX));
        else if (first) setEvents([]);
        first = false;
        since = startedAt;
        setStatus((st) => ({ loading: false, error: null, ms: Date.now() - startedAt, requests: st.requests + n, polledAt: startedAt }));
      } catch (e) {
        if (id !== seq.current) return;
        setStatus((st) => ({ ...st, loading: false, error: errorText(e) }));
      }
      if (id === seq.current) timer = setTimeout(poll, LIVE_EVERY);
    };
    poll();
    return () => {
      clearTimeout(timer);
      seq.current++;
    };
  }, [live, group]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (patch = {}) => {
    const r = patch.range ?? range;
    const p = patch.pattern ?? pattern;
    const s = patch.streams ?? streams;
    if (patch.range) setRange(r);
    if (patch.pattern !== undefined) setPattern(p);
    if (patch.streams) setStreams(s);
    if (live) {
      // Restart the tail with the new filter.
      setLive(false);
      setTimeout(() => setLive(true), 0);
    } else run({ r, p, s });
  };

  // "/" focuses the search box.
  useEffect(() => {
    const f = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);

  const terms = useMemo(() => [...patternTerms(applied?.pattern), ...(find.trim() ? [find.trim()] : [])], [applied, find]);
  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0, debug: 0 };
    for (const e of events) if (c[e.level] !== undefined) c[e.level]++;
    return c;
  }, [events]);
  const shown = useMemo(() => {
    const f = find.trim().toLowerCase();
    let list = events;
    if (levels.length) list = list.filter((e) => levels.includes(e.level));
    if (f) list = list.filter((e) => e.message.toLowerCase().includes(f) || (e.logStreamName || '').toLowerCase().includes(f));
    return prefs.newest ? [...list].reverse() : list;
  }, [events, levels, find, prefs.newest]);
  const rendered = live && !prefs.newest ? shown.slice(-1000) : shown.slice(0, renderLimit);

  // Keep the tail pinned to the newest line unless the user scrolled away.
  useEffect(() => {
    const el = listRef.current;
    if (!live || !el || !stick.current) return;
    if (prefs.newest) el.scrollTop = 0;
    else el.scrollTop = el.scrollHeight;
  }, [events, live, prefs.newest]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stick.current = prefs.newest ? el.scrollTop < 40 : el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const toggle = useCallback((id) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const bins = useMemo(() => {
    if (!events.length) return [];
    const w = applied?.window || { startTime: events[0].timestamp, endTime: events[events.length - 1].timestamp + 1 };
    return histogram(events, w.startTime, w.endTime, 60);
  }, [events, applied]);

  // Stable callbacks for the memoised rows; `apply` changes every render, so go through a ref.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const actions = useMemo(
    () => ({
      toggle,
      context: (e) => setContext(e),
      onlyStream: (name) => {
        setPanel(true);
        applyRef.current({ streams: [name] });
      },
    }),
    [toggle],
  );

  const lastTs = events.length ? events[events.length - 1].timestamp : null;
  const exportName = group.replace(/[^\w.-]+/g, '_').replace(/^_+/, '');

  return (
    <div className="page logs-page">
      <div className="page-head lv-head">
        <button className={`star big${fav ? ' on' : ''}`} onClick={() => toggleLogFavorite(group)} title={fav ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={fav}>
          {fav ? '★' : '☆'}
        </button>
        <h2 className="lv-title" title={group}>{group}</h2>
        <button className="icon-btn" title="Copy name" onClick={() => copyText(group).then(() => toast('Copied'))}>⧉</button>
        {groupInfo && (
          <span className="row-gap small muted">
            <button className="badge badge-btn" onClick={() => setRetention(true)} title="Change retention">⏳ {retentionLabel(groupInfo.retentionInDays)}</button>
            {groupInfo.storedBytes !== undefined && <span className="badge">{fmtBytes(groupInfo.storedBytes)}</span>}
          </span>
        )}
        <div className="push-right row-gap">
          <a className="btn" href={`#${insightsPath({ groups: group, ...rangeToParams(range) })}`}>🔎 Query in Insights</a>
        </div>
      </div>

      <div className="lv-query card">
        <div className="lv-row">
          <TimeRangePicker value={range} onChange={(r) => apply({ range: r })} utc={utc} onUtc={setUtc} disabled={live} />
          <div className="lv-search">
            <span className="lv-search-icon" aria-hidden>⌕</span>
            <input
              ref={searchRef}
              className="mono"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              placeholder='Search logs: ERROR   "exact phrase"   ?ERROR ?WARN   { $.level = "error" }'
              aria-label="Filter pattern"
              spellCheck={false}
            />
            {pattern && (
              <button className="icon-btn lv-clear" title="Clear filter" onClick={() => apply({ pattern: '' })}>×</button>
            )}
            <PatternHelp onPick={(p) => apply({ pattern: p })} />
          </div>
          <button className="btn btn-primary" onClick={() => apply()} disabled={status.loading && !live}>
            {status.loading && !live ? <Spinner /> : 'Search'}
          </button>
          <button className={`btn live-btn${live ? ' on' : ''}`} onClick={() => setLive(!live)} title="Stream new events as they arrive">
            {live ? <><span className="live-dot" /> Stop tail</> : '▶ Live tail'}
          </button>
        </div>
        <div className="lv-row lv-row-2">
          <button className={`btn btn-xs${panel ? ' active' : ''}`} onClick={() => setPanel(!panel)}>
            ☰ Streams: {streams.length ? `${streams.length} selected` : 'all'}
          </button>
          {streams.slice(0, 3).map((s) => (
            <span key={s} className="chip chip-x" title={s}>
              <span className="ellipsis-s">{s}</span>
              <button className="icon-btn" onClick={() => apply({ streams: streams.filter((x) => x !== s) })} aria-label={`Remove ${s}`}>×</button>
            </span>
          ))}
          {streams.length > 3 && <span className="muted small">+{streams.length - 3} more</span>}
          {streams.length > 0 && <button className="link small" onClick={() => apply({ streams: [] })}>All streams</button>}
          <span className="muted small push-right">
            Filter patterns are case-sensitive. <a href="https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html" target="_blank" rel="noreferrer">Syntax</a>
          </span>
        </div>
      </div>

      <div className={`lv-body${panel ? ' with-panel' : ''}`}>
        {panel && <StreamsPanel group={group} selected={streams} utc={utc} onApply={(s) => apply({ streams: s })} onClose={() => setPanel(false)} />}
        <div className="lv-results card">
          <div className="lv-toolbar">
            <span className="small">
              {live ? (
                <span className="live-label"><span className="live-dot" /> Live · {events.length} events{status.polledAt ? ` · updated ${fmtTime(status.polledAt, utc, true).slice(11)}` : ''}</span>
              ) : (
                <>
                  <strong>{events.length}</strong> events
                  {applied?.window && <span className="muted"> · {fmtDuration(applied.window.endTime - applied.window.startTime)} window</span>}
                  {status.ms > 0 && <span className="muted"> · {status.requests} request{status.requests === 1 ? '' : 's'} · {fmtDuration(status.ms)}</span>}
                </>
              )}
              {shown.length !== events.length && <span className="muted"> · {shown.length} shown</span>}
            </span>
            <div className="lvl-filter" role="group" aria-label="Level filter">
              {LEVELS.map((l) => (
                <button
                  key={l}
                  className={`lvl-chip lvl-chip-${l}${levels.includes(l) ? ' active' : ''}`}
                  onClick={() => setLevels((x) => (x.includes(l) ? x.filter((y) => y !== l) : [...x, l]))}
                  aria-pressed={levels.includes(l)}
                  disabled={!counts[l] && !levels.includes(l)}
                >
                  {l} <span className="n">{counts[l]}</span>
                </button>
              ))}
            </div>
            <input className="lv-find" placeholder="Find in results…" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find in results" />
            <div className="row-gap push-right">
              <label className="check small"><input type="checkbox" checked={prefs.wrap} onChange={(e) => setPrefs({ ...prefs, wrap: e.target.checked })} /> Wrap</label>
              <label className="check small" title="Show JSON logs as message + key=value"><input type="checkbox" checked={prefs.compact !== false} onChange={(e) => setPrefs({ ...prefs, compact: e.target.checked })} /> Compact JSON</label>
              <label className="check small"><input type="checkbox" checked={prefs.stream} onChange={(e) => setPrefs({ ...prefs, stream: e.target.checked })} /> Stream</label>
              <label className="check small"><input type="checkbox" checked={prefs.newest} onChange={(e) => setPrefs({ ...prefs, newest: e.target.checked })} /> Newest first</label>
              {expanded.size > 0 && <button className="btn btn-xs" onClick={() => setExpanded(new Set())}>Collapse all</button>}
              <ExportMenu
                disabled={!shown.length}
                onPick={(kind) => {
                  const list = prefs.newest ? [...shown].reverse() : shown;
                  if (kind === 'copy') return copyText(eventsToText(list, utc)).then(() => toast(`${list.length} lines copied`));
                  if (kind === 'json') download(`${exportName}.json`, eventsToJson(list));
                  if (kind === 'csv') download(`${exportName}.csv`, eventsToCsv(list, utc), 'text/csv');
                  if (kind === 'txt') download(`${exportName}.log`, eventsToText(list, utc), 'text/plain');
                }}
              />
            </div>
          </div>

          {!live && bins.length > 0 && (
            <Histogram bins={bins} utc={utc} onZoom={(start, end) => apply({ range: { start: Math.floor(start), end: Math.ceil(end) } })} />
          )}

          <ErrorBox error={status.error} />

          <div className={`ev-list${prefs.wrap ? ' wrap' : ''}`} ref={listRef} onScroll={onScroll} role="log" aria-live={live ? 'polite' : 'off'}>
            {rendered.map((e) => (
              <EventRow key={e.id} e={e} open={expanded.has(e.id)} terms={terms} utc={utc} showStream={prefs.stream} compact={prefs.compact !== false} actions={actions} />
            ))}
            {!rendered.length && !status.loading && !status.error && (
              <div className="ev-empty">
                {live ? (
                  'Waiting for new events…'
                ) : events.length ? (
                  'No loaded events match the level / find filters.'
                ) : (
                  <>
                    <div>No events found{applied?.pattern ? <> matching <code>{applied.pattern}</code></> : ''} in this time range.</div>
                    <div className="row-gap mt" style={{ justifyContent: 'center' }}>
                      <button className="btn btn-sm" onClick={() => apply({ range: { rel: '1h' } })}>Last hour</button>
                      <button className="btn btn-sm" onClick={() => apply({ range: { rel: '1d' } })}>Last day</button>
                      <button className="btn btn-sm" onClick={() => apply({ range: { rel: '1w' } })}>Last week</button>
                      {applied?.pattern && <button className="btn btn-sm" onClick={() => apply({ pattern: '' })}>Clear filter</button>}
                    </div>
                  </>
                )}
              </div>
            )}
            {status.loading && !events.length && <div className="ev-empty"><Spinner /> Searching…</div>}
            {!live && shown.length > rendered.length && (
              <div className="center pad">
                <button className="btn btn-sm" onClick={() => setRenderLimit((n) => n + RENDER_STEP)}>Show {Math.min(RENDER_STEP, shown.length - rendered.length)} more rows ({shown.length - rendered.length} hidden)</button>
              </div>
            )}
            {!live && nextToken && (
              <div className="ev-more">
                <span className="muted small">
                  More events match in this range{lastTs ? ` (loaded up to ${fmtTime(lastTs, utc)})` : ''}.
                  {events.length >= MAX_EVENTS && ' Limit reached: narrow the time range or filter.'}
                </span>
                <button className="btn btn-sm" onClick={() => run({ more: true })} disabled={status.loading || events.length >= MAX_EVENTS}>
                  {status.loading ? <Spinner /> : `Load more`}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {context && <ContextModal group={group} event={context} utc={utc} terms={terms} onClose={() => setContext(null)} />}
      {retention && groupInfo && (
        <RetentionModal
          group={groupInfo}
          onClose={() => setRetention(false)}
          onSaved={(days) => {
            setRetention(false);
            setMeta({ ...groupInfo, retentionInDays: days });
            toast('Retention updated');
            reloadLogGroups();
          }}
        />
      )}
    </div>
  );
}

const EventRow = memo(function EventRow({ e, open, terms, utc, showStream, compact, actions }) {
  const text = compact && e.summary !== null ? e.summary : e.message;
  const firstLine = text.includes('\n') ? text.slice(0, text.indexOf('\n')) : text;
  const onClick = () => {
    if (window.getSelection?.().toString()) return; // selecting text, not toggling
    actions.toggle(e.id);
  };
  return (
    <div className={`ev ev-${e.level || 'none'}${open ? ' open' : ''}`}>
      <div className="ev-line" onClick={onClick} role="button" tabIndex={0} aria-expanded={open} onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && (k.preventDefault(), actions.toggle(e.id))}>
        <span className="ev-caret">{open ? '▾' : '▸'}</span>
        <span className="ev-time">{fmtTime(e.timestamp, utc)}</span>
        <LevelTag level={e.level} />
        {showStream && <span className="ev-stream" title={e.logStreamName}>{e.logStreamName}</span>}
        <span className="ev-msg">
          <Highlight text={open ? firstLine : text} terms={terms} />
          {text.includes('\n') && !open && <span className="ev-more-lines"> ↵</span>}
        </span>
      </div>
      {open && <EventDetail e={e} terms={terms} utc={utc} actions={actions} />}
    </div>
  );
});

function EventDetail({ e, terms, utc, actions }) {
  const toast = useToast();
  const [raw, setRaw] = useState(!e.json);
  const copy = (text, what) => copyText(text).then(() => toast(`${what} copied`));
  return (
    <div className="ev-detail">
      <div className="ev-detail-bar">
        {e.json && (
          <div className="seg seg-xs">
            <button className={raw ? '' : 'active'} onClick={() => setRaw(false)}>JSON</button>
            <button className={raw ? 'active' : ''} onClick={() => setRaw(true)}>Raw</button>
          </div>
        )}
        <button className="btn btn-xs" onClick={() => copy(e.message, 'Message')}>Copy message</button>
        {e.json && <button className="btn btn-xs" onClick={() => copy(JSON.stringify(e.json, null, 2), 'JSON')}>Copy JSON</button>}
        {e.logStreamName && (
          <>
            <button className="btn btn-xs" onClick={() => actions.context(e)} title="Show the surrounding lines of this stream">Show context</button>
            <button className="btn btn-xs" onClick={() => actions.onlyStream(e.logStreamName)}>Only this stream</button>
          </>
        )}
      </div>
      {raw ? (
        <pre className="ev-raw"><Highlight text={e.message} terms={terms} /></pre>
      ) : (
        <div className="ev-json">
          {e.prefix && <div className="ev-prefix mono small">{e.prefix}</div>}
          <JsonTree value={e.json} terms={terms} />
        </div>
      )}
      <dl className="kv ev-kv">
        <dt>Timestamp</dt>
        <dd>{fmtTime(e.timestamp, utc)} {utc ? '' : <span className="muted">· {new Date(e.timestamp).toISOString()}</span>}</dd>
        {e.ingestionTime && (
          <>
            <dt>Ingested</dt>
            <dd>{fmtTime(e.ingestionTime, utc)} <span className="muted">(+{fmtDuration(Math.max(0, e.ingestionTime - e.timestamp))})</span></dd>
          </>
        )}
        {e.logStreamName && (
          <>
            <dt>Log stream</dt>
            <dd className="mono small">{e.logStreamName}</dd>
          </>
        )}
        {e.eventId && (
          <>
            <dt>Event ID</dt>
            <dd className="mono small muted">{e.eventId}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function PatternHelp({ onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, setOpen);
  return (
    <div className="dropdown" ref={ref}>
      <button className="icon-btn lv-help" onClick={() => setOpen(!open)} title="Filter pattern examples" aria-label="Filter pattern examples">?</button>
      {open && (
        <div className="dropdown-menu pattern-menu">
          <div className="trp-title">Click an example to use it</div>
          {FILTER_EXAMPLES.map(([p, label]) => (
            <button
              key={p}
              onClick={() => {
                onPick(p);
                setOpen(false);
              }}
            >
              <code>{p}</code>
              <span className="muted small">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ExportMenu({ onPick, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, setOpen);
  const pick = (k) => {
    setOpen(false);
    onPick(k);
  };
  return (
    <div className="dropdown" ref={ref}>
      <button className="btn btn-xs" onClick={() => setOpen(!open)} disabled={disabled}>Export ▾</button>
      {open && (
        <div className="dropdown-menu dropdown-right">
          <button onClick={() => pick('copy')}>Copy as text</button>
          <button onClick={() => pick('txt')}>Download .log</button>
          <button onClick={() => pick('csv')}>Download CSV</button>
          <button onClick={() => pick('json')}>Download JSON</button>
        </div>
      )}
    </div>
  );
}

// --- Streams panel ---------------------------------------------------------------------------
function StreamsPanel({ group, selected, utc, onApply, onClose }) {
  const [prefix, setPrefix] = useState('');
  const [list, setList] = useState([]);
  const [token, setToken] = useState(null);
  const [state, setState] = useState({ loading: false, error: null });
  const [picked, setPicked] = useState(selected);
  const seqRef = useRef(0);

  useEffect(() => setPicked(selected), [selected]);

  const load = useCallback(
    async (more) => {
      const id = ++seqRef.current;
      setState({ loading: true, error: null });
      try {
        const p = prefix.trim();
        // The API only allows a name prefix when ordering by name.
        const out = await logs('DescribeLogStreams', {
          logGroupName: group,
          limit: 50,
          ...(p ? { logStreamNamePrefix: p, orderBy: 'LogStreamName' } : { orderBy: 'LastEventTime', descending: true }),
          ...(more && token ? { nextToken: token } : {}),
        });
        if (id !== seqRef.current) return;
        setList((l) => (more ? l : []).concat(out.logStreams || []));
        setToken(out.nextToken || null);
        setState({ loading: false, error: null });
      } catch (e) {
        if (id === seqRef.current) setState({ loading: false, error: errorText(e) });
      }
    },
    [group, prefix, token],
  );

  useEffect(() => {
    const t = setTimeout(() => load(false), prefix ? 300 : 0);
    return () => clearTimeout(t);
  }, [group, prefix]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (name) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : p.length >= 100 ? p : [...p, name]));
  const changed = picked.length !== selected.length || picked.some((p) => !selected.includes(p));
  const now = Date.now();

  return (
    <div className="card streams-panel">
      <div className="card-head">
        <h4>Log streams</h4>
        <button className="icon-btn" onClick={onClose} aria-label="Close streams">×</button>
      </div>
      <input placeholder="Stream name prefix…" value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label="Stream name prefix" />
      <div className="row-gap mt-s">
        <button className="btn btn-xs btn-primary" disabled={!changed} onClick={() => onApply(picked)}>Apply ({picked.length || 'all'})</button>
        <button className="btn btn-xs" disabled={!picked.length} onClick={() => setPicked([])}>Clear</button>
        <span className="muted small push-right">{prefix ? 'by name' : 'latest first'}</span>
      </div>
      <ErrorBox error={state.error} />
      <div className="streams-list">
        {list.map((s) => (
          <label key={s.logStreamName} className={`stream-item${picked.includes(s.logStreamName) ? ' on' : ''}`} title={s.logStreamName}>
            <input type="checkbox" checked={picked.includes(s.logStreamName)} onChange={() => toggle(s.logStreamName)} />
            <span className="stream-name">{s.logStreamName}</span>
            <span className="stream-meta muted" title={s.lastEventTimestamp ? fmtTime(s.lastEventTimestamp, utc) : ''}>
              {s.lastEventTimestamp ? timeAgo(s.lastEventTimestamp, now) : 'no events'}
            </span>
          </label>
        ))}
        {state.loading && <div className="pad"><Spinner /></div>}
        {!state.loading && !list.length && !state.error && <div className="muted small pad">No streams.</div>}
        {token && !state.loading && <button className="btn btn-xs mt-s" onClick={() => load(true)}>Load more</button>}
      </div>
    </div>
  );
}

// --- Context around one event ------------------------------------------------------------------
function ContextModal({ group, event, utc, terms, onClose }) {
  const [n, setN] = useState(25);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const targetRef = useRef();

  useEffect(() => {
    let off = false;
    setRows(null);
    const base = { logGroupName: group, logStreamName: event.logStreamName };
    Promise.all([
      logs('GetLogEvents', { ...base, endTime: event.timestamp, limit: n, startFromHead: false }),
      logs('GetLogEvents', { ...base, startTime: event.timestamp, limit: n + 1, startFromHead: true }),
    ])
      .then(([before, after]) => {
        if (off) return;
        const all = mergeEvents([], [...(before.events || []), ...(after.events || [])].map((e) => enrichEvent({ ...e, logStreamName: event.logStreamName })));
        if (!all.some((e) => e.timestamp === event.timestamp && e.message === event.message)) all.push(event);
        all.sort((a, b) => a.timestamp - b.timestamp);
        setRows(all);
      })
      .catch((e) => !off && setError(errorText(e)));
    return () => {
      off = true;
    };
  }, [group, event, n]);

  useEffect(() => {
    targetRef.current?.scrollIntoView?.({ block: 'center' });
  }, [rows]);

  const isTarget = (e) => e.id === event.id || (e.timestamp === event.timestamp && e.message === event.message);

  return (
    <Modal title={`Context · ${event.logStreamName}`} onClose={onClose} size="lg">
      <div className="row-gap mb">
        <span className="muted small">Lines around {fmtTime(event.timestamp, utc)} in this stream</span>
        <div className="seg seg-xs push-right">
          {[10, 25, 50, 100].map((x) => (
            <button key={x} className={n === x ? 'active' : ''} onClick={() => setN(x)}>±{x}</button>
          ))}
        </div>
      </div>
      <ErrorBox error={error} />
      {!rows && !error && <Spinner />}
      {rows && (
        <div className="ev-list wrap ctx-list">
          {rows.map((e) => (
            <div key={e.id} ref={isTarget(e) ? targetRef : undefined} className={`ev ev-${e.level || 'none'}${isTarget(e) ? ' ev-target' : ''}`}>
              <div className="ev-line ev-static">
                <span className="ev-time">{fmtTime(e.timestamp, utc)}</span>
                <LevelTag level={e.level} />
                <span className="ev-msg"><Highlight text={e.message} terms={terms} /></span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
