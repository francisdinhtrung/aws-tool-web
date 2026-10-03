import React, { useEffect, useRef, useState } from 'react';
import { useLocalStorage } from './ui.jsx';
import {
  QUICK_RANGES, durationLabel, rangeLabel, parseDuration, resolveRange, toInputValue, fromInputValue, fmtTime, splitHighlights,
} from '../lib/logs.js';

export const useUtc = () => useLocalStorage('ddbs.logs.utc', false);

export function useOutsideClose(open, setOpen) {
  const ref = useRef();
  useEffect(() => {
    if (!open) return undefined;
    const f = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const k = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', f);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', f);
      document.removeEventListener('keydown', k);
    };
  }, [open, setOpen]);
  return ref;
}

/** Button showing the current range; opens quick ranges, a relative input and an absolute from/to editor. */
export function TimeRangePicker({ value, onChange, utc, onUtc, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, setOpen);
  const [rel, setRel] = useState('');
  const [abs, setAbs] = useState({ start: '', end: '' });
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    const { startTime, endTime } = resolveRange(value);
    setAbs({ start: toInputValue(startTime, utc), end: toInputValue(endTime, utc) });
    setRel(value?.rel && !QUICK_RANGES.includes(value.rel) ? value.rel : '');
    setErr('');
  }, [open, value, utc]);

  const pick = (r) => {
    onChange(r);
    setOpen(false);
  };
  const applyRel = () => {
    const t = rel.trim().toLowerCase().replace(/\s+/g, '');
    if (!parseDuration(t)) return setErr('Use a number and a unit: 30m, 2h, 4d, 2w');
    pick({ rel: t });
  };
  const applyAbs = () => {
    const start = fromInputValue(abs.start, utc);
    const end = fromInputValue(abs.end, utc);
    if (!start || !end) return setErr('Enter both start and end');
    if (end <= start) return setErr('End must be after start');
    pick({ start, end });
  };

  return (
    <div className="dropdown" ref={ref}>
      <button className="btn trp-btn" onClick={() => setOpen(!open)} disabled={disabled} aria-haspopup="dialog" title="Time range">
        <span aria-hidden>🕑</span> {rangeLabel(value, utc)} <span className="muted">▾</span>
      </button>
      {open && (
        <div className="dropdown-menu trp-menu" role="dialog" aria-label="Time range">
          <div className="trp-section">
            <div className="trp-title">Relative</div>
            <div className="trp-quick">
              {QUICK_RANGES.map((r) => (
                <button key={r} className={`chip-btn${value?.rel === r ? ' active' : ''}`} onClick={() => pick({ rel: r })} title={durationLabel(r)}>
                  {r}
                </button>
              ))}
            </div>
            <div className="row-gap mt-s">
              <input
                className="trp-rel"
                placeholder="Custom, e.g. 45m, 2d"
                value={rel}
                onChange={(e) => setRel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyRel()}
                aria-label="Custom relative range"
              />
              <button className="btn btn-sm" onClick={applyRel}>Apply</button>
            </div>
          </div>
          <div className="trp-section">
            <div className="trp-title">Absolute ({utc ? 'UTC' : 'local time'})</div>
            <label className="trp-row">
              <span>From</span>
              <input type="datetime-local" step="1" value={abs.start} onChange={(e) => setAbs({ ...abs, start: e.target.value })} aria-label="Start time" />
            </label>
            <label className="trp-row">
              <span>To</span>
              <input type="datetime-local" step="1" value={abs.end} onChange={(e) => setAbs({ ...abs, end: e.target.value })} aria-label="End time" />
            </label>
            <div className="row-gap mt-s">
              <button className="btn btn-sm btn-primary" onClick={applyAbs}>Apply range</button>
              <label className="check small push-right">
                <input type="checkbox" checked={utc} onChange={(e) => onUtc(e.target.checked)} /> UTC
              </label>
            </div>
          </div>
          {err && <div className="text-bad small trp-err">{err}</div>}
        </div>
      )}
    </div>
  );
}

export function Highlight({ text, terms }) {
  const parts = splitHighlights(text, terms);
  if (parts.length === 1 && !parts[0].hit) return text;
  return parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>));
}

export function LevelTag({ level }) {
  if (!level) return <span className="lvl lvl-none" />;
  const label = { error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG', system: 'SYS' }[level];
  return <span className={`lvl lvl-${level}`}>{label}</span>;
}

/** Collapsible JSON tree. */
export function JsonTree({ value, name, depth = 0, terms }) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === 'object';
  const keyEl = name !== undefined ? <span className="jt-key">{Array.isArray(name) ? name[0] : `"${name}"`}: </span> : null;
  if (!isObj) {
    const cls = value === null ? 'jt-null' : typeof value === 'string' ? 'jt-str' : typeof value === 'number' ? 'jt-num' : 'jt-bool';
    return (
      <div className="jt-line">
        {keyEl}
        <span className={cls}>{typeof value === 'string' ? <>"<Highlight text={value} terms={terms} />"</> : String(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [[i], v]) : Object.entries(value);
  const [o, c] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return (
    <div className="jt-node">
      <button className="jt-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="jt-caret">{open ? '▾' : '▸'}</span>
        {keyEl}
        {o}
        {!open && <span className="muted"> {entries.length} {Array.isArray(value) ? 'items' : 'keys'} {c}</span>}
      </button>
      {open && (
        <>
          <div className="jt-children">
            {entries.map(([k, v]) => (
              <JsonTree key={String(k)} name={k} value={v} depth={depth + 1} terms={terms} />
            ))}
          </div>
          <div className="jt-line">{c}</div>
        </>
      )}
    </div>
  );
}

/** Bar chart of event counts over time. Clicking a bar calls onZoom(start, end). */
export function Histogram({ bins, utc, onZoom, height = 64 }) {
  const max = Math.max(1, ...bins.map((b) => b.total));
  const [hover, setHover] = useState(null);
  const w = 100 / bins.length;
  const h = hover !== null ? bins[hover] : null;
  return (
    <div className="histo">
      <div className="histo-info small muted">
        {h ? (
          <>
            {fmtTime(h.start, utc, true)} – {fmtTime(h.end, utc, true)} · <strong>{h.total}</strong> events
            {h.error > 0 && <span className="text-bad"> · {h.error} errors</span>}
            {h.warn > 0 && <span className="lvl-text-warn"> · {h.warn} warnings</span>}
            {onZoom && h.total > 0 && ' · click to zoom'}
          </>
        ) : (
          <>
            {bins.length > 0 && `${fmtTime(bins[0].start, utc, true)} → ${fmtTime(bins[bins.length - 1].end, utc, true)}`} · max {max}/bar
          </>
        )}
      </div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="histo-svg" style={{ height }} onMouseLeave={() => setHover(null)} role="img" aria-label="Events over time">
        {bins.map((b, i) => {
          const th = (b.total / max) * (height - 2);
          const eh = (b.error / max) * (height - 2);
          const wh = (b.warn / max) * (height - 2);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onClick={() => onZoom && b.total > 0 && onZoom(b.start, b.end)} style={{ cursor: onZoom && b.total ? 'pointer' : 'default' }}>
              <rect x={i * w} y={0} width={w} height={height} fill="transparent" />
              <rect x={i * w + w * 0.1} y={height - th} width={w * 0.8} height={th} className={`hb-total${hover === i ? ' hb-hover' : ''}`} />
              {wh > 0 && <rect x={i * w + w * 0.1} y={height - eh - wh} width={w * 0.8} height={wh} className="hb-warn" />}
              {eh > 0 && <rect x={i * w + w * 0.1} y={height - eh} width={w * 0.8} height={eh} className="hb-error" />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
