import React, { useState, type ReactNode } from 'react';
import { actions, adapter, useApp, useSimulation } from '../lib/store';
import { mission, terminals, timeline as baseTimeline, agentById, tasks, agents, pipeline, live } from '../data/source';
import { cx, Icon, Button, IconButton, Badge, Status, PanelHead, Tabs, Tip, Kbd, RoleMark, usePresence, Seg } from '../ui/primitives';
import { AgentGraph } from '../ui/graph';
import { Timeline, countByFilter, type TLFilter } from '../ui/timeline';
import { TerminalView, TermTabs } from '../ui/terminal';
import { ApprovalCard } from '../ui/overlays';
import { VerificationRow } from '../ui/verify';

import {
  IPause, IPlay, IHistory, IMaximize, IXCircle, IArrowRight, IRetry, IUndo, IHand, ICheck, IClose, IFilter, IRows, IMessage, ITerminal, IFileText,
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
          {paused ? <Badge tone="warning" icon={IPause}>Paused</Badge> : mission.status === 'running' ? <Badge tone="accent"><span className="at-act" style={{ width: 8, height: 8 }}><i /><i /><i /></span>Running · {mission.elapsed}</Badge>
            : <Badge tone={mission.status === 'failed' ? 'danger' : mission.status === 'review' ? 'warning' : mission.status === 'paused' ? 'warning' : 'success'}>{({ review: 'Ready for review', failed: 'Failed', done: 'Done', verified: 'Verified', paused: 'Awaiting plan approval', draft: 'Draft' } as Record<string, string>)[mission.status] ?? mission.status} · {mission.elapsed}</Badge>}
        </div>
        <div className="at-mobj">
          <span className="at-trunc">{mission.objective}</span>
        </div>
      </div>
      <div className="at-mhead-r">
        <div className="at-mstats">
          <Tip label="Tasks verified or complete"><span><b className="at-tnum">{done}</b><span className="at-subtle">/{tasks.length}</span> tasks</span></Tip>
          <span><b>{Math.max(0, agents.length - 1)}</b> agents</span>
          <Tip label="Input + output tokens across all agents"><span><b className="at-tnum">{mission.tokens}</b> tokens</span></Tip>
          <Tip label={live.on ? 'Tool calls executed through policy' : 'Model spend so far · budget $12.00'}><span><b className="at-tnum">{mission.compute}</b>{live.on ? '' : ' compute'}</span></Tip>
        </div>
        <div className="at-row" style={{ gap: 6 }}>
          <Tabs value={tab} onChange={(v) => A.go(v === 'control' ? 'mission' : v === 'graph' ? 'graph' : 'report')} className="at-mtabs"
            items={[{ id: 'control', label: 'Control' }, { id: 'graph', label: 'Task graph' }, { id: 'report', label: 'Report' }]} />
          <span className="at-sep-v" />
          <IconButton icon={IHistory} label="Checkpoints" onClick={() => A.set({ drawer: 'checkpoints' })} />
          {adapter && live.on && <Tip label="Evidence, changes, Cloudflare publish, deploy and terminal for this mission"><Button size="sm" icon={IFileText} data-testid="open-full-record" onClick={() => A.go('record')}>Full record</Button></Tip>}
          {adapter ? (mission.status === 'running' && <Button size="sm" icon={IPause} onClick={() => void adapter!.stop().catch((e: Error) => A.toast({ tone: 'danger', title: 'Could not stop', body: e.message }))}>Stop mission</Button>)
            : <Button size="sm" icon={paused ? IPlay : IPause} kbd="⌘ ⇧ P" onClick={() => A.set({ paused: !paused })}>{paused ? 'Resume' : 'Pause'}</Button>}
        </div>
      </div>
    </div>
  );
}

const STAGE: Record<string, 'passed' | 'failed' | 'warning' | 'pending' | 'running'> = { passed: 'passed', failed: 'failed', warning: 'warning', running: 'running', pending: 'pending', locked: 'pending' };

function NeedsYou() {
  const resolved = useApp((s) => s.resolved);
  const approvals = useApp((s) => s.approvals);
  const A = actions();
  const failed = agents.filter((x) => x.status === 'failed');
  const pending = approvals.filter((x) => !resolved[x.id]);
  if (!failed.length && !pending.length) {
    return <div className="at-needs-rail" role="status" aria-label="Needs you: nothing waiting"><span className="at-needs-count at-tnum">0</span></div>;
  }
  return (
    <div className="at-panel at-mc-needs">
      <PanelHead label="Needs you" count={failed.length + pending.length} />
      <div className="at-pbody at-needs">
        <div className="at-col" style={{ gap: 8, padding: 12 }}>
          {failed.map((f) => (
            <div key={f.id} className="at-error" style={{ animation: 'at-insert var(--dur-4) var(--ease-out) both' }}>
              <Icon as={IXCircle} />
              <h5>{f.assignment} · failed</h5>
              <p>{f.name}: {f.blocker ?? f.activity}</p>
              <div className="at-row" style={{ gap: 6 }}><Button size="sm" onClick={() => A.set({ recovery: true, agent: f.id })}>Recover…</Button><Button size="sm" variant="ghost" onClick={() => A.selectAgent(f.id)}>Inspect</Button></div>
            </div>
          ))}
          {approvals.map((ap, i) => <ApprovalCard key={ap.id} id={ap.id} compact={i > 0} />)}
          {!failed.length && !approvals.length && <p className="at-subtle" style={{ fontSize: 12, margin: 0 }}>Nothing is waiting for you.</p>}
        </div>
        <div className="at-label" style={{ padding: '6px 12px 4px' }}>Verification</div>
        <div style={{ padding: '0 0 8px' }}>
          {pipeline.filter((p) => p.id !== 'approval').map((p) => <VerificationRow key={p.id} label={p.name} value={p.summary} status={STAGE[p.status]} />)}
        </div>
      </div>
    </div>
  );
}

export function TerminalDock({ initial, tabs, hidden }: { initial?: string; tabs?: ReactNode; hidden?: boolean }) {
  const [active, setActive] = useState(initial ?? (terminals.find((t) => t.id === 't-qa') ?? terminals[0])?.id ?? '');
  const term = useApp((s) => s.term);
  const s = terminals.find((t) => t.id === active) ?? terminals[0];
  if (!s) return <div className="at-panel at-tdock" hidden={hidden}><PanelHead title={tabs} /><div className="at-pbody at-subtle" style={{ padding: 16, fontSize: 12 }}>No commands have run yet. Agent and operator processes appear here live.</div></div>;
  return (
    <div className="at-panel at-tdock" hidden={hidden}>
      <PanelHead title={tabs} />
      <TermTabs sessions={terminals} active={active} onSelect={setActive} />
      <div className="at-grow" style={{ display: 'flex', flexDirection: 'column' }}>
        <TerminalView key={s.id} s={s} extra={term[s.id]} focused />
      </div>
    </div>
  );
}

function TimelinePanel({ tabs, hidden }: { tabs?: ReactNode; hidden?: boolean }) {
  const events = useApp((s) => s.timeline);
  const [f, setF] = useState<TLFilter>('all');
  const [raw, setRaw] = useState(false);
  const c = countByFilter(events);
  const chips: [TLFilter, string][] = [['all', 'All'], ['decisions', 'Decisions'], ['files', 'Files'], ['issues', 'Issues'], ['approvals', 'Approvals'], ['verified', 'Verified']];
  return (
    <div className="at-panel at-mc-tl" hidden={hidden}>
      <PanelHead title={tabs}>
        <div className="at-row at-tl-chips" style={{ gap: 4 }}>
          {chips.map(([id, l]) => <button key={id} type="button" className="at-chip at-chip--xs" aria-pressed={f === id} onClick={() => setF(id)}>{l}<span className="at-count">{c[id]}</span></button>)}
        </div>
        <IconButton icon={IRows} label={raw ? 'Grouped view' : 'Raw event log'} size="sm" pressed={raw} onClick={() => setRaw(!raw)} />
      </PanelHead>
      <div className="at-pbody">
        {raw ? (
          <div className="at-rawlog">{events.map((e) => <div key={e.id}><span className="at-subtle">{e.time}</span> <span className="at-acc">{agentById(e.agent).mark.toLowerCase()}</span> <span className="at-muted">{e.kind.padEnd(10)}</span> {e.title}{e.meta ? <span className="at-subtle"> · {e.meta}</span> : null}</div>)}</div>
        ) : <Timeline events={events} filter={f} newFrom={live.on ? events.length : baseTimeline.length} />}
      </div>
    </div>
  );
}

export function MissionControl() {
  const A = actions();
  const [bottomTab, setBottomTab] = useState<'timeline' | 'terminals'>('timeline');
  const approvals = useApp((s) => s.approvals);
  const resolved = useApp((s) => s.resolved);
  const openCount = agents.filter((x) => x.status === 'failed').length + approvals.filter((x) => !resolved[x.id]).length;
  useSimulation(true);
  const tabs = (
    <Tabs<'timeline' | 'terminals'> value={bottomTab} onChange={setBottomTab} className="at-mc-tabs"
      items={[{ id: 'timeline', label: 'Timeline' }, { id: 'terminals', label: 'Terminals', count: terminals.length }]} />
  );
  return (
    <div className="at-screen at-mc">
      <MissionHeader tab="control" />
      <div className="at-mc-body">
        <div className={cx('at-mc-top', openCount === 0 && 'at-mc-top--calm')}>
          <div className="at-panel at-mc-graph">
            <PanelHead label="Workforce" title={<span className="at-subtle" style={{ fontWeight: 400 }}>delegation & dependencies · click to inspect, double-click to open</span>}>
              <IconButton icon={IMaximize} label="Open task graph" size="sm" onClick={() => A.go('graph')} />
            </PanelHead>
            <AgentGraph onOpenAgent={(id) => A.go('agent', { agent: id })} />
          </div>
          <NeedsYou />
        </div>
        <div className="at-mc-bottom">
          <TimelinePanel tabs={tabs} hidden={bottomTab !== 'timeline'} />
          <TerminalDock tabs={tabs} hidden={bottomTab !== 'terminals'} />
        </div>
      </div>
      <RecoveryDialog />
    </div>
  );
}

/* ---------- Failure recovery ---------- */
export function RecoveryDialog() {
  const open = useApp((s) => s.recovery);
  const agentId = useApp((s) => s.agent);
  const { mounted, closing } = usePresence(open, 160);
  const [pick, setPick] = useState('route');
  const A = actions();
  if (!mounted) return null;
  const close = () => A.set({ recovery: false });
  const f = agentById(agentId);
  const task = tasks.find((t) => t.agent === f.id);
  const options = [
    { id: 'route', title: 'Start a follow-up mission that fixes it', body: `A new mission gets this failure, its evidence and the mission's branch as context. ${live.on ? 'You approve its plan first.' : ''}`, meta: 'Recommended', icon: IArrowRight },
    { id: 'retry', title: 'Re-run verification', body: 'Run the gate again on the integrated revision: tests, API, browser and review checks.', meta: 'If the failure looks environmental', icon: IRetry },
    { id: 'rollback', title: 'Reject the change', body: 'Remove the mission’s isolated work. Your checkout was never touched.', meta: 'Discards this attempt', icon: IUndo },
    { id: 'takeover', title: 'Take over in a terminal', body: `Open a sandboxed shell in ${f.worktree} to inspect and fix it yourself.`, meta: 'Manual', icon: IHand },
  ];
  const run = async () => {
    close();
    if (pick === 'takeover') { A.go('terminal'); return; }
    if (!adapter) { A.toast({ tone: 'info', title: pick === 'route' ? 'Follow-up mission started' : pick === 'retry' ? 'Re-running verification' : 'Change rejected' }); return; }
    try {
      if (pick === 'route') await adapter.launch(`Fix the failure in "${mission.title}": ${f.assignment} failed — ${f.blocker ?? f.activity}. Investigate the root cause, fix it with a regression test, and keep every other check passing.`, { title: `Fix: ${(task?.title ?? f.assignment).slice(0, 60)}` });
      else if (pick === 'retry') await adapter.reverify();
      else await adapter.decide('reject');
    } catch (e) { A.toast({ tone: 'danger', title: 'Recovery failed', body: (e as Error).message }); }
  };
  return (
    <>
      <div className="at-scrim" data-closing={closing} onMouseDown={close} />
      <div className="at-dialog at-recovery" data-closing={closing} role="dialog" aria-labelledby="rec-title">
        <div className="at-dialog-head">
          <span className="at-apd-icon" style={{ color: 'var(--danger)', background: 'var(--danger-wash)', boxShadow: 'inset 0 0 0 1px rgba(208, 138, 127,0.35)' }}><Icon as={IXCircle} /></span>
          <div className="at-col" style={{ gap: 2, flex: 1 }}>
            <div id="rec-title" className="heading">{task?.id ?? f.id} failed: {task?.title ?? f.assignment}</div>
            <div className="at-subtle" style={{ fontSize: 12 }}>{f.name} · {f.lastAction.time} · {f.elapsed}</div>
          </div>
          <IconButton icon={IClose} label="Close" kbd="esc" onClick={close} />
        </div>
        <div className="at-rec-grid">
          <div className="at-col" style={{ gap: 12, minWidth: 0 }}>
            <div className="at-label">Evidence</div>
            <code className="at-approval-action" style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{f.blocker ?? f.activity}</code>
            <div className="at-label">Last action</div>
            <p className="at-rec-why">{f.lastAction.text}</p>
            {f.artifacts.length > 0 && <><div className="at-label">Artifacts</div><div className="at-row" style={{ gap: 6, flexWrap: 'wrap' }}>{f.artifacts.map((x) => <Badge key={x.name} tone="outline">{x.name}</Badge>)}</div></>}
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
          <Button variant={pick === 'takeover' ? 'human' : 'primary'} icon={pick === 'takeover' ? IHand : ICheck} kbd="⌘ ↵" onClick={() => void run()}>{pick === 'route' ? 'Start follow-up' : pick === 'retry' ? 'Re-run verification' : pick === 'rollback' ? 'Reject change' : 'Take over'}</Button>
        </div>
      </div>
    </>
  );
}

export { RoleMark, Status, Seg, Kbd, IFilter, IMessage, ITerminal, cx };
