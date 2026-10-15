import React, { useState } from 'react';
import type { IconType } from 'react-icons';
import { actions, useApp, type ScreenId } from '../lib/store';
import { agents, agentById, mission, missions, workspace, workspaces, checkpoints, tasks } from '../data/sample';
import { cx, Icon, IconButton, Tip, Kbd, RoleMark, Status, Badge, Menu, MenuItem, ContextMeter, Section, KV, Button, SampleTag, Activity, Dot } from '../ui/primitives';
import { DiffStat } from '../ui/code';
import { openRepository } from '../lib/workspace';
import {
  IHome, IWorkspaces, IMissions, IAgents, IReviews, IDeploy, IActivity, ISettings, ITerminal, IComputer, ISearch, IBranch, IChevronDown,
  IPause, IPlay, IStop, IBell, IPanelLeft, IPanelRight, IClose, IHistory, IUndo, IFolder, IPlus, IFileCode, 
  ICpu, IMaximize, IWarn, IFolderOpen,
} from '../lib/icons';

const nav: { id: ScreenId; label: string; icon: IconType; kbd?: string; badge?: number; also?: ScreenId[] }[] = [
  { id: 'home', label: 'Home', icon: IHome, kbd: '⌘ 1', also: ['welcome'] },
  { id: 'workspaces', label: 'Workspaces', icon: IWorkspaces },
  { id: 'mission', label: 'Missions', icon: IMissions, kbd: '⌘ 2', also: ['graph', 'create', 'report'] },
  { id: 'agent', label: 'Agents', icon: IAgents, kbd: '⌘ 3', also: ['studio'] },
  { id: 'review', label: 'Reviews', icon: IReviews, kbd: '⌘ 4', badge: 3 },
  { id: 'deploy', label: 'Deployments', icon: IDeploy, kbd: '⌘ 5' },
  { id: 'activity', label: 'Activity', icon: IActivity },
];
const tools: typeof nav = [
  { id: 'terminal', label: 'Terminal', icon: ITerminal, kbd: '⌃ `' },
  { id: 'computer', label: 'Browser & desktop', icon: IComputer },
];

/* ---------- Title bar / command region ---------- */
export function TitleBar() {
  const paused = useApp((s) => s.paused);
  const resolved = useApp((s) => s.resolved);
  const notifCount = 2 - Object.keys(resolved).length + 1;
  const repo = useApp((s) => s.repo);
  const A = actions();
  const wsName = repo?.name ?? 'storefront';
  const branch = repo ? (repo.branch ?? 'no git') : workspace.branch;
  const branchTip = repo
    ? (repo.isGit ? `HEAD ${repo.head}${repo.ahead != null ? ` · ${repo.ahead} ahead, ${repo.behind} behind upstream` : ''} · ${repo.dirty ? `${repo.dirty} changed` : 'clean'}` : repo.path)
    : 'HEAD a41f9c2 · 3 ahead of main · clean';
  return (
    <header className="at-titlebar">
      <div className="at-traffic" aria-hidden><i /><i /><i /></div>
      <Menu width={300} trigger={(open, t) => (
        <button type="button" className="at-tb-ws" onClick={t} aria-expanded={open}>
          <span className="at-tb-wsmark">{wsName.charAt(0).toUpperCase()}</span>
          {!repo && <span className="at-subtle at-tb-owner">acme /</span>}<span className="at-tb-wsname">{wsName}</span><Icon as={IChevronDown} size="sm" className="at-subtle" />
        </button>
      )}>
        {(close) => (
          <>
            <div className="at-label at-menu-label">Workspaces</div>
            {repo && <MenuItem icon={IFolderOpen} active hint="local" onClick={close}>{repo.name}</MenuItem>}
            {workspaces.map((w) => <MenuItem key={w.id} icon={IFolder} active={!repo && w.id === 'storefront'} hint={w.updated} onClick={() => { close(); if (repo || w.id !== 'storefront') A.set({ repo: null }); if (w.id !== 'storefront') A.toast({ tone: 'info', title: `Switched to ${w.name}`, body: 'Panel layout and active context restored from your last session.' }); }}>{w.name}</MenuItem>)}
            <div className="at-menu-sep" />
            <MenuItem icon={IPlus} kbd="⌘ O" onClick={() => { close(); openRepository(); }}>Open repository…</MenuItem>
          </>
        )}
      </Menu>
      <Tip label={branchTip}><span className="at-tb-branch"><Icon as={IBranch} size="sm" />{branch}</span></Tip>
      <span className="at-sep-v" />
      <button type="button" className="at-tb-mission" onClick={() => A.go('mission')}>
        {paused ? <Icon as={IPause} size="sm" className="at-warn" /> : <Activity />}
        <span className="at-mono at-subtle">{mission.id}</span>
        <span className="at-trunc">{mission.title}</span>
        <span className="at-meter at-meter--segments" style={{ width: 56 }}>{tasks.map((t) => <span key={t.id} data-s={t.status} />)}</span>
      </button>

      <button type="button" className="at-tb-search" onClick={() => A.set({ palette: true })}>
        <Icon as={ISearch} size="sm" /><span className="at-trunc">Search, run a command, or direct an agent</span><Kbd k="⌘ K" />
      </button>

      <div className="at-tb-right">
        <Tip label="storefront-staging · v214 · checks passing"><span className="at-tb-env"><Dot s="healthy" />staging</span></Tip>
        <Tip label="Default model · Pi runtime 0.9 (sample adapter)"><span className="at-tb-model"><Icon as={ICpu} size="sm" />Sonnet 5.5</span></Tip>
        <span className="at-sep-v" />
        <InspectorToggle />
        <span data-bell style={{ position: 'relative', display: 'inline-flex' }}>
          <IconButton icon={IBell} label="Notifications" onClick={() => A.set((s) => ({ notifications: !s.notifications }))} />
          {notifCount > 0 && <span className="at-tb-count">{notifCount}</span>}
        </span>
        <IconButton icon={paused ? IPlay : IPause} label={paused ? 'Resume all agents' : 'Pause all agents'} kbd="⌘ ⇧ ." pressed={paused}
          onClick={() => { A.set({ paused: !paused }); A.toast(paused ? { tone: 'info', title: 'Agents resumed', body: 'Each agent continues from its last step.' } : { tone: 'warning', title: 'Pausing all agents', body: 'Agents stop after their current step. Context and worktrees are kept.' }); }} />
        <IconButton icon={IStop} label="Stop mission…" danger onClick={() => A.toast({ tone: 'danger', title: 'Stop requires confirmation', body: 'Use Mission → Stop to cancel and choose a checkpoint to keep.' })} />
      </div>
    </header>
  );
}

function InspectorToggle() {
  const on = useApp((s) => s.inspector);
  const screen = useApp((s) => s.screen);
  if (!['mission', 'agent', 'activity'].includes(screen)) return null;
  return <IconButton icon={IPanelRight} label={on ? 'Hide inspector' : 'Show inspector'} kbd="⌘ ⌥ I" pressed={on} onClick={() => actions().set({ inspector: !on })} />;
}

/* ---------- Rail + expandable sidebar ---------- */
export function Rail() {
  const screen = useApp((s) => s.screen);
  const expanded = useApp((s) => s.sidebar);
  const sel = useApp((s) => s.agent);
  const A = actions();
  const item = (n: (typeof nav)[number]) => {
    const active = screen === n.id || !!n.also?.includes(screen);
    const btn = (
      <button key={n.id} type="button" className="at-rail-item" aria-current={active ? 'page' : undefined} onClick={() => A.go(n.id)}>
        <Icon as={n.icon} size="lg" />
        <span className="at-rail-label">{n.label}</span>
        {n.badge && <span className="at-rail-badge">{n.badge}</span>}
        {expanded && n.kbd && <span className="at-rail-kbd"><Kbd k={n.kbd} /></span>}
      </button>
    );
    return expanded ? btn : <Tip key={n.id} label={n.label} kbd={n.kbd} side="right" delay={250}>{btn}</Tip>;
  };
  return (
    <nav className={cx('at-rail', expanded && 'at-rail--open')} aria-label="Primary">
      <div className="at-rail-group">{nav.map(item)}</div>
      <div className="at-rail-div" />
      <div className="at-rail-group">{tools.map(item)}</div>
      {expanded && (
        <div className="at-side-ctx">
          <div className="at-label" style={{ padding: '14px 12px 6px' }}>{mission.id} · agents</div>
          {agents.filter((a) => a.status !== 'idle').map((a) => (
            <button key={a.id} type="button" className="at-side-agent" aria-selected={sel === a.id} onClick={() => A.go('agent', { agent: a.id })}>
              <RoleMark mark={a.mark} s={a.status} size="sm" />
              <span className="at-trunc">{a.name}</span>
              <span style={{ marginLeft: 'auto' }}>{a.status === 'running' ? <Activity /> : <Dot s={a.status} />}</span>
            </button>
          ))}
          <div className="at-label" style={{ padding: '16px 12px 6px' }}>Recent missions</div>
          {missions.slice(1, 4).map((m) => (
            <button key={m.id} type="button" className="at-side-agent" onClick={() => A.go(m.status === 'verified' ? 'report' : 'mission')}>
              <Dot s={m.status === 'verified' ? 'done' : m.status === 'failed' ? 'failed' : m.status === 'review' ? 'waiting' : 'idle'} />
              <span className="at-trunc">{m.title}</span>
            </button>
          ))}
        </div>
      )}
      <div style={{ flex: 1 }} />
      <div className="at-rail-group">
        {item({ id: 'settings', label: 'Settings', icon: ISettings, kbd: '⌘ ,' })}
        <Tip label={expanded ? 'Collapse sidebar' : 'Expand sidebar'} kbd="⌘ \" side="right">
          <button type="button" className="at-rail-item" onClick={() => A.set({ sidebar: !expanded })}><Icon as={IPanelLeft} size="lg" /><span className="at-rail-label">Collapse</span></button>
        </Tip>
        <button type="button" className="at-rail-item at-rail-user"><span className="at-rail-avatar">PS</span><span className="at-rail-label">premal@shahpremal.com</span></button>
      </div>
    </nav>
  );
}

/* ---------- Status bar ---------- */
export function StatusBar() {
  const paused = useApp((s) => s.paused);
  const drawer = useApp((s) => s.drawer);
  const A = actions();
  const counts = { running: 0, waiting: 0, blocked: 0, failed: 0 } as Record<string, number>;
  agents.forEach((a) => { if (a.status in counts) counts[a.status]++; });
  return (
    <footer className="at-statusbar">
      <span className="at-sb-item"><Dot s="connected" />Pi runtime · sample adapter</span>
      <SampleTag>Prototype · sample data</SampleTag>
      <span className="at-sep-v" style={{ margin: '6px 2px' }} />
      <button type="button" className={cx('at-sb-item at-sb-btn', drawer === 'activity' && 'at-sb-btn--on')} onClick={() => A.set({ drawer: drawer === 'activity' ? null : 'activity' })}>
        {paused ? <Icon as={IPause} size="sm" className="at-warn" /> : <Activity />}
        <span>{paused ? 'Paused' : `${counts.running} working`}</span>
        <span className="at-warn">{counts.waiting + counts.blocked} waiting</span>
        <span className="at-err">{counts.failed} failed</span>
        <Kbd k="⌘ J" />
      </button>
      <span style={{ flex: 1 }} />
      <button type="button" className={cx('at-sb-item at-sb-btn', drawer === 'checkpoints' && 'at-sb-btn--on')} onClick={() => A.set({ drawer: drawer === 'checkpoints' ? null : 'checkpoints' })}>
        <Icon as={IHistory} size="sm" />CP-9 · 2m ago
      </button>
      <span className="at-sb-item at-mono at-tnum">1.42M tok</span>
      <span className="at-sb-item at-mono at-tnum">$3.18</span>
      <span className="at-sb-item at-mono at-tnum">14:32</span>
    </footer>
  );
}

/* ---------- Context inspector (selected agent) ---------- */
export function Inspector() {
  const id = useApp((s) => s.agent);
  const paused = useApp((s) => s.paused);
  const a = agentById(id);
  const A = actions();
  const [hoverFile, setHoverFile] = useState<string | null>(null);
  const myTasks = tasks.filter((t) => t.agent === a.id);
  return (
    <aside className="at-inspector" aria-label="Context inspector">
      <div className="at-phead">
        <span className="at-label">Inspector</span><span className="at-spacer" />
        <IconButton icon={IMaximize} label="Open agent detail" size="sm" onClick={() => A.go('agent')} />
        <IconButton icon={IPanelRight} label="Hide inspector" kbd="⌘ ⌥ I" size="sm" onClick={() => A.set({ inspector: false })} />
      </div>
      <div className="at-pbody">
        <div className="at-insp-head" key={a.id}>
          <RoleMark mark={a.mark} s={a.status} size="lg" />
          <div className="at-col" style={{ gap: 2, flex: 1 }}>
            <div className="heading at-trunc">{a.name}</div>
            <Status s={a.status === 'running' && paused ? 'paused' : a.status} paused={paused} label={<span className="at-trunc">{a.status === 'idle' ? 'Idle' : `${a.status === 'running' ? (paused ? 'Paused' : 'Working') : a.status[0].toUpperCase() + a.status.slice(1)} · ${a.elapsed}`}</span>} />
          </div>
        </div>
        {a.blocker && (
          <div style={{ padding: '0 16px 12px' }}>
            <div className={cx('at-callout', a.status !== 'failed' && 'at-callout--warning')} style={a.status === 'failed' ? { background: 'var(--danger-wash)', boxShadow: 'inset 0 0 0 1px rgba(208, 138, 127,0.25)' } : undefined}>
              <Icon as={IWarn} className={a.status === 'failed' ? 'at-err' : undefined} /><div><b>{a.status === 'failed' ? 'Failure' : 'Blocker'}</b> · {a.blocker}{a.status === 'failed' && <div style={{ marginTop: 8 }}><Button size="sm" onClick={() => A.set({ recovery: true })}>Open diagnostic</Button></div>}</div>
            </div>
          </div>
        )}
        <Section label="Objective">
          <p className="at-insp-obj">{a.assignment}</p>
          <div className="at-row" style={{ gap: 4, marginTop: 8, flexWrap: 'wrap' }}>{myTasks.map((t) => <Badge key={t.id} tone={t.status === 'done' ? 'outline' : t.status === 'running' ? 'accent' : t.status === 'failed' ? 'danger' : t.status === 'pending' ? 'outline' : 'warning'}><span className="at-mono">{t.id}</span></Badge>)}</div>
        </Section>
        <Section label="Context usage"><ContextMeter used={a.context.used} limit={a.context.limit} /></Section>
        <Section label="Environment">
          <KV rows={[['Model', a.model], ['Runs in', a.environment], ['Worktree', <span className="at-mono">{a.worktree}</span>], ['Branch', <span className="at-mono">{a.branch}</span>], ['Parent', a.parent ? agentById(a.parent).name : '—']]} />
        </Section>
        {a.permissions.length > 0 && (
          <Section label="Execution permission" aside={<button type="button" className="at-link" onClick={() => A.go('settings')}>Edit</button>}>
            <div className="at-perms">
              {a.permissions.map((p) => (
                <div key={p.scope} className="at-perm" data-l={p.level}>
                  <span className="at-perm-level">{p.level}</span><span className="at-perm-scope">{p.scope}</span><span className="at-perm-detail at-trunc" title={p.detail}>{p.detail}</span>
                </div>
              ))}
            </div>
          </Section>
        )}
        <Section label="Tools"><div className="at-row" style={{ flexWrap: 'wrap', gap: 4 }}>{a.tools.map((t) => <Badge key={t} tone="outline"><span className="at-mono">{t}</span></Badge>)}</div></Section>
        {a.files.length > 0 && (
          <Section label="Files touched" aside={<span className="at-mono at-subtle">{a.files.length}</span>}>
            <div className="at-files">
              {a.files.map((f) => (
                <button key={f.path} type="button" className="at-file" onMouseEnter={() => setHoverFile(f.path)} onMouseLeave={() => setHoverFile(null)} onClick={() => A.go('review')}>
                  <Icon as={IFileCode} size="sm" className="at-subtle" />
                  <span className="at-mono at-trunc">{f.path}</span>
                  <DiffStat add={f.add} del={f.del} blocks={false} />
                  {hoverFile === f.path && <span className="at-file-tip">{agentById(f.agent).name} · {f.task} {tasks.find((t) => t.id === f.task)?.title}</span>}
                </button>
              ))}
            </div>
          </Section>
        )}
        <Section label="Recent actions">
          <div className="at-recent">
            <div><span className="at-mono at-subtle">{a.lastAction.time}</span><span>{a.lastAction.text}</span></div>
            {a.id === 'be' && <>
              <div><span className="at-mono at-subtle">09:56:41</span><span>Ran <span className="at-mono">pnpm vitest run src/auth</span> · 33 passed</span></div>
              <div><span className="at-mono at-subtle">09:56:30</span><span>Requested approval AP-31</span></div>
            </>}
          </div>
        </Section>
        {a.artifacts.length > 0 && (
          <Section label="Verification evidence & artifacts">
            {a.artifacts.map((x) => <div key={x.name} className="at-artifact"><Icon as={IFileCode} size="sm" className="at-subtle" /><span className="at-mono">{x.name}</span><span className="at-subtle" style={{ marginLeft: 'auto', fontSize: 11.5 }}>{x.kind}</span></div>)}
          </Section>
        )}
      </div>
    </aside>
  );
}

/* ---------- Agent activity drawer ---------- */
export function ActivityDrawer() {
  const open = useApp((s) => s.drawer === 'activity');
  const paused = useApp((s) => s.paused);
  const A = actions();
  if (!open) return null;
  const ticks: Record<string, number[]> = { orch: [2, 9, 15, 31, 44, 52], be: [1, 4, 6, 9, 12, 18, 21, 25, 33, 38, 41, 47, 52, 55, 58], fe: [3, 8, 12, 19], sec: [5, 11, 14, 22, 29, 36, 43, 49, 54], qa: [10, 16, 24, 30, 37, 45, 50], ops: [28, 31] };
  return (
    <div className="at-drawer" role="region" aria-label="Agent activity">
      <div className="at-phead">
        <span className="at-label">Agent activity</span>
        <span className="at-mono at-subtle">last 15 min · each tick is one tool call</span>
        <span className="at-spacer" />
        <Button size="sm" variant="ghost" icon={paused ? IPlay : IPause} onClick={() => A.set({ paused: !paused })}>{paused ? 'Resume all' : 'Pause all'}</Button>
        <IconButton icon={IClose} label="Close" kbd="⌘ J" size="sm" onClick={() => A.set({ drawer: null })} />
      </div>
      <div className="at-drawer-body">
        {agents.filter((a) => a.status !== 'idle').map((a) => (
          <button key={a.id} type="button" className="at-drow2" onClick={() => A.selectAgent(a.id)}>
            <RoleMark mark={a.mark} s={a.status} size="sm" />
            <span className="at-drow2-name at-trunc">{a.name}</span>
            <span className="at-drow2-st"><Status s={paused && a.status === 'running' ? 'paused' : a.status} paused={paused} /></span>
            <span className="at-drow2-act at-trunc">{a.activity}</span>
            <span className="at-ticks">{(ticks[a.id] ?? []).map((t, i) => <i key={i} style={{ left: `${(t / 60) * 100}%` }} data-s={a.status} />)}</span>
            <span className="at-mono at-subtle at-tnum" style={{ textAlign: 'right' }}>{Math.round(a.tokens / 1000)}k</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- Checkpoint history ---------- */
export function CheckpointDrawer() {
  const open = useApp((s) => s.drawer === 'checkpoints');
  const [confirm, setConfirm] = useState<string | null>(null);
  const A = actions();
  if (!open) return null;
  return (
    <aside className="at-sheet" aria-label="Checkpoint history">
      <div className="at-phead"><span className="at-label">Checkpoints</span><span className="at-mono at-subtle">{mission.id}</span><span className="at-spacer" /><Button size="sm" variant="ghost" icon={IPlus}>Create now</Button><IconButton icon={IClose} label="Close" size="sm" onClick={() => A.set({ drawer: null })} /></div>
      <div className="at-pbody" style={{ padding: '8px 0' }}>
        {checkpoints.map((c, i) => (
          <div key={c.id} className="at-cp" data-first={i === 0}>
            <span className="at-cp-dot" />
            <div className="at-col" style={{ gap: 2, flex: 1 }}>
              <div className="at-row"><span className="at-mono at-acc">{c.id}</span><span style={{ fontWeight: 500 }} className="at-trunc">{c.label}</span></div>
              <div className="at-subtle" style={{ fontSize: 12 }}>{c.time} · {c.by} · {c.files} files · {c.note}</div>
              {confirm === c.id ? (
                <div className="at-cp-confirm">
                  <p>Restore <b>{c.id}</b>? Running agents pause first. {c.files || 4} files in 2 worktrees return to {c.time}. Database rows and deployed releases are <b>not</b> reverted.</p>
                  <div className="at-row" style={{ gap: 6 }}><Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button size="sm" variant="danger" icon={IUndo} onClick={() => { setConfirm(null); A.set({ drawer: null }); A.toast({ tone: 'warning', title: `Restored ${c.id}`, body: 'Agents paused. Review the plan before resuming.' }); }}>Restore {c.id}</Button></div>
                </div>
              ) : (
                <div className="at-row" style={{ gap: 6, marginTop: 6 }}>
                  <Button size="sm" variant="ghost" icon={IFileCode}>Compare</Button>
                  {i > 0 && <Button size="sm" variant="ghost" icon={IUndo} onClick={() => setConfirm(c.id)}>Restore…</Button>}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

export { Activity };
