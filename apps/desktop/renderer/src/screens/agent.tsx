import React, { useState } from 'react';
import { actions, adapter, useApp } from '../lib/store';
import { agents, agentById, tasks, terminals, diffs, templates, models, live, threads, traces, roleDetails, type TraceRow } from '../data/source';
import { cx, Icon, Button, IconButton, Badge, Status, PanelHead, RoleMark, Tabs, Seg, Toggle, Field, Input, Select, Check, Meter, Tip, SampleTag, Split, EmptyState } from '../ui/primitives';
import { Composer } from '../ui/composer';
import { DiffView, CodeBlock, DiffStat } from '../ui/code';
import { ApprovalCard } from '../ui/overlays';
import { TaskGraph, AgentGraph } from '../ui/graph';
import { TerminalView } from '../ui/terminal';
import { MissionHeader } from './mission';
import { VerificationRow } from '../ui/verify';
import {
  IPause, IPlay, ITerminal, IArrowRight, IChevronRight, IFileCode, IDecision, ICheck, ITool, IReviews, IClose, IPlus, IPlug, ISkill,
  IShield, IFilter, IGraph, IAgents, IBranch, IHand, ICode, ISearch, ICircleDashed, IRetry, IBox, ICopy, IUndo,
} from '../lib/icons';

/* ---------- 5. Agent detail ---------- */
const approvalsOpen = (id: string) => !!(window as unknown as { __atlasOpenApprovals?: Set<string> }).__atlasOpenApprovals?.has(id);
function Block({ who, time, children, kind }: { who: string; time: string; children: React.ReactNode; kind?: 'human' | 'delegation' | 'agent' | 'system' }) {
  const a = who === 'you' ? null : agentById(who);
  return (
    <div className={cx('at-blk', kind && `at-blk--${kind}`)}>
      <div className="at-blk-gutter">{a ? <RoleMark mark={a.mark} size="sm" /> : <RoleMark mark="YOU" size="sm" human />}</div>
      <div className="at-blk-main">
        <div className="at-blk-head"><span className={cx('at-blk-who', !a && 'at-human-c')}>{a ? a.name : 'You'}</span><span className="at-mono at-subtle">{time}</span></div>
        {children}
      </div>
    </div>
  );
}

function LiveToolTrace({ rows }: { rows: TraceRow[] }) {
  const [open, setOpen] = useState(false);
  const kinds: Record<string, number> = {};
  rows.forEach((r) => { kinds[r.tool] = (kinds[r.tool] ?? 0) + 1; });
  return (
    <div className="at-trace">
      <button type="button" className="at-trace-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon as={IChevronRight} size="sm" className="at-trace-chev" /><Icon as={ITool} size="sm" className="at-subtle" />
        <span>{rows.length} tool call{rows.length === 1 ? '' : 's'}</span><span className="at-subtle">· {Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(' · ')}</span>{rows.some((r) => !r.ok) && <Badge tone="warning">{rows.filter((r) => !r.ok).length} refused or failed</Badge>}
      </button>
      {open && <div className="at-trace-list">{rows.map((r, i) => <div key={i} className="at-trace-row"><span className="at-trace-kind">{r.tool}</span><span className="at-mono at-trunc" title={r.result}>{r.call}</span><span className="at-mono at-subtle">{r.ms}</span></div>)}</div>}
    </div>
  );
}

function ToolTrace() {
  const [open, setOpen] = useState(false);
  const calls = [
    ['read', 'src/auth/session.ts', '12ms'], ['read', 'src/auth/tokens.ts', '8ms'], ['search', '"replacedBy" in src/', '41ms'],
    ['edit', 'src/auth/session.ts  +18 −4', '—'], ['shell', 'pnpm vitest run src/auth --reporter=dot', '4.1s'], ['edit', 'src/auth/tokens.ts  +6 −2', '—'],
  ];
  return (
    <div className="at-trace">
      <button type="button" className="at-trace-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon as={IChevronRight} size="sm" className="at-trace-chev" /><Icon as={ITool} size="sm" className="at-subtle" />
        <span>6 tool calls</span><span className="at-subtle">· read 2 · search 1 · edit 2 · shell 1</span><span className="at-mono at-subtle" style={{ marginLeft: 'auto' }}>5.2s</span>
      </button>
      {open && <div className="at-trace-list">{calls.map(([k, v, d], i) => <div key={i} className="at-trace-row"><span className="at-trace-kind">{k}</span><span className="at-mono at-trunc">{v}</span><span className="at-mono at-subtle">{d}</span></div>)}</div>}
    </div>
  );
}

export function AgentDetail() {
  const id = useApp((s) => s.agent);
  const paused = useApp((s) => s.paused);
  const a = agentById(id);
  const [tab, setTab] = useState<'thread' | 'trace' | 'terminals' | 'files'>('thread');
  const [sent, setSent] = useState<string[]>([]);
  const A = actions();
  const term = terminals.find((t) => t.agent === a.id);
  return (
    <div className="at-screen at-agent">
      <div className="at-agent-head">
        <RoleMark mark={a.mark} s={a.status} size="xl" />
        <div className="at-col" style={{ gap: 4, minWidth: 0, flex: 1 }}>
          <div className="at-row" style={{ gap: 10 }}><span className="display" style={{ fontSize: 20 }}>{a.name}</span><Status s={paused && a.status === 'running' ? 'paused' : a.status} paused={paused} /></div>
          <div className="at-row at-home-meta">
            <span>{a.model}</span><span><Icon as={IBranch} size="sm" /><span className="at-mono">{a.branch}</span></span><span className="at-mono">{a.worktree}</span>
            {a.parent && <span>reports to <button type="button" className="at-link" onClick={() => A.go('agent', { agent: a.parent })}>{agentById(a.parent).name}</button></span>}
          </div>
        </div>
        <div className="at-row" style={{ gap: 6 }}>
          <Select value={a.id} onChange={(v) => A.selectAgent(v)} width={200} options={agents.map((x) => ({ id: x.id, label: x.name, hint: x.mark }))} />
          <Button icon={IPause} disabled={live.on && a.status !== 'running'} onClick={() => { if (adapter) void adapter.direct(a.id, 'Pause: finish the step you are on, then stop and summarize what you did and what remains. Do not start new changes.').catch((e: Error) => A.toast({ tone: 'danger', title: 'Not delivered', body: e.message })); else A.toast({ tone: 'warning', title: `${a.name} will pause after the current step`, body: 'Context, worktree and terminals are kept.' }); }}>Pause after step</Button>
          <Button variant="human" icon={IHand} onClick={() => A.go('terminal')}>Take over</Button>
        </div>
      </div>
      <div className="at-agent-tabs">
        <Tabs value={tab} onChange={setTab} items={[{ id: 'thread', label: 'Thread' }, { id: 'trace', label: 'Trace', count: live.on ? (traces[a.id]?.length ?? 0) : 38 }, { id: 'terminals', label: 'Terminals', count: a.terminals.length }, { id: 'files', label: 'Files', count: a.files.length }]} />
        <span style={{ flex: 1 }} />
        <span className="at-subtle" style={{ fontSize: 12 }}>Decision summaries and tool traces — not private model reasoning.</span>
      </div>
      {tab === 'thread' && (
        <div className="at-col at-grow">
          <div className="at-pbody at-thread">
            <div className="at-thread-inner">
              {live.on ? (threads[a.id]?.length ? threads[a.id].map((it, i) => (
                <Block key={i} who={it.who} time={it.time} kind={it.kind === 'human' ? 'human' : it.kind === 'delegation' ? 'delegation' : it.kind === 'system' ? 'system' : undefined}>
                  {it.kind === 'delegation' && <div className="at-deleg"><Icon as={IArrowRight} size="sm" className="at-acc" /><span>{it.text}</span></div>}
                  {it.kind === 'message' && <div className="at-agent-msg" style={{ whiteSpace: 'pre-wrap' }}>{it.text}</div>}
                  {it.kind === 'human' && <div className="at-human-msg">{it.text}</div>}
                  {it.kind === 'tools' && <LiveToolTrace rows={it.tools ?? []} />}
                  {it.kind === 'approval' && (it.approvalId && approvalsOpen(it.approvalId) ? <ApprovalCard id={it.approvalId} /> : <div className="at-ack"><Icon as={IShield} size="sm" className="at-acc" />Asked to run <span className="at-mono">{it.text.slice(0, 160)}</span></div>)}
                  {it.kind === 'system' && <div className="at-ack"><Icon as={ICheck} size="sm" className="at-acc" />{it.text}</div>}
                </Block>
              )) : <EmptyState center icon={IAgents} title="No activity yet" body={`${a.name} has not started. It begins when the tasks it waits on finish.`} />) : (<>
              <Block who="orch" time="09:42:13" kind="delegation">
                <div className="at-deleg"><Icon as={IArrowRight} size="sm" className="at-acc" /><span>Delegated <b>T3, T4, T5, T6, T7</b> · token-family rotation, migration, middleware hardening, contract v2</span></div>
                <div className="at-subtle" style={{ fontSize: 12, marginTop: 4 }}>Constraints: keep password login working · no network · ask before schema changes</div>
              </Block>
              <Block who={a.id === 'orch' ? 'be' : a.id} time="09:42:40">
                <div className="at-plan-mini">
                  <div className="at-label" style={{ marginBottom: 6 }}>Plan · T5</div>
                  {[['done', 'Add token_family + replaced_by columns (0042)'], ['done', 'Rotate token on every refresh'], ['running', 'Detect reuse → revoke family inside one transaction'], ['pending', 'Publish contract v2 with family_id'], ['pending', 'Hand contract to Frontend Engineer']].map(([s, t], i) => (
                    <div key={i} className="at-plan-step" data-s={s}><span className="at-plan-dot">{s === 'done' ? <Icon as={ICheck} size="sm" /> : s === 'running' ? <span className="at-act" style={{ width: 8, height: 8 }}><i /><i /><i /></span> : null}</span><span>{t}</span></div>
                  ))}
                </div>
              </Block>
              <Block who={a.id === 'orch' ? 'be' : a.id} time="09:44:02">
                <div className="at-decision">
                  <div className="at-row" style={{ gap: 6 }}><Icon as={IDecision} size="sm" className="at-acc" /><b>Decision</b><span className="at-subtle">rotate on every refresh; revoke the family on reuse</span></div>
                  <ul>
                    <li><b>Why:</b> detects a stolen refresh token the first time either party reuses it (T2 threat model §3).</li>
                    <li><b>Rejected:</b> sliding expiry — simpler, but a stolen token stays valid for 30 days.</li>
                    <li><b>Cost:</b> one extra write per refresh; measured +3 ms p50 in tests.</li>
                  </ul>
                </div>
              </Block>
              <Block who="you" time="09:49:58" kind="human"><div className="at-human-msg">Continue, but don’t modify database migrations — I’ll own 0043.</div></Block>
              <Block who={a.id === 'orch' ? 'be' : a.id} time="09:50:01"><div className="at-ack"><Icon as={IShield} size="sm" className="at-acc" />Constraint added for this mission: <span className="at-mono">db/migrations/**</span> is read-only for me. I’ll request approval instead.</div></Block>
              <Block who={a.id === 'orch' ? 'be' : a.id} time="09:56:58">
                <ToolTrace />
                <div className="at-blk-diff">
                  <div className="at-blk-diffhead"><Icon as={IFileCode} size="sm" className="at-subtle" /><span className="at-mono">src/auth/session.ts</span><DiffStat add={18} del={4} /><span style={{ flex: 1 }} /><Button size="sm" variant="ghost" icon={IReviews} onClick={() => A.go('review')}>Open in review</Button></div>
                  <DiffView before={diffs.sessionBefore.split('\n').slice(3, 16).join('\n')} after={diffs.sessionAfter.split('\n').slice(4, 21).join('\n')} mode="inline" />
                </div>
                <div className="at-tests">
                  <VerificationRow label="src/auth/tokens.test.ts" value="14 passed · 212ms" status="passed" />
                  <VerificationRow label="src/auth/session.test.ts" value="19 passed · 488ms" status="passed" />
                  <VerificationRow label="src/auth/rotation.test.ts" value="running" status="running" />
                </div>
              </Block>
              <Block who={a.id === 'orch' ? 'be' : a.id} time="09:56:30"><ApprovalCard id="AP-31" /></Block>
              </>)}
              {!live.on && sent.map((t, i) => (
                <React.Fragment key={i}>
                  <Block who="you" time="now" kind="human"><div className="at-human-msg">{t}</div></Block>
                  <Block who={a.id} time="now"><div className="at-ack"><Icon as={ICheck} size="sm" className="at-acc" />Understood — applying after the current step. Context kept (118k tokens).</div></Block>
                </React.Fragment>
              ))}
            </div>
          </div>
          <Composer target={<><RoleMark mark={a.mark} size="sm" />{a.name}</>} running={!live.on || a.status === 'running'} placeholder={live.on && a.status !== 'running' ? `${a.name} is not running. Directions reach running agents only.` : undefined}
            quick={live.on ? ['Run the full test suite before you continue', 'Keep the change minimal: no unrelated files', 'Explain in two sentences why you chose this approach'] : ['Pause after the current test', 'Ask the security agent to review this change', 'Continue, but don’t modify database migrations', 'Show me why this approach was chosen']}
            onSend={(t) => { if (adapter) void adapter.direct(a.id, t).catch((e: Error) => A.toast({ tone: 'danger', title: 'Direction not delivered', body: e.message })); else setSent((s) => [...s, t]); }} />
        </div>
      )}
      {tab === 'trace' && (
        <div className="at-pbody" style={{ padding: 16 }}>
          <table className="at-table">
            <thead><tr><th>Time</th><th>Tool</th><th>Call</th><th>Result</th><th style={{ textAlign: 'right' }}>Duration</th></tr></thead>
            <tbody>
              {live.on ? (traces[a.id] ?? []).map((r, i) => (
                <tr key={i}><td className="at-mono at-subtle">{r.time}</td><td><Badge tone="outline"><span className="at-mono">{r.tool}</span></Badge></td><td className="at-mono at-trunc" style={{ maxWidth: 420 }}>{r.call}</td><td className={cx(r.ok ? 'at-muted' : 'at-warn')}>{r.result}</td><td className="at-mono at-subtle" style={{ textAlign: 'right' }}>{r.ms}</td></tr>
              )) : [['09:56:58', 'edit', 'src/auth/session.ts', '+18 −4', '—'], ['09:56:41', 'shell', 'pnpm vitest run src/auth', 'exit 0 · 33 passed', '4.1s'], ['09:56:30', 'approval', 'pnpm db:migrate --to 0043', 'waiting on you', '—'], ['09:55:47', 'search', '"replacedBy" in src/', '6 matches', '41ms'], ['09:55:44', 'read', 'src/auth/tokens.ts', '118 lines', '8ms'], ['09:55:44', 'read', 'src/auth/session.ts', '96 lines', '12ms']].map((r, i) => (
                <tr key={i}><td className="at-mono at-subtle">{r[0]}</td><td><Badge tone="outline"><span className="at-mono">{r[1]}</span></Badge></td><td className="at-mono">{r[2]}</td><td className={cx(r[3].startsWith('waiting') ? 'at-warn' : 'at-muted')}>{r[3]}</td><td className="at-mono at-subtle" style={{ textAlign: 'right' }}>{r[4]}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'terminals' && (term ? <div className="at-grow" style={{ display: 'flex', flexDirection: 'column' }}><TerminalView s={term} focused /></div> : <EmptyState center icon={ITerminal} title="No terminal sessions" body={`${a.name} hasn’t opened a shell in this mission.`} />)}
      {tab === 'files' && (
        <div className="at-pbody" style={{ padding: 16 }}>
          {a.files.length ? a.files.map((f) => <div key={f.path} className="at-feed-row"><Icon as={IFileCode} size="sm" className="at-subtle" /><span className="at-mono">{f.path}</span><span className="at-mono at-subtle">{f.task}</span><span style={{ marginLeft: 'auto' }}><DiffStat add={f.add} del={f.del} /></span></div>)
            : <EmptyState icon={IFileCode} title="No files modified" body="This agent is read-only or hasn’t written anything yet." />}
        </div>
      )}
    </div>
  );
}

/* ---------- 6. Multi-agent graph ---------- */
export function GraphScreen() {
  const [sel, setSel] = useState<string | undefined>(live.on ? (tasks.find((x) => x.status === 'running' || x.status === 'failed') ?? tasks[0])?.id : 'T13');
  const [view, setView] = useState<'tasks' | 'agents'>('tasks');
  const last = [...tasks].sort((a, b) => b.phase - a.phase)[0];
  const [critical, setCritical] = useState(false);
  const A = actions();
  const t = tasks.find((x) => x.id === sel);
  const ag = t ? agentById(t.agent) : null;
  return (
    <div className="at-screen">
      <MissionHeader tab="graph" />
      <div className="at-graphbar">
        <Seg value={view} onChange={setView} items={[{ id: 'tasks', label: 'Tasks by agent' }, { id: 'agents', label: 'Agents' }]} />
        <button type="button" className="at-chip" aria-pressed={critical} onClick={() => setCritical(!critical)}>Critical path to {last?.id ?? '—'}</button>
        <span style={{ flex: 1 }} />
        <span className="at-graph-key"><span><i data-s="done" />done</span><span><i data-s="running" />running</span><span><i data-s="waiting" />waiting</span><span><i data-s="failed" />failed</span><span><i data-s="pending" />pending</span></span>
      </div>
      <div className="at-row at-grow" style={{ alignItems: 'stretch', gap: 0 }}>
        <div className="at-col at-grow" style={{ position: 'relative' }}>
          {view === 'tasks' ? <TaskGraph selected={sel} onSelect={setSel} critical={critical} /> : <AgentGraph onOpenAgent={(id) => A.go('agent', { agent: id })} />}
        </div>
        <aside className="at-taskpanel">
          {t && ag ? (
            <>
              <PanelHead label="Task" title={<span className="at-mono">{t.id}</span>}><IconButton icon={IClose} label="Clear selection" size="sm" onClick={() => setSel(undefined)} /></PanelHead>
              <div className="at-pbody">
                <div style={{ padding: 16 }}>
                  <div className="heading" style={{ marginBottom: 8 }}>{t.title}</div>
                  <Status s={t.status} />
                  <dl className="at-kv" style={{ marginTop: 14 }}>
                    <dt>Owner</dt><dd><button type="button" className="at-row at-link" style={{ gap: 6 }} onClick={() => A.go('agent', { agent: ag.id })}><RoleMark mark={ag.mark} size="sm" />{ag.name}</button></dd>
                    <dt>Depends on</dt><dd>{t.deps.length ? t.deps.map((d) => <button key={d} type="button" className="at-badge at-badge--outline at-mono" style={{ marginRight: 4 }} onClick={() => setSel(d)}>{d}</button>) : '—'}</dd>
                    <dt>Unblocks</dt><dd>{tasks.filter((x) => x.deps.includes(t.id)).map((x) => <button key={x.id} type="button" className="at-badge at-badge--outline at-mono" style={{ marginRight: 4 }} onClick={() => setSel(x.id)}>{x.id}</button>)}</dd>
                    <dt>Duration</dt><dd>{t.duration ?? (t.status === 'running' ? 'running' : '—')}</dd>
                  </dl>
                </div>
                {!live.on && t.id === 'T13' && <div className="at-callout at-callout--warning" style={{ margin: '0 16px 16px' }}><Icon as={IShield} /><div><b>Gated.</b> Starts only when T10 security review and T12 browser QA pass, and T9 lands. T12 is failing.</div></div>}
                {live.on && t.status === 'blocked' && <div className="at-callout at-callout--warning" style={{ margin: '0 16px 16px' }}><Icon as={IShield} /><div><b>Gated.</b> Starts when {t.deps.join(', ')} finish{t.deps.some((d) => tasks.find((x) => x.id === d)?.status === 'failed') ? ' — one of them failed' : ''}.</div></div>}
                {(live.on ? t.status === 'failed' : t.id === 'T12') && <div style={{ padding: '0 16px 16px' }}><Button size="sm" onClick={() => A.go('mission', { recovery: true, agent: t.agent })}>Open diagnostic</Button></div>}
              </div>
            </>
          ) : <EmptyState icon={IGraph} title="Select a task" body="Click any task to see its owner, what it waits on and what it unblocks. Drag to pan; ⌘-scroll to zoom." />}
        </aside>
      </div>
    </div>
  );
}

/* ---------- 11. Agent studio ---------- */
const yaml = `name: browser-qa
role: QA Engineer
model:
  primary: claude-sonnet-5-5
  fallback: claude-haiku-5-5
tools: [browser, shell, test, screenshot]
skills: [playwright-flows, a11y-audit]
mcp:
  - linear        # read issues only
permissions:
  browser: { allow: ["localhost:*"], ask: ["*.staging.acme.dev"] }
  shell:   { allow: ["pnpm playwright*", "pnpm test*"] }
  write:   { allow: ["e2e/**"] }
  network: ask
context:
  strategy: rolling-summary
  keep: [mission-brief, contract, last-failure]
limits: { tokens: 400k, minutes: 30, usd: 4.00 }
output:
  require: [junit, trace, screenshots]
verify:
  - every assertion has evidence (screenshot or trace)
  - never mark a flow passed on a 2xx alone`;

export function AgentStudio() { return live.on ? <LiveStudio /> : <SampleStudio />; }

/** Live Agent Studio: the roles ATLAS runs are versioned policy in code, shown exactly as enforced. */
function LiveStudio() {
  const ids = Object.keys(roleDetails);
  const [sel, setSel] = useState(ids[0] ?? '');
  const [task, setTask] = useState('');
  const A = actions();
  const r = roleDetails[sel];
  const used = agents.filter((a) => a.role === r?.title).length;
  return (
    <div className="at-screen at-studio">
      <aside className="at-studio-list">
        <div className="at-phead"><span className="at-label">Agent Studio</span></div>
        <div className="at-pbody">
          <div className="at-label" style={{ padding: '12px 12px 6px' }}>Roles in this mission</div>
          {agents.filter((a) => a.id !== 'orch').map((a) => { const id = ids.find((x) => roleDetails[x].title === a.role) ?? ''; return <button key={a.id} type="button" className="at-list-row" aria-selected={sel === id} onClick={() => id && setSel(id)}><RoleMark mark={a.mark} size="sm" /><span className="at-trunc">{a.name}</span><span className="at-subtle at-mono" style={{ marginLeft: 'auto', fontSize: 11 }}>{a.id}</span></button>; })}
          <div className="at-label" style={{ padding: '16px 12px 6px' }}>All roles</div>
          {templates.map((t) => <button key={t.id} type="button" className="at-list-row" aria-selected={sel === t.id} onClick={() => setSel(t.id)}><RoleMark mark={t.mark} size="sm" /><span className="at-col" style={{ minWidth: 0 }}><span className="at-trunc">{t.name}</span><span className="at-subtle at-trunc" style={{ fontSize: 11.5 }}>{t.tools} tools</span></span></button>)}
        </div>
      </aside>
      {r ? (
        <div className="at-col at-grow">
          <div className="at-studio-head">
            <RoleMark mark={templates.find((t) => t.id === r.id)?.mark ?? 'AG'} size="lg" />
            <div className="at-col" style={{ gap: 2, flex: 1 }}><span className="heading">{r.title}</span><span className="at-subtle" style={{ fontSize: 12 }}>{r.version} · versioned policy in code · in this mission: {used} agent{used === 1 ? '' : 's'}</span></div>
            <Tip label="Roles are code-reviewed policy: change them through a mission on the ATLAS repository, not in the UI."><span><Button disabled icon={ICheck}>Policy · read-only</Button></span></Tip>
          </div>
          <div className="at-pbody at-studio-form">
            <section className="at-sform">
              <div className="at-sform-h"><span className="at-label">Identity</span></div>
              <div className="at-sform-grid">
                <Field label="Name"><Input value={r.title} readOnly /></Field>
                <Field label="Role id"><Input value={r.id} readOnly /></Field>
                <div style={{ gridColumn: '1 / -1' }}><Field label="Instructions" help="Shown to the agent at the top of every context." aside={<span className="at-mono at-subtle">{Math.round(r.instructions.length / 4)} tokens</span>}>
                  <label className="at-input at-textarea"><textarea rows={8} value={r.instructions} readOnly /></label>
                </Field></div>
              </div>
            </section>
            <section className="at-sform">
              <div className="at-sform-h"><span className="at-label">Model & context</span></div>
              <div className="at-sform-grid">
                <Field label="Tier"><Input value={r.tier} readOnly /></Field>
                <Field label="Model" help="Set per tier in Settings → Models."><Input value={r.model} readOnly /></Field>
              </div>
            </section>
            <section className="at-sform">
              <div className="at-sform-h"><span className="at-label">Tools & capabilities</span></div>
              <div className="at-toolgrid">{r.tools.map((k) => <label key={k} className="at-toolrow"><span className="at-mono">{k}</span><Toggle on label={k} /></label>)}</div>
              <div className="at-row" style={{ gap: 6, marginTop: 12, flexWrap: 'wrap' }}>{r.capabilities.map((c) => <Badge key={c} tone="accent" icon={ISkill}>{c}</Badge>)}</div>
            </section>
            <section className="at-sform">
              <div className="at-sform-h"><span className="at-label">Execution permissions</span></div>
              <div className="at-perms">
                {[['File writes', r.writes ? 'allow' : 'deny', r.writes ? 'its own worktree only' : 'read-only role'], ['Shell', r.tools.includes('shell_exec') ? 'allow' : 'deny', 'safe list, OS sandbox'], ['Risky commands', 'ask', 'your approval, once'], ['Network', r.capabilities.some((c) => c.startsWith('net')) ? 'ask' : 'deny', 'no outbound by default'], ['Deploy', r.capabilities.some((c) => c.startsWith('deploy')) ? 'ask' : 'deny', 'staging only, approved each time']].map(([k, v, d]) => (
                  <div key={k} className="at-permrow"><span>{k}</span><span className="at-mono at-subtle at-trunc">{d}</span><Seg value={v} onChange={() => {}} items={[{ id: 'allow', label: 'Allow' }, { id: 'ask', label: 'Ask' }, { id: 'deny', label: 'Deny' }]} /></div>
                ))}
              </div>
            </section>
            <section className="at-sform">
              <div className="at-sform-h"><span className="at-label">Limits</span></div>
              <div className="at-sform-grid at-sform-grid--3">
                <Field label="Tool calls"><Input value={String(r.budget.maxToolCalls)} readOnly /></Field><Field label="Token limit"><Input value={`${Math.round(r.budget.maxTokens / 1000)}k`} readOnly /></Field><Field label="Time limit"><Input value={`${Math.round(r.budget.wallClockMs / 60000)} min`} readOnly /></Field>
              </div>
            </section>
          </div>
        </div>
      ) : <EmptyState center icon={IAgents} title="No roles" body="The control plane returned no roles." />}
      <aside className="at-sandbox">
        <PanelHead label="Try it" title={<span className="at-subtle" style={{ fontWeight: 400 }}>a real mission</span>} />
        <div className="at-pbody" style={{ padding: 14 }}>
          <Field label="Test task"><label className="at-input at-textarea"><textarea rows={4} value={task} onChange={(e) => setTask(e.target.value)} placeholder="A small, safe task for this repository" /></label></Field>
          <div className="at-row" style={{ gap: 8, margin: '10px 0 16px' }}><Button variant="primary" icon={IPlay} disabled={!task.trim() || !adapter} onClick={() => void adapter?.launch(task.trim()).catch((e: Error) => A.toast({ tone: 'danger', title: 'Could not launch', body: e.message }))}>Run as mission</Button></div>
          <p className="at-subtle" style={{ fontSize: 12 }}>Runs in isolated worktrees under the same policy, with a plan you approve first.</p>
        </div>
      </aside>
    </div>
  );
}

function SampleStudio() {
  const [mode, setMode] = useState<'visual' | 'config'>('visual');
  const [sel, setSel] = useState('bqa');
  const [tools, setTools] = useState<Record<string, boolean>>({ browser: true, shell: true, test: true, screenshot: true, edit: false, deploy: false });
  const [ctx, setCtx] = useState('rolling');
  const [ran, setRan] = useState(false);
  const [perm, setPerm] = useState<Record<string, string>>({ Browser: 'allow', Shell: 'allow', 'File writes': 'allow', Network: 'ask', Deploy: 'deny' });
  return (
    <div className="at-screen at-studio">
      <aside className="at-studio-list">
        <div className="at-phead"><span className="at-label">Agent Studio</span><span className="at-spacer" /><IconButton icon={IPlus} label="New agent" size="sm" /></div>
        <div className="at-pbody">
          <div className="at-label" style={{ padding: '12px 12px 6px' }}>Your agents</div>
          {agents.slice(0, 8).map((a) => <button key={a.id} type="button" className="at-list-row" aria-selected={sel === a.id} onClick={() => setSel(a.id)}><RoleMark mark={a.mark} size="sm" /><span className="at-trunc">{a.name}</span><span className="at-subtle" style={{ marginLeft: 'auto', fontSize: 11 }}>{a.model.replace('Claude ', '')}</span></button>)}
          <div className="at-label" style={{ padding: '16px 12px 6px' }}>Templates</div>
          {templates.map((t) => <button key={t.id} type="button" className="at-list-row" aria-selected={sel === t.id} onClick={() => setSel(t.id)}><RoleMark mark={t.mark} size="sm" /><span className="at-col" style={{ minWidth: 0 }}><span className="at-trunc">{t.name}</span></span></button>)}
        </div>
      </aside>
      <div className="at-col at-grow">
        <div className="at-studio-head">
          <RoleMark mark="BQ" size="lg" />
          <div className="at-col" style={{ gap: 2, flex: 1 }}><span className="heading">Browser QA</span><span className="at-subtle" style={{ fontSize: 12 }}>From template · used by QA Engineer in 3 missions · edited 2 days ago</span></div>
          <Seg value={mode} onChange={setMode} items={[{ id: 'visual', label: 'Visual' }, { id: 'config', label: 'Config & Markdown' }]} />
          <Button variant="primary" icon={ICheck}>Save agent</Button>
        </div>
        {mode === 'config' ? (
          <div className="at-pbody" style={{ padding: 20 }}>
            <div className="at-row" style={{ alignItems: 'stretch', gap: 16 }}>
              <div style={{ flex: 1, minWidth: 0 }}><CodeBlock title="agents/browser-qa.yaml" lang="yaml" code={yaml} /></div>
              <div style={{ flex: 1, minWidth: 0 }}><CodeBlock title="agents/browser-qa.md" lang="bash" code={`# Browser QA\n\nYou verify user flows in an isolated browser.\n\n## Rules\n- Write the flow as steps before running it.\n- Every assertion needs a screenshot or trace.\n- A 2xx response is not a passing flow.\n- On failure, attach the trace and the\n  smallest reproduction you can find.\n\n## Hand-off\nReport to the Orchestrator with: flows,\nevidence paths, and anything you could\nnot verify.`} /></div>
            </div>
          </div>
        ) : (
          <div className="at-pbody at-studio-form">
            <section className="at-sform">
              <div className="at-sform-h"><span className="at-label">Identity</span></div>
              <div className="at-sform-grid">
                <Field label="Name"><Input defaultValue="Browser QA" /></Field>
                <Field label="Role"><Input defaultValue="QA Engineer" /></Field>
                <div style={{ gridColumn: '1 / -1' }}><Field label="Instructions" help="Markdown. Shown to the agent at the top of every context." aside={<span className="at-mono at-subtle">412 tokens</span>}>
                  <label className="at-input at-textarea"><textarea rows={4} defaultValue={'You verify user flows in an isolated browser. Write each flow as steps before running it. Every assertion needs a screenshot or trace. A 2xx response is not a passing flow.'} /></label>
                </Field></div>
              </div>
            </section>
            <section className="at-sform">
              <div className="at-sform-h"><span className="at-label">Model & context</span></div>
              <div className="at-sform-grid">
                <Field label="Model"><Select value="sonnet" onChange={() => {}} options={models.map((m) => ({ id: m.id, label: m.name, hint: m.provider }))} /></Field>
                <Field label="Fallback"><Select value="haiku" onChange={() => {}} options={models.map((m) => ({ id: m.id, label: m.name, hint: m.provider }))} /></Field>
                <div style={{ gridColumn: '1 / -1' }}><Field label="Context strategy" help={ctx === 'rolling' ? 'Older turns are summarized; the brief, contract and last failure are always kept verbatim.' : ctx === 'full' ? 'Keeps everything until the limit, then stops and asks.' : 'Starts lean and retrieves files and past events on demand.'}>
                  <Seg value={ctx} onChange={setCtx} items={[{ id: 'full', label: 'Full history' }, { id: 'rolling', label: 'Rolling summary' }, { id: 'retrieval', label: 'Retrieval' }]} />
                </Field></div>
              </div>
            </section>
            <section className="at-sform">
              <div className="at-sform-h"><span className="at-label">Tools, skills & MCP</span></div>
              <div className="at-toolgrid">{Object.entries(tools).map(([k, v]) => <label key={k} className="at-toolrow"><span className="at-mono">{k}</span><Toggle on={v} onChange={(x) => setTools({ ...tools, [k]: x })} label={k} /></label>)}</div>
              <div className="at-row" style={{ gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                <Badge tone="accent" icon={ISkill}>playwright-flows</Badge><Badge tone="accent" icon={ISkill}>a11y-audit</Badge>
                <Badge tone="outline" icon={IPlug}>linear · read-only</Badge><button type="button" className="at-chip"><Icon as={IPlus} size="sm" />Add skill or MCP server</button>
              </div>
            </section>
            <section className="at-sform">
              <div className="at-sform-h"><span className="at-label">Execution permissions</span></div>
              <div className="at-perms">
                {Object.entries(perm).map(([k, v]) => (
                  <div key={k} className="at-permrow"><span>{k}</span><span className="at-mono at-subtle at-trunc">{k === 'Browser' ? 'localhost:* · ask *.staging.acme.dev' : k === 'Shell' ? 'pnpm playwright*, pnpm test*' : k === 'File writes' ? 'e2e/**' : k === 'Network' ? 'outside localhost' : 'any environment'}</span>
                    <Seg value={v} onChange={(x) => setPerm({ ...perm, [k]: x })} items={[{ id: 'allow', label: 'Allow' }, { id: 'ask', label: 'Ask' }, { id: 'deny', label: 'Deny' }]} /></div>
                ))}
              </div>
            </section>
            <section className="at-sform">
              <div className="at-sform-h"><span className="at-label">Limits, output & verification</span></div>
              <div className="at-sform-grid at-sform-grid--3">
                <Field label="Token limit"><Input defaultValue="400k" /></Field><Field label="Time limit"><Input defaultValue="30 min" /></Field><Field label="Cost limit"><Input defaultValue="$4.00" /></Field>
              </div>
              <div className="at-col" style={{ gap: 8, marginTop: 14 }}>
                {['Produce junit.xml, Playwright trace and screenshots', 'Every assertion has evidence', 'Never mark a flow passed on a 2xx alone', 'Report what could not be verified'].map((x, i) => <label key={i} className="at-row" style={{ gap: 10, fontSize: 12.5 }}><Check on={true} label={x} />{x}</label>)}
              </div>
            </section>
          </div>
        )}
      </div>
      <aside className="at-sandbox">
        <PanelHead label="Sandbox" title={<SampleTag>sample run</SampleTag>} />
        <div className="at-pbody" style={{ padding: 14 }}>
          <Field label="Test task"><label className="at-input at-textarea"><textarea rows={3} defaultValue="Verify that a signed-in user can sign out from the account menu and lands on /login." /></label></Field>
          <div className="at-row" style={{ gap: 8, margin: '10px 0 16px' }}><Select value="fixture" onChange={() => {}} options={[{ id: 'fixture', label: 'Fixture app · storefront@main' }]} /><Button variant="primary" icon={IPlay} onClick={() => setRan(true)}>Run</Button></div>
          {ran ? (
            <div className="at-col" style={{ gap: 0 }}>
              <div className="at-label" style={{ marginBottom: 6 }}>Result · 41s · $0.08</div>
              <VerificationRow label="Wrote 5-step flow before running" value="ok" status="passed" />
              <VerificationRow label="Sign in with fixture user" value="screenshot" status="passed" />
              <VerificationRow label="Sign out via account menu" value="trace" status="passed" />
              <VerificationRow label="Lands on /login" value="screenshot" status="passed" />
              <VerificationRow label="Stayed inside permissions" value="0 denials" status="passed" />
              <div className="at-callout" style={{ marginTop: 12 }}><Icon as={ICheck} className="at-ok" /><div>Ready to add to missions. Sandbox runs use a disposable container and never touch your worktree.</div></div>
            </div>
          ) : <EmptyState icon={IBox} title="Test before it joins a mission" body="Runs the agent against a fixture copy of your app in a throwaway container." />}
        </div>
      </aside>
    </div>
  );
}

export { IFilter, IAgents, ICode, ISearch, ICircleDashed, IRetry, ICopy, IUndo, Meter, Tip, Split, IPause, ITerminal };
