import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PipelineStage } from '../data/types';
import { cx, Icon, Activity } from './primitives';
import { ICheck, IXCircle, IWarn, ILock, ICircleDashed } from '../lib/icons';

export function StageGlyph({ s }: { s: PipelineStage['status'] | 'done' }) {
  if (s === 'done') return <span className="at-sg at-sg--done"><Icon as={ICheck} size="sm" /></span>;
  if (s === 'passed') return <span className="at-sg at-sg--ok"><Icon as={ICheck} size="sm" /></span>;
  if (s === 'failed') return <span className="at-sg at-sg--err"><Icon as={IXCircle} size="sm" /></span>;
  if (s === 'warning') return <span className="at-sg at-sg--warn"><Icon as={IWarn} size="sm" /></span>;
  if (s === 'running') return <span className="at-sg at-sg--run"><Activity /></span>;
  if (s === 'locked') return <span className="at-sg at-sg--lock"><Icon as={ILock} size="sm" /></span>;
  return <span className="at-sg"><Icon as={ICircleDashed} size="sm" /></span>;
}

/* ---------- Deployment cycle graph ---------- */

type LaneKey = 'integrate' | 'verify' | 'release';
const LANES: { key: LaneKey; label: string }[] = [
  { key: 'integrate', label: 'Integrate' },
  { key: 'verify', label: 'Verify' },
  { key: 'release', label: 'Release' },
];

// Unknown stage ids fall back to the Verify lane.
function laneOf(id: string): LaneKey {
  if (id === 'commit' || id === 'build') return 'integrate';
  if (id === 'deploy' || id === 'health' || id === 'approval') return 'release';
  return 'verify';
}

// Geometry (px). Nodes are sized to fill the available width, clamped to MIN_W..MAX_W.
const NODE_H = 88;
const NODE_TOP = 30; // below the lane label
const LANE_H = NODE_TOP + NODE_H + 12;
const LOOP_DEPTH = 52;
const PAD_X = 16;
const LANE_PAD = 10;
const LANE_GAP = 22;
const NODE_GAP = 30;
const MIN_W = 120;
const MAX_W = 184;
const FALLBACK_WIDTH = 1200;

type Edge = { key: string; d: string; kind: 'ok' | 'err' | 'warn' | 'run' | 'idle' };

function edgeKind(s: PipelineStage['status']): Edge['kind'] {
  if (s === 'passed') return 'ok';
  if (s === 'failed') return 'err';
  if (s === 'warning') return 'warn';
  if (s === 'running') return 'run';
  return 'idle';
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Pipeline({ stages, selected, onSelect }: { stages: PipelineStage[]; selected: string; onSelect: (id: string) => void }) {
  const uid = useId().replace(/:/g, '');
  const [scrollRef, measured] = useElementWidth<HTMLDivElement>();
  const available = measured > 0 ? measured : FALLBACK_WIDTH;

  const graph = useMemo(() => {
    // Group into lanes (stable: keeps pipeline order inside each lane).
    const groups = LANES.map((lane) => ({ ...lane, items: stages.filter((s) => laneOf(s.id) === lane.key) })).filter((g) => g.items.length > 0);
    const n = stages.length;
    const L = groups.length;
    if (n === 0) return { width: 0, nodeW: MIN_W, lanes: [], placed: [], edges: [], loop: null as null | { d: string; labelX: number; labelY: number }, height: 0 };

    const withinLaneGaps = n - L;
    const fixed = PAD_X * 2 + withinLaneGaps * NODE_GAP + (L - 1) * LANE_GAP + L * 2 * LANE_PAD;
    const nodeW = Math.min(MAX_W, Math.max(MIN_W, Math.floor((available - fixed) / n)));

    const lanes: { key: LaneKey; label: string; x: number; w: number }[] = [];
    const placed: { st: PipelineStage; x: number; w: number }[] = [];
    let x = PAD_X;
    groups.forEach((g, gi) => {
      if (gi > 0) x += LANE_GAP;
      const laneX = x;
      x += LANE_PAD;
      g.items.forEach((st, j) => {
        if (j > 0) x += NODE_GAP;
        placed.push({ st, x, w: nodeW });
        x += nodeW;
      });
      x += LANE_PAD;
      lanes.push({ key: g.key, label: g.label, x: laneX, w: x - laneX });
    });
    const width = x + PAD_X;

    // Forward edges between consecutive nodes, coloured by upstream status.
    const edges: Edge[] = [];
    for (let i = 0; i < placed.length - 1; i++) {
      const a = placed[i];
      const b = placed[i + 1];
      const x1 = a.x + a.w;
      const y1 = NODE_TOP + NODE_H / 2;
      const x2 = b.x;
      const y2 = y1;
      const dx = Math.max(12, (x2 - x1) * 0.5);
      edges.push({
        key: `${a.st.id}-${b.st.id}`,
        kind: edgeKind(a.st.status),
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      });
    }

    // Feedback loop: first failed stage back to "commit" (or the first node).
    let loop: null | { d: string; labelX: number; labelY: number } = null;
    const failed = placed.find((p) => p.st.status === 'failed');
    const target = placed.find((p) => p.st.id === 'commit') ?? placed[0];
    if (failed && target && failed.st.id !== target.st.id) {
      const x1 = failed.x + failed.w / 2;
      const x2 = target.x + target.w / 2;
      const yb = NODE_TOP + NODE_H;
      const depth = LOOP_DEPTH + 18;
      loop = {
        d: `M ${x1} ${yb} C ${x1} ${yb + depth}, ${x2} ${yb + depth}, ${x2} ${yb}`,
        labelX: (x1 + x2) / 2,
        labelY: yb + depth * 0.75 + 4,
      };
    }

    const height = LANE_H + (loop ? LOOP_DEPTH + 8 : 8);
    return { width, nodeW, lanes, placed, edges, loop, height };
  }, [stages, available]);

  const markerId = (kind: Edge['kind']) => `${uid}-arrow-${kind}`;
  const kinds: Edge['kind'][] = ['ok', 'err', 'warn', 'run', 'idle'];

  return (
    <div className="at-dc-scroll" ref={scrollRef}>
      <div className="at-dc-canvas" role="tablist" aria-label="Verification pipeline" style={{ width: graph.width, height: graph.height }}>
        {graph.lanes.map((lane) => (
          <div key={lane.key} className="at-dc-lane" data-lane={lane.key} style={{ left: lane.x, top: 0, width: lane.w, height: LANE_H }}>
            <span className="at-dc-lane-label">{lane.label}</span>
          </div>
        ))}

        <svg className="at-dc-svg" width={graph.width} height={graph.height} aria-hidden="true" focusable="false">
          <defs>
            {kinds.map((k) => (
              <marker key={k} id={markerId(k)} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path className="at-dc-arrow" data-k={k} d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            ))}
          </defs>
          {graph.edges.map((e) => (
            <path key={e.key} className="at-dc-edge" data-k={e.kind} d={e.d} markerEnd={`url(#${markerId(e.kind)})`} />
          ))}
          {graph.loop && (
            <g className="at-dc-loop-g">
              <path className="at-dc-loop" d={graph.loop.d} markerEnd={`url(#${markerId('err')})`} />
              <rect className="at-dc-loop-bg" x={graph.loop.labelX - 46} y={graph.loop.labelY - 9} width={92} height={17} rx={8.5} />
              <text className="at-dc-loop-text" x={graph.loop.labelX} y={graph.loop.labelY + 3} textAnchor="middle">fix &amp; re-run</text>
            </g>
          )}
        </svg>

        {graph.placed.map(({ st, x, w }) => {
          const isSel = st.id === selected;
          const locked = st.status === 'locked';
          return (
            <button
              key={st.id}
              type="button"
              role="tab"
              aria-selected={isSel}
              aria-label={`${st.name}, ${st.status}`}
              className={cx('at-dc-node', isSel && 'at-dc-node--sel')}
              data-s={st.status}
              style={{ left: x, top: NODE_TOP, width: w, height: NODE_H }}
              onClick={() => onSelect(st.id)}
            >
              <span className="at-dc-head">
                <StageGlyph s={st.status} />
                <span className="at-dc-name">{st.name}</span>
              </span>
              <span className="at-dc-sum">{st.summary}</span>
              <span className="at-dc-foot">
                <span className="at-dc-dur at-mono at-tnum">{locked ? 'needs you' : st.duration ?? '—'}</span>
                {st.evidence.length > 0 && <span className="at-dc-ev at-mono at-tnum" title={`${st.evidence.length} evidence items`}>{st.evidence.length} ev</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function VerificationRow({ label, value, status }: { label: React.ReactNode; value: React.ReactNode; status?: 'passed' | 'failed' | 'warning' | 'pending' | 'running' }) {
  return (
    <div className="at-vrow" data-s={status}>
      <StageGlyph s={status === 'pending' || !status ? 'pending' : status} />
      <span className="at-vrow-label at-trunc">{label}</span>
      <span className="at-vrow-value at-mono">{value}</span>
    </div>
  );
}
