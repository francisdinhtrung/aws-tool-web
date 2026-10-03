import React, { useMemo, useState } from 'react';
import { layoutDefinition, edgePath, parseDefinition } from '../lib/sfn.js';

const TYPE_ICON = { Task: '⚙', Pass: '→', Choice: '◇', Wait: '⏱', Succeed: '✓', Fail: '✕', Parallel: '⫴', Map: '⟳' };

/**
 * Workflow graph of a definition (Amazon States Language).
 * `status` maps state names to running | succeeded | failed | caught | cancelled (execution view).
 */
export default function SfnGraph({ definition, status = {}, selected, onSelect }) {
  const def = useMemo(() => parseDefinition(definition), [definition]);
  const layout = useMemo(() => (def ? layoutDefinition(def) : null), [def]);
  const [zoom, setZoom] = useState(1);
  if (!def) return <div className="muted small pad">The definition is not valid: the graph cannot be drawn.</div>;
  const { width, height, nodes, edges } = layout;
  const w = width + 120; // room for back-edge loops on the right

  return (
    <div className="sfn-graph">
      <div className="sfn-graph-tools row-gap">
        <button className="btn btn-xs" onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))} aria-label="Zoom out">−</button>
        <span className="muted small">{Math.round(zoom * 100)}%</span>
        <button className="btn btn-xs" onClick={() => setZoom((z) => Math.min(2, z + 0.15))} aria-label="Zoom in">＋</button>
        <button className="btn btn-xs" onClick={() => setZoom(1)}>Reset</button>
        {Object.keys(status).length > 0 && (
          <span className="sfn-legend small">
            {['succeeded', 'failed', 'caught', 'running', 'cancelled'].map((s) => (
              <span key={s}><i className={`sfn-dot st-${s}`} />{s}</span>
            ))}
          </span>
        )}
      </div>
      <div className="sfn-graph-scroll">
        <svg width={w * zoom} height={height * zoom} viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Workflow graph">
          <defs>
            <marker id="sfn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="sfn-arrow" />
            </marker>
          </defs>
          {nodes.filter((n) => n.container || n.group).map((n) =>
            n.group ? (
              <g key={n.id}>
                <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="6" className="sfn-group" />
                <text x={n.x + 6} y={n.y + 11} className="sfn-group-label">{n.label}</text>
              </g>
            ) : (
              <g key={n.id} className={`sfn-node sfn-container ${status[n.name] ? `st-${status[n.name]}` : ''} ${selected === n.name ? 'selected' : ''}`} onClick={() => onSelect?.(n.name)} data-state={n.name}>
                <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="8" />
                <text x={n.x + 10} y={n.y + 17} className="sfn-node-title">{TYPE_ICON[n.type]} {n.name}</text>
                <text x={n.x + n.w - 8} y={n.y + 17} textAnchor="end" className="sfn-node-type">{n.type}</text>
              </g>
            ),
          )}
          {edges.map((e, i) => {
            const d = edgePath(e);
            const [x1, y1, x2, y2] = e.points;
            return (
              <g key={i} className={`sfn-edge edge-${e.kind}`}>
                <path d={d} markerEnd="url(#sfn-arrow)" />
                {e.label && (
                  <text x={e.back ? Math.max(x1, x2) + 105 : (x1 + x2) / 2 + 4} y={(y1 + y2) / 2} className="sfn-edge-label">
                    <title>{e.label}</title>
                    {e.label.length > 28 ? `${e.label.slice(0, 27)}…` : e.label}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.filter((n) => !n.container && !n.group).map((n) =>
            n.marker ? (
              <circle key={n.id} cx={n.x + n.w / 2} cy={n.y + n.h / 2} r={n.w / 2} className={`sfn-marker marker-${n.marker}`}>
                <title>{n.marker === 'start' ? 'Start' : 'End'}</title>
              </circle>
            ) : (
              <g key={n.id} className={`sfn-node type-${n.type} ${status[n.name] ? `st-${status[n.name]}` : ''} ${selected === n.name ? 'selected' : ''}`} onClick={() => onSelect?.(n.name)} data-state={n.name}>
                <title>{`${n.name} (${n.type})${status[n.name] ? ` – ${status[n.name]}` : ''}`}</title>
                <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={n.type === 'Choice' ? 18 : 6} />
                <text x={n.x + n.w / 2} y={n.y + 16} textAnchor="middle" className="sfn-node-title">
                  {n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name}
                </text>
                <text x={n.x + n.w / 2} y={n.y + 30} textAnchor="middle" className="sfn-node-type">{TYPE_ICON[n.type]} {n.type}</text>
              </g>
            ),
          )}
        </svg>
      </div>
    </div>
  );
}
