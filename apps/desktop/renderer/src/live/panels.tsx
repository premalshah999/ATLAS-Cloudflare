// Mission panels for M2–M5 capabilities: task graph, review findings, browser QA, deployments,
// the virtual desktop, the operator terminal and the budget meter. All data comes from the daemon.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AtlasEvent, Deployment, DesktopAction, DesktopSessionInfo, Finding, Task } from '@atlas/contracts';
import { Badge, Button, cx, EmptyState, Icon, Input, Meter, RoleMark, Seg, Status, Tip } from '../ui/primitives';
import { ICamera, ICheck, IComputer, IDeploy, IGlobe, IHand, IImage, IPause, IPlay, IReviews, IStop, ITerminal, IUndo, IWarn, IXCircle } from '../lib/icons';
import { bridge, call, type MissionSnapshot } from './api';
import { fmtMs, roleMark, roleName, stateWord } from './format';
import { toast } from './toast';
import { attachGate } from './termSync';

const fail = (title: string) => (e: unknown) => toast({ tone: 'danger', title, body: (e as Error).message });
const taskStatus = (s: string) => ({ done: 'done', running: 'running', reviewing: 'running', failed: 'failed', cancelled: 'idle', blocked: 'waiting' } as Record<string, string>)[s] ?? 'draft';

// ---------------------------------------------------------------- task graph

/** The mission DAG: columns by dependency depth, delegated subtasks under their parent (dashed). */
export function TaskGraph({ snap }: { snap: MissionSnapshot }) {
  const { nodes, edges, width, height } = useMemo(() => {
    const byKey = new Map(snap.tasks.map((t) => [t.key, t]));
    const byId = new Map(snap.tasks.map((t) => [t.id, t]));
    const deps = (t: Task) => t.dependencies.map((d) => byKey.get(d) ?? byId.get(d)).filter((x): x is Task => !!x);
    const level = new Map<string, number>();
    const lv = (t: Task, seen = new Set<string>()): number => {
      if (level.has(t.id)) return level.get(t.id)!;
      if (seen.has(t.id)) return 0;
      seen.add(t.id);
      const parent = t.parentTaskId ? byId.get(t.parentTaskId) : undefined;
      const v = parent ? lv(parent, seen) + 1 : deps(t).reduce((m, d) => Math.max(m, lv(d, seen) + 1), 0);
      level.set(t.id, v);
      return v;
    };
    snap.tasks.forEach((t) => lv(t));
    const cols = new Map<number, Task[]>();
    for (const t of snap.tasks) cols.set(level.get(t.id)!, [...(cols.get(level.get(t.id)!) ?? []), t]);
    const W = 220, H = 64, GX = 64, GY = 18;
    const pos = new Map<string, { x: number; y: number }>();
    for (const [c, ts] of cols) ts.forEach((t, i) => pos.set(t.id, { x: 16 + c * (W + GX), y: 16 + i * (H + GY) }));
    const e: { from: string; to: string; delegated: boolean }[] = [];
    for (const t of snap.tasks) {
      for (const d of deps(t)) e.push({ from: d.id, to: t.id, delegated: false });
      if (t.parentTaskId) e.push({ from: t.parentTaskId, to: t.id, delegated: true });
    }
    const maxCol = Math.max(0, ...cols.keys());
    const maxRows = Math.max(1, ...[...cols.values()].map((x) => x.length));
    return { nodes: snap.tasks.map((t) => ({ t, ...pos.get(t.id)!, w: W, h: H })), edges: e.map((x) => ({ ...x, a: pos.get(x.from)!, b: pos.get(x.to)! })).filter((x) => x.a && x.b), width: 32 + (maxCol + 1) * (W + GX), height: 32 + maxRows * (H + GY) };
  }, [snap.tasks]);
  const integ = snap.mission.integrationCommit;
  if (!snap.tasks.length) return <EmptyState center icon={IReviews} title="No tasks yet" body="Tasks appear when the plan is approved." />;
  return (
    <div className="lv-scroll" data-testid="task-graph">
      <div className="lv-graph-meta at-subtle lv-small">
        {snap.tasks.length} task{snap.tasks.length === 1 ? '' : 's'} · arrows are dependencies, dashed arrows are delegations · {integ ? <>integrated at <span className="at-mono">{integ.slice(0, 7)}</span> on <span className="at-mono">{snap.mission.integrationBranch}</span></> : 'not integrated yet'}
      </div>
      <div className="lv-graph" style={{ width, height }}>
        <svg width={width} height={height} className="lv-graph-svg" aria-hidden>
          <defs><marker id="lv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker></defs>
          {edges.map((e, i) => {
            const x1 = e.a.x + 220, y1 = e.a.y + 32, x2 = e.b.x, y2 = e.b.y + 32, mx = (x1 + x2) / 2;
            return <path key={i} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`} className={cx('lv-edge', e.delegated && 'lv-edge--dele')} markerEnd="url(#lv-arrow)" />;
          })}
        </svg>
        {nodes.map(({ t, x, y, w, h }) => (
          <div key={t.id} className="lv-node" data-state={t.state} style={{ left: x, top: y, width: w, height: h }} data-testid="graph-node">
            <div className="at-row" style={{ gap: 6 }}>
              <RoleMark mark={roleMark(t.role)} size="sm" />
              <span className="lv-node-title at-trunc">{t.title}</span>
            </div>
            <div className="at-row lv-small" style={{ gap: 6 }}>
              <Status s={taskStatus(t.state)} label={stateWord(t.state)} />
              <span className="at-subtle at-trunc">{roleName(t.role)}{t.checkpoint ? ` · ${t.checkpoint.slice(0, 7)}` : ''}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- findings

const SEV_TONE: Record<string, 'danger' | 'warning' | 'outline'> = { high: 'danger', medium: 'warning', low: 'outline', info: 'outline' };

export function Findings({ snap, onLog }: { snap: MissionSnapshot; onLog: (artifactId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const finished = ['completed', 'failed'].includes(snap.mission.state);
  const update = (f: Finding, status: Finding['status']) => { setBusy(true); void call('finding.update', { findingId: f.id, status }).catch(fail('Finding not updated')).finally(() => setBusy(false)); };
  const blocking = snap.findings.filter((f) => f.kind === 'confirmed' && f.status === 'open' && ['high', 'medium'].includes(f.severity));
  return (
    <div className="lv-scroll" data-testid="findings">
      <div className="lv-evid">
        <div className="at-row" style={{ gap: 8, marginBottom: 12 }}>
          <div className="at-label" style={{ flex: 1 }}>Review findings</div>
          {finished && !snap.mission.decision && <Button size="sm" disabled={busy} onClick={() => { setBusy(true); void call('mission.reverify', { missionId: snap.mission.id }).catch(fail('Re-verification failed')).finally(() => setBusy(false)); }} data-testid="reverify">Re-run release gate</Button>}
        </div>
        <p className="at-muted lv-small" style={{ marginTop: 0 }}>
          A finding is <b>confirmed</b> only when the reviewer referenced a failing command ATLAS itself ran in that review; anything else is <b>suspected</b>. Open confirmed high or medium findings block release{blocking.length ? ` — ${blocking.length} blocking now` : ''}. Dismissing or accepting one is recorded as your decision.
        </p>
        {snap.findings.length === 0 && <EmptyState icon={IReviews} title="No findings" body="Reviewers report findings here with file, line, evidence and a reproduction when they have one." />}
        {snap.findings.map((f) => (
          <div key={f.id} className={cx('lv-finding', f.status !== 'open' && 'lv-finding--closed')} data-testid="finding" data-kind={f.kind} data-status={f.status}>
            <div className="at-row" style={{ gap: 8 }}>
              <Badge tone={SEV_TONE[f.severity]}>{f.severity}</Badge>
              <Badge tone={f.kind === 'confirmed' ? 'danger' : 'outline'}>{f.kind}</Badge>
              {f.source === 'security' && <Badge tone="warning">security scan</Badge>}
              <span className="body-strong at-trunc" style={{ flex: 1 }}>{f.title}</span>
              <span className="at-mono at-subtle lv-small">{f.file}{f.line ? `:${f.line}${f.endLine && f.endLine !== f.line ? `–${f.endLine}` : ''}` : ''}</span>
            </div>
            <div className="lv-finding-body">{f.observation}</div>
            {f.recommendation && <div className="lv-finding-body at-muted"><b>Recommendation:</b> {f.recommendation}</div>}
            <div className="lv-finding-body at-mono at-subtle lv-small">{f.evidence}</div>
            <div className="at-row" style={{ gap: 6, marginTop: 8 }}>
              <span className="at-subtle lv-small" style={{ flex: 1 }}>Status: {f.status} · confidence {Math.round(f.confidence * 100)}%</span>
              {f.reproductionArtifactId && <Button size="sm" variant="ghost" onClick={() => onLog(f.reproductionArtifactId!)}>View reproduction</Button>}
              {f.status === 'open' ? (
                <>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => update(f, 'dismissed')} data-testid="dismiss-finding">Dismiss</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => update(f, 'accepted')}>Accept risk</Button>
                  <Button size="sm" disabled={busy} onClick={() => update(f, 'fixed')}>Mark fixed</Button>
                </>
              ) : <Button size="sm" variant="ghost" disabled={busy} onClick={() => update(f, 'open')}>Reopen</Button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- screenshots

/** A PNG artifact as a data URL, or why it cannot be shown. */
function useArtifactImage(artifactId: string | null): { src: string | null; err: string | null } {
  const [state, setState] = useState<{ src: string | null; err: string | null }>({ src: null, err: null });
  useEffect(() => {
    if (!artifactId) { setState({ src: null, err: null }); return; }
    let live = true;
    setState({ src: null, err: null });
    void call('artifact.read', { artifactId }).then((r) => { if (!live) return; setState(r.base64 ? { src: `data:image/png;base64,${r.base64}`, err: null } : { src: null, err: r.intact ? 'Image too large to preview' : 'Artifact missing or altered' }); }).catch((e) => live && setState({ src: null, err: (e as Error).message }));
    return () => { live = false; };
  }, [artifactId]);
  return state;
}

export function Screenshot({ artifactId, alt }: { artifactId: string; alt: string }) {
  const { src, err } = useArtifactImage(artifactId);
  if (err) return <div className="lv-shot lv-shot--err at-subtle lv-small">{err}</div>;
  return src ? <img className="lv-shot" src={src} alt={alt} /> : <div className="lv-shot at-subtle lv-small">Loading…</div>;
}

// ---------------------------------------------------------------- visual proof (ADR 0027)

type VisualRow = { name: string; path: string; result: 'changed' | 'unchanged' | 'new' | 'broken' | 'missing'; percent: number | null; before: string | null; after: string | null; diff: string | null; note: string | null };
type VisualView = 'compare' | 'diff' | 'before' | 'after';

/** Before over after, split where the operator drags: the same page at the mission's base and at its result. */
function CompareSlider({ before, after, name }: { before: string; after: string; name: string }) {
  const b = useArtifactImage(before), a = useArtifactImage(after);
  const [at, setAt] = useState(50);
  if (b.err || a.err) return <div className="lv-shot lv-shot--err at-subtle lv-small">{b.err ?? a.err}</div>;
  if (!b.src || !a.src) return <div className="lv-shot at-subtle lv-small">Loading…</div>;
  return (
    <div className="lv-compare" data-testid="visual-compare">
      <div className="lv-compare__stage">
        <img className="lv-shot" src={a.src} alt={`${name} after`} />
        <img className="lv-compare__before" src={b.src} alt={`${name} before`} style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }} />
        <div className="lv-compare__line" style={{ left: `${at}%` }} />
      </div>
      <div className="lv-compare__bar lv-small at-subtle">
        <span>Before</span>
        <input type="range" min={0} max={100} value={at} aria-label="Before and after split" onChange={(e) => setAt(Number(e.target.value))} />
        <span>After</span>
      </div>
    </div>
  );
}

function VisualPage({ row }: { row: VisualRow }) {
  const both = !!(row.before && row.after);
  const [view, setView] = useState<VisualView>(row.diff ? 'diff' : both ? 'compare' : 'after');
  const shown = view === 'before' ? row.before : view === 'after' ? row.after : view === 'diff' ? row.diff : null;
  const tone = row.result === 'changed' ? 'accent' : row.result === 'broken' || row.result === 'missing' ? 'danger' : row.result === 'new' ? 'success' : 'outline';
  const label = row.result === 'changed' ? `${row.percent! >= 0.1 ? row.percent!.toFixed(1) : row.percent!.toFixed(2)}% changed` : row.result === 'unchanged' ? 'No visual change' : row.result === 'new' ? 'New page' : row.result === 'broken' ? 'Stopped rendering' : 'Not rendered';
  const items: { id: VisualView; label: string }[] = [
    ...(both ? [{ id: 'compare' as const, label: 'Compare' }] : []),
    ...(row.diff ? [{ id: 'diff' as const, label: 'Diff' }] : []),
    ...(row.before ? [{ id: 'before' as const, label: 'Before' }] : []),
    ...(row.after ? [{ id: 'after' as const, label: 'After' }] : []),
  ];
  return (
    <div className="lv-visual" data-testid="visual-page" data-result={row.result}>
      <div className="lv-visual__head">
        <span className="body-strong">{row.name}</span>
        {row.name !== row.path && <span className="at-mono at-subtle lv-small">{row.path}</span>}
        <Badge tone={tone}>{label}</Badge>
        <span style={{ flex: 1 }} />
        {items.length > 1 && <Seg items={items} value={view} onChange={setView} />}
      </div>
      {row.note && <p className="at-muted lv-small" style={{ margin: '4px 0 8px' }}>{row.note}</p>}
      {view === 'compare' && both ? <CompareSlider before={row.before!} after={row.after!} name={row.name} /> : shown ? <Screenshot artifactId={shown} alt={`${row.name} ${view}`} /> : null}
      {view === 'diff' && <p className="at-subtle lv-small" style={{ marginTop: 6 }}>Red marks every pixel that differs; the rest of the result is shown faded.</p>}
    </div>
  );
}

export function VisualPanel({ snap, events }: { snap: MissionSnapshot; events: AtlasEvent[] }) {
  const check = snap.checks.filter((c) => c.name === 'visual').at(-1);
  // The latest run per page (a re-verification renders the pages again).
  const rows = [...new Map(events.filter((e) => e.type === 'visual.page').map((e) => [String(e.payload.path), e.payload as unknown as VisualRow])).values()];
  if (!rows.length) return <EmptyState center icon={IImage} title="No visual comparison" body="When a project has an app section in atlas.config.json, ATLAS renders its pages at the mission's starting point and at the result, and shows what changed on screen." />;
  return (
    <div className="lv-scroll" data-testid="visual">
      <div className="lv-evid">
        <div className="at-label">What changed on screen</div>
        {check && <p className="at-muted" style={{ margin: '6px 0 16px' }} data-testid="visual-summary">{check.reason}</p>}
        {rows.map((r) => <VisualPage key={r.path} row={r} />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- browser QA

export function BrowserPanel({ snap, events }: { snap: MissionSnapshot; events: AtlasEvent[] }) {
  const steps = events.filter((e) => e.type === 'browser.step' && e.payload.phase !== 'app');
  const checks = snap.checks.filter((c) => /^(staging:)?(api|browser):/.test(c.name));
  const [open, setOpen] = useState<string | null>(null);
  if (!steps.length && !checks.length) return <EmptyState center icon={IGlobe} title="No browser or API checks" body="Add an app, api or browser section to atlas.config.json and ATLAS starts the app in the sandbox, checks its endpoints and drives its flows in an isolated browser." />;
  return (
    <div className="lv-scroll" data-testid="browser">
      <div className="lv-evid">
        <div className="at-label">Application checks</div>
        <table className="at-table" style={{ marginTop: 8 }}>
          <tbody>{checks.map((c) => <tr key={c.id}><td className="body-strong">{c.name}</td><td>{c.result}</td><td className="at-muted">{c.reason}</td><td className="at-mono at-muted">{fmtMs(c.durationMs)}</td></tr>)}</tbody>
        </table>
        <div className="at-label" style={{ marginTop: 20 }}>Browser steps</div>
        <div className="lv-steps">
          {steps.map((e) => (
            <div key={e.seq} className={cx('lv-step', !e.payload.ok && 'lv-step--fail')} data-testid="browser-step">
              <Icon as={e.payload.ok ? ICheck : IXCircle} size="sm" />
              <span className="at-mono">{String(e.payload.flow ?? 'agent')}</span>
              <span>{String(e.payload.action)}</span>
              <span className="at-subtle at-trunc" style={{ flex: 1 }}>{String(e.payload.message ?? '')}</span>
              {e.artifactIds[0] && <Button size="sm" variant="ghost" icon={ICamera} onClick={() => setOpen(open === e.artifactIds[0] ? null : e.artifactIds[0])}>Screenshot</Button>}
            </div>
          ))}
        </div>
        {open && <div style={{ marginTop: 12 }}><Screenshot artifactId={open} alt="Browser screenshot" /></div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- deployment

export function DeployPanel({ snap, events }: { snap: MissionSnapshot; events: AtlasEvent[] }) {
  const target = snap.mission.targetEnvironment;
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => { if (target) void call('deployment.list', { target }).then(setDeps).catch(() => {}); };
  useEffect(load, [target, events.length]);
  if (!target) return <EmptyState center icon={IDeploy} title="No staging target" body="This mission was not given a target environment, so nothing was deployed. Choose one in the mission composer; the target must be on your allowlist in Settings." />;
  const mine = deps.filter((d) => d.missionId === snap.mission.id);
  const staging = snap.checks.filter((c) => c.name === 'deploy' || c.name.startsWith('staging:'));
  const rollback = [...events].reverse().find((e) => e.type === 'rollback.result');
  const manifest = [...events].reverse().find((e) => e.type === 'staging.check');
  const doRollback = (d: Deployment) => {
    setBusy(true);
    void call('deployment.rollback', { deploymentId: d.id }).then((r) => toast({ tone: r.ok ? 'info' : 'danger', title: r.ok ? 'Rolled back' : 'Rollback failed', body: `${r.message}${r.revisionConfirmed === false ? ' — the served revision could not be confirmed.' : ''}` })).catch(fail('Rollback failed')).finally(() => { setBusy(false); load(); });
  };
  return (
    <div className="lv-scroll" data-testid="deploy">
      <div className="lv-evid">
        <div className="at-label">Staging · {target}</div>
        {mine.length === 0 && <p className="at-muted">This mission has not deployed. Deployment runs after build, tests, review and application checks pass, and only with your approval.</p>}
        <table className="at-table" style={{ marginTop: 8 }}>
          <thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
          <tbody>{staging.map((c) => <tr key={c.id} data-result={c.result}><td className="body-strong">{c.name}{c.required ? '' : <span className="at-subtle lv-small"> optional</span>}</td><td>{c.result}</td><td className="at-muted">{c.reason}</td></tr>)}</tbody>
        </table>
        {manifest && <p className="at-subtle lv-small">Verification manifest SHA-256 <span className="at-mono">{String(manifest.payload.manifestSha256)}</span> (artifact {manifest.artifactIds[0]}).</p>}
        {rollback && <div className="lv-callout"><Icon as={IUndo} /><div><b>Rollback.</b> {String(rollback.payload.message ?? rollback.payload.reason ?? '')}{rollback.payload.revisionConfirmed === true ? ' The served revision was re-read and matches.' : ''}</div></div>}
        <div className="at-label" style={{ marginTop: 20 }}>Deployment history for {target}</div>
        <table className="at-table" style={{ marginTop: 8 }}>
          <thead><tr><th>Deployment</th><th>Revision</th><th>Status</th><th>Verified</th><th>When</th><th /></tr></thead>
          <tbody>
            {deps.map((d) => (
              <tr key={d.id} data-testid="deployment-row">
                <td className="at-mono">{d.id}{d.missionId === snap.mission.id ? <Badge tone="accent">this mission</Badge> : null}</td>
                <td className="at-mono">{d.revision.slice(0, 12)}</td>
                <td>{d.status}{d.url ? <div className="at-subtle lv-small at-mono">{d.url}</div> : null}</td>
                <td>{d.verified ? 'yes' : 'no'}</td>
                <td className="at-muted lv-small">{new Date(d.createdAt).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>{d.status !== 'live' && d.verified && d.releaseDir && <Button size="sm" variant="ghost" disabled={busy} onClick={() => doRollback(d)}>Roll back to this</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="lv-callout"><Icon as={IWarn} /><div><b>Production is never deployed.</b> Only staging targets on your allowlist, one approval per deployment. A deployment is verified only when ATLAS reads back the exact revision and its checks pass against the deployed URL.</div></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- desktop

export function DesktopPanel({ snap, events }: { snap: MissionSnapshot; events: AtlasEvent[] }) {
  const [sessions, setSessions] = useState<DesktopSessionInfo[]>([]);
  const [frame, setFrame] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const live = sessions.find((s) => s.missionId === snap.mission.id);
  useEffect(() => { void call('desktop.list').then((d) => setSessions(d.sessions)).catch(() => {}); }, [events.length]);
  useEffect(() => {
    if (!live) { setFrame(null); return; }
    let stop = false;
    const tick = async () => {
      try { const f = await call('desktop.frame', { sessionId: live.id }); if (!stop) { setFrame(`data:image/png;base64,${f.png}`); setSessions((s) => s.map((x) => (x.id === f.info.id ? f.info : x))); } }
      catch {
        // The session ended: stop asking for its frames and drop it, instead of polling a session that is gone.
        if (!stop) { stop = true; setSessions((s) => s.filter((x) => x.id !== live.id)); }
        return;
      }
      if (!stop) window.setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => { stop = true; };
  }, [live?.id]);
  const control = (op: 'takeover' | 'release' | 'pause' | 'resume' | 'stop') => { if (!live) return; setBusy(true); void call('desktop.control', { sessionId: live.id, op }).then((i) => setSessions((s) => s.map((x) => (x.id === i.id ? i : x)))).catch(fail('Desktop control failed')).finally(() => setBusy(false)); };
  const input = (a: DesktopAction) => { if (!live) return; void call('desktop.input', { sessionId: live.id, input: a }).then((r) => { if (!r.ok) toast({ tone: 'danger', title: 'Input not sent', body: r.message }); }).catch(fail('Input not sent')); };
  const shots = events.filter((e) => e.type === 'desktop.action' && e.artifactIds.length);
  const [shot, setShot] = useState<string | null>(null);
  return (
    <div className="lv-scroll" data-testid="desktop">
      <div className="lv-evid">
        <div className="at-row" style={{ gap: 8 }}>
          <div className="at-label" style={{ flex: 1 }}>Virtual desktop</div>
          {live && <span data-testid="desktop-controller" data-controller={live.controller}><Badge tone={live.controller === 'agent' ? 'accent' : live.controller === 'operator' ? 'human' : 'warning'}>{live.controller === 'agent' ? 'agent in control' : live.controller === 'operator' ? 'you are in control' : live.controller}</Badge></span>}
        </div>
        {!live ? <p className="at-muted">No desktop session is running for this mission. A desktop operator task starts one only after you enable desktop control in Settings and approve the session.</p> : (
          <>
            <p className="at-subtle lv-small">{live.environment} · {live.inputs} inputs so far · started {new Date(live.startedAt).toLocaleTimeString()}</p>
            <div className="at-row" style={{ gap: 6, margin: '8px 0' }}>
              {live.controller !== 'operator' && <Button size="sm" variant="primary" icon={IHand} disabled={busy} onClick={() => control('takeover')} data-testid="desktop-takeover">Take over</Button>}
              {live.controller === 'operator' && <Button size="sm" disabled={busy} onClick={() => control('release')}>Hand back to agent</Button>}
              {live.controller === 'agent' && <Button size="sm" icon={IPause} disabled={busy} onClick={() => control('pause')} data-testid="desktop-pause">Pause</Button>}
              {live.controller === 'paused' && <Button size="sm" icon={IPlay} disabled={busy} onClick={() => control('resume')}>Resume agent</Button>}
              <Button size="sm" variant="danger" icon={IStop} disabled={busy} onClick={() => control('stop')}>Stop session</Button>
            </div>
            {frame && (
              <img className={cx('lv-desk', live.controller === 'operator' && 'lv-desk--live')} src={frame} alt="Virtual desktop" width={live.width} height={live.height}
                onClick={(e) => { if (live.controller !== 'operator') return; const r = e.currentTarget.getBoundingClientRect(); input({ action: 'click', x: Math.round(((e.clientX - r.left) / r.width) * live.width), y: Math.round(((e.clientY - r.top) / r.height) * live.height) }); }} />
            )}
            {live.controller === 'operator' && (
              <form className="at-row" style={{ gap: 6, marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (text) { input({ action: 'type', text }); setText(''); } }}>
                <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type into the focused window" style={{ flex: 1 }} />
                <Button size="sm" type="submit">Type</Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => input({ action: 'key', keys: 'Return' })}>Enter</Button>
              </form>
            )}
          </>
        )}
        <div className="at-label" style={{ marginTop: 20 }}>Recorded frames ({shots.length})</div>
        <div className="lv-steps">
          {shots.map((e) => <div key={e.seq} className={cx('lv-step', !e.payload.ok && 'lv-step--fail')}><Icon as={IComputer} size="sm" /><span>{String(e.payload.action)}</span><span className="at-subtle" style={{ flex: 1 }}>{String(e.payload.message ?? '')}</span><Button size="sm" variant="ghost" icon={ICamera} onClick={() => setShot(shot === e.artifactIds[0] ? null : e.artifactIds[0])}>View</Button></div>)}
        </div>
        {shot && <div style={{ marginTop: 12 }}><Screenshot artifactId={shot} alt="Recorded desktop frame" /></div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- operator terminal

export function TerminalPanel({ snap }: { snap: MissionSnapshot }) {
  const host = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<string>(snap.mission.integrationCommit ? 'integration' : snap.tasks.find((t) => t.worktree)?.id ?? '');
  const [session, setSession] = useState<{ sessionId: string; writable: boolean; worktree: string } | null>(null);
  const [ended, setEnded] = useState<number | null | undefined>(undefined);
  /** Detach from the view only: the shell keeps running in the daemon (P1-5). */
  const detach = useRef<(() => void) | null>(null);
  const resize = useRef<(() => void) | null>(null);
  /** Bumped by every attach/open and by unmount: a slower, older attempt disposes itself instead of leaking. */
  const gen = useRef(0);
  /** Until the session list is known, offering "Open terminal" would start a second shell beside a running one. */
  const [listed, setListed] = useState(false);
  const targets = [...(snap.mission.integrationCommit ? [{ id: 'integration', label: 'Integration branch' }] : []), ...snap.tasks.filter((t) => t.worktree).map((t) => ({ id: t.id, label: `${t.key} · ${t.title}` }))];

  const mountXterm = async () => {
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    await import('@xterm/xterm/css/xterm.css');
    detach.current?.();
    const t = new Terminal({ fontFamily: 'DejaVu Sans Mono, monospace', fontSize: 12.5, theme: { background: '#0e0f12' }, cursorBlink: true });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current!);
    fit.fit();
    return { t, fit };
  };

  const attach = async (sessionId: string, x?: Awaited<ReturnType<typeof mountXterm>>, my = ++gen.current) => {
    if (!host.current || !bridge) { x?.t.dispose(); return; }
    const { t, fit } = x ?? await mountXterm();
    if (my !== gen.current) { t.dispose(); return; }
    const gate = attachGate((d) => t.write(d), (code) => setEnded(code));
    // Subscribe before the snapshot, so nothing emitted in between is lost.
    const off = bridge.onTerminal((m) => { if (m.sessionId === sessionId) gate.push(m); });
    try {
      const a = await call('terminal.attach', { sessionId });
      if (my !== gen.current) { off(); t.dispose(); return; }
      gate.snapshot(a.snapshot, a.seq);
      setSession({ sessionId, writable: a.writable, worktree: a.worktree });
      setTarget(a.target);
      setEnded(undefined);
    } catch (e) { off(); t.dispose(); fail('Terminal not attached')(e); return; }
    const input = t.onData((d) => void call('terminal.input', { sessionId, data: d }).catch(() => {}));
    let pending: ReturnType<typeof setTimeout> | null = null;
    resize.current = () => {
      fit.fit();
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => void call('terminal.resize', { sessionId, cols: Math.max(20, t.cols), rows: Math.max(5, t.rows) }).catch(() => {}), 120);
    };
    resize.current();
    detach.current = () => { off(); input.dispose(); if (pending) clearTimeout(pending); resize.current = null; t.dispose(); detach.current = null; };
    t.focus();
  };

  const open = async () => {
    if (!host.current || !target) return;
    const my = ++gen.current;
    const x = await mountXterm();
    if (my !== gen.current) { x.t.dispose(); return; }
    try {
      const s = await call('terminal.open', { missionId: snap.mission.id, target, cols: Math.max(20, x.t.cols), rows: Math.max(5, x.t.rows) });
      await attach(s.sessionId, x, my);
    } catch (e) { x.t.dispose(); fail('Terminal not opened')(e); }
  };

  // Mounting again (another tab, a reload): re-attach to the mission's open session instead of starting a new one.
  useEffect(() => {
    let cancelled = false;
    setListed(false);
    void call('terminal.list', { missionId: snap.mission.id })
      .then((list) => { if (cancelled) return; setListed(true); const s = list.at(-1); if (s) void attach(s.sessionId); })
      .catch(() => { if (!cancelled) setListed(true); });
    return () => { cancelled = true; gen.current++; detach.current?.(); };
  }, [snap.mission.id]);
  const hasTargets = targets.length > 0;
  useEffect(() => {
    if (!host.current) return;
    const ro = new ResizeObserver(() => resize.current?.());
    ro.observe(host.current);
    return () => ro.disconnect();
  }, [hasTargets]);

  if (!targets.length) return <EmptyState center icon={ITerminal} title="No worktree to open" body="A terminal opens inside a task worktree or the integration branch, in the same sandbox as agent commands." />;
  return (
    <div className="lv-term-wrap" data-testid="terminal">
      <div className="at-row lv-term-bar" style={{ gap: 8 }}>
        <select className="lv-native-select" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!!session && ended === undefined}>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        {listed && (!session || ended !== undefined) && <Button size="sm" variant="primary" icon={ITerminal} onClick={() => void open()} data-testid="open-terminal">Open terminal</Button>}
        {session && ended === undefined && <Button size="sm" variant="ghost" onClick={() => void call('terminal.close', { sessionId: session.sessionId }).then(() => setEnded(null))} data-testid="close-terminal">Close</Button>}
        {session && <span className="at-subtle lv-small at-trunc">{session.writable ? 'writable' : 'read-only: an agent holds this worktree'} · sandboxed · <span className="at-mono">{session.worktree}</span>{ended !== undefined ? ` · exited${ended === null ? '' : ` ${ended}`}` : ''}</span>}
        <Tip label="Your keystrokes go to a PTY inside the OS sandbox. The shell keeps running when you switch views; Close ends it. Opening and closing it is recorded in the mission log."><span><Badge tone="human">operator</Badge></span></Tip>
      </div>
      <div className="lv-term" ref={host} />
    </div>
  );
}

// ---------------------------------------------------------------- budget

export function BudgetMeter({ snap }: { snap: MissionSnapshot }) {
  const b = snap.budget;
  const rows: [string, number, number, (n: number) => string][] = [
    ['Tokens', b.tokens, b.budget.maxTokens, (n) => n.toLocaleString()],
    ['Agents now', b.agentsNow, b.budget.maxConcurrentAgents, String],
    ['Tasks', b.tasks, b.budget.maxTasks, String],
    ['Wall clock', b.elapsedMs / 60000, b.budget.maxWallClockMinutes, (n) => `${n.toFixed(n < 10 ? 1 : 0)} min`],
  ];
  return (
    <div className="lv-budget" data-testid="budget">
      {rows.map(([label, v, max, f]) => (
        <div key={label} className="lv-budget-row">
          <span className="at-subtle lv-small">{label}</span>
          <Meter value={Math.min(v, max)} max={max} tone={v / max > 0.9 ? 'warning' : 'accent'} />
          <span className="at-mono lv-small at-tnum">{f(v)} / {f(max)}</span>
        </div>
      ))}
      <div className="at-subtle lv-small">Delegation depth ≤ {b.budget.maxDelegationDepth} · {b.toolCalls} tool calls</div>
    </div>
  );
}
