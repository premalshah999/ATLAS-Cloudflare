// Live mission view (manual §35–37): plan approval, live execution, approvals, process output, evidence.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Approval, AtlasEvent, CheckRecord, Task } from '@atlas/contracts';
import { Badge, Button, cx, EmptyState, Icon, PanelHead, RoleMark, Status, Tabs, Tip } from '../ui/primitives';
import { ICheck, ICheckCircle, IClock, IFileDiff, IShield, IStopCircle, ITerminal, IWarn, IXCircle, IUndo, IMerge, IFileText, ITube, ITree, IGraph, IReviews, IGlobe, IDeploy, IComputer, IMore, IDisk, IClose } from '../lib/icons';
import { Menu, MenuItem } from '../ui/primitives';
import { BrowserPanel, BudgetMeter, DeployPanel, DesktopPanel, Findings, TaskGraph, TerminalPanel } from './panels';
import { go, refreshLists } from './store';
import { call } from './api';
import { CloudPanel } from './cloud';
import { useMission } from './useMission';
import { describeEvent, fmtMs, markOf, resultWord, roleMark, roleName, stateWord, time, type Row } from './format';
import { toast } from './toast';

const ACTIVE = new Set(['planning', 'running', 'verifying']);
type Tab = 'cloud' | 'activity' | 'graph' | 'changes' | 'evidence' | 'findings' | 'browser' | 'deploy' | 'desktop' | 'terminal';

export function MissionView({ missionId }: { missionId: string }) {
  const { snap, events, error } = useMission(missionId);
  const [tab, setTab] = useState<Tab>('activity');
  const [log, setLog] = useState<{ name: string; text: string } | null>(null);
  const showLog = (artifactId: string) => void call('artifact.read', { artifactId }).then((r) => setLog({ name: r.artifact.name, text: r.text })).catch(() => {});
  const [busy, setBusy] = useState(false);
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast({ tone: 'danger', title: label, body: (e as Error).message }); } finally { setBusy(false); }
  };
  useEffect(() => { if (snap && ['completed', 'failed'].includes(snap.mission.state)) setTab((t) => (t === 'activity' ? 'evidence' : t)); }, [snap?.mission.state]);

  if (error) return <div className="at-screen lv-page"><EmptyState center icon={IXCircle} title="Mission unavailable" body={error} /></div>;
  if (!snap) return <div className="at-screen lv-page"><div className="lv-loading">Loading mission…</div></div>;
  const m = snap.mission;
  const pending = snap.approvals.filter((a) => a.status === 'pending');
  const gate = [...events].reverse().find((e) => e.type === 'gate.result');
  const verdict = gate?.payload.verdict as string | undefined;
  const finished = m.state === 'completed' || m.state === 'failed';
  const patchCount = snap.artifacts.filter((a) => a.kind === 'patch').length;
  const hasBrowser = events.some((e) => e.type === 'browser.step') || snap.checks.some((c) => /^(api|browser):/.test(c.name));
  const hasDesktop = events.some((e) => e.type.startsWith('desktop.')) || snap.tasks.some((t) => t.role === 'desktop_operator');

  return (
    <div className="at-screen lv-mission" data-testid="mission" data-state={m.state}>
      <div className="at-mhead">
        <div className="at-mhead-l">
          <div className="at-row" style={{ gap: 10 }}>
            <span className="at-mid">{m.id}</span>
            <h1 className="display at-trunc" style={{ margin: 0 }}>{m.title}</h1>
            <span data-testid="mission-state"><Status s={statusKey(m.state)} label={stateWord(m.state)} /></span>
            {m.runtime === 'fake' && <Tip label="Scripted sample runtime: no model is called. Tool calls, commands and checks are real."><span><Badge tone="sample">scripted runtime</Badge></span></Tip>}
          </div>
          <div className="at-muted at-trunc" style={{ maxWidth: 900 }}>{m.goal}</div>
        </div>
        <div className="at-mhead-r">
          <div className="at-row" style={{ gap: 6 }}>
            {ACTIVE.has(m.state) && <Button variant="danger" icon={IStopCircle} disabled={busy} onClick={() => void act('Could not cancel', () => call('mission.cancel', { missionId }))}>Cancel mission</Button>}
            {finished && !m.decision && (
              <>
                <Button variant="ghost" icon={IUndo} disabled={busy} data-testid="reject" onClick={() => void act('Could not reject', () => call('mission.decide', { missionId, decision: 'reject' }))}>Reject changes</Button>
                <Button variant={verdict === 'verified' ? 'primary' : 'default'} icon={IMerge} disabled={busy || patchCount === 0} data-testid="accept" onClick={() => void act('Could not accept', () => call('mission.decide', { missionId, decision: 'accept' }))}>Accept changes</Button>
              </>
            )}
            {m.decision && <Badge tone="human">{m.decision === 'accepted' ? 'Accepted by you' : 'Rejected by you'}</Badge>}
            {m.archived && <Badge tone="outline">imported archive · read-only</Badge>}
            <Menu align="right" width={260} trigger={(_o, toggle) => <Button variant="ghost" icon={IMore} onClick={toggle} aria-label="Mission actions" data-testid="mission-menu">More</Button>}>{(close) => (<>
              <MenuItem icon={IDisk} onClick={() => { close(); void act('Export failed', async () => { const r = await call('mission.export', { missionId }); if (r) toast({ tone: 'info', title: 'Audit log exported', body: `${r.records} records · SHA-256 ${r.sha256.slice(0, 16)}… → ${r.path}` }); }); }}>Export audit log (JSONL)…</MenuItem>
              <MenuItem icon={IClose} onClick={() => { close(); if (ACTIVE.has(m.state)) { toast({ tone: 'danger', title: 'Cancel the mission first' }); return; } if (window.confirm('Delete this mission? Its events, artifacts, worktrees and task branches are removed. An accepted branch is kept.')) void act('Delete failed', async () => { await call('mission.delete', { missionId }); await refreshLists(); go({ screen: 'projects' }); }); }}>Delete mission…</MenuItem>
            </>)}</Menu>
          </div>
          <span className="at-subtle lv-small">{snap.workspace?.name} · base {m.baseCommit?.slice(0, 7) ?? 'not yet snapshotted'} · {modeWord(m.approvalMode)}</span>
        </div>
      </div>

      {m.outcome && (
        <div className={cx('lv-outcome', `lv-outcome--${verdict ?? (m.state === 'failed' ? 'failed' : 'neutral')}`)} data-testid="outcome">
          <Icon as={verdict === 'verified' ? ICheckCircle : verdict === 'failed' || m.state === 'failed' ? IXCircle : IWarn} />
          <span>{m.outcome}</span>
        </div>
      )}

      {m.state === 'awaiting_approval' && snap.plan && <PlanReview snap={snap} busy={busy} onApprove={() => void act('Could not start the mission', () => call('mission.approvePlan', { missionId }))} />}

      {m.state !== 'awaiting_approval' && m.state !== 'draft' && (
        <div className="lv-mbody">
          <div className="lv-mmain">
            <div className="lv-tabs">
              <Tabs value={tab} onChange={setTab} items={[
                { id: 'activity', label: 'Activity', count: events.length },
                { id: 'graph', label: 'Tasks', icon: IGraph, count: snap.tasks.length || undefined },
                { id: 'changes', label: 'Changes', icon: IFileDiff, count: patchCount || undefined },
                { id: 'evidence', label: 'Evidence', icon: ITube, count: snap.checks.length || undefined },
                { id: 'cloud', label: 'Cloudflare', icon: IGlobe },
                { id: 'findings', label: 'Review', icon: IReviews, count: snap.findings.filter((f) => f.status === 'open').length || undefined },
                ...(hasBrowser ? [{ id: 'browser' as Tab, label: 'Browser', icon: IGlobe }] : []),
                ...(m.targetEnvironment ? [{ id: 'deploy' as Tab, label: 'Deploy', icon: IDeploy }] : []),
                ...(hasDesktop ? [{ id: 'desktop' as Tab, label: 'Desktop', icon: IComputer }] : []),
                ...(m.archived ? [] : [{ id: 'terminal' as Tab, label: 'Terminal', icon: ITerminal }]),
              ]} />
            </div>
            {tab === 'cloud' && <CloudPanel mission={m} />}
            {tab === 'activity' && <ActivityTimeline events={events} />}
            {tab === 'graph' && <TaskGraph snap={snap} />}
            {tab === 'changes' && <Changes snap={snap} />}
            {tab === 'evidence' && <Evidence checks={snap.checks} gate={gate} />}
            {tab === 'findings' && <Findings snap={snap} onLog={showLog} />}
            {tab === 'browser' && <BrowserPanel snap={snap} events={events} />}
            {tab === 'deploy' && <DeployPanel snap={snap} events={events} />}
            {tab === 'desktop' && <DesktopPanel snap={snap} events={events} />}
            {tab === 'terminal' && <TerminalPanel snap={snap} />}
            {log && (
              <div className="lv-log lv-log--float">
                <PanelHead label="Log" title={log.name}><Button size="sm" variant="ghost" onClick={() => setLog(null)}>Close</Button></PanelHead>
                <pre className="lv-proc-body" style={{ maxHeight: 360 }}>{log.text}</pre>
              </div>
            )}
          </div>
          <aside className="lv-mside">
            <PanelHead label="Needs you" count={pending.length} />
            <div className="lv-needs" data-testid="needs-you">
              {pending.length === 0 ? <div className="at-subtle lv-small" style={{ padding: '10px 12px' }}>Nothing is waiting for you.</div> : pending.map((a) => <ApprovalCard key={a.id} a={a} />)}
            </div>
            <PanelHead label="Budget" />
            <BudgetMeter snap={snap} />
            <PanelHead label="Tasks" count={snap.tasks.length} />
            <div className="lv-tasks">{snap.tasks.map((t) => <TaskRow key={t.id} t={t} attempts={snap.attempts.filter((a) => a.taskId === t.id).length} />)}</div>
            <ProcessPane events={events} />
          </aside>
        </div>
      )}
    </div>
  );
}

const statusKey = (s: string) => ({ running: 'running', verifying: 'running', planning: 'running', awaiting_approval: 'waiting', completed: 'done', failed: 'failed', cancelled: 'idle', draft: 'draft' } as Record<string, string>)[s] ?? s;
const modeWord = (m: string) => ({ ask_risky: 'asks for risky actions', ask_all_writes: 'asks for every write', plan_only: 'read-only' } as Record<string, string>)[m] ?? m;

function PlanReview({ snap, busy, onApprove }: { snap: NonNullable<ReturnType<typeof useMission>['snap']>; busy: boolean; onApprove: () => void }) {
  const p = snap.plan!.plan;
  return (
    <div className="lv-scroll" data-testid="plan">
      <div className="lv-plan">
        <div className="at-label">Plan v{p.version} · review before anything runs</div>
        <p className="body-lg" style={{ margin: '8px 0 4px' }}>{p.summary}</p>
        <p className="at-muted lv-small" style={{ margin: 0 }}>Scope: {p.scope}</p>
        {p.tasks.map((t) => (
          <div key={t.key} className="lv-plan-task">
            <div className="at-row" style={{ gap: 8 }}>
              <RoleMark mark={roleMark(t.role)} size="sm" />
              <span className="body-strong">{t.title}</span>
              <span className="at-subtle lv-small">{roleName(t.role)} · {t.risk} risk{t.dependsOn.length ? ` · after ${t.dependsOn.join(', ')}` : ''}</span>
            </div>
            <div className="at-label" style={{ marginTop: 10 }}>Acceptance criteria</div>
            <ul className="lv-ul">{t.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul>
            <div className="at-label" style={{ marginTop: 10 }}>Tools this task may request</div>
            <div className="at-row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 4 }}>{t.tools.map((x) => <span key={x} className="at-chip at-mono">{x}</span>)}</div>
          </div>
        ))}
        <div className="lv-callout">
          <Icon as={IShield} />
          <div>
            <b>What will ask you first.</b> Installing packages, network access, deleting or moving files, git writes and any program not on the safe list wait for your approval ({modeWord(snap.mission.approvalMode)}). {snap.mission.targetEnvironment ? `Deploying to ${snap.mission.targetEnvironment} needs its own approval. ` : 'Nothing is deployed (no target environment). '}A desktop session needs desktop control enabled in Settings and its own approval. Production deploys and credentials are never available to agents.
          </div>
        </div>
        <div className="lv-callout">
          <Icon as={IClock} />
          <div><b>Budget.</b> Up to {snap.mission.budget.maxConcurrentAgents} agents at once, {snap.mission.budget.maxTasks} tasks, delegation depth {snap.mission.budget.maxDelegationDepth}, {snap.mission.budget.maxTokens.toLocaleString()} tokens and {snap.mission.budget.maxWallClockMinutes} minutes. The mission stops with a reason when any limit is reached.</div>
        </div>
        <div className="lv-callout">
          <Icon as={ITube} />
          <div><b>How it will be verified.</b> {p.verification.length ? p.verification.map((v) => `${v.name}${v.required ? ' (required)' : ' (optional)'}`).join(', ') : 'No checks configured'} — run by ATLAS on the checkpointed commit, independent of what the agent reports.</div>
        </div>
        <div className="at-row" style={{ gap: 8, marginTop: 16 }}>
          <Button variant="primary" icon={ICheck} disabled={busy} onClick={onApprove} data-testid="approve-plan">Approve plan and start</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void call('mission.cancel', { missionId: snap.mission.id })}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

type Filter = 'all' | 'agent' | 'commands' | 'policy' | 'checks';
const FILTERS: { id: Filter; label: string; match: (e: AtlasEvent) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'agent', label: 'Agent', match: (e) => e.type.startsWith('agent.') },
  { id: 'commands', label: 'Commands', match: (e) => e.type.startsWith('process.') },
  { id: 'policy', label: 'Policy & approvals', match: (e) => e.type.startsWith('policy.') || e.type.startsWith('approval.') },
  { id: 'checks', label: 'Checks', match: (e) => e.type === 'check.result' || e.type === 'gate.result' || e.type === 'workspace.worktree' },
];

function ActivityTimeline({ events }: { events: AtlasEvent[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const all = useMemo(() => events.map((e) => ({ e, r: describeEvent(e) })).filter((x): x is { e: AtlasEvent; r: Row } => !!x.r), [events]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, all.filter((x) => f.match(x.e)).length])) as Record<Filter, number>, [all]);
  const rows = useMemo(() => all.filter((x) => FILTERS.find((f) => f.id === filter)!.match(x.e)), [all, filter]);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [rows.length]);
  return (
    <div className="lv-tl-wrap">
      <div className="lv-tl-filters" role="toolbar" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="lv-chip" aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); stick.current = true; }}>
            {f.label}<span className="at-mono">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      <div className="lv-timeline" ref={ref} data-testid="timeline" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        <div className="lv-trust at-subtle lv-small">Decision summaries and tool traces — not private model reasoning. Agent summaries are claims; evidence comes from checks.</div>
        {rows.length === 0 && <div className="at-subtle lv-small" style={{ padding: '8px 20px' }}>No events in this view yet.</div>}
        {rows.map(({ e, r }) => (
          <div key={e.seq} className={cx("lv-ev", `lv-ev--${r.tone}`)} data-type={e.type} data-seq={e.seq}>
            <span className="lv-ev-time at-mono at-tnum">{time(e.ts)}</span>
            <RoleMark mark={markOf(e)} size="sm" human={e.actor.kind === 'operator'} />
            <div className="lv-ev-main">
              <div className="lv-ev-title"><span className="lv-ev-text">{r.title}</span>{r.meta && <span className="lv-ev-meta at-mono">{r.meta}</span>}</div>
              {r.detail && <Detail text={r.detail} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Long details (stack traces, test output) collapse to a few lines with an explicit expander. */
function Detail({ text }: { text: string }) {
  const lines = text.split('\n');
  const [open, setOpen] = useState(false);
  const LIMIT = 4;
  if (lines.length <= LIMIT + 1) return <div className="lv-ev-detail">{text}</div>;
  return (
    <div className="lv-ev-detail">
      {open ? text : lines.slice(0, LIMIT).join('\n')}
      <button type="button" className="lv-more" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Show less' : `Show ${lines.length - LIMIT} more lines`}</button>
    </div>
  );
}

function ApprovalCard({ a }: { a: Approval }) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  const left = Math.max(0, new Date(a.expiresAt).getTime() - now);
  const respond = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    try { await call('approval.respond', { approvalId: a.id, decision }); } catch (e) { toast({ tone: 'danger', title: 'Approval not recorded', body: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <div className={cx('lv-approval', a.risk !== 'low' && 'lv-approval--risk')} data-testid="approval">
      <div className="at-row" style={{ gap: 8 }}>
        <Icon as={IShield} className="at-warn" />
        <span className="body-strong">{a.tool === 'shell_exec' ? 'Run a command' : a.tool === 'write_file' ? 'Write a file' : a.tool}</span>
        <span style={{ flex: 1 }} />
        <span className="at-mono at-subtle lv-small"><Icon as={IClock} size="sm" /> {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}</span>
      </div>
      <code className="lv-action">{a.action}</code>
      <dl className="lv-kv">
        <dt>Who</dt><dd>{roleName(a.agentRole)} agent</dd>
        <dt>Where</dt><dd>{a.environment}</dd>
        <dt>Touches</dt><dd>{a.resources.length ? a.resources.join(', ') : 'worktree only'}</dd>
        <dt>For</dt><dd>This command, once</dd>
        <dt>Why asked</dt><dd>{a.reason} · {a.risk} risk</dd>
      </dl>
      <div className="at-row" style={{ gap: 6 }}>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void respond('approve')} data-testid="approve">Approve once</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void respond('deny')} data-testid="deny">Deny</Button>
      </div>
    </div>
  );
}

function TaskRow({ t, attempts }: { t: Task; attempts: number }) {
  return (
    <div className="lv-task">
      <Status s={statusKey(t.state === 'done' ? 'completed' : t.state === 'running' ? 'running' : t.state === 'failed' ? 'failed' : 'draft')} label={stateWord(t.state)} />
      <span className="at-trunc" style={{ fontWeight: 500 }}>{t.title}</span>
      <span style={{ flex: 1 }} />
      {t.state === 'running' && <Button size="sm" variant="ghost" onClick={() => void call('task.cancel', { taskId: t.id })}>Stop</Button>}
      <span className="at-mono at-subtle lv-small">{attempts > 1 ? `attempt ${attempts}` : ''}</span>
    </div>
  );
}

function ProcessPane({ events }: { events: AtlasEvent[] }) {
  const lines = useMemo(() => {
    const out: { k: 'cmd' | 'out' | 'exit'; text: string; ok?: boolean }[] = [];
    for (const e of events) {
      if (e.type === 'process.started') out.push({ k: 'cmd', text: `$ ${e.payload.command}` });
      else if (e.type === 'process.output') out.push({ k: 'out', text: String(e.payload.text) });
      else if (e.type === 'process.exited') out.push({ k: 'exit', text: e.payload.timedOut ? '[timed out]' : e.payload.cancelled ? '[cancelled]' : `[exit ${e.payload.exitCode} · ${fmtMs(e.payload.durationMs as number)}]`, ok: e.payload.exitCode === 0 });
    }
    return out;
  }, [events]);
  const running = useMemo(() => {
    const open = new Set<number>();
    for (const e of events) { if (e.type === 'process.started') open.add(e.payload.pid as number); if (e.type === 'process.exited') open.delete(e.payload.pid as number); }
    return open.size;
  }, [events]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines.length]);
  return (
    <div className="lv-proc">
      <PanelHead icon={ITerminal} label="Process output">{running > 0 ? <Badge tone="accent">{running} running</Badge> : null}</PanelHead>
      <pre className="lv-proc-body" ref={ref} data-testid="process-output">
        {lines.length === 0 ? <span className="at-subtle">No commands yet.</span> : lines.map((l, i) => <span key={i} className={cx('lv-pl', `lv-pl--${l.k}`, l.k === 'exit' && (l.ok ? 'lv-ok' : 'lv-bad'))}>{l.text}{l.k !== 'out' ? '\n' : ''}</span>)}
      </pre>
      <div className="lv-proc-foot at-mono at-subtle">live process · argument arrays, no shell · sanitized environment</div>
    </div>
  );
}

function Changes({ snap }: { snap: NonNullable<ReturnType<typeof useMission>['snap']> }) {
  const patches = snap.artifacts.filter((a) => a.kind === 'patch');
  const [text, setText] = useState<string | null>(null);
  const [intact, setIntact] = useState(true);
  const id = patches[patches.length - 1]?.id;
  useEffect(() => { if (id) void call('artifact.read', { artifactId: id }).then((r) => { setText(r.text); setIntact(r.intact); }); }, [id]);
  if (!patches.length) return <EmptyState center icon={IFileDiff} title="No changes yet" body={['completed', 'failed', 'cancelled'].includes(snap.mission.state) ? 'The agent finished without modifying files.' : 'Changes appear here when the agent checkpoints its worktree.'} />;
  const task = snap.tasks.find((t) => t.resultRef === id);
  return (
    <div className="lv-scroll" data-testid="changes">
      <div className="lv-diffmeta at-row" style={{ gap: 10 }}>
        <Icon as={ITree} className="at-subtle" />
        <span className="at-mono">{task?.branch}</span>
        <span className="at-subtle lv-small">base {snap.mission.baseCommit?.slice(0, 7)} → checkpoint · isolated worktree</span>
        {!intact && <Badge tone="danger">artifact checksum mismatch</Badge>}
      </div>
      {text === null ? <div className="lv-loading">Loading patch…</div> : <UnifiedDiff text={text} />}
    </div>
  );
}

/** Renders a unified diff as text. Untrusted content is never interpreted as HTML. */
function UnifiedDiff({ text }: { text: string }) {
  const files = useMemo(() => {
    const out: { name: string; lines: string[] }[] = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('diff --git ')) out.push({ name: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), lines: [] });
      else if (out.length && !line.startsWith('index ') && !line.startsWith('--- ') && !line.startsWith('+++ ')) out[out.length - 1].lines.push(line);
    }
    return out;
  }, [text]);
  return (
    <div className="lv-udiff">
      {files.map((f, i) => {
        const add = f.lines.filter((l) => l.startsWith('+')).length;
        const del = f.lines.filter((l) => l.startsWith('-')).length;
        return (
          <section key={i} className="lv-ufile">
            <div className="lv-ufile-head"><Icon as={IFileText} size="sm" className="at-subtle" /><span className="at-mono">{f.name}</span><span className="at-mono lv-add">+{add}</span><span className="at-mono lv-del">−{del}</span></div>
            <pre className="lv-ucode">{f.lines.map((l, j) => <span key={j} className={cx('lv-uline', l.startsWith('+') && 'lv-uline--add', l.startsWith('-') && 'lv-uline--del', l.startsWith('@@') && 'lv-uline--hunk')}>{l || ' '}{'\n'}</span>)}</pre>
          </section>
        );
      })}
    </div>
  );
}

function Evidence({ checks, gate }: { checks: CheckRecord[]; gate?: AtlasEvent }) {
  const [log, setLog] = useState<{ name: string; text: string } | null>(null);
  return (
    <div className="lv-scroll" data-testid="evidence">
      <div className="lv-evid">
        <div className="at-label">Release gate</div>
        {gate ? <p className="body-lg" style={{ margin: '6px 0 14px' }}>{String(gate.payload.summary)}</p> : <p className="at-muted">Verification has not run yet. It runs after the agent finishes, on the checkpointed commit.</p>}
        <table className="at-table">
          <thead><tr><th>Check</th><th>Result</th><th>Command</th><th>Commit</th><th>Duration</th><th /></tr></thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.id} data-testid="check-row" data-result={c.result}>
                <td><span className="body-strong">{c.name}</span> <span className="at-subtle lv-small">{c.required ? 'required' : 'optional'}</span>{c.result !== 'pass' && c.reason && <div className="lv-check-reason">{c.reason}</div>}</td>
                <td><span className={cx('lv-result', `lv-result--${c.result}`)}><Icon as={c.result === 'pass' ? ICheck : c.result === 'fail' ? IXCircle : IWarn} size="sm" />{resultWord(c.result)}</span></td>
                <td className="at-mono at-muted">{c.command ?? '—'}</td>
                <td className="at-mono at-muted">{c.commit?.slice(0, 7) ?? '—'}</td>
                <td className="at-mono at-muted">{fmtMs(c.durationMs) || '—'}</td>
                <td style={{ textAlign: 'right' }}>{c.artifactId && <Button size="sm" variant="ghost" onClick={() => void call('artifact.read', { artifactId: c.artifactId! }).then((r) => setLog({ name: r.artifact.name, text: r.text }))}>View log</Button>}</td>
              </tr>
            ))}
            {checks.length === 0 && <tr><td colSpan={6} className="at-subtle">No checks recorded.</td></tr>}
          </tbody>
        </table>
        <div className="lv-callout" style={{ marginTop: 16 }}>
          <Icon as={IShield} />
          <div><b>Only the checks above count as evidence.</b> A passing review is a gate, not evidence. Anything not listed (for example a deployment that was not configured) was not verified.</div>
        </div>
        {log && (
          <div className="lv-log">
            <PanelHead label="Log" title={log.name}><Button size="sm" variant="ghost" onClick={() => setLog(null)}>Close</Button></PanelHead>
            <pre className="lv-proc-body" style={{ maxHeight: 360 }}>{log.text}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
