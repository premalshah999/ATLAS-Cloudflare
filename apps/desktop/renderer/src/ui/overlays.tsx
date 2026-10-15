import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { IconType } from 'react-icons';
import { agents, agentById, approvals as allApprovals, mission, missions, live, workspace, reviewFiles, checkpoints, activity } from '../data/source';
import { actions, useApp, type ScreenId } from '../lib/store';
import { cx, Icon, Kbd, Button, IconButton, RoleMark, Seg, Badge, usePresence, Dot } from './primitives';
import {
  IHome, IMissions, IAgents, IReviews, IDeploy, ISettings, ITerminal, IComputer, IPlus, IPause, IPlay, IStop, IGraph,
  IHistory, ISearch, IShield, ICheck, IClose, ICopy, INetwork, IDatabase, IWarn, IXCircle, ICheckCircle, IInfo, IHand, IRetry, IFolder,
  ICpu, IRepo, IChevronRight, IEnter, IArrowUp, IArrowDown, IBell, ISpark, IWorkspaces, IFileDiff,
} from '../lib/icons';

/* ---------- Command palette ---------- */
interface Cmd { id: string; label: string; icon: IconType; group: string; kbd?: string; hint?: string; keywords?: string; run: () => void }

function score(q: string, text: string) {
  if (!q) return 1;
  const t = text.toLowerCase(); const s = q.toLowerCase();
  if (t.startsWith(s)) return 3;
  if (t.includes(s)) return 2;
  let i = 0; for (const ch of t) if (ch === s[i]) i++;
  return i === s.length ? 1 : 0;
}

export function CommandPalette() {
  const open = useApp((s) => s.palette);
  const screen = useApp((s) => s.screen);
  const paused = useApp((s) => s.paused);
  const { mounted, closing } = usePresence(open, 160);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const A = actions();
  const go = (s: ScreenId, extra = {}) => () => A.go(s, extra);
  const commands: Cmd[] = useMemo(() => {
    const ctx: Cmd[] = [];
    if (screen === 'mission' || screen === 'graph') {
      if (live.on) {
        for (const ap of A.get().approvals) ctx.push({ id: `c-ap-${ap.id}`, label: `Review pending approval · ${ap.action.slice(0, 60)}`, icon: IShield, group: 'Mission Control', kbd: '⌘ ↵', run: () => A.set({ palette: false, approvalDialog: ap.id }) });
        for (const f of agents.filter((x) => x.status === 'failed')) ctx.push({ id: `c-fail-${f.id}`, label: `Open failure diagnostic · ${f.assignment}`, icon: IXCircle, group: 'Mission Control', hint: f.name, run: () => A.set({ palette: false, recovery: true, agent: f.id }) });
      } else {
      ctx.push({ id: 'c-approve', label: 'Review pending approval · migration 0043', icon: IShield, group: 'Mission Control', kbd: '⌘ ↵', run: () => A.set({ palette: false, approvalDialog: 'AP-31' }) });
      ctx.push({ id: 'c-qa', label: 'Open QA failure diagnostic', icon: IXCircle, group: 'Mission Control', hint: 'logout clears session', run: () => A.set({ palette: false, recovery: true }) });
      }
      ctx.push({ id: 'c-pause', label: paused ? 'Resume mission' : 'Pause mission after current steps', icon: paused ? IPlay : IPause, group: 'Mission Control', kbd: '⌘ ⇧ P', run: () => { A.set({ palette: false, paused: !paused }); } });
    }
    if (screen === 'review') ctx.push({ id: 'c-next', label: 'Next changed file', icon: IArrowDown, group: 'Review', kbd: 'J', run: () => A.set({ palette: false }) }, { id: 'c-acc', label: 'Accept all changes in file', icon: ICheck, group: 'Review', kbd: '⌘ ⇧ A', run: () => A.set({ palette: false }) });
    if (screen === 'terminal') ctx.push({ id: 'c-split', label: 'Split terminal pane', icon: ITerminal, group: 'Terminal', kbd: '⌘ D', run: () => A.set({ palette: false }) });
    const liveCmds: Cmd[] = live.on ? [
      ...missions.map((m) => ({ id: `m-${m.id}`, label: `${m.title}`, icon: IMissions, group: 'Missions', hint: `${m.id} · ${m.status}`, run: () => A.go('mission', { missionId: (window as unknown as { __atlasMissionIds?: Record<string, string> }).__atlasMissionIds?.[m.id] ?? null }) })),
      ...agents.filter((a) => a.id !== 'orch').map((a) => ({ id: `a-${a.id}`, label: `${a.status === 'running' ? 'Direct' : 'Open'} ${a.name} · ${a.id}`, icon: IAgents, group: 'Agents', hint: a.status, run: () => A.go('agent', { agent: a.id }) })),
    ] : [];
    return [
      ...ctx,
      ...liveCmds,
      { id: 'new', label: 'Create new mission', icon: IPlus, group: 'Actions', kbd: '⌘ N', run: go('create') },
      { id: 'ws', label: 'Open workspace…', icon: IWorkspaces, group: 'Actions', kbd: '⌘ O', run: go('workspaces') },
      { id: 'repo', label: 'Switch repository', icon: IRepo, group: 'Actions', hint: live.on ? workspace.name : 'acme/storefront', run: go('workspaces') },
      { id: 'spawn', label: 'Spawn agent from template', icon: ISpark, group: 'Actions', run: go('studio') },
      { id: 'pauseall', label: 'Pause all agents', icon: IPause, group: 'Actions', kbd: '⌘ ⇧ .', run: () => { A.set({ palette: false, paused: true }); A.toast({ tone: 'warning', title: 'All agents pausing', body: 'Each agent stops after its current step. Nothing is discarded.' }); } },
      { id: 'term', label: 'Open terminal', icon: ITerminal, group: 'Actions', kbd: '⌃ `', run: go('terminal') },
      { id: 'review', label: 'Review pending changes', icon: IFileDiff, group: 'Actions', hint: live.on ? `${reviewFiles.length} files` : '6 files', run: go('review') },
      { id: 'deps', label: 'Show deployments', icon: IDeploy, group: 'Actions', run: go('deploy') },
      { id: 'verify', label: 'Run verification on staging', icon: ICheckCircle, group: 'Actions', run: go('deploy') },
      { id: 'cp', label: `Open recent checkpoint · ${live.on ? checkpoints[0]?.id ?? 'none' : 'CP-9'}`, icon: IHistory, group: 'Actions', run: () => A.set({ palette: false, drawer: 'checkpoints' }) },
      { id: 'model', label: live.on ? 'Change the model for a role tier' : 'Switch model for selected agent', icon: ICpu, group: 'Actions', hint: live.on ? '' : 'Claude Sonnet 5.5', run: go('settings') },
      { id: 'n-home', label: 'Home', icon: IHome, group: 'Go to', kbd: '⌘ 1', run: go('home') },
      { id: 'n-mc', label: 'Mission Control', icon: IMissions, group: 'Go to', kbd: '⌘ 2', run: go('mission') },
      { id: 'n-graph', label: 'Multi-agent graph', icon: IGraph, group: 'Go to', run: go('graph') },
      { id: 'n-agents', label: 'Agents', icon: IAgents, group: 'Go to', kbd: '⌘ 3', run: go('agent') },
      { id: 'n-review', label: 'Reviews', icon: IReviews, group: 'Go to', kbd: '⌘ 4', run: go('review') },
      { id: 'n-deploy', label: 'Deployments', icon: IDeploy, group: 'Go to', kbd: '⌘ 5', run: go('deploy') },
      { id: 'n-computer', label: 'Browser & desktop control', icon: IComputer, group: 'Go to', run: go('computer') },
      { id: 'n-studio', label: 'Agent Studio', icon: ISpark, group: 'Go to', run: go('studio') },
      { id: 'n-settings', label: 'Settings', icon: ISettings, group: 'Go to', kbd: '⌘ ,', run: go('settings') },
      ...agents.map((a) => ({ id: 'a-' + a.id, label: a.name, icon: IAgents, group: 'Agents', hint: a.status === 'idle' ? 'idle' : a.activity, keywords: '@' + a.mark, run: () => A.go('agent', { agent: a.id }) })),
    ];
  }, [screen, paused]);

  const results = useMemo(() => {
    const qq = q.startsWith('@') ? q.slice(1) : q;
    const pool = q.startsWith('@') ? commands.filter((c) => c.group === 'Agents') : commands;
    return pool.map((c) => ({ c, s: Math.max(score(qq, c.label), score(qq, c.keywords ?? '')) })).filter((x) => x.s > 0).sort((a, b) => (q ? b.s - a.s : 0)).map((x) => x.c);
  }, [q, commands]);
  useEffect(() => { setIdx(0); }, [q, open]);
  useEffect(() => { if (open) setQ(''); }, [open]);
  useEffect(() => { listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [idx]);
  if (!mounted) return null;
  const groups: Record<string, Cmd[]> = {};
  results.forEach((c) => { (groups[c.group] ??= []).push(c); });
  let n = -1;
  return (
    <>
      <div className="at-scrim" data-closing={closing} onMouseDown={() => A.set({ palette: false })} />
      <div className="at-palette" data-closing={closing} role="dialog" aria-label="Command palette">
        <div className="at-palette-input">
          <Icon as={ISearch} size="lg" className="at-subtle" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search commands, agents, files…  ( @ for agents )"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
              if (e.key === 'Enter') { e.preventDefault(); results[idx]?.run(); }
              if (e.key === 'Escape') A.set({ palette: false });
            }} />
          <span className="at-palette-scope"><Icon as={IFolder} size="sm" />{live.on ? workspace.name : 'storefront'}</span>
        </div>
        <div className="at-palette-list" ref={listRef}>
          {results.length === 0 && <div className="at-palette-empty">No command matches “{q}”. <span className="at-subtle">Press ↵ to ask Atlas instead.</span></div>}
          {Object.entries(groups).map(([g, cs]) => (
            <div key={g} className="at-palette-group">
              <div className="at-label at-palette-glabel">{g}</div>
              {cs.map((c) => {
                n++; const i = n;
                const ag = c.id.startsWith('a-') ? agentById(c.id.slice(2)) : null;
                return (
                  <button key={c.id} type="button" className="at-palette-item" data-active={i === idx} onMouseMove={() => setIdx(i)} onClick={() => c.run()}>
                    {ag ? <RoleMark mark={ag.mark} s={ag.status} size="sm" /> : <Icon as={c.icon} />}
                    <span className="at-trunc">{c.label}</span>
                    {c.hint && <span className="at-palette-hint at-trunc">{c.hint}</span>}
                    {c.kbd ? <Kbd k={c.kbd} /> : i === idx ? <Icon as={IEnter} size="sm" className="at-subtle" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="at-palette-foot">
          <span><Kbd k="↑" /><Kbd k="↓" /> navigate</span><span><Kbd k="↵" /> run</span><span><Kbd k="@" /> agents</span><span><Kbd k="esc" /> close</span>
          <span style={{ flex: 1 }} /><span className="at-subtle">{results.length} results</span>
        </div>
      </div>
    </>
  );
}

/* ---------- Approval: inline card ---------- */
const kindIcon: Record<string, IconType> = { shell: ITerminal, network: INetwork, filesystem: IFolder, sensitive: IShield, deployment: IDeploy, desktop: IHand, tool: ISpark, database: IDatabase };

export function ApprovalCard({ id, compact }: { id: string; compact?: boolean }) {
  const ap = useApp((s) => s.approvals.find((a) => a.id === id))!;
  const resolved = useApp((s) => s.resolved[id]);
  const scope = useApp((s) => s.scopes[id]);
  const a = agentById(ap.agent);
  return (
    <div className={cx('at-approval', resolved && 'at-approval--done')} data-risk={ap.risk}>
      <div className="at-approval-head">
        <Icon as={kindIcon[ap.kind] ?? IShield} size="sm" className={ap.risk === 'low' ? 'at-muted' : 'at-warn'} />
        <span className="at-approval-title at-trunc">{ap.title}</span>
        <span className="at-mono at-subtle">{ap.requestedAt}</span>
      </div>
      <div className="at-approval-who"><RoleMark mark={a.mark} size="sm" /><span className="at-trunc">{a.name}</span><span className="at-subtle">· {ap.duration.toLowerCase()}</span></div>
      <code className="at-approval-action at-trunc">{ap.action}</code>
      {!compact && <div className="at-approval-reason">{ap.reason}</div>}
      {resolved ? (
        <div className={cx('at-approval-verdict', resolved === 'approved' ? 'at-acc' : 'at-warn')}>{resolved === 'approved' ? <><Icon as={ICheck} size="sm" />Approved · {(scope || ap.duration).toLowerCase()}</> : <><Icon as={IClose} size="sm" />Denied</>}</div>
      ) : (
        <div className="at-row" style={{ gap: 6, marginTop: 10 }}>
          <Button size="sm" variant="primary" onClick={() => actions().set({ approvalDialog: id })}>Review</Button>
          <Button size="sm" variant="ghost" onClick={() => actions().resolve(id, 'denied')}>Deny</Button>
          <span style={{ flex: 1 }} />
          <Badge tone={ap.risk === 'low' ? 'outline' : 'warning'}>{ap.risk} risk</Badge>
        </div>
      )}
    </div>
  );
}

/* ---------- Approval: full dialog ---------- */
export function ApprovalDialog() {
  const id = useApp((s) => s.approvalDialog);
  const ap = allApprovals.find((a) => a.id === id) ?? null;
  const { mounted, closing } = usePresence(!!id, 160);
  const [dur, setDur] = useState<'once' | '30m' | 'mission'>('once');
  const [denying, setDenying] = useState(false);
  const durRef = useRef(dur); durRef.current = dur;
  const last = useRef(ap);
  if (ap) last.current = ap;
  const cur = last.current;
  useEffect(() => {
    if (!id) return;
    setDur(cur?.duration.startsWith('30') ? '30m' : 'once'); setDenying(false);
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') actions().set({ approvalDialog: null });
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { const d = durRef.current; actions().resolve(id, 'approved', d === 'once' ? 'This command, once' : d === '30m' ? 'For 30 minutes' : `Until ${mission.id} ends`); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [id]);
  if (!mounted || !cur) return null;
  const a = agentById(cur.agent);
  const scopeText = dur === 'once' ? 'This command, once' : dur === '30m' ? 'For 30 minutes' : `Until ${mission.id} ends`;
  return (
    <>
      <div className="at-scrim" data-closing={closing} onMouseDown={() => actions().set({ approvalDialog: null })} />
      <div className="at-dialog at-apd" data-closing={closing} role="alertdialog" aria-labelledby="apd-title">
        <div className="at-dialog-head">
          <span className="at-apd-icon" data-risk={cur.risk}><Icon as={kindIcon[cur.kind] ?? IShield} /></span>
          <div className="at-col" style={{ gap: 2, flex: 1 }}>
            <div id="apd-title" className="heading">{a.name} wants to {cur.title.charAt(0).toLowerCase() + cur.title.slice(1)}</div>
            <div className="at-subtle" style={{ fontSize: 12 }}>{cur.id} · requested {cur.requestedAt} · {mission.id} · T5</div>
          </div>
          <IconButton icon={IClose} label="Close" kbd="esc" onClick={() => actions().set({ approvalDialog: null })} />
        </div>
        <div className="at-apd-grid">
          <div className="at-apd-k">Agent</div>
          <div className="at-row"><RoleMark mark={a.mark} s={a.status} size="sm" /><span>{a.name}</span><span className="at-subtle">· {a.model}</span></div>
          <div className="at-apd-k">Exact action</div>
          <div className="at-apd-cmd"><code>{cur.kind === 'network' ? 'allow ' : '$ '}{cur.action}</code><IconButton icon={ICopy} label="Copy" size="sm" /></div>
          <div className="at-apd-k">Environment</div>
          <div>{cur.environment}</div>
          <div className="at-apd-k">Affects</div>
          <ul className="at-apd-list">{cur.resources.map((r) => <li key={r}>{r}</li>)}</ul>
          <div className="at-apd-k">Duration</div>
          <div className="at-row" style={{ gap: 10 }}>
            <Seg value={live.on ? 'once' : dur} onChange={setDur} items={live.on ? [{ id: 'once', label: 'Once' }] : [{ id: 'once', label: 'Once' }, { id: '30m', label: '30 min' }, { id: 'mission', label: 'This mission' }]} />
            <span className="at-subtle" style={{ fontSize: 12 }}>{scopeText}</span>
          </div>
          <div className="at-apd-k">Why you’re asked</div>
          <div className="at-muted">{cur.reason}</div>
        </div>
        {cur.risk !== 'low' && (
          <div style={{ padding: '0 16px 14px' }}>
            <div className="at-callout at-callout--warning">
              <Icon as={IWarn} />
              {live.on ? <div><b>This runs inside the agent’s sandboxed worktree.</b> It cannot touch your checkout; the result is reviewed and verified before anything is accepted.</div> : <div><b>Restoring a checkpoint won’t undo this.</b> CP-10 will snapshot the worktree first. Database rows written by the migration stay until <span className="at-mono">0043_family_index.down.sql</span> is run.</div>}
            </div>
          </div>
        )}
        {denying && (
          <div style={{ padding: '0 16px 14px' }}>
            <label className="at-input at-textarea"><textarea autoFocus rows={2} placeholder="Tell Backend Engineer what to do instead (optional)" defaultValue="Generate the index migration but don’t run it — I’ll apply it with the staging deploy." /></label>
          </div>
        )}
        <div className="at-dialog-foot">
          {denying
            ? <><Button variant="ghost" onClick={() => setDenying(false)}>Back</Button><span style={{ flex: 1 }} /><Button variant="danger" icon={IClose} onClick={() => actions().resolve(cur.id, 'denied')}>Deny with note</Button></>
            : <>
              <Button variant="ghost" onClick={() => setDenying(true)}>Deny…</Button>
              <Button variant="ghost" onClick={() => { actions().set({ approvalDialog: null }); actions().toast({ tone: 'info', title: 'Asked Security Engineer to review the request', body: 'You’ll be asked again with their note attached.' }); }}>Ask Security Engineer</Button>
              <span style={{ flex: 1 }} />
              <Button variant="primary" icon={ICheck} kbd="⌘ ↵" onClick={() => actions().resolve(cur.id, 'approved', scopeText)}>Approve {dur === 'once' ? 'once' : dur === '30m' ? 'for 30 min' : 'for mission'}</Button>
            </>}
        </div>
      </div>
    </>
  );
}

/* ---------- Toasts ---------- */
const toastIcon = { success: ICheckCircle, warning: IWarn, danger: IXCircle, info: IInfo, human: IHand };
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="at-toasts" aria-live="polite">
      {toasts.slice(-3).map((t) => (
        <div key={t.id} className="at-toast" data-tone={t.tone}>
          <Icon as={toastIcon[t.tone]} className={t.tone === 'success' ? 'at-ok' : t.tone === 'warning' ? 'at-warn' : t.tone === 'danger' ? 'at-err' : t.tone === 'human' ? 'at-human-c' : 'at-acc'} />
          <div className="at-toast-title">{t.title}</div>
          <IconButton icon={IClose} label="Dismiss" size="sm" onClick={() => actions().dismiss(t.id)} />
          {t.body && <div className="at-toast-body">{t.body}</div>}
          {t.action && <div className="at-row"><Button size="sm" onClick={() => { if (t.action?.screen) actions().go(t.action.screen); actions().dismiss(t.id); }}>{t.action.label}</Button></div>}
        </div>
      ))}
    </div>
  );
}

/* ---------- Notification center ---------- */
export function NotificationCenter() {
  const open = useApp((s) => s.notifications);
  const resolved = useApp((s) => s.resolved);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-bell]')) actions().set({ notifications: false }); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [open]);
  if (!open) return null;
  const pending = allApprovals.filter((a) => !resolved[a.id]);
  return (
    <div className="at-pop at-notif" ref={ref} style={{ right: 12, top: 44, width: 380, transformOrigin: 'top right' }}>
      <div className="at-row" style={{ padding: '8px 8px 6px', justifyContent: 'space-between' }}>
        <span className="at-ptitle" style={{ fontSize: 12.5, fontWeight: 600 }}>Notifications</span>
        <Button size="sm" variant="ghost">Mark all read</Button>
      </div>
      <div className="at-label" style={{ padding: '6px 8px' }}>Needs you · {pending.length + (live.on ? agents.filter((x) => x.status === 'failed').length : 1)}</div>
      {pending.map((ap) => {
        const a = agentById(ap.agent);
        return (
          <button key={ap.id} type="button" className="at-notif-item" onClick={() => actions().set({ notifications: false, approvalDialog: ap.id })}>
            <Icon as={IShield} className="at-warn" />
            <span className="at-col" style={{ gap: 1 }}><span className="at-ink">{ap.title}</span><span className="at-subtle at-trunc" style={{ fontSize: 12 }}>{a.name} · <span className="at-mono">{ap.action}</span></span></span>
            <span className="at-mono at-subtle">{ap.requestedAt.slice(0, 5)}</span>
          </button>
        );
      })}
      {live.on ? agents.filter((x) => x.status === 'failed').map((f) => (
        <button key={f.id} type="button" className="at-notif-item" onClick={() => actions().set({ notifications: false, recovery: true, agent: f.id, screen: 'mission' })}>
          <Icon as={IXCircle} className="at-err" />
          <span className="at-col" style={{ gap: 1 }}><span className="at-ink">{f.name} failed {f.id}</span><span className="at-subtle at-trunc" style={{ fontSize: 12 }}>{f.blocker ?? f.activity}</span></span>
          <span className="at-mono at-subtle">{f.lastAction.time.slice(0, 5)}</span>
        </button>
      )) : <button type="button" className="at-notif-item" onClick={() => actions().set({ notifications: false, recovery: true, screen: 'mission' })}>
        <Icon as={IXCircle} className="at-err" />
        <span className="at-col" style={{ gap: 1 }}><span className="at-ink">QA Engineer failed T12</span><span className="at-subtle" style={{ fontSize: 12 }}>logout clears session · diagnostic ready</span></span>
        <span className="at-mono at-subtle">09:56</span>
      </button>}
      <div className="at-menu-sep" />
      <div className="at-label" style={{ padding: '6px 8px' }}>Earlier</div>
      {live.on && activity.slice(0, 5).map((x, i) => <div key={i} className="at-notif-item at-notif-item--quiet"><Icon as={x.kind === 'error' ? IXCircle : ICheckCircle} className={x.kind === 'error' ? 'at-err' : 'at-ok'} /><span className="at-col"><span className="at-trunc">{x.text}</span><span className="at-subtle" style={{ fontSize: 12 }}>{x.who} · {x.mission}</span></span><span className="at-mono at-subtle">{x.time}</span></div>)}
      {!live.on && <><div className="at-notif-item at-notif-item--quiet"><Icon as={ICheckCircle} className="at-ok" /><span className="at-col"><span>Regression test passed</span><span className="at-subtle" style={{ fontSize: 12 }}>refresh-reuse.spec · QA Engineer</span></span><span className="at-mono at-subtle">09:46</span></div>
      <div className="at-notif-item at-notif-item--quiet"><Icon as={IFileDiff} className="at-muted" /><span className="at-col"><span>MSN-0141 ready for your review</span><span className="at-subtle" style={{ fontSize: 12 }}>9 files · Code Reviewer approved</span></span><span className="at-mono at-subtle">09:04</span></div></>}
    </div>
  );
}

export { Dot, IBell, IChevronRight, IArrowUp, IRetry, IStop };
