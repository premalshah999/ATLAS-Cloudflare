import React, { useState } from 'react';
import { actions, useApp, useSimulation } from '../lib/store';
import { mission, terminals, timeline as baseTimeline, agentById, tasks } from '../data/sample';
import { cx, Icon, Button, IconButton, Badge, Status, PanelHead, Split, Tabs, Tip, Kbd, RoleMark, usePresence, Seg } from '../ui/primitives';
import { AgentGraph } from '../ui/graph';
import { Timeline, countByFilter, type TLFilter } from '../ui/timeline';
import { TerminalView, TermTabs } from '../ui/terminal';
import { ApprovalCard } from '../ui/overlays';
import { VerificationRow } from '../ui/verify';
import { CodeBlock } from '../ui/code';
import {
  IPause, IPlay, IHistory, IMaximize, IXCircle, IArrowRight, IRetry, IUndo, IHand, ICheck, IClose, IImage, IExternal, IFilter, IRows, IMessage, ITerminal,
} from '../lib/icons';

export function MissionHeader({ tab }: { tab: 'control' | 'graph' | 'report' }) {
  const paused = useApp((s) => s.paused);
  const A = actions();
  const done = tasks.filter((t) => t.status === 'done').length;
  return (
    <div className="at-mhead">
      <div className="at-mhead-l">
        <div className="at-row" style={{ gap: 10 }}>
          <span className="at-mid">{mission.id}</span>
          <h1 className="display at-mtitle">{mission.title}</h1>
          {paused ? <Badge tone="warning" icon={IPause}>Paused</Badge> : <Badge tone="accent"><span className="at-act" style={{ width: 8, height: 8 }}><i /><i /><i /></span>Running · {mission.elapsed}</Badge>}
        </div>
        <div className="at-mobj">
          <span className="at-trunc">{mission.objective}</span>
        </div>
      </div>
      <div className="at-mhead-r">
        <div className="at-mstats">
          <Tip label="Tasks verified or complete"><span><b className="at-tnum">{done}</b><span className="at-subtle">/{tasks.length}</span> tasks</span></Tip>
          <span><b>6</b> agents</span>
          <Tip label="Input + output tokens across all agents"><span><b className="at-tnum">1.42M</b> tokens</span></Tip>
          <Tip label="Model spend so far · budget $12.00"><span><b className="at-tnum">$3.18</b> compute</span></Tip>
        </div>
        <div className="at-row" style={{ gap: 6 }}>
          <Tabs value={tab} onChange={(v) => A.go(v === 'control' ? 'mission' : v === 'graph' ? 'graph' : 'report')} className="at-mtabs"
            items={[{ id: 'control', label: 'Control' }, { id: 'graph', label: 'Task graph' }, { id: 'report', label: 'Report' }]} />
          <span className="at-sep-v" />
          <IconButton icon={IHistory} label="Checkpoints" onClick={() => A.set({ drawer: 'checkpoints' })} />
          <Button size="sm" icon={paused ? IPlay : IPause} kbd="⌘ ⇧ P" onClick={() => A.set({ paused: !paused })}>{paused ? 'Resume' : 'Pause'}</Button>
        </div>
      </div>
    </div>
  );
}

function NeedsYou() {
  const resolved = useApp((s) => s.resolved);
  const term = useApp((s) => s.term);
  const A = actions();
  const open = 2 - Object.keys(resolved).length + 1;
  const unitDone = !!term['t-be'];
  return (
    <div className="at-panel" style={{ height: '100%' }}>
      <PanelHead label="Needs you" count={open} />
      <div className="at-pbody at-needs">
        <div className="at-col" style={{ gap: 8, padding: 12 }}>
          <div className="at-error" style={{ animation: 'at-insert var(--dur-4) var(--ease-out) both' }}>
            <Icon as={IXCircle} />
            <h5>T12 failed · logout clears session</h5>
            <p>QA Engineer: <span className="at-mono">__Host-session</span> survives logout. Diagnosis points to <span className="at-mono">Path=/api</span> (SEC-2).</p>
            <div className="at-row" style={{ gap: 6 }}><Button size="sm" onClick={() => A.set({ recovery: true })}>Recover…</Button><Button size="sm" variant="ghost" onClick={() => A.selectAgent('qa')}>Inspect</Button></div>
          </div>
          <ApprovalCard id="AP-31" />
          <ApprovalCard id="AP-32" compact />
        </div>
        <div className="at-label" style={{ padding: '6px 12px 4px' }}>Verification</div>
        <div style={{ padding: '0 0 8px' }}>
          <VerificationRow label="Unit · src/auth" value={unitDone ? '38 / 38' : 'running · 33 / 38'} status={unitDone ? 'passed' : 'running'} />
          <VerificationRow label="Reuse regression" value="1.8s" status="passed" />
          <VerificationRow label="semgrep owasp-top-ten" value="1 finding" status="warning" />
          <VerificationRow label="Browser QA · auth" value="11 / 12" status="failed" />
          <VerificationRow label="Staging deploy" value="gated" status="pending" />
        </div>
      </div>
    </div>
  );
}

export function TerminalDock({ initial = 't-qa' }: { initial?: string }) {
  const [active, setActive] = useState(initial);
  const term = useApp((s) => s.term);
  const s = terminals.find((t) => t.id === active)!;
  return (
    <div className="at-panel at-tdock" style={{ height: '100%' }}>
      <TermTabs sessions={terminals} active={active} onSelect={setActive} />
      <div className="at-grow" style={{ display: 'flex', flexDirection: 'column' }}>
        <TerminalView key={s.id} s={s} extra={term[s.id]} focused />
      </div>
    </div>
  );
}

function TimelinePanel() {
  const events = useApp((s) => s.timeline);
  const [f, setF] = useState<TLFilter>('all');
  const [raw, setRaw] = useState(false);
  const c = countByFilter(events);
  const chips: [TLFilter, string][] = [['all', 'All'], ['decisions', 'Decisions'], ['files', 'Files'], ['issues', 'Issues'], ['approvals', 'Approvals'], ['verified', 'Verified']];
  return (
    <div className="at-panel" style={{ height: '100%' }}>
      <PanelHead label="Timeline">
        <div className="at-row at-tl-chips" style={{ gap: 4 }}>
          {chips.map(([id, l]) => <button key={id} type="button" className="at-chip at-chip--xs" aria-pressed={f === id} onClick={() => setF(id)}>{l}<span className="at-count">{c[id]}</span></button>)}
        </div>
        <IconButton icon={IRows} label={raw ? 'Grouped view' : 'Raw event log'} size="sm" pressed={raw} onClick={() => setRaw(!raw)} />
      </PanelHead>
      <div className="at-pbody">
        {raw ? (
          <div className="at-rawlog">{events.map((e) => <div key={e.id}><span className="at-subtle">{e.time}</span> <span className="at-acc">{agentById(e.agent).mark.toLowerCase()}</span> <span className="at-muted">{e.kind.padEnd(10)}</span> {e.title}{e.meta ? <span className="at-subtle"> · {e.meta}</span> : null}</div>)}</div>
        ) : <Timeline events={events} filter={f} newFrom={baseTimeline.length} />}
      </div>
    </div>
  );
}

export function MissionControl() {
  const A = actions();
  useSimulation(true);
  return (
    <div className="at-screen at-mc">
      <MissionHeader tab="control" />
      <Split dir="v" id="mc-rows" initial={0.5} min={200}>
        <Split dir="h" id="mc-top" initial={0.69} min={420}>
          <div className="at-panel" style={{ height: '100%' }}>
            <PanelHead label="Workforce" title={<span className="at-subtle" style={{ fontWeight: 400 }}>delegation & dependencies · click to inspect, double-click to open</span>}>
              <IconButton icon={IMaximize} label="Open task graph" size="sm" onClick={() => A.go('graph')} />
            </PanelHead>
            <AgentGraph onOpenAgent={(id) => A.go('agent', { agent: id })} />
          </div>
          <NeedsYou />
        </Split>
        <Split dir="h" id="mc-bottom" initial={0.56} min={360}>
          <TimelinePanel />
          <TerminalDock />
        </Split>
      </Split>
      <RecoveryDialog />
    </div>
  );
}

/* ---------- Failure recovery ---------- */
const options = [
  { id: 'route', title: 'Route the fix to Backend Engineer', body: 'Set Path=/ in setSessionCookie (SEC-2), then QA re-runs T12 only. Keeps all other progress.', meta: 'Recommended · ~2 min', icon: IArrowRight },
  { id: 'retry', title: 'Retry the failing test', body: 'Re-run auth.spec.ts:62 three times. Already failed 3 / 3 — unlikely to be flaky.', meta: 'Low value', icon: IRetry },
  { id: 'rollback', title: 'Roll back to CP-9', body: 'Restore the worktrees to 09:55:20, before the cookie change. Database rows are not reverted.', meta: '4 files', icon: IUndo },
  { id: 'takeover', title: 'Take over in a terminal', body: 'Pause QA Engineer and open a human session in .atlas/wt/qa-auth with the trace loaded.', meta: 'Manual', icon: IHand },
];

export function RecoveryDialog() {
  const open = useApp((s) => s.recovery);
  const { mounted, closing } = usePresence(open, 160);
  const [pick, setPick] = useState('route');
  const A = actions();
  if (!mounted) return null;
  const close = () => A.set({ recovery: false });
  return (
    <>
      <div className="at-scrim" data-closing={closing} onMouseDown={close} />
      <div className="at-dialog at-recovery" data-closing={closing} role="dialog" aria-labelledby="rec-title">
        <div className="at-dialog-head">
          <span className="at-apd-icon" style={{ color: 'var(--danger)', background: 'var(--danger-wash)', boxShadow: 'inset 0 0 0 1px rgba(208, 138, 127,0.35)' }}><Icon as={IXCircle} /></span>
          <div className="at-col" style={{ gap: 2, flex: 1 }}>
            <div id="rec-title" className="heading">T12 failed: logout clears session</div>
            <div className="at-subtle" style={{ fontSize: 12 }}>QA Engineer · 09:56:12 · failed 3 of 3 runs · other 11 tests pass</div>
          </div>
          <IconButton icon={IClose} label="Close" kbd="esc" onClick={close} />
        </div>
        <div className="at-rec-grid">
          <div className="at-col" style={{ gap: 12, minWidth: 0 }}>
            <div className="at-label">Evidence</div>
            <div className="at-rec-evidence">
              <div className="at-rec-shot" aria-label="Screenshot placeholder">
                <div className="at-rec-shot-bar"><span /><span /><span /><em>localhost:3000/</em></div>
                <div className="at-rec-shot-body"><div className="at-skel" style={{ width: '40%', height: 8 }} /><div className="at-skel" style={{ width: '70%', height: 8, marginTop: 8 }} /><div className="at-rec-cookie">__Host-session · path /api · still set</div></div>
                <span className="at-rec-shot-cap"><Icon as={IImage} size="sm" />logout-after.png · sample</span>
              </div>
              <div className="at-col" style={{ gap: 6, minWidth: 0 }}>
                <code className="at-approval-action" style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>expect(cookie).toBeUndefined(){'\n'}Received {'{'} name: "__Host-session", path: "/api" {'}'}</code>
                <Button size="sm" variant="ghost" icon={IExternal}>Open Playwright trace</Button>
              </div>
            </div>
            <div className="at-label">Probable cause · from SEC-2</div>
            <CodeBlock compact title="src/middleware.ts" startLine={38} highlight={[42]} code={`export function setSessionCookie(res, token) {\n  res.cookies.set('__Host-session', token, {\n    httpOnly: true, secure: true, sameSite: 'lax',\n    path: '/api',\n  });`} />
            <p className="at-rec-why">The logout handler runs at <span className="at-mono">/</span> and can’t clear a cookie scoped to <span className="at-mono">/api</span>. Security Engineer flagged the same line at 09:55:09. Browsers also reject <span className="at-mono">__Host-</span> cookies whose path isn’t <span className="at-mono">/</span>.</p>
          </div>
          <div className="at-col" style={{ gap: 8, minWidth: 0 }}>
            <div className="at-label">Recover</div>
            {options.map((o) => (
              <button key={o.id} type="button" className="at-recopt" aria-pressed={pick === o.id} onClick={() => setPick(o.id)}>
                <span className="at-recopt-radio" />
                <span className="at-col" style={{ gap: 3, minWidth: 0 }}>
                  <span className="at-row" style={{ gap: 8 }}><Icon as={o.icon} size="sm" className="at-subtle" /><b>{o.title}</b></span>
                  <span className="at-recopt-body">{o.body}</span>
                  <span className="at-mono at-subtle" style={{ fontSize: 10.5 }}>{o.meta}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="at-dialog-foot">
          <span className="at-subtle" style={{ fontSize: 12 }}>Nothing runs until you choose. Other agents keep working.</span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={close}>Later</Button>
          <Button variant={pick === 'takeover' ? 'human' : 'primary'} icon={pick === 'takeover' ? IHand : ICheck} kbd="⌘ ↵" onClick={() => {
            close();
            if (pick === 'takeover') A.go('terminal');
            else A.toast({ tone: 'info', title: pick === 'route' ? 'Fix routed to Backend Engineer' : pick === 'retry' ? 'Retrying T12 · 3 runs' : 'Restoring CP-9', body: pick === 'route' ? 'SEC-2 attached as context. QA re-runs T12 when the change lands.' : undefined });
          }}>{pick === 'route' ? 'Route fix' : pick === 'retry' ? 'Retry test' : pick === 'rollback' ? 'Restore CP-9…' : 'Take over'}</Button>
        </div>
      </div>
    </>
  );
}

export { RoleMark, Status, Seg, Kbd, IFilter, IMessage, ITerminal, cx };
