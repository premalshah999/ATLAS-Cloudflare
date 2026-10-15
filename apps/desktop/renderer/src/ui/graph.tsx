import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Task } from '../data/types';
import { agents, tasks, agentById } from '../data/source';
import { cx, RoleMark, Activity, Dot, IconButton, Tip } from './primitives';
import { IZoomIn, IZoomOut, IFit } from '../lib/icons';
import { actions, useApp } from '../lib/store';

/* ---------- shared: pan / zoom canvas (n8n / React Flow style) ---------- */
type View = { x: number; y: number; k: number };
const K_MIN = 0.35, K_MAX = 2.2, FIT_MAX = 1.6, GRID = 16;
const clampK = (k: number) => Math.max(K_MIN, Math.min(K_MAX, k));
const gridStyle = (v: View): React.CSSProperties => ({ backgroundPosition: `${v.x}px ${v.y}px`, backgroundSize: `${GRID * v.k}px ${GRID * v.k}px` });
const stageTransform = (v: View) => `translate(${v.x}px, ${v.y}px) scale(${v.k})`;

/** Fit-to-view on mount and on resize; ctrl/cmd+wheel zooms at the pointer; drag on empty canvas pans. */
function usePanZoom(W: number, H: number, onBackground?: () => void) {
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const fit = useCallback(() => {
    const el = wrap.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const k = Math.max(0.2, Math.min(FIT_MAX, (r.width - 48) / W, (r.height - 48) / H));
    setView({ k, x: (r.width - W * k) / 2, y: (r.height - H * k) / 2 });
  }, [W, H]);
  useLayoutEffect(() => { fit(); }, [fit]);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  // Native listener so preventDefault stops Electron's page zoom on ctrl+wheel.
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        setView((v) => { const k = clampK(v.k * Math.exp(-e.deltaY * 0.0022)), f = k / v.k; return { k, x: mx - (mx - v.x) * f, y: my - (my - v.y) * f }; });
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const zoomBy = useCallback((f: number) => {
    const el = wrap.current; if (!el) return;
    const r = el.getBoundingClientRect(); const cx0 = r.width / 2, cy0 = r.height / 2;
    setView((v) => { const k = clampK(v.k * f), g = k / v.k; return { k, x: cx0 - (cx0 - v.x) * g, y: cy0 - (cy0 - v.y) * g }; });
  }, []);
  const bind = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('button, .at-zoom, .at-graph-legend')) return;
      drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current; if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
      setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
    },
    onPointerUp: () => {
      const d = drag.current; drag.current = null;
      if (d && !d.moved) onBackground?.();
    },
  };
  return { wrap, view, fit, zoomBy, bind };
}

function ZoomBar({ k, zoomBy, fit }: { k: number; zoomBy: (f: number) => void; fit: () => void }) {
  return (
    <div className="at-zoom">
      <IconButton icon={IZoomOut} label="Zoom out" kbd="⌘ −" size="sm" onClick={() => zoomBy(1 / 1.15)} />
      <button type="button" className="at-zoom-pct at-mono at-tnum" title="Reset to 100%" onClick={() => zoomBy(1 / k)}>{Math.round(k * 100)}%</button>
      <IconButton icon={IZoomIn} label="Zoom in" kbd="⌘ +" size="sm" onClick={() => zoomBy(1.15)} />
      <IconButton icon={IFit} label="Fit to view" kbd="⇧ 1" size="sm" onClick={fit} />
    </div>
  );
}

/* Arrowhead markers, one per edge tone. Colours come from CSS (.at-ar--*). */
const ARROW_KINDS = ['idle', 'done', 'active', 'warn', 'fail'] as const;
function ArrowDefs({ id }: { id: string }) {
  return (
    <defs>
      {ARROW_KINDS.map((k) => (
        <marker key={k} id={`${id}-${k}`} className={`at-ar at-ar--${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M1 1 L9 5 L1 9 Z" />
        </marker>
      ))}
    </defs>
  );
}
const arrowFor = (s: string) => s === 'done' ? 'done' : s === 'active' ? 'active' : s === 'failed' ? 'fail' : s === 'waiting' || s === 'blocked' ? 'warn' : 'idle';

/* ---------- Agent node (n8n-style card) ---------- */
const STATUS_WORD: Record<string, string> = { running: 'Working', waiting: 'Waiting', blocked: 'Blocked', failed: 'Failed', done: 'Done', idle: 'Idle', paused: 'Paused' };

export function AgentNode({ a, selected, dim, onSelect, onOpen, style, compact }: { a: Agent; selected?: boolean; dim?: boolean; onSelect?: () => void; onOpen?: () => void; style?: React.CSSProperties; compact?: boolean }) {
  const paused = useApp((s) => s.paused);
  const ts = tasks.filter((t) => t.agent === a.id);
  const shown = paused && a.status === 'running' ? 'paused' : a.status;
  const live = a.status === 'running' && !paused;
  const act = paused && a.status === 'running' ? 'Paused after current step' : a.activity;
  return (
    <button type="button" className={cx('at-node at-nn', selected && 'at-node--sel', dim && 'at-node--dim', compact && 'at-node--compact')} data-s={shown}
      style={style} onClick={onSelect} onDoubleClick={onOpen} aria-pressed={selected} aria-label={`${a.name}: ${act}`}>
      <span className="at-nn-port at-nn-port--in" aria-hidden />
      <span className="at-nn-port at-nn-port--out" aria-hidden />
      <div className="at-node-top">
        <RoleMark mark={a.mark} s={a.status} size="sm" />
        <span className="at-node-name at-trunc">{a.name}</span>
        {live && <Activity />}
      </div>
      <div className="at-node-act at-trunc">{act}</div>
      <div className="at-node-foot">
        <span className="at-nn-pill" data-s={shown}>{STATUS_WORD[shown] ?? shown}</span>
        {!compact && <span className="at-meter at-meter--segments" style={{ flex: 1 }}>{ts.map((t) => <span key={t.id} data-s={t.status} title={`${t.id} · ${t.title}`} />)}</span>}
        {!compact && <span className="at-mono at-subtle at-tnum">{ts.filter((t) => t.status === 'done').length}/{ts.length}</span>}
      </div>
    </button>
  );
}

/* ---------- Mission Control agent graph ---------- */
type EdgeState = 'done' | 'active' | 'waiting' | 'blocked' | 'failed' | 'pending';
interface GEdge { id: string; from: string; to: string; d: string; state: EdgeState; kind: 'dep' | 'delegate' }

const NW = 200, NH = 76, COLW = 260, ROWH = 110, GX = 56, GY = 96;
const ORCH_BOTTOM = 58;

/** Agent-level layout from the task dependency graph: an agent sits one column right of the agents it waits on. */
function agentLayout() {
  const workers = agents.filter((a) => a.id !== 'orch');
  const deps = new Map<string, Set<string>>(workers.map((a) => [a.id, new Set<string>()]));
  for (const t of tasks) for (const d of t.deps) {
    const from = tasks.find((x) => x.id === d)?.agent;
    if (from && from !== t.agent && deps.has(t.agent) && deps.has(from)) deps.get(t.agent)!.add(from);
  }
  const depth = new Map<string, number>();
  const dep = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const v = [...(deps.get(id) ?? [])].reduce((m, x) => Math.max(m, dep(x, seen) + 1), 0);
    depth.set(id, v); return v;
  };
  const cols: string[][] = [];
  for (const a of workers) (cols[dep(a.id)] ??= []).push(a.id);
  const pos: Record<string, { x: number; y: number }> = {};
  cols.forEach((c, i) => c?.forEach((id, j) => { pos[id] = { x: GX + i * COLW, y: GY + j * ROWH }; }));
  const ncol = Math.max(1, cols.length), nrow = Math.max(1, ...cols.map((c) => c?.length ?? 0));
  return { pos, deps, w: Math.max(800, GX * 2 + (ncol - 1) * COLW + NW), h: GY + (nrow - 1) * ROWH + NH + 40, workers };
}

const edgeState = (s?: string): EdgeState => s === 'done' ? 'done' : s === 'running' ? 'active' : s === 'failed' ? 'failed' : s === 'blocked' ? 'blocked' : s === 'waiting' ? 'waiting' : 'pending';

function edgesFor(L: ReturnType<typeof agentLayout>): GEdge[] {
  const out: GEdge[] = [];
  for (const a of L.workers) {
    const p = L.pos[a.id]; if (!p) continue;
    const px = p.x, py = p.y + NH / 2;
    // Delegation: drop from the orchestrator bar down a trunk, then curve into the root agent's input port.
    if (!(L.deps.get(a.id)?.size)) {
      const x0 = px - 30;
      out.push({ id: `d-${a.id}`, from: 'orch', to: a.id, kind: 'delegate', state: edgeState(a.status),
        d: `M${x0} ${ORCH_BOTTOM} V${py - 22} Q${x0} ${py} ${x0 + 22} ${py} H${px}` });
    }
    // Dependency: cubic bezier from the source's output port to this agent's input port.
    for (const from of L.deps.get(a.id) ?? []) {
      const q = L.pos[from]; if (!q) continue;
      const x1 = q.x + NW, y1 = q.y + NH / 2, dx = Math.max(40, (px - x1) * 0.5);
      out.push({ id: `${from}-${a.id}`, from, to: a.id, kind: 'dep', state: edgeState(agentById(from).status),
        d: `M${x1} ${y1} C${x1 + dx} ${y1} ${px - dx} ${py} ${px} ${py}` });
    }
  }
  return out;
}

export function AgentGraph({ onOpenAgent }: { onOpenAgent?: (id: string) => void }) {
  const sel = useApp((s) => s.agent);
  const paused = useApp((s) => s.paused);
  const [hover, setHover] = useState<string | null>(null);
  const L = agentLayout();
  const AG_W = L.w, AG_H = L.h, pos = L.pos;
  const { wrap, view, fit, zoomBy, bind } = usePanZoom(AG_W, AG_H);
  const edges = edgesFor(L);
  const focus = hover;
  const near = new Set<string>();
  if (focus) { near.add(focus); for (const e of edges) { if (e.from === focus) near.add(e.to); if (e.to === focus) near.add(e.from); } }
  const related = (e: GEdge) => !focus || e.from === focus || e.to === focus;
  const orch = agentById('orch');
  return (
    <div className="at-graph at-ngraph" ref={wrap} style={gridStyle(view)} onPointerDown={bind.onPointerDown} onPointerMove={bind.onPointerMove} onPointerUp={bind.onPointerUp}>
      <div className="at-graph-stage" style={{ width: AG_W, height: AG_H, transform: stageTransform(view) }}>
        <svg className="at-graph-svg" width={AG_W} height={AG_H} viewBox={`0 0 ${AG_W} ${AG_H}`} aria-hidden>
          <ArrowDefs id="ag-ar" />
          {edges.map((e) => (
            <g key={e.id} className={cx('at-edge-g', !related(e) && 'at-edge-g--dim', focus && related(e) && 'at-edge-g--hi', paused && 'at-edge-g--paused')} data-state={e.state} data-kind={e.kind}>
              <path d={e.d} className="at-edge" markerEnd={`url(#ag-ar-${arrowFor(e.state)})`} />
              {e.state === 'active' && <path d={e.d} className="at-edge-flow" />}
            </g>
          ))}
        </svg>
        <button type="button" className={cx('at-orch', sel === 'orch' && 'at-node--sel')} style={{ left: 16, top: 14, width: AG_W - 32 }}
          onClick={() => actions().selectAgent('orch')} onDoubleClick={() => onOpenAgent?.('orch')} onMouseEnter={() => setHover('orch')} onMouseLeave={() => setHover(null)}>
          <RoleMark mark="OR" s={orch.status} />
          <span className="at-node-name">{orch.name}</span>
          <span className="at-orch-act at-trunc">{paused ? 'Mission paused · agents finish their current step' : orch.activity}</span>
          <span style={{ flex: 1 }} />
          <span className="at-mono at-subtle">delegated {L.workers.length} · {tasks.length} tasks</span>
          <Activity paused={paused} />
        </button>
        {L.workers.map((w) => w.id).filter((id) => pos[id]).map((id) => (
          <div key={id} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)} style={{ position: 'absolute', left: pos[id].x, top: pos[id].y, width: NW, height: NH }}>
            <AgentNode a={agentById(id)} selected={sel === id} dim={!!focus && !near.has(id)}
              onSelect={() => actions().selectAgent(id)} onOpen={() => onOpenAgent?.(id)} style={{ width: NW, height: NH }} />
          </div>
        ))}
      </div>
      <div className="at-graph-legend">
        <span><i className="lg-del" />delegation</span>
        <span><i className="lg-dep" />dependency</span>
        <span><i className="lg-act" />live handoff</span>
        <span><i className="lg-wait" />waiting / gated</span>
        <span><i className="lg-fail" />failed</span>
      </div>
      <ZoomBar k={view.k} zoomBy={zoomBy} fit={fit} />
    </div>
  );
}

/* ---------- Task dependency graph (full screen) ---------- */
const SC = 188, TW = 168, TH = 54, ROW = 74, TOP = 60, LEFT = 20;

/** Lanes per agent (in agent order), one slot per task sharing a lane and phase. */
function taskLayout() {
  const order = agents.map((a) => a.id).filter((id) => tasks.some((t) => t.agent === id));
  const slots: Record<string, number> = {}; const cols: Record<string, number> = {};
  for (const id of order) {
    const byPhase: Record<number, number> = {};
    for (const t of tasks.filter((x) => x.agent === id)) { const n = byPhase[t.phase] ?? 0; slots[t.id] = n; byPhase[t.phase] = n + 1; }
    cols[id] = Math.max(1, ...Object.values(byPhase));
  }
  const laneX: Record<string, number> = {}; let c = 0;
  for (const id of order) { laneX[id] = c; c += cols[id]; }
  const phases = Math.max(1, ...tasks.map((t) => t.phase + 1));
  return { lanes: order.map((id) => ({ id, cols: cols[id] })), laneX, slots, w: LEFT * 2 + Math.max(1, c) * SC - (SC - TW), h: TOP + phases * ROW - (ROW - TH) + 16, phases };
}
let TL = taskLayout();
export const taskPos = (t: Task) => ({ x: LEFT + ((TL.laneX[t.agent] ?? 0) + (TL.slots[t.id] ?? 0)) * SC, y: TOP + t.phase * ROW });

function chain(id: string, dir: 'up' | 'down', acc = new Set<string>()) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return acc;
  const next = dir === 'up' ? t.deps : tasks.filter((x) => x.deps.includes(id)).map((x) => x.id);
  for (const n of next) if (!acc.has(n)) { acc.add(n); chain(n, dir, acc); }
  return acc;
}

export function TaskGraph({ selected, onSelect, critical }: { selected?: string; onSelect: (id?: string) => void; critical?: boolean }) {
  TL = taskLayout();
  const TG_W = TL.w, TG_H = TL.h, lanes = TL.lanes, laneX = TL.laneX;
  const last = [...tasks].sort((a, b) => b.phase - a.phase)[0]?.id ?? '';
  const { wrap, view, fit, zoomBy, bind } = usePanZoom(TG_W, TG_H, () => onSelect(undefined));
  const hi = useMemo(() => {
    if (critical) { const s = chain(last, 'up'); if (last) s.add(last); return s; }
    if (!selected) return null;
    const s = new Set<string>([selected]); chain(selected, 'up', s); chain(selected, 'down', s); return s;
  }, [selected, critical, last]);
  const edges = useMemo(() => {
    const out: { id: string; d: string; from: string; to: string; state: string }[] = [];
    const incoming: Record<string, number> = {};
    for (const t of tasks) {
      t.deps.forEach((dep) => {
        const s = tasks.find((x) => x.id === dep);
        if (!s) return;
        const a = taskPos(s), b = taskPos(t);
        const n = (incoming[t.id] = (incoming[t.id] ?? -1) + 1);
        const total = t.deps.length;
        const x1 = a.x + TW / 2, y1 = a.y + TH;
        const x2 = b.x + TW / 2 + (n - (total - 1) / 2) * 14, y2 = b.y;
        const my = (y1 + y2) / 2;
        const d = `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
        const state = s.status === 'done' ? (t.status === 'pending' || t.status === 'waiting' || t.status === 'blocked' ? 'ready' : 'done') : s.status === 'failed' ? 'failed' : s.status === 'running' ? 'active' : 'pending';
        out.push({ id: dep + '-' + t.id, d, from: dep, to: t.id, state });
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.map((t) => `${t.id}:${t.status}:${t.phase}`).join(',')]);
  return (
    <div className="at-tgraph at-ngraph" ref={wrap} style={gridStyle(view)} onPointerDown={bind.onPointerDown} onPointerMove={bind.onPointerMove} onPointerUp={bind.onPointerUp}>
      <div className="at-tgraph-stage" style={{ width: TG_W, height: TG_H, transform: stageTransform(view) }}>
        {lanes.map((l) => {
          const a = agentById(l.id);
          return (
            <div key={l.id} className="at-lane" style={{ left: LEFT + laneX[l.id] * SC - 10, width: l.cols * SC - (SC - TW) + 20, height: TG_H }}>
              <button type="button" className="at-lane-head" onClick={() => actions().selectAgent(l.id)}>
                <RoleMark mark={a.mark} s={a.status} size="sm" /><span className="at-trunc">{a.name}</span>
              </button>
            </div>
          );
        })}
        {Array.from({ length: TL.phases }, (_, p) => <span key={p} className="at-phase-tick at-mono" style={{ top: TOP + p * ROW + TH / 2 - 7 }}>{p + 1}</span>)}
        <svg className="at-graph-svg" width={TG_W} height={TG_H} aria-hidden>
          <ArrowDefs id="tg-ar" />
          {edges.map((e) => (
            <g key={e.id} className={cx('at-edge-g', hi && !(hi.has(e.from) && hi.has(e.to)) && 'at-edge-g--dim', hi && hi.has(e.from) && hi.has(e.to) && 'at-edge-g--hi')} data-state={e.state} data-kind="dep">
              <path d={e.d} className="at-edge" markerEnd={`url(#tg-ar-${arrowFor(e.state)})`} />
              {e.state === 'active' && <path d={e.d} className="at-edge-flow" />}
            </g>
          ))}
        </svg>
        {tasks.map((t) => {
          const p = taskPos(t);
          return (
            <button key={t.id} type="button" className={cx('at-tnode', selected === t.id && 'at-node--sel', hi && !hi.has(t.id) && 'at-node--dim')} data-s={t.status}
              style={{ left: p.x, top: p.y, width: TW, height: TH }} onClick={() => onSelect(t.id === selected ? undefined : t.id)}>
              <span className="at-tport at-tport--in" aria-hidden />
              <span className="at-tport at-tport--out" aria-hidden />
              <span className="at-row" style={{ gap: 6 }}>
                <span className="at-mono at-subtle">{t.id}</span>
                <span style={{ flex: 1 }} />
                {t.status === 'running' ? <Activity /> : <Dot s={t.status} />}
              </span>
              <span className="at-tnode-title">{t.title}</span>
            </button>
          );
        })}
      </div>
      <ZoomBar k={view.k} zoomBy={zoomBy} fit={fit} />
    </div>
  );
}

export function TaskChip({ t }: { t: Task }) {
  return <Tip label={`${t.title} · ${agentById(t.agent).name}`}><span className="at-badge at-badge--outline at-mono">{t.id}</span></Tip>;
}
export { agents };
