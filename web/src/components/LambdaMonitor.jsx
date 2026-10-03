import React, { useCallback, useEffect, useState } from 'react';
import { errorText } from '../api.js';
import { Spinner, ErrorBox, Empty, Select } from './ui.jsx';
import { lambdaCw, METRICS, metricPeriod, metricQueries, metricSeries, parseReport, fmtMs, logGroupOf } from '../lib/lambda.js';
import { logs, logsGroupPath, insightsPath, QUERY_TEMPLATES, parseDuration } from '../lib/logs.js';

const RANGES = ['1h', '3h', '12h', '1d', '3d', '1w'];

/** Small line chart with hover readout. Points: [{ t, v }]. */
export function MetricChart({ label, points, start, end, unit = '', sum = false }) {
  const [hover, setHover] = useState(null);
  const W = 300;
  const H = 80;
  const max = Math.max(1, ...points.map((p) => p.v));
  const x = (t) => ((t - start) / Math.max(1, end - start)) * W;
  const y = (v) => H - 4 - (v / max) * (H - 10);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const total = points.reduce((n, p) => n + p.v, 0);
  const h = hover !== null ? points[hover] : null;
  const fmt = (v) => (unit === 'ms' ? fmtMs(v) : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2));
  return (
    <div className="fn-chart">
      <div className="fn-chart-head">
        <span>{label}</span>
        <span className="muted small">{h ? `${new Date(h.t).toLocaleString()} · ${fmt(h.v)}` : points.length ? (sum ? `total ${fmt(total)}` : `max ${fmt(max)}`) : 'no data'}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="fn-chart-svg" role="img" aria-label={label} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          if (!points.length) return;
          const r = e.currentTarget.getBoundingClientRect();
          const t = start + ((e.clientX - r.left) / r.width) * (end - start);
          let best = 0;
          points.forEach((p, i) => { if (Math.abs(p.t - t) < Math.abs(points[best].t - t)) best = i; });
          setHover(best);
        }}
      >
        <line x1="0" x2={W} y1={H - 4} y2={H - 4} className="fn-chart-axis" />
        {points.length > 1 && <path d={path} className="fn-chart-line" />}
        {points.length === 1 && <circle cx={x(points[0].t)} cy={y(points[0].v)} r="2.5" className="fn-chart-dot" />}
        {h && <circle cx={x(h.t)} cy={y(h.v)} r="3" className="fn-chart-dot" />}
      </svg>
    </div>
  );
}

export default function MonitorTab({ name, cfg, qualifier }) {
  const [range, setRange] = useState('3h');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [recent, setRecent] = useState(null);
  const [recentError, setRecentError] = useState(null);
  const [tick, setTick] = useState(0);
  const group = logGroupOf(cfg);

  const load = useCallback(async () => {
    const end = Date.now();
    const start = end - parseDuration(range);
    setData(null);
    setError(null);
    setRecent(null);
    setRecentError(null);
    const period = metricPeriod(end - start);
    lambdaCw('GetMetricData', { StartTime: new Date(start).toISOString(), EndTime: new Date(end).toISOString(), MetricDataQueries: metricQueries(name, qualifier, period), ScanBy: 'TimestampAscending' })
      .then((out) => setData({ start, end, series: metricSeries(out.MetricDataResults) }))
      .catch((e) => setError(errorText(e)));
    try {
      const events = [];
      let nextToken;
      do {
        const out = await logs('FilterLogEvents', { logGroupName: group, startTime: start, endTime: end, filterPattern: '"REPORT RequestId"', limit: 1000, ...(nextToken ? { nextToken } : {}) });
        events.push(...(out.events || []));
        nextToken = out.nextToken;
      } while (nextToken && events.length < 2000);
      setRecent(events.map((e) => ({ ...parseReport(e.message), timestamp: e.timestamp, stream: e.logStreamName })).sort((a, b) => b.timestamp - a.timestamp));
    } catch (e) {
      setRecent([]);
      setRecentError(e.name === 'ResourceNotFoundException' ? `Log group ${group} does not exist yet: the function has not written any logs.` : errorText(e));
    }
  }, [name, qualifier, range, group]);

  useEffect(() => {
    load();
  }, [load, tick]);

  const cold = recent?.filter((r) => r.initDuration).length || 0;
  const avg = recent?.length ? recent.reduce((n, r) => n + (r.duration || 0), 0) / recent.length : 0;
  const p95 = recent?.length ? [...recent].map((r) => r.duration || 0).sort((a, b) => a - b)[Math.floor(recent.length * 0.95)] : 0;

  return (
    <>
      <div className="row-gap wrap fn-mon-bar">
        <Select value={range} onChange={setRange} options={RANGES.map((r) => [r, `Last ${r}`])} aria-label="Time range" />
        <button className="btn btn-sm" onClick={() => setTick((t) => t + 1)}>↻ Refresh</button>
        {qualifier && <span className="badge">{qualifier}</span>}
        <div className="push-right row-gap">
          <a className="btn btn-sm" href={`#${logsGroupPath(group, { range })}`}>📜 Log group</a>
          <a className="btn btn-sm" href={`#${insightsPath({ groups: group, q: QUERY_TEMPLATES.find((t) => t[0].startsWith('Lambda: duration'))?.[1] || '', range })}`}>Logs Insights</a>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Metrics</h3><span className="muted small">CloudWatch AWS/Lambda</span></div>
        <ErrorBox error={error} />
        {!data && !error && <Spinner />}
        {data && (
          <div className="fn-charts">
            {METRICS.map(([id, label, metric, stat]) => (
              <MetricChart key={id} label={label} points={data.series[id.toLowerCase()] || []} start={data.start} end={data.end} unit={metric === 'Duration' ? 'ms' : ''} sum={stat === 'Sum'} />
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Recent invocations {recent && <span className="muted">({recent.length})</span>}</h3>
          {recent?.length > 0 && <span className="muted small">avg {fmtMs(avg)} · p95 {fmtMs(p95)} · {cold} cold start{cold === 1 ? '' : 's'}</span>}
        </div>
        {recentError && <div className="muted small">{recentError}</div>}
        {!recent && <Spinner />}
        {recent && !recent.length && !recentError && <Empty>No invocations in this range.</Empty>}
        {recent?.length > 0 && (
          <div className="grid-wrap">
            <table className="grid grid-plain">
              <thead><tr><th>Time</th><th>Request ID</th><th className="col-num">Duration</th><th className="col-num">Billed</th><th className="col-num">Memory</th><th className="col-num">Init</th></tr></thead>
              <tbody>
                {recent.slice(0, 100).map((r) => (
                  <tr key={r.requestId || r.timestamp}>
                    <td className="small">{new Date(r.timestamp).toLocaleString()}</td>
                    <td className="mono small"><a href={`#${logsGroupPath(group, { q: `"${r.requestId}"`, start: String(r.timestamp - 15 * 60000), end: String(r.timestamp + 60000) })}`} title="Logs of this request">{r.requestId}</a></td>
                    <td className="col-num">{fmtMs(r.duration)}</td>
                    <td className="col-num">{fmtMs(r.billed)}</td>
                    <td className="col-num">{r.maxMemory ?? '—'} / {r.memorySize ?? '—'} MB</td>
                    <td className="col-num">{r.initDuration ? <span className="badge" title="Cold start">{fmtMs(r.initDuration)}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
