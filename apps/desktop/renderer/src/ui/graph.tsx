import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Task } from '../data/types';
import { agents, tasks, agentById } from '../data/source';
import { cx, Icon, RoleMark, Activity, Dot, IconButton, Tip } from './primitives';
import { IXCircle, IClock, ICheck, IZoomIn, IZoomOut, IFit, IWarn } from '../lib/icons';
import { actions, useApp } from '../lib/store';

/* ---------- shared: scale-to-fit stage ---------- */
function useFit(w: number, h: number, maxScale = 1) {
  const ref = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setK(Math.min(maxScale, (r.width - 8) / w, (r.height - 8) / h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);
  return { ref, k };
}

/* ---------- Agent node ---------- */
export function AgentNode({ a, selected, dim, onSelect, onOpen, style, compact }: { a: Agent; selected?: boolean; dim?: boolean; onSelect?: () => void; onOpen?: () => void; style?: React.CSSProperties; compact?: boolean }) {
  const paused = useApp((s) => s.paused);
  const ts = tasks.filter((t) => t.agent === a.id);
  const glyph = a.status === 'running' ? <Activity paused={paused} />
    : a.status === 'failed' ? <Icon as={IXCircle} size="sm" className="at-err" />
      : a.status === 'blocked' ? <Icon as={IWarn} size="sm" className="at-warn" />
        : a.status === 'waiting' ? <Icon as={IClock} size="sm" className="at-warn" />
          : a.status === 'done' ? <Icon as={ICheck} size="sm" className="at-ok" /> : <Dot s="idle" />;
  return (
    <button type="button" className={cx('at-node', selected && 'at-node--sel', dim && 'at-node--dim', compact && 'at-node--compact')} data-s={paused && a.status === 'running' ? 'paused' : a.status}
      style={style} onClick={onSelect} onDoubleClick={onOpen} aria-pressed={selected} aria-label={`${a.name}: ${a.activity}`}>
      <div className="at-node-top">
        <RoleMark mark={a.mark} s={a.status} size="sm" />
        <span className="at-node-name at-trunc">{a.name}</span>
        <span className="at-node-glyph">{glyph}</span>
      </div>
      <div className="at-node-act at-trunc">{paused && a.status === 'running' ? 'Paused after current step' : a.activity}</div>
      {!compact && (
        <div className="at-node-foot">
          <span className="at-meter at-meter--segments" style={{ flex: 1 }}>{ts.map((t) => <span key={t.id} data-s={t.status} title={`${t.id} · ${t.title}`} />)}</span>
          <span className="at-mono at-subtle at-tnum">{ts.filter((t) => t.status === 'done').length}/{ts.length}</span>
        </div>
      )}
    </button>
  );
}

/* ---------- Mission Control agent graph ---------- */
type EdgeState = 'done' | 'active' | 'waiting' | 'blocked' | 'failed' | 'pending';
interface GEdge { id: string; from: string; to: string; d: string; label: string; lx: number; ly: number; state: EdgeState; kind: 'dep' | 'delegate' }

const NW = 184, NH = 66, COLW = 256, ROWH = 108, GX = 40, GY = 92;

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
  return { pos, deps, w: Math.max(752, GX * 2 + (ncol - 1) * COLW + NW), h: GY + (nrow - 1) * ROWH + NH + 34, workers };
}

const edgeState = (s?: string): EdgeState => s === 'done' ? 'done' : s === 'running' ? 'active' : s === 'failed' ? 'failed' : s === 'blocked' ? 'blocked' : s === 'waiting' ? 'waiting' : 'pending';

function edgesFor(L: ReturnType<typeof agentLayout>): GEdge[] {
  const out: GEdge[] = [];
  const b = 58;
  for (const a of L.workers) {
    const p = L.pos[a.id]; if (!p) continue;
    if (!(L.deps.get(a.id)?.size)) out.push({ id: `d-${a.id}`, from: 'orch', to: a.id, kind: 'delegate', d: `M${p.x + 24} ${b} V${p.y}`, label: '', lx: 0, ly: 0, state: 'done' });
    for (const from of L.deps.get(a.id) ?? []) {
      const q = L.pos[from]; if (!q) continue;
      const x1 = q.x + NW, y1 = q.y + NH / 2, x2 = p.x, y2 = p.y + NH / 2, mx = (x1 + x2) / 2;
      out.push({ id: `${from}-${a.id}`, from, to: a.id, kind: 'dep', d: Math.abs(y1 - y2) < 2 ? `M${x1} ${y1} H${x2}` : `M${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, label: '', lx: 0, ly: 0, state: edgeState(agentById(from).status) });
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
  const { ref, k } = useFit(AG_W, AG_H, 1.12);
  const edges = edgesFor(L);
  const focus = hover ?? null;
  const related = (e: GEdge) => !focus || e.from === focus || e.to === focus;
  const orch = agentById('orch');
  return (
    <div className="at-graph" ref={ref}>
      <div className="at-graph-stage" style={{ width: AG_W, height: AG_H, transform: `translate(-50%, -50%) scale(${k})` }}>
        <svg className="at-graph-svg" width={AG_W} height={AG_H} viewBox={`0 0 ${AG_W} ${AG_H}`} aria-hidden>
          <defs>
            <marker id="at-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1 L7 4 L1 7" fill="none" stroke="context-stroke" strokeWidth="1.4" /></marker>
          </defs>
                    {edges.map((e) => (
            <g key={e.id} className={cx('at-edge-g', !related(e) && 'at-edge-g--dim', paused && 'at-edge-g--paused')} data-state={e.state} data-kind={e.kind}>
              <path d={e.d} className="at-edge" markerEnd={e.kind === 'dep' ? 'url(#at-arrow)' : undefined} />
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
            <AgentNode a={agentById(id)} selected={sel === id} dim={!!focus && focus !== id && !edges.some((e) => e.kind === 'dep' && ((e.from === focus && e.to === id) || (e.to === focus && e.from === id)))}
              onSelect={() => actions().selectAgent(id)} onOpen={() => onOpenAgent?.(id)} style={{ width: NW, height: NH }} />
          </div>
        ))}
        {edges.filter((e) => e.label).map((e) => (
          <span key={e.id} className={cx('at-elabel', !related(e) && 'at-elabel--dim')} data-state={e.state} style={{ left: e.lx, top: e.ly }}>{e.label}</span>
        ))}
      </div>
      <div className="at-graph-legend">
        <span><i className="lg-del" />delegation</span>
        <span><i className="lg-dep" />dependency</span>
        <span><i className="lg-act" />live handoff</span>
        <span><i className="lg-wait" />waiting / gated</span>
        <span><i className="lg-fail" />failed</span>
      </div>
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
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const fit = () => {
    const r = wrap.current?.getBoundingClientRect(); if (!r) return;
    const k = Math.min(1, (r.width - 32) / TG_W, (r.height - 32) / TG_H);
    setView({ k, x: Math.max(12, (r.width - TG_W * k) / 2), y: 8 });
  };
  useLayoutEffect(fit, []);
  useEffect(() => { const ro = new ResizeObserver(fit); if (wrap.current) ro.observe(wrap.current); return () => ro.disconnect(); }, []);
  const hi = useMemo(() => {
    if (critical) { const s = chain(last, 'up'); if (last) s.add(last); return s; }
    if (!selected) return null;
    const s = new Set<string>([selected]); chain(selected, 'up', s); chain(selected, 'down', s); return s;
  }, [selected, critical]);
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
        let d: string;
        if (Math.abs(x1 - x2) < 2) d = `M${x1} ${y1} V${y2}`;
        else {
          const cy = y2 - 11; const r = 7; const dir = x2 > x1 ? 1 : -1;
          d = `M${x1} ${y1} V${cy - r} Q${x1} ${cy} ${x1 + dir * r} ${cy} H${x2 - dir * r} Q${x2} ${cy} ${x2} ${cy + r} V${y2}`;
        }
        const state = s.status === 'done' ? (t.status === 'pending' || t.status === 'waiting' || t.status === 'blocked' ? 'ready' : 'done') : s.status === 'failed' ? 'failed' : s.status === 'running' ? 'active' : 'pending';
        out.push({ id: dep + '-' + t.id, d, from: dep, to: t.id, state });
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.map((t) => `${t.id}:${t.status}:${t.phase}`).join(',')]);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  return (
    <div className="at-tgraph" ref={wrap}
      onWheel={(e) => {
        const r = wrap.current!.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) {
          const k = Math.max(0.4, Math.min(1.8, view.k * (1 - e.deltaY * 0.002)));
          const mx = e.clientX - r.left, my = e.clientY - r.top;
          setView({ k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k });
        } else setView({ ...view, x: view.x - e.deltaX, y: view.y - e.deltaY });
      }}
      onPointerDown={(e) => { if ((e.target as HTMLElement).closest('.at-tnode')) return; drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { const d = drag.current; if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y })); }}
      onPointerUp={(e) => { const d = drag.current; drag.current = null; if (d && Math.abs(e.clientX - d.x) < 3 && Math.abs(e.clientY - d.y) < 3) onSelect(undefined); }}>
      <div className="at-tgraph-stage" style={{ width: TG_W, height: TG_H, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
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
          <defs><marker id="at-arrow2" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1 L7 4 L1 7" fill="none" stroke="context-stroke" strokeWidth="1.4" /></marker></defs>
          {edges.map((e) => (
            <g key={e.id} className={cx('at-edge-g', hi && !(hi.has(e.from) && hi.has(e.to)) && 'at-edge-g--dim', hi && hi.has(e.from) && hi.has(e.to) && 'at-edge-g--hi')} data-state={e.state} data-kind="dep">
              <path d={e.d} className="at-edge" markerEnd="url(#at-arrow2)" />
              {e.state === 'active' && <path d={e.d} className="at-edge-flow" />}
            </g>
          ))}
        </svg>
        {tasks.map((t) => {
          const p = taskPos(t);
          return (
            <button key={t.id} type="button" className={cx('at-tnode', selected === t.id && 'at-node--sel', hi && !hi.has(t.id) && 'at-node--dim')} data-s={t.status}
              style={{ left: p.x, top: p.y, width: TW, height: TH }} onClick={() => onSelect(t.id === selected ? undefined : t.id)}>
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
      <div className="at-zoom">
        <IconButton icon={IZoomOut} label="Zoom out" kbd="⌘ −" size="sm" onClick={() => setView((v) => ({ ...v, k: Math.max(0.4, v.k - 0.1) }))} />
        <span className="at-mono at-subtle at-tnum" style={{ width: 36, textAlign: 'center' }}>{Math.round(view.k * 100)}%</span>
        <IconButton icon={IZoomIn} label="Zoom in" kbd="⌘ +" size="sm" onClick={() => setView((v) => ({ ...v, k: Math.min(1.8, v.k + 0.1) }))} />
        <IconButton icon={IFit} label="Fit to view" kbd="⇧ 1" size="sm" onClick={fit} />
      </div>
    </div>
  );
}

export function TaskChip({ t }: { t: Task }) {
  return <Tip label={`${t.title} · ${agentById(t.agent).name}`}><span className="at-badge at-badge--outline at-mono">{t.id}</span></Tip>;
}
export { agents };
