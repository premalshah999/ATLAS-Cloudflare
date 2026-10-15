// Mission Control (the design's "Control" view, live): the workforce of agents with their dependencies, what needs
// you, the selected agent's thread, terminal and inspector, and a composer that directs a running agent.
// Every value comes from the mission snapshot, its event log and the role registry.
import React, { useEffect, useMemo, useState } from 'react';
import type { AtlasEvent, Task } from '@atlas/contracts';
import { Badge, Button, cx, Icon, Meter, RoleMark, Status } from '../ui/primitives';
import { IArrowRight, ISend, IShield, ITool, IWarn } from '../lib/icons';
import { call, type MissionSnapshot, type RoleInfo } from './api';
import { ApprovalCard, ProcessPane } from './mission';
import { describeEvent, fmtMs, roleMark, roleName, stateWord, time } from './format';
import { toast } from './toast';

const TASK_DOT: Record<string, string> = { running: 'running', reviewing: 'running', done: 'done', failed: 'failed', cancelled: 'idle', blocked: 'waiting', queued: 'idle', ready: 'waiting' };
const SUGGESTIONS = [
  'Run the full test suite before you continue, and fix anything you broke.',
  'Pause your current approach and explain in two sentences why you chose it.',
  'Keep the change minimal: do not modify files unrelated to the task.',
];

/** Columns of tasks by dependency depth: a task sits one column right of the deepest task it waits on. */
function layers(tasks: Task[]): Task[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const d = (t: Task, seen = new Set<string>()): number => {
    if (depth.has(t.id)) return depth.get(t.id)!;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const v = t.dependencies.length ? 1 + Math.max(...t.dependencies.map((x) => (byId.get(x) ? d(byId.get(x)!, seen) : 0))) : 0;
    depth.set(t.id, v);
    return v;
  };
  const cols: Task[][] = [];
  for (const t of tasks) (cols[d(t)] ??= []).push(t);
  return cols.filter(Boolean);
}

type Started = { model?: string; worktree?: string; branch?: string; tools?: string[]; sandbox?: string; roleVersion?: string };

export function ControlPanel({ snap, events }: { snap: MissionSnapshot; events: AtlasEvent[] }) {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  useEffect(() => { void call('roles.list').then(setRoles).catch(() => {}); }, []);
  const tasks = snap.tasks;
  const running = tasks.find((t) => t.state === 'running');
  const [sel, setSel] = useState<string | null>(null);
  const selected = tasks.find((t) => t.id === sel) ?? running ?? tasks[0];
  const cols = useMemo(() => layers(tasks), [tasks]);
  const keyOf = new Map(tasks.map((t) => [t.id, t.key]));

  const perTask = useMemo(() => {
    const m = new Map<string, { calls: number; started?: Started; tokens: number; last?: string }>();
    for (const e of events) {
      if (!e.taskId) continue;
      const r = m.get(e.taskId) ?? { calls: 0, tokens: 0 };
      if (e.type === 'agent.tool_call') r.calls++;
      if (e.type === 'attempt.started') { r.started = e.payload as Started; r.calls = 0; r.tokens = 0; }
      if (e.type === 'agent.usage') r.tokens = Number(e.payload.total ?? r.tokens);
      if (e.type === 'agent.message') r.last = String(e.payload.text ?? '');
      m.set(e.taskId, r);
    }
    return m;
  }, [events]);

  const role = roles.find((r) => r.id === selected?.role);
  const info = selected ? perTask.get(selected.id) : undefined;
  const planTask = selected ? snap.plan?.plan.tasks.find((p) => p.key === selected.key) : undefined;
  const pending = snap.approvals.filter((a) => a.status === 'pending');
  const failed = tasks.filter((t) => t.state === 'failed');
  const thread = useMemo(() => selected ? events.filter((e) => e.taskId === selected.id && e.type !== 'process.output' && e.type !== 'agent.usage') : [], [events, selected]);
  const procEvents = useMemo(() => selected ? events.filter((e) => e.taskId === selected.id && e.type.startsWith('process.')) : [], [events, selected]);

  return (
    <div className="lv-control" data-testid="control">
      <div className="lv-control-main">
        <section className="lv-workforce" data-testid="workforce">
          <div className="at-row lv-wf-head">
            <span className="at-label">Workforce</span>
            <span className="at-subtle lv-small">dependencies · click an agent to inspect and direct it</span>
          </div>
          <div className="lv-wf-orch">
            <RoleMark mark="OR" size="sm" />
            <b>Orchestrator</b>
            <span className="at-subtle lv-small">{snap.plan ? `plan v${snap.plan.plan.version} · ${tasks.length} tasks · ${snap.budget.agentsNow} working now` : 'planning'}</span>
            <span style={{ flex: 1 }} />
            <span className="at-mono at-subtle lv-small">{snap.budget.toolCalls} tool calls · {snap.budget.tokens.toLocaleString()} tokens · {fmtMs(snap.budget.elapsedMs)}</span>
          </div>
          <div className="lv-wf-cols">
            {cols.map((col, i) => (
              <React.Fragment key={i}>
                {i > 0 && <div className="lv-wf-arrow" aria-hidden><Icon as={IArrowRight} /></div>}
                <div className="lv-wf-col">
                  {col.map((t) => {
                    const r = perTask.get(t.id);
                    const budget = roles.find((x) => x.id === t.role)?.budget.maxToolCalls ?? 60;
                    return (
                      <button type="button" key={t.id} data-testid="agent-card" data-state={t.state} aria-pressed={t.id === selected?.id}
                        className={cx('lv-agent-card', t.id === selected?.id && 'is-selected', t.state === 'failed' && 'is-failed')} onClick={() => setSel(t.id)}>
                        <div className="at-row" style={{ gap: 8 }}>
                          <RoleMark mark={roleMark(t.role)} s={TASK_DOT[t.state]} size="sm" />
                          <b className="at-trunc">{roleName(t.role)}</b>
                          <span style={{ flex: 1 }} />
                          <Status s={TASK_DOT[t.state] ?? 'idle'} label={stateWord(t.state)} />
                        </div>
                        <div className="lv-agent-title at-trunc">{t.title}</div>
                        <Meter value={t.state === 'done' ? 1 : Math.min(1, (r?.calls ?? 0) / budget)} tone={t.state === 'failed' ? 'warning' : undefined} />
                        <div className="at-row lv-small at-subtle" style={{ gap: 6 }}>
                          <span className="at-mono">{t.key}</span>
                          {t.dependencies.length > 0 && <span>after {t.dependencies.map((x) => keyOf.get(x) ?? '?').join(', ')}</span>}
                          <span style={{ flex: 1 }} />
                          {r?.calls ? <span className="at-mono">{r.calls} calls</span> : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </React.Fragment>
            ))}
            {!tasks.length && <p className="at-subtle">Tasks appear here when the plan is approved.</p>}
          </div>
        </section>

        <div className="lv-control-lower">
          <section className="lv-thread" data-testid="agent-thread">
            <div className="at-row lv-wf-head"><span className="at-label">Thread</span>{selected && <span className="at-subtle lv-small">{roleName(selected.role)} · {selected.key} · decision summaries and tool trace</span>}</div>
            <div className="lv-thread-body">
              {thread.length === 0 ? <p className="at-subtle lv-small">No activity for this agent yet.</p> : thread.slice(-120).map((e) => {
                const d = describeEvent(e);
                if (!d) return null;
                const msg = e.type === 'agent.message';
                return (
                  <div key={e.seq} className={cx('lv-thread-row', msg && 'is-message', e.type === 'operator.action' && 'is-operator')}>
                    <span className="at-mono at-subtle lv-small">{time(e.ts)}</span>
                    <span className="lv-thread-text">{msg ? String(e.payload.text) : <>{d.title}{d.detail ? <span className="at-subtle"> · {d.detail.slice(0, 200)}</span> : null}</>}</span>
                  </div>
                );
              })}
            </div>
            <Composer task={selected} />
          </section>
          <div className="lv-control-term"><ProcessPane events={procEvents} /></div>
        </div>
      </div>

      <aside className="lv-inspector" data-testid="inspector">
        <section className="lv-insp-section" data-testid="needs-you">
          <div className="at-row" style={{ gap: 8 }}><span className="at-label">Needs you</span><span className="at-mono at-subtle">{pending.length + failed.length}</span></div>
          {pending.map((a) => <ApprovalCard key={a.id} a={a} />)}
          {failed.map((t) => (
            <div key={t.id} className="lv-insp-fail">
              <Icon as={IWarn} className="at-danger" /> <b>{t.key} failed</b> <span className="at-subtle lv-small">{roleName(t.role)}</span>
              <div className="lv-small at-subtle">{snap.attempts.filter((a) => a.taskId === t.id).at(-1)?.error ?? 'See its thread and the Evidence tab.'}</div>
              <Button size="sm" variant="ghost" onClick={() => setSel(t.id)}>Inspect</Button>
            </div>
          ))}
          {!pending.length && !failed.length && <p className="at-subtle lv-small">Nothing is waiting for you.</p>}
        </section>

        {selected && (
          <section className="lv-insp-section" data-testid="agent-inspector">
            <div className="at-row" style={{ gap: 10 }}>
              <RoleMark mark={roleMark(selected.role)} s={TASK_DOT[selected.state]} />
              <div style={{ minWidth: 0 }}>
                <b>{role?.title ?? roleName(selected.role)}</b>
                <div className="lv-small"><Status s={TASK_DOT[selected.state] ?? 'idle'} label={stateWord(selected.state)} /></div>
              </div>
            </div>
            <span className="at-label">Objective</span>
            <p className="lv-small" style={{ margin: 0 }}>{selected.key} · {selected.title}</p>
            {planTask?.acceptance?.length ? <ul className="lv-small lv-insp-list">{planTask.acceptance.slice(0, 5).map((a, i) => <li key={i}>{a}</li>)}</ul> : null}
            {role && <>
              <span className="at-label">Context usage</span>
              <div className="at-row lv-small" style={{ gap: 8 }}><span className="at-mono">{(info?.tokens ?? 0).toLocaleString()} / {role.budget.maxTokens.toLocaleString()} tokens</span></div>
              <Meter value={Math.min(1, (info?.tokens ?? 0) / role.budget.maxTokens)} />
            </>}
            <span className="at-label">Environment</span>
            <dl className="lv-kv">
              <dt>Model</dt><dd className="at-mono">{info?.started?.model ?? snap.mission.model ?? (snap.mission.runtime === 'fake' ? 'scripted runtime' : '—')}</dd>
              <dt>Runs in</dt><dd>{info?.started?.sandbox === 'sandbox' ? 'Isolated worktree · OS sandbox' : info?.started?.sandbox ?? 'Isolated worktree'}</dd>
              <dt>Branch</dt><dd className="at-mono at-trunc">{info?.started?.branch ?? selected.branch ?? '—'}</dd>
              <dt>Worktree</dt><dd className="at-mono at-trunc" title={info?.started?.worktree}>{info?.started?.worktree ? `…/${info.started.worktree.split('/').slice(-2).join('/')}` : '—'}</dd>
              <dt>Role</dt><dd className="at-mono">{info?.started?.roleVersion ?? role?.version ?? selected.role}</dd>
            </dl>
            {role && <>
              <span className="at-label">Execution permission</span>
              <div className="lv-perms">
                <div><Badge tone={role.writes ? 'success' : 'outline'}>{role.writes ? 'ALLOW' : 'DENY'}</Badge> Filesystem write <span className="at-subtle lv-small">its worktree only</span></div>
                <div><Badge tone="success">ALLOW</Badge> Shell <span className="at-subtle lv-small">safe list, sandboxed</span></div>
                <div><Badge tone="warning">ASK</Badge> Risky commands <span className="at-subtle lv-small">approval, once</span></div>
                <div><Badge tone={role.capabilities.some((c) => c.startsWith('net')) ? 'warning' : 'outline'}>{role.capabilities.some((c) => c.startsWith('net')) ? 'ASK' : 'DENY'}</Badge> Network <span className="at-subtle lv-small">no outbound by default</span></div>
              </div>
              <span className="at-label">Tools</span>
              <div className="at-row" style={{ gap: 4, flexWrap: 'wrap' }}>{(info?.started?.tools ?? role.tools).map((t) => <Badge key={t} tone="outline"><Icon as={ITool} size="sm" /> {t}</Badge>)}</div>
            </>}
          </section>
        )}
      </aside>
    </div>
  );
}

function Composer({ task }: { task?: Task }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const live = task?.state === 'running';
  const send = async (value = text) => {
    if (!task || !value.trim()) return;
    setBusy(true);
    try { await call('task.direct', { taskId: task.id, text: value.trim() }); setText(''); toast({ tone: 'info', title: `Directed ${task.key}`, body: 'Delivered as the agent’s next turn. It keeps its context.' }); }
    catch (e) { toast({ tone: 'danger', title: 'Direction not delivered', body: (e as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <div className="lv-composer" data-testid="composer">
      {live && <div className="at-row" style={{ gap: 6, flexWrap: 'wrap' }}>{SUGGESTIONS.map((s) => <button type="button" key={s} className="lv-chip" disabled={busy} onClick={() => void send(s)}>{s}</button>)}</div>}
      <div className="lv-composer-box">
        <span className="at-subtle lv-small">To {task ? `${roleName(task.role)} · ${task.key}` : 'an agent'}</span>
        <textarea data-testid="composer-input" rows={2} value={text} disabled={!live || busy} placeholder={live ? 'Direct this agent — it keeps its context.' : 'Select a running agent to direct it.'}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <div className="at-row" style={{ gap: 8 }}>
          <span className="at-subtle lv-small"><Icon as={IShield} size="sm" /> scoped to this task’s worktree and permissions</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="primary" icon={ISend} disabled={!live || busy || !text.trim()} onClick={() => void send()} data-testid="composer-send">Send</Button>
        </div>
      </div>
    </div>
  );
}
