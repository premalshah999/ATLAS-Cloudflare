import React, { useState } from 'react';
import { actions, adapter, useApp } from '../lib/store';
import { openRepository } from '../lib/workspace';
import { missions, workspaces, workspace, agents, agentById, activity, deployments, checkpoints, templates, models, live } from '../data/source';
import { cx, Icon, Button, IconButton, Badge, Status, PanelHead, Kbd, RoleMark, Input, Field, Select, Seg, Meter, Tip, SampleTag, Check, Dot, EmptyState } from '../ui/primitives';
import { Composer } from '../ui/composer';
import { ApprovalCard } from '../ui/overlays';
import {
  IFolder, IPlus, ILink, ICheck, IKey, IShield, IPlay, IArrowRight, IRepo, IBranch, ICommit, IReviews, IDeploy, IHistory, IMissions, IXCircle,
  ISpark, IChevronRight, ISearch, IClose, IServer, ICpu, IMore,
} from '../lib/icons';

/* ---------- 1. Welcome / first launch ---------- */
const presets = [
  { id: 'ask', title: 'Ask first', body: 'Every write, command and network call waits for you. Slow; good for an unfamiliar repo.' },
  { id: 'balanced', title: 'Balanced', body: 'Agents edit and test freely inside isolated worktrees. Schema changes, network, deploys and anything outside the repo ask.', rec: true },
  { id: 'sandbox', title: 'Autonomous in sandbox', body: 'Full autonomy inside a disposable container. Nothing leaves it until you merge.' },
];

export function Welcome() {
  const [step, setStep] = useState(1);
  const [ws, setWs] = useState(false);
  const [key, setKey] = useState('');
  const [connected, setConnected] = useState(false);
  const [preset, setPreset] = useState('balanced');
  const [permsDone, setPermsDone] = useState(false);
  const A = actions();
  const stepState = (n: number) => (n === 1 ? ws : n === 2 ? connected : n === 3 ? permsDone : false);
  const Step = ({ n, title, summary, children }: { n: number; title: string; summary: React.ReactNode; children: React.ReactNode }) => (
    <div className={cx('at-wstep', step === n && 'at-wstep--open', stepState(n) && 'at-wstep--done')}>
      <button type="button" className="at-wstep-head" onClick={() => setStep(n)} aria-expanded={step === n}>
        <span className="at-wstep-n">{stepState(n) ? <Icon as={ICheck} size="sm" /> : n}</span>
        <span className="at-wstep-title">{title}</span>
        <span className="at-wstep-sum at-trunc">{summary}</span>
      </button>
      {step === n && <div className="at-wstep-body">{children}</div>}
    </div>
  );
  return (
    <div className="at-welcome">
      <div className="at-welcome-l">
        <div className="at-wordmark">ATLAS</div>
        <h1 className="display-xl" style={{ margin: '28px 0 14px' }}>Engineering,<br />under command.</h1>
        <p className="at-welcome-lede">Give Atlas a goal. It becomes a mission: a plan, a team of agents working in isolated worktrees, and evidence that the work actually runs. Nothing executes outside the permissions you set.</p>
        <div className="at-row" style={{ gap: 8, marginTop: 28 }}>
          <Button variant="primary" icon={IFolder} kbd="⌘ O" onClick={() => { setWs(true); setStep(2); }}>Open repository</Button>
          <Button icon={IPlus}>New workspace</Button>
          <Button variant="ghost" icon={ILink}>Clone from URL</Button>
        </div>
        <div className="at-label" style={{ marginTop: 44, marginBottom: 6 }}>Recent</div>
        <div className="at-col">
          {workspaces.slice(0, 3).map((w) => (
            <button key={w.id} type="button" className="at-recent-ws" onClick={() => { setWs(true); setStep(2); }}>
              <Icon as={IRepo} className="at-subtle" /><span>{w.name}</span><span className="at-mono at-subtle at-trunc">{w.path}</span><span className="at-subtle" style={{ marginLeft: 'auto', fontSize: 12 }}>{w.updated}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="at-welcome-r">
        <div className="at-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <span className="at-label">Set up · about 2 minutes</span>
          <button type="button" className="at-link" onClick={() => A.go('home')}>Skip — I know my way around</button>
        </div>
        <div className="at-wsteps">
          <Step n={1} title="Workspace" summary={ws ? <span className="at-mono">~/code/acme/storefront</span> : 'Choose a repository'}>
            <p className="at-wstep-p">Atlas reads the repository and creates agent worktrees under <span className="at-mono">.atlas/wt/</span>. Your working tree is never edited directly.</p>
            <div className="at-row" style={{ gap: 8 }}><Input icon={IFolder} defaultValue="~/code/acme/storefront" style={{ flex: 1 }} /><Button onClick={() => { setWs(true); setStep(2); }}>Use folder</Button></div>
          </Step>
          <Step n={2} title="Model provider" summary={connected ? 'Anthropic · 3 models' : 'Not connected'}>
            <p className="at-wstep-p">Keys are stored in the system keychain and only sent to the provider.</p>
            <Field label="Anthropic API key" help={connected ? 'Connected · Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 available.' : 'Or run models locally with Ollama.'}>
              <div className="at-row" style={{ gap: 8 }}>
                <Input icon={IKey} type="password" placeholder="sk-ant-…" value={key || (connected ? 'sk-ant-api03-•••••••••••' : '')} onChange={(e) => setKey(e.target.value)} style={{ flex: 1 }} />
                {connected ? <Badge tone="success" icon={ICheck}>Connected</Badge> : <Button onClick={() => { setConnected(true); setStep(3); }}>Connect</Button>}
              </div>
            </Field>
            <div className="at-row" style={{ gap: 8, marginTop: 10 }}><Button size="sm" variant="ghost" icon={IServer}>Use local models (Ollama)</Button><Button size="sm" variant="ghost">Bedrock / Vertex…</Button></div>
          </Step>
          <Step n={3} title="Execution permissions" summary={permsDone ? presets.find((p) => p.id === preset)!.title : 'What agents may do without asking'}>
            <div className="at-col" style={{ gap: 6 }}>
              {presets.map((p) => (
                <button key={p.id} type="button" className="at-recopt" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
                  <span className="at-recopt-radio" />
                  <span className="at-col" style={{ gap: 3 }}><span className="at-row" style={{ gap: 8 }}><b>{p.title}</b>{p.rec && <Badge tone="accent">Recommended</Badge>}</span><span className="at-recopt-body">{p.body}</span></span>
                </button>
              ))}
            </div>
            <div className="at-permtable">
              {[['Edit files in worktree', 'allow', 'ask', 'allow'], ['Run tests & linters', 'allow', 'ask', 'allow'], ['Schema / DB changes', 'ask', 'ask', 'allow'], ['Network outside localhost', 'ask', 'ask', 'deny'], ['Deploy to staging', 'ask', 'ask', 'deny'], ['Deploy to production', 'ask', 'ask', 'deny']].map((r) => {
                const col = preset === 'ask' ? 2 : preset === 'balanced' ? 1 : 3;
                return <div key={r[0]} className="at-perm" data-l={r[col]}><span className="at-perm-level">{r[col]}</span><span className="at-perm-scope">{r[0]}</span></div>;
              })}
            </div>
            <div className="at-row" style={{ marginTop: 10 }}><span className="at-subtle" style={{ fontSize: 12, flex: 1 }}>Production deploys always need your authorization.</span><Button onClick={() => { setPermsDone(true); setStep(4); }}>Save</Button></div>
          </Step>
          <Step n={4} title="Try a sample mission" summary="Runs in a disposable worktree">
            <p className="at-wstep-p">Watch Mission Control with real activity on a small, safe task. Nothing is merged.</p>
            <div className="at-sample-mission">
              <Icon as={IMissions} className="at-acc" />
              <div className="at-col" style={{ gap: 2, flex: 1 }}><b>Add rate limiting to POST /api/login</b><span className="at-subtle" style={{ fontSize: 12 }}>3 agents · ~6 min · writes tests first · no network</span></div>
              <Button variant="primary" icon={IPlay} onClick={() => A.go('mission')}>Start</Button>
            </div>
          </Step>
        </div>
        <div className="at-welcome-foot"><Kbd k="⌘ K" /> opens the command palette from anywhere</div>
      </div>
    </div>
  );
}

/* ---------- 2. Workspace home ---------- */
/** Live: rows show the short id (MSN-XXXXXX); map back to the control-plane id. */
const missionIdOf = (short: string) => (window as unknown as { __atlasMissionIds?: Record<string, string> }).__atlasMissionIds?.[short] ?? null;
function HomeNeeds() {
  const A = actions();
  const approvals = useApp((st) => st.approvals);
  const failed = agents.filter((a) => a.status === 'failed');
  return (
    <section>
      <div className="at-home-sh"><span className="at-label">Needs you</span><span className="at-mono at-subtle">{approvals.length + failed.length}</span></div>
      <div className="at-col" style={{ gap: 8 }}>
        {failed.slice(0, 2).map((f) => <div key={f.id} className="at-error"><Icon as={IXCircle} /><h5>{f.assignment} failed</h5><p>{f.blocker ?? f.activity}</p><div className="at-row"><Button size="sm" onClick={() => A.go('mission', { recovery: true, agent: f.id })}>Recover…</Button></div></div>)}
        {approvals.slice(0, 2).map((ap) => <ApprovalCard key={ap.id} id={ap.id} compact />)}
        {!approvals.length && !failed.length && <p className="at-subtle" style={{ fontSize: 12, margin: 0 }}>Nothing is waiting for you.</p>}
      </div>
    </section>
  );
}
const mStatus = (s: string) => (s === 'running' ? 'running' : s === 'verified' ? 'verified' : s === 'review' ? 'review' : s === 'failed' ? 'failed' : 'done');
export function Home() {
  const A = actions();
  return (
    <div className="at-screen at-home">
      <div className="at-home-head">
        <div className="at-col" style={{ gap: 4, minWidth: 0 }}>
          <div className="at-row" style={{ gap: 10, minWidth: 0 }}><span className="display at-trunc" style={{ fontSize: 20 }}>{workspace.name}</span><span className="at-subtle at-trunc">{workspace.owner}</span></div>
          <div className="at-row at-home-meta">
            <span><Icon as={IFolder} size="sm" /><span className="at-mono at-trunc">{workspace.path}</span></span>
            <span><Icon as={IBranch} size="sm" /><span className="at-mono">{workspace.branch}</span></span>
            <span><Icon as={ICommit} size="sm" /><span className="at-mono">{workspace.head}</span>{live.on ? '' : ' auth: rotate refresh tokens per use'}</span>
            <span className="at-ok">{live.on ? workspace.runtime : 'clean'}</span>
          </div>
        </div>
      </div>
      <div className="at-home-composer">
        <Composer large running={false} mode="plan" placeholder="Describe a goal. Atlas plans it, staffs it, and shows you before anything runs." quick={live.on ? ['Find and fix the most important bug, with a regression test', 'Upgrade dependencies with security advisories', 'Add request logging and a readiness endpoint'] : ['Fix the flaky checkout e2e test', 'Upgrade dependencies with security advisories', 'Add passkey sign-in and deploy to staging']}
          onSend={(text?: string) => { if (adapter && text?.trim()) void adapter.launch(text.trim()).catch((e: Error) => A.toast({ tone: 'danger', title: 'Could not launch', body: e.message })); else A.go('create'); }} />
      </div>
      <div className="at-home-grid">
        <div className="at-col at-home-main" style={{ gap: 28, minWidth: 0 }}>
          <section>
            <div className="at-home-sh"><span className="at-label">Missions</span><span style={{ flex: 1 }} /><Button size="sm" variant="ghost" icon={IPlus} kbd="⌘ N" onClick={() => A.go('create')}>New mission</Button></div>
            <div className="at-table-wrap">
              <table className="at-table at-home-table">
                <thead><tr><th style={{ width: 120 }}>Status</th><th>Mission</th><th style={{ width: 130 }}>Progress</th><th style={{ width: 70 }}>Agents</th><th style={{ width: 90, textAlign: 'right' }}>Updated</th></tr></thead>
                <tbody>
                  {missions.map((m) => (
                    <tr key={m.id} onClick={() => A.go(m.status === 'verified' ? 'report' : m.status === 'review' ? 'review' : 'mission', live.on ? { missionId: missionIdOf(m.id) } : {})} style={{ cursor: 'default' }}>
                      <td><Status s={mStatus(m.status)} label={m.status === 'running' ? 'Running' : m.status === 'review' ? 'Needs review' : m.status === 'verified' ? 'Verified' : m.status === 'failed' ? 'Failed' : m.status === 'paused' ? 'Plan ready' : 'Done'} /></td>
                      <td className="at-home-title"><span className="at-row at-home-titlecell" style={{ gap: 8 }}><span className="at-mono at-subtle" style={{ flex: 'none' }}>{m.id}</span><span className="at-trunc" style={{ fontWeight: 500 }}>{m.title}</span></span></td>
                      <td><span className="at-row" style={{ gap: 8 }}><Meter value={m.tasksDone} max={m.tasksTotal} tone={m.status === 'running' ? 'accent' : undefined} style={{ flex: 1 }} /><span className="at-mono at-subtle at-tnum">{m.tasksDone}/{m.tasksTotal}</span></span></td>
                      <td className="at-mono at-muted">{m.agents}</td>
                      <td className="at-subtle" style={{ textAlign: 'right' }}>{m.updated}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <div className="at-home-sh"><span className="at-label">Recent activity</span><span style={{ flex: 1 }} /><Button size="sm" variant="ghost" onClick={() => A.go('activity')}>All activity</Button></div>
            <div className="at-feed">
              {activity.slice(0, 6).map((a, i) => (
                <div key={i} className="at-feed-row">
                  <span className="at-mono at-subtle">{a.time}</span>
                  <Dot s={a.kind === 'error' ? 'failed' : a.kind === 'warn' ? 'warning' : a.kind === 'ok' ? 'done' : 'human'} />
                  <span className={cx('at-trunc', a.kind === 'human' && 'at-human-c')} style={{ fontWeight: 500, flex: 'none', maxWidth: '40%' }}>{a.who}</span>
                  <span className="at-muted at-trunc">{a.text}</span>
                  <span className="at-mono at-subtle at-trunc" style={{ marginLeft: 'auto', flex: 'none', maxWidth: 120 }}>{a.mission}</span>
                </div>
              ))}
            </div>
          </section>
          {deployments.length > 0 && (
            <section>
              <div className="at-home-sh"><span className="at-label">Environments</span></div>
              <div className="at-envs">
                {deployments.slice(0, 3).map((d) => <div key={d.id}><Dot s={d.status.includes('fail') || d.status.includes('roll') ? 'failed' : 'healthy'} /><span className="at-trunc">{d.env}</span><span className="at-mono at-subtle at-trunc">{d.commit} · {d.mission}</span><Badge tone={d.status.includes('warning') ? 'warning' : 'outline'}>{d.status}</Badge></div>)}
              </div>
            </section>
          )}
          {checkpoints.length > 0 && (
            <section>
              <div className="at-home-sh"><span className="at-label">Checkpoints</span><span style={{ flex: 1 }} /><Button size="sm" variant="ghost" onClick={() => A.set({ drawer: 'checkpoints', screen: 'mission' })}>History</Button></div>
              {checkpoints.slice(0, 3).map((c) => <div key={c.id} className="at-feed-row"><span className="at-mono at-acc">{c.id}</span><span className="at-trunc">{c.label}</span><span className="at-mono at-subtle" style={{ marginLeft: 'auto' }}>{c.time.slice(0, 5)}</span></div>)}
            </section>
          )}
        </div>
        <div className="at-col at-home-side" style={{ gap: 24, minWidth: 0 }}>
          <HomeNeeds />
          <section>
            <div className="at-home-sh"><span className="at-label">Ready for review</span></div>
            {missions.filter((m) => m.status === 'review').slice(0, 3).map((m) => (
              <button key={m.id} type="button" className="at-home-card" onClick={() => A.go('review', live.on ? { missionId: missionIdOf(m.id) } : {})}>
                <Icon as={IReviews} className="at-subtle" />
                <span className="at-col" style={{ gap: 2, flex: 1, minWidth: 0 }}><span className="at-trunc" style={{ fontWeight: 500 }}>{m.id} · {m.title}</span><span className="at-subtle" style={{ fontSize: 12 }}>{m.tasksDone}/{m.tasksTotal} tasks · {m.updated}</span></span>
                <Icon as={IChevronRight} size="sm" className="at-subtle" />
              </button>
            ))}
            {!missions.some((m) => m.status === 'review') && <p className="at-subtle" style={{ fontSize: 12 }}>Nothing is waiting for review.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

/* ---------- Workspaces ---------- */
export function Workspaces() {
  const A = actions();
  const [q, setQ] = useState('');
  return (
    <div className="at-screen">
      <div className="at-pagehead"><span className="heading">Workspaces</span><span style={{ flex: 1 }} /><Input icon={ISearch} placeholder="Filter" style={{ width: 220 }} value={q} onChange={(e) => setQ(e.target.value)} /><Button variant="primary" icon={IFolder} kbd="⌘ O" onClick={() => openRepository()}>Open repository</Button></div>
      <div className="at-pbody" style={{ padding: '0 20px' }}>
        <table className="at-table">
          <thead><tr><th>Repository</th><th>Path</th><th>Branch</th><th>Active missions</th><th style={{ textAlign: 'right' }}>Last opened</th></tr></thead>
          <tbody>{workspaces.filter((w) => !q || `${w.name} ${w.path}`.toLowerCase().includes(q.toLowerCase())).map((w) => (
            <tr key={w.id} aria-selected={w.name === workspace.name} onClick={() => A.go('home')}>
              <td><span className="at-row"><Icon as={IRepo} className="at-subtle" /><span style={{ fontWeight: 500 }}>{w.name}</span></span></td>
              <td className="at-mono at-muted">{w.path}</td><td className="at-mono at-muted">{w.branch}</td>
              <td>{w.missions ? <Badge tone="accent">{w.missions} mission{w.missions === 1 ? '' : 's'}</Badge> : <span className="at-subtle">—</span>}</td>
              <td className="at-subtle" style={{ textAlign: 'right' }}>{w.updated}</td>
            </tr>
          ))}</tbody>
        </table>
        <div className="at-callout" style={{ marginTop: 20, maxWidth: 640 }}><Icon as={IHistory} /><div>Each workspace remembers its own panel layout, open terminals and inspector state. Switching restores exactly where you left off.</div></div>
      </div>
    </div>
  );
}

/* ---------- 3. Mission creation ---------- */
const plan = [
  { id: 'P1', agent: 'orch', title: 'Map current auth flows and session storage', deps: [], est: '1 min' },
  { id: 'P2', agent: 'sec', title: 'Threat-model WebAuthn registration & assertion', deps: ['P1'], est: '3 min' },
  { id: 'P3', agent: 'be', title: 'Credential table + /api/passkeys register & verify', deps: ['P1'], est: '9 min', perm: 'Schema change · asks' },
  { id: 'P4', agent: 'fe', title: 'Passkey button, conditional UI, fallbacks', deps: ['P3'], est: '7 min' },
  { id: 'P5', agent: 'qa', title: 'Virtual authenticator e2e: register, sign in, revoke', deps: ['P3', 'P4'], est: '5 min' },
  { id: 'P6', agent: 'ops', title: 'Deploy to staging; verify flows on staging', deps: ['P2', 'P5'], est: '6 min', perm: 'Deploy staging · asks' },
];
export function MissionCreate() {
  const A = actions();
  const [included, setIncluded] = useState<Record<string, boolean>>(Object.fromEntries(plan.map((p) => [p.id, true])));
  const [env, setEnv] = useState(live.on ? 'none' : 'staging');
  const [goal, setGoal] = useState(live.on ? '' : 'Add passkey (WebAuthn) sign-in alongside password login, test it with a virtual authenticator, deploy to staging, and verify the flows there.');
  const [rule, setRule] = useState('');
  const [busy, setBusy] = useState(false);
  const [constraints, setConstraints] = useState(live.on ? ['Keep every existing test passing', 'Do not change unrelated files'] : ['Keep password login working', 'No changes to db/migrations without approval', 'Public API stays backward compatible']);
  const launch = async () => {
    if (!adapter) { A.go('mission'); A.toast({ tone: 'info', title: 'MSN-0143 launched', body: '6 agents staffed · checkpoint CP-1 created' }); return; }
    if (!goal.trim()) { A.toast({ tone: 'warning', title: 'Describe the goal first' }); return; }
    setBusy(true);
    try { await adapter.launch(goal.trim(), { constraints: constraints.join('\n'), target: env === 'none' ? null : env }); }
    catch (e) { A.toast({ tone: 'danger', title: 'Could not launch', body: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const team = live.on ? templates : null;
  return (
    <div className="at-screen at-create">
      <div className="at-create-l">
        <div className="at-row" style={{ gap: 8, marginBottom: 14 }}><span className="at-mid">{live.on ? 'New mission · draft' : 'MSN-0143 · draft'}</span><span className="at-subtle" style={{ fontSize: 12 }}>{workspace.name} · from {workspace.branch}</span></div>
        <div className="at-create-goal">
          <div className="at-label" style={{ marginBottom: 8 }}>Goal</div>
          {live.on ? <textarea className="at-goal-text at-goal-input" data-testid="design-goal" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Describe the outcome. The orchestrator model plans it; you approve the plan before anything runs." />
            : <div className="at-goal-text">{goal}</div>}
        </div>
        <div className="at-create-form">
          <Field label="Constraints" help="Agents treat these as hard rules and cite them when declining.">
            <div className="at-row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {constraints.map((c) => <span key={c} className="at-chip" style={{ color: 'var(--ink)' }}>{c}<button type="button" aria-label="Remove" onClick={() => setConstraints(constraints.filter((x) => x !== c))} style={{ display: 'inline-flex', color: 'var(--ink-subtle)' }}><Icon as={IClose} size="sm" /></button></span>)}
              {live.on ? <span className="at-row" style={{ gap: 4 }}><Input placeholder="Add a rule" value={rule} onChange={(e) => setRule(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && rule.trim()) { setConstraints([...constraints, rule.trim()]); setRule(''); } }} style={{ width: 200 }} /></span>
                : <button type="button" className="at-chip"><Icon as={IPlus} size="sm" />Add rule</button>}
            </div>
          </Field>
          <div className="at-create-row">
            <Field label="Deploy target"><Select value={env} onChange={setEnv} options={live.on ? [{ id: 'none', label: 'Don’t deploy' }, ...deployTargets().map((t) => ({ id: t, label: t }))] : [{ id: 'none', label: 'Don’t deploy' }, { id: 'staging', label: 'staging · fly.io' }, { id: 'preview', label: 'Preview per branch' }]} /></Field>
            <Field label="Budget" help="Atlas stops and asks when reached."><Select value="b2" onChange={() => {}} options={live.on ? [{ id: 'b2', label: 'Default · 12 tasks · 2M tokens' }] : [{ id: 'b1', label: '$5 · 45 min' }, { id: 'b2', label: '$12 · 90 min' }, { id: 'b3', label: '$30 · 3 h' }]} /></Field>
            <Field label="Mode"><Seg value="plan" onChange={() => {}} items={[{ id: 'plan', label: 'Plan, then ask' }]} /></Field>
          </div>
        </div>
        <div className="at-create-perms">
          <div className="at-label" style={{ marginBottom: 8 }}>This mission will ask for</div>
          {(live.on ? [['Risky commands', 'shells, package installs, anything off the safe list', 'ask'], ['Deploy', env === 'none' ? 'not requested' : env, env === 'none' ? 'deny' : 'ask'], ['Network', 'only commands you approve', 'ask'], ['Filesystem write', 'each agent’s own worktree', 'allow']] : [['Database schema change', 'db/migrations/0044_passkeys.sql', 'ask'], ['Deploy', 'storefront-staging (fly.io)', 'ask'], ['Network', 'staging.acme.dev from QA browser', 'ask'], ['Filesystem write', 'src/auth/**, app/(auth)/**, e2e/**', 'allow']]).map(([sc, d, l]) => (
            <div key={sc} className="at-perm" data-l={l} style={{ gridTemplateColumns: '40px 170px 1fr' }}><span className="at-perm-level">{l}</span><span className="at-perm-scope">{sc}</span><span className="at-perm-detail at-mono at-trunc">{d}</span></div>
          ))}
        </div>
      </div>
      <div className="at-create-r">
        <PanelHead label={live.on ? 'Team' : 'Proposed plan'} title={<span className="at-subtle" style={{ fontWeight: 400 }}>{live.on ? 'the orchestrator staffs these roles; you approve its plan first' : 'v1 · drafted by Atlas Orchestrator in 18s'}</span>}>{!live.on && <Button size="sm" variant="ghost" icon={ISpark}>Refine</Button>}</PanelHead>
        <div className="at-pbody">
          {team ? (
            <div style={{ padding: '8px 16px' }}>
              {team.map((t) => <div key={t.id} className="at-team-row"><RoleMark mark={t.mark} size="sm" /><span>{t.name}</span><span className="at-subtle at-trunc" style={{ marginLeft: 'auto', fontSize: 12, maxWidth: 220 }}>{models.find((m) => m.role.includes(t.name))?.name ?? `${t.tools} tools`}</span></div>)}
              <div className="at-callout" style={{ margin: '16px 0' }}><Icon as={ICpu} /><div>Launching creates the mission and asks the orchestrator model for a plan: tasks, dependencies, acceptance criteria and the tools each needs. Nothing runs until you approve it.</div></div>
            </div>
          ) : (<>
          <div className="at-plan">
            {plan.map((p, i) => {
              const a = agentById(p.agent);
              return (
                <div key={p.id} className={cx('at-plan-row', !included[p.id] && 'at-plan-row--off')} style={{ animationDelay: `${i * 40}ms` }}>
                  <Check on={included[p.id]} onChange={(v) => setIncluded({ ...included, [p.id]: v })} label={`Include ${p.id}`} />
                  <span className="at-mono at-subtle">{p.id}</span>
                  <div className="at-col" style={{ gap: 3, minWidth: 0, flex: 1 }}>
                    <span className="at-plan-title">{p.title}</span>
                    <span className="at-row" style={{ gap: 6, fontSize: 11.5 }}>
                      <RoleMark mark={a.mark} size="sm" /><span className="at-muted">{a.name}</span>
                      {p.deps.length > 0 && <span className="at-subtle">after {p.deps.join(', ')}</span>}
                      {p.perm && <Badge tone="warning" icon={IShield}>{p.perm}</Badge>}
                    </span>
                  </div>
                  <span className="at-mono at-subtle">{p.est}</span>
                </div>
              );
            })}
          </div>
          <div className="at-label" style={{ padding: '16px 16px 8px' }}>Team</div>
          <div style={{ padding: '0 16px' }}>
            {['orch', 'be', 'fe', 'sec', 'qa', 'ops'].map((id) => { const a = agentById(id); return <div key={id} className="at-team-row"><RoleMark mark={a.mark} size="sm" /><span>{a.name}</span><span className="at-subtle" style={{ marginLeft: 'auto', fontSize: 12 }}>{a.model}</span></div>; })}
          </div>
          <div className="at-callout" style={{ margin: 16 }}><Icon as={ICpu} /><div>Estimated <b>~31 min</b> and <b>$6–9</b> at current prices. Estimates, not limits — the budget above is the limit.</div></div>
          </>)}
        </div>
        <div className="at-create-foot">
          <Button variant="ghost" onClick={() => A.go('home')}>Discard</Button>
          <span style={{ flex: 1 }} />
          <Button variant="primary" icon={IPlay} kbd="⌘ ↵" disabled={busy} data-testid="design-launch" onClick={() => void launch()}>{busy ? 'Launching…' : 'Launch mission'}</Button>
        </div>
      </div>
    </div>
  );
}
const deployTargets = () => (window as unknown as { __atlasTargets?: string[] }).__atlasTargets ?? [];

export { IArrowRight, IMore, Tip, SampleTag, EmptyState, IconButton, agents, deployments, IDeploy };
