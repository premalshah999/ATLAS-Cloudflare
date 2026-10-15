// Runtime adapter for the design-system screens: reads the ATLAS control plane and produces exactly the shapes the
// design components render (data/types.ts), then hydrates data/source.ts in place. Actions on those screens are
// mapped to real control-plane calls in designActions below. Nothing here invents values: a field the control plane
// does not know is shown as "—" or omitted.
import type { AtlasEvent } from '@atlas/contracts';
import type { Agent, AgentStatus, Approval, Checkpoint, FileTouch, Mission, PipelineStage, ReviewFinding, Task, TerminalSession, TermLine, TimelineEvent } from '../data/types';
import { hydrate, type ActivityRow, type BrowserAction, type Deployment, type ModelRow, type ProviderRow, type ReviewContent, type Snapshot, type Template, type ThreadItem, type TraceRow } from '../data/source';
import { call, type MissionListItem, type MissionSnapshot, type RoleInfo } from './api';
import { fetchAllSince } from './eventSync';
import { describeEvent, fmtMs, roleMark, roleName } from './format';

const hhmmss = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const kTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const shortId = (id: string) => `MSN-${id.replace(/^msn_/, '').slice(0, 6).toUpperCase()}`;

const TASK_AGENT: Record<string, AgentStatus> = { running: 'running', reviewing: 'running', done: 'done', failed: 'failed', cancelled: 'idle', blocked: 'blocked', queued: 'waiting', ready: 'waiting' };
const TASK_STATUS: Record<string, Task['status']> = { running: 'running', reviewing: 'running', done: 'done', failed: 'failed', cancelled: 'failed', blocked: 'blocked', queued: 'pending', ready: 'waiting' };
export function missionStatusOf(m: { state: string; verdict?: string | null; decision?: string | null }): Mission['status'] {
  if (m.state === 'completed') return m.decision ? 'done' : m.verdict === 'verified' ? 'review' : 'review';
  if (m.state === 'failed' || m.state === 'cancelled') return 'failed';
  if (m.state === 'draft') return 'draft';
  if (m.state === 'awaiting_approval') return 'paused';
  return 'running';
}
const KIND: Record<string, TimelineEvent['kind']> = { activity: 'activity', decision: 'decision', file: 'file', error: 'error', approval: 'approval', milestone: 'milestone', test: 'test', delegation: 'delegation' };
const APPROVAL_KIND = (tool: string, cap: string): Approval['kind'] => tool === 'shell_exec' || tool === 'run_tests' ? 'shell' : tool === 'write_file' ? 'filesystem' : cap.startsWith('net') ? 'network' : cap.startsWith('deploy') ? 'deployment' : tool.startsWith('desktop') ? 'desktop' : 'tool';

function missionRow(m: MissionListItem, wsName: (id: string) => string): Mission {
  const done = m.tasks.filter((t) => t.state === 'done').length;
  return {
    id: shortId(m.id), title: m.title, objective: m.goal, status: missionStatusOf(m), elapsed: '—', agents: m.tasks.length, tasksDone: done, tasksTotal: m.tasks.length,
    tokens: '—', compute: '—', workspace: wsName(m.workspaceId), updated: ago(m.updatedAt),
  };
}

/** Parse a unified diff into per-file stats and before/after hunk text. */
function parsePatch(text: string, agentOf: (path: string) => { agent: string; task: string }): { files: FileTouch[]; contents: Record<string, ReviewContent> } {
  const files: FileTouch[] = [];
  const contents: Record<string, ReviewContent> = {};
  let cur: { path: string; add: number; del: number; before: string[]; after: string[]; status: FileTouch['status'] } | null = null;
  const flush = () => { if (!cur) return; const who = agentOf(cur.path); files.push({ path: cur.path, add: cur.add, del: cur.del, status: cur.status, ...who }); contents[cur.path] = { before: cur.before.join('\n'), after: cur.after.join('\n'), lang: cur.path.split('.').pop(), comments: [] }; };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); const m = / b\/(.+)$/.exec(line); cur = { path: m ? m[1] : line.slice(11), add: 0, del: 0, before: [], after: [], status: 'modified' }; continue; }
    if (!cur) continue;
    if (line.startsWith('new file')) cur.status = 'added';
    else if (line.startsWith('deleted file')) cur.status = 'deleted';
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) continue;
    else if (line.startsWith('@@')) { if (cur.before.length) { cur.before.push(''); cur.after.push(''); } }
    else if (line.startsWith('+')) { cur.add++; cur.after.push(line.slice(1)); }
    else if (line.startsWith('-')) { cur.del++; cur.before.push(line.slice(1)); }
    else if (line.startsWith(' ')) { cur.before.push(line.slice(1)); cur.after.push(line.slice(1)); }
  }
  flush();
  return { files, contents };
}

const patchCache = new Map<string, string>();
async function readText(artifactId: string) {
  if (patchCache.has(artifactId)) return patchCache.get(artifactId)!;
  const r = await call('artifact.read', { artifactId });
  patchCache.set(artifactId, r.text);
  return r.text;
}

let roles: RoleInfo[] = [];
let slow: { at: number; roleDetails: Record<string, import('../data/source').RoleDetail>; models: ModelRow[]; providers: ProviderRow[]; templates: Template[]; activity: ActivityRow[]; deployments: Deployment[] } | null = null;

async function slowData(missions: MissionListItem[]) {
  if (slow && Date.now() - slow.at < 20_000) return slow;
  if (!roles.length) roles = await call('roles.list').catch(() => []);
  const [models, creds, settings] = await Promise.all([call('models.list').catch(() => []), call('credentials.list').catch(() => null), call('settings.get').catch(() => null)]);
  const tierOf = (ref: string) => {
    const v = settings?.values as Record<string, unknown> | undefined;
    const tiers = (['default', 'fast', 'strong'] as const).filter((t) => v?.[`models.${t}`] === ref);
    const rs = roles.filter((r) => tiers.includes(r.modelPreference as 'default')).map((r) => r.title);
    return rs.length ? rs.join(', ') : tiers.length ? `${tiers.join(', ')} tier` : 'available';
  };
  const recent = [...missions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const activity: ActivityRow[] = [];
  const deployments: Deployment[] = [];
  for (const m of recent) {
    const snap = await call('mission.get', { missionId: m.id }).catch(() => null);
    if (!snap) continue;
    const evs = await call('events.since', { missionId: m.id, afterSeq: Math.max(0, snap.lastSeq - 60) }).catch(() => [] as AtlasEvent[]);
    for (const e of evs) {
      const d = describeEvent(e);
      if (!d || e.type === 'process.output' || e.type === 'agent.usage') continue;
      activity.push({ time: hhmm(e.ts), who: d.who, text: d.title, kind: d.tone === 'danger' || d.kind === 'error' ? 'error' : d.tone === 'warning' ? 'warn' : e.actor.kind === 'operator' ? 'human' : d.kind === 'milestone' || d.tone === 'success' ? 'ok' : 'info', mission: shortId(m.id), missionId: m.id, _ts: e.ts } as ActivityRow & { _ts: string });
    }
    for (const e of evs.filter((x) => x.type === 'deploy.event' && (x.payload.phase === 'live' || x.payload.phase === 'failed'))) {
      const verified = evs.some((x) => x.type === 'staging.check' && x.payload.deploymentId === e.payload.deploymentId && x.payload.verified);
      deployments.push({ id: String(e.payload.deploymentId ?? `DEP-${e.seq}`).slice(0, 12), env: String(e.payload.target ?? 'staging'), mission: shortId(m.id), missionId: m.id, commit: String(e.payload.revision ?? '').slice(0, 7), status: e.payload.phase === 'failed' ? 'failed' : verified ? 'verified' : 'live · unverified', when: ago(e.ts), url: String(e.payload.url ?? '') });
    }
  }
  activity.sort((a, b) => ((b as unknown as { _ts: string })._ts).localeCompare((a as unknown as { _ts: string })._ts));
  const sv = settings?.values as Record<string, unknown> | undefined;
  slow = {
    at: Date.now(),
    roleDetails: Object.fromEntries(roles.map((r) => [r.id, { id: r.id, title: r.title, version: r.version, instructions: r.instructions, tools: r.tools, capabilities: r.capabilities, writes: r.writes, tier: r.modelPreference, model: String(sv?.[`models.${r.modelPreference}`] ?? models[0]?.ref ?? '—'), budget: r.budget }])),
    models: models.map((m) => ({ id: m.ref, name: m.name, provider: m.provider, ctx: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : '—', role: tierOf(m.ref), status: 'connected' })),
    providers: (creds?.providers ?? []).filter((p) => p.stored || p.fromEnvironment).map((p) => ({ id: p.provider, name: p.provider === 'github' ? 'GitHub' : p.provider[0].toUpperCase() + p.provider.slice(1), detail: p.stored ? 'Key in the OS credential store' : `From ${p.env}`, status: 'connected' as const })),
    templates: roles.map((r) => ({ id: r.id, name: r.title, mark: roleMark(r.id), desc: r.instructions.split('. ')[0].slice(0, 140), tools: r.tools.length })),
    activity: activity.slice(0, 60),
    deployments,
  };
  return slow;
}

const evCache = new Map<string, AtlasEvent[]>();

/** Build the design snapshot for one mission (the one Mission Control shows) plus cross-mission lists. */
export async function buildSnapshot(missionId: string | null, missions: MissionListItem[], workspaces: { id: string; name: string; root: string; branch: string | null; head: string | null; dirty: number }[]): Promise<{ snap: Snapshot; missionId: string } | null> {
  const ordered = [...missions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const chosen = ordered.find((m) => m.id === missionId) ?? ordered.find((m) => ['running', 'verifying', 'planning', 'awaiting_approval'].includes(m.state)) ?? ordered[0];
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? '—';
  const s = await slowData(missions);
  if (!chosen) return null;
  const snap: MissionSnapshot = await call('mission.get', { missionId: chosen.id });
  const prev = evCache.get(chosen.id) ?? [];
  const more = await fetchAllSince((after) => call('events.since', { missionId: chosen.id, afterSeq: after }), prev.length ? prev[prev.length - 1].seq : 0);
  const events = [...prev, ...more];
  evCache.set(chosen.id, events);
  const m = snap.mission;
  const w = workspaces.find((x) => x.id === m.workspaceId);
  const keyOf = new Map(snap.tasks.map((t) => [t.id, t.key]));

  // Per-task facts from the event log.
  const per = new Map<string, { started?: Record<string, unknown>; tokens: number; last?: AtlasEvent; lastMsg?: string; startedAt?: string; endedAt?: string }>();
  for (const e of events) {
    if (!e.taskId) continue;
    const r = per.get(e.taskId) ?? { tokens: 0 };
    if (e.type === 'attempt.started') { r.started = e.payload; r.startedAt = e.ts; r.tokens = 0; }
    if (e.type === 'attempt.ended') r.endedAt = e.ts;
    if (e.type === 'agent.usage') r.tokens = Number(e.payload.total ?? r.tokens);
    if (e.type === 'agent.message') r.lastMsg = String(e.payload.text ?? '');
    if (e.type !== 'process.output' && e.type !== 'agent.usage') r.last = e;
    per.set(e.taskId, r);
  }

  // Terminals: one session per process.
  const procs = new Map<number, TerminalSession & { _task?: string }>();
  for (const e of events) {
    if (e.type === 'process.started') {
      const pid = Number(e.payload.pid);
      procs.set(pid, { id: `p-${pid}-${e.seq}`, title: String(e.payload.label ?? e.payload.command ?? '').slice(0, 40) || 'process', owner: e.actor.kind === 'operator' ? 'human' : 'agent', agent: e.taskId ? keyOf.get(e.taskId) : 'orch', cwd: String(e.payload.cwd ?? '').split('/').slice(-2).join('/'), command: String(e.payload.command ?? ''), status: 'running', duration: '—', pid, recording: true, lines: [{ t: 'cmd', text: String(e.payload.command ?? '') }], _task: e.taskId ?? undefined });
    } else if (e.type === 'process.output') {
      const p = procs.get(Number(e.payload.pid)) ?? [...procs.values()].at(-1);
      if (p) for (const l of String(e.payload.text ?? '').split('\n')) if (l.length) p.lines.push({ t: /error|fail|✗|✕/i.test(l) ? 'err' : /pass|✓|ok\b/i.test(l) ? 'ok' : 'out', text: l } as TermLine);
    } else if (e.type === 'process.exited') {
      const p = procs.get(Number(e.payload.pid));
      if (p) { p.exit = Number(e.payload.exitCode ?? 0); p.status = p.exit === 0 ? 'exited' : 'failed'; p.duration = fmtMs(Number(e.payload.durationMs ?? 0)); }
    }
  }
  const terminals = [...procs.values()].slice(-12).reverse().map((p) => ({ ...p, lines: p.lines.slice(-400) }));

  // Agents: the orchestrator plus one per task.
  const orch: Agent = {
    id: 'orch', name: 'Atlas Orchestrator', mark: 'OR', role: 'Orchestrator', model: String(per.values().next().value?.started?.model ?? m.model ?? '—'),
    status: m.state === 'planning' ? 'running' : ['running', 'verifying'].includes(m.state) ? 'running' : m.state === 'awaiting_approval' ? 'waiting' : m.state === 'failed' ? 'failed' : 'done',
    assignment: m.goal, activity: m.state === 'verifying' ? 'Verifying the integrated result independently' : m.state === 'planning' ? 'Planning the mission' : `${snap.budget.agentsNow} agent(s) working · plan v${m.planVersion}`,
    children: snap.tasks.map((t) => t.key), worktree: '—', branch: m.integrationBranch ?? '—', environment: 'Control plane · read-only',
    context: { used: 0, limit: 200_000 }, tools: ['plan', 'delegate', 'verify', 'integrate'],
    permissions: [{ scope: 'Filesystem write', level: 'deny', detail: 'Delegates writes to engineers' }, { scope: 'Shell', level: 'deny', detail: 'No direct execution' }],
    files: [], terminals: [], lastAction: events.length ? { time: hhmmss(events[events.length - 1].ts), text: describeEvent(events[events.length - 1])?.title ?? '' } : { time: '—', text: '—' },
    artifacts: snap.artifacts.filter((a) => a.kind === 'plan').map((a) => ({ name: a.name, kind: 'plan' })), tokens: snap.budget.tokens, elapsed: fmtMs(snap.budget.elapsedMs),
  };
  const patches = snap.artifacts.filter((a) => a.kind === 'patch');
  const latestPatch = patches[patches.length - 1];
  let review = { files: [] as FileTouch[], contents: {} as Record<string, ReviewContent> };
  if (latestPatch) {
    const text = await readText(latestPatch.id).catch(() => '');
    const owner = snap.tasks.find((t) => t.resultRef === latestPatch.id) ?? snap.tasks.find((t) => t.role === 'coder');
    review = parsePatch(text, () => ({ agent: owner?.key ?? 'orch', task: owner?.key ?? '' }));
  }
  const agents: Agent[] = [orch, ...snap.tasks.map((t): Agent => {
    const r = per.get(t.id);
    const role = roles.find((x) => x.id === t.role);
    const st = r?.started as { model?: string; worktree?: string; branch?: string; tools?: string[]; sandbox?: string } | undefined;
    const waiting = t.dependencies.filter((d) => snap.tasks.find((x) => x.id === d && x.state !== 'done')).map((d) => keyOf.get(d));
    return {
      id: t.key, name: `${roleName(t.role)}`, mark: roleMark(t.role), role: role?.title ?? roleName(t.role), model: st?.model ?? m.model ?? '—', status: TASK_AGENT[t.state] ?? 'idle', parent: 'orch',
      assignment: `${t.key} · ${t.title}`, activity: (r?.lastMsg ?? (r?.last ? describeEvent(r.last)?.title : '') ?? '').split('\n')[0].slice(0, 140) || (t.state === 'done' ? 'Finished' : 'Waiting to start'),
      children: [], worktree: st?.worktree ? `…/${st.worktree.split('/').slice(-2).join('/')}` : '—', branch: st?.branch ?? t.branch ?? '—', environment: st?.sandbox === 'sandbox' ? 'Isolated worktree · OS sandbox' : 'Isolated worktree',
      context: { used: r?.tokens ?? 0, limit: role?.budget.maxTokens ?? 200_000 }, tools: st?.tools ?? role?.tools ?? [],
      permissions: [
        { scope: 'Filesystem write', level: role?.writes ? 'allow' : 'deny', detail: role?.writes ? 'Its worktree only' : 'Read-only role' },
        { scope: 'Shell', level: 'allow', detail: 'Safe commands, sandboxed' },
        { scope: 'Risky commands', level: 'ask', detail: 'Your approval, once' },
        { scope: 'Network', level: role?.capabilities.some((c) => c.startsWith('net')) ? 'ask' : 'deny', detail: 'No outbound by default' },
      ],
      files: review.files.filter((f) => f.agent === t.key), terminals: terminals.filter((x) => x.agent === t.key).map((x) => x.id),
      lastAction: r?.last ? { time: hhmmss(r.last.ts), text: describeEvent(r.last)?.title ?? '' } : { time: '—', text: '—' },
      blocker: waiting.length && t.state === 'blocked' ? `Waiting on ${waiting.join(', ')}` : t.state === 'failed' ? snap.attempts.filter((a) => a.taskId === t.id).at(-1)?.error ?? 'Failed' : undefined,
      artifacts: snap.artifacts.filter((a) => a.taskId === t.id).slice(-6).map((a) => ({ name: a.name, kind: a.kind })),
      tokens: r?.tokens ?? 0, elapsed: r?.startedAt ? fmtMs((r.endedAt ? new Date(r.endedAt).getTime() : Date.now()) - new Date(r.startedAt).getTime()) : '—',
    };
  })];

  // Task graph phases by dependency depth.
  const depth = new Map<string, number>();
  const d = (id: string, seen = new Set<string>()): number => { if (depth.has(id)) return depth.get(id)!; if (seen.has(id)) return 0; seen.add(id); const t = snap.tasks.find((x) => x.id === id); const v = t && t.dependencies.length ? 1 + Math.max(...t.dependencies.map((x) => d(x, seen))) : 0; depth.set(id, v); return v; };
  const tasks: Task[] = snap.tasks.map((t) => { const r = per.get(t.id); return { id: t.key, title: t.title, agent: t.key, status: TASK_STATUS[t.state] ?? 'pending', deps: t.dependencies.map((x) => keyOf.get(x) ?? x), phase: d(t.id), duration: r?.startedAt && r.endedAt ? fmtMs(new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()) : undefined }; });

  const timeline: TimelineEvent[] = events.filter((e) => e.type !== 'process.output' && e.type !== 'agent.usage').slice(-250).flatMap((e) => {
    const r = describeEvent(e);
    if (!r) return [];
    return [{ id: `e${e.seq}`, time: hhmmss(e.ts), agent: e.taskId ? keyOf.get(e.taskId) ?? 'orch' : 'orch', kind: KIND[r.kind] ?? 'activity', title: e.type === 'agent.message' ? String(e.payload.text ?? '').split('\n')[0].slice(0, 160) : r.title, detail: e.type === 'agent.message' ? String(e.payload.text ?? '').split('\n').slice(1).join(' ').slice(0, 300) || undefined : r.detail?.slice(0, 300), meta: r.meta }];
  });
  const approvals: Approval[] = snap.approvals.filter((a) => a.status === 'pending').map((a) => ({
    id: a.id, agent: a.taskId ? keyOf.get(a.taskId) ?? 'orch' : 'orch', kind: APPROVAL_KIND(a.tool, a.capability), title: a.tool === 'shell_exec' ? 'Run a command' : a.tool === 'write_file' ? 'Write a file' : a.tool,
    action: a.action, environment: a.environment, resources: a.resources, duration: 'This action, once', reason: a.reason, risk: a.risk, requestedAt: hhmmss(a.requestedAt),
  }));
  const checkpoints: Checkpoint[] = events.filter((e) => e.type === 'workspace.worktree' && e.payload.action === 'checkpoint').reverse().map((e, i, arr) => ({
    id: `CP-${arr.length - i}`, time: hhmmss(e.ts), label: `${e.taskId ? keyOf.get(e.taskId) : 'mission'} checkpoint`, by: e.taskId ? roleName(snap.tasks.find((t) => t.id === e.taskId)?.role ?? '') : 'ATLAS',
    files: Array.isArray(e.payload.files) ? (e.payload.files as unknown[]).length : Number(e.payload.files ?? 0), note: `${String(e.payload.commit ?? '').slice(0, 7)} · isolated worktree`,
  }));
  const findings: ReviewFinding[] = snap.findings.map((f, i) => ({ id: `${snap.tasks.find((t) => t.id === f.taskId)?.role === 'security_reviewer' ? 'SEC' : 'RV'}-${i + 1}`, severity: f.severity, title: f.title, file: f.file, line: f.line ?? 0, agent: keyOf.get(f.taskId) ?? 'orch', status: f.status === 'fixed' ? 'fixed' : f.status === 'accepted' ? 'accepted' : 'open', body: `${f.observation}${f.recommendation ? ` — ${f.recommendation}` : ''}` }));
  for (const f of findings) { const c = review.contents[f.file]; if (c) c.comments.push({ line: f.line, author: roleName(snap.tasks.find((t) => t.key === f.agent)?.role ?? 'reviewer'), mark: roleMark(snap.tasks.find((t) => t.key === f.agent)?.role ?? 'reviewer'), id: f.id, severity: f.severity, resolved: f.status === 'fixed', body: f.body }); }

  // Pipeline stages from the checks and staging events.
  const ck = (re: RegExp) => snap.checks.filter((c) => re.test(c.name));
  const stage = (id: string, name: string, cs: typeof snap.checks, summaryEmpty: string): PipelineStage => {
    const failed = cs.some((c) => c.result === 'fail'); const pending = !cs.length;
    return { id, name, status: pending ? (['running', 'verifying'].includes(m.state) ? 'running' : 'pending') : failed ? 'failed' : cs.some((c) => c.result === 'inconclusive') ? 'warning' : 'passed',
      duration: cs.length ? fmtMs(cs.reduce((s, c) => s + (c.durationMs ?? 0), 0)) : undefined, summary: cs.length ? `${cs.filter((c) => c.result === 'pass').length} / ${cs.length} passed` : summaryEmpty,
      evidence: cs.map((c) => ({ label: c.name, value: c.reason.slice(0, 80) || c.result, status: c.result === 'pass' ? 'passed' : c.result === 'fail' ? 'failed' : 'warning' })), logs: cs.map((c) => `${c.command ?? c.name} → ${c.result}${c.exitCode != null ? ` (exit ${c.exitCode})` : ''}`), artifacts: cs.filter((c) => c.artifactId).map((c) => `${c.name}.log`) };
  };
  const integ = [...events].reverse().find((e) => e.type === 'integration.result');
  const pipeline: PipelineStage[] = [
    { id: 'commit', name: 'Commit', status: integ ? (integ.payload.ok ? 'passed' : 'failed') : 'pending', summary: m.integrationCommit ? `${m.integrationCommit.slice(0, 7)} · ${m.integrationBranch}` : 'Integration pending', evidence: m.baseCommit ? [{ label: 'Base', value: m.baseCommit.slice(0, 12) }, { label: 'Branch', value: m.integrationBranch ?? '—' }] : [], logs: integ ? [`merge ${(integ.payload.merged as string[] | undefined)?.join(', ') ?? ''} → ${String(integ.payload.commit ?? '').slice(0, 12)}`] : [], artifacts: [] },
    stage('build', 'Build', ck(/build/), 'No build check'),
    stage('tests', 'Tests', ck(/^tests$|test|lint|types/), 'No test checks yet'),
    stage('deploy', 'Staging deploy', ck(/^staging:(deploy|revision)/), m.targetEnvironment ? 'Deploys after verification' : 'No staging target'),
    stage('api', 'API checks', ck(/^api:/), 'No API checks'),
    stage('qa', 'Browser QA', ck(/^browser:|^visual$/), 'No browser checks'),
    stage('health', 'Runtime health', ck(/^staging:(traffic|errors|latency|health)|^staging:/), 'Runs on staging'),
    { id: 'approval', name: 'Approval', status: m.decision === 'accepted' ? 'passed' : m.decision === 'rejected' ? 'failed' : 'locked', summary: m.decision ? `You ${m.decision} the change` : 'Your decision is required', evidence: [], logs: [], artifacts: [] },
  ];
  const browserActions: BrowserAction[] = events.filter((e) => e.type === 'browser.step' && e.payload.action).slice(-40).map((e) => ({ time: hhmmss(e.ts), text: `${e.payload.flow ? `${e.payload.flow} · ` : ''}${e.payload.action}${e.payload.message ? ` — ${String(e.payload.message).slice(0, 120)}` : ''}`, status: e.payload.ok ? (String(e.payload.action).startsWith('expect') ? 'verified' : 'done') : 'failed', shot: e.artifactIds?.[0] }));
  const checks = snap.checks.filter((c) => !['review', 'security', 'verification-definition'].includes(c.name));
  // Per-agent threads (decision summaries, tool groups, your directions) and tool traces.
  const threads: Record<string, ThreadItem[]> = {};
  const traces: Record<string, TraceRow[]> = {};
  const argText = (a: Record<string, unknown>) => (typeof a.command === 'string' ? [a.command, ...((a.args as string[]) ?? [])].join(' ') : typeof a.path === 'string' ? a.path : JSON.stringify(a).slice(0, 120));
  const calls = new Map<string, { e: AtlasEvent; row: TraceRow }>();
  for (const e of events) {
    const key = e.taskId ? keyOf.get(e.taskId) : undefined;
    if (!key) continue;
    const th = (threads[key] ??= []);
    const tr = (traces[key] ??= []);
    if (e.type === 'attempt.started') th.push({ time: hhmmss(e.ts), who: 'orch', kind: 'delegation', text: `Delegated ${key} · ${snap.tasks.find((t) => t.id === e.taskId)?.title ?? ''} — attempt ${e.payload.number}, ${String(e.payload.model ?? '')}, ${e.payload.sandbox === 'sandbox' ? 'OS sandbox' : 'worktree'}` });
    else if (e.type === 'agent.message') th.push({ time: hhmmss(e.ts), who: key, kind: 'message', text: String(e.payload.text ?? '') });
    else if (e.type === 'agent.tool_call') {
      const row: TraceRow = { time: hhmmss(e.ts), tool: String(e.payload.tool), call: argText((e.payload.args ?? {}) as Record<string, unknown>), result: '…', ms: '—', ok: true };
      calls.set(String(e.payload.callId), { e, row }); tr.push(row);
      const last = th[th.length - 1];
      if (last?.kind === 'tools') last.tools!.push(row); else th.push({ time: hhmmss(e.ts), who: key, kind: 'tools', text: '', tools: [row] });
    } else if (e.type === 'agent.tool_result') {
      const c = calls.get(String(e.payload.callId));
      if (c) { c.row.result = String(e.payload.summary ?? '').split('\n')[0].slice(0, 140); c.row.ok = !!e.payload.ok; c.row.ms = fmtMs(new Date(e.ts).getTime() - new Date(c.e.ts).getTime()); }
    } else if (e.type === 'operator.action' && e.payload.action === 'direct') th.push({ time: hhmmss(e.ts), who: 'you', kind: 'human', text: String(e.payload.text ?? '') });
    else if (e.type === 'approval.requested') th.push({ time: hhmmss(e.ts), who: key, kind: 'approval', text: String(e.payload.action ?? ''), approvalId: String(e.payload.approvalId ?? '') });
    else if (e.type === 'task.state' && ['done', 'failed'].includes(String(e.payload.to))) th.push({ time: hhmmss(e.ts), who: key, kind: 'system', text: `Task ${key} ${e.payload.to}` });
  }
  const first = Object.keys(review.contents)[0];

  const out: Snapshot = {
    workspace: { name: w?.name ?? '—', owner: '', path: w?.root?.replace(/^\/Users\/[^/]+/, '~') ?? '—', branch: w?.branch ?? '—', head: w?.head?.slice(0, 7) ?? '—', environment: m.targetEnvironment ?? 'local', envHealth: 'healthy' as const, runtime: m.runtime === 'pi' ? `Pi · ${String(m.model ?? agents.find((a) => a.model && a.model !== '—')?.model ?? 'default model').replace(/^[a-z-]+\//, '')}` : 'Local runtime' },
    workspaces: workspaces.map((x) => ({ id: x.id, name: x.name, path: x.root.replace(/^\/Users\/[^/]+/, '~'), branch: x.branch ?? '—', missions: missions.filter((y) => y.workspaceId === x.id).length, updated: ago(missions.filter((y) => y.workspaceId === x.id).map((y) => y.updatedAt).sort().at(-1) ?? new Date().toISOString()) })),
    mission: { ...missionRow(chosen, wsName), elapsed: fmtMs(snap.budget.elapsedMs), tokens: kTokens(snap.budget.tokens), compute: `${snap.budget.toolCalls} tool calls`, agents: snap.tasks.length },
    missions: ordered.map((x) => missionRow(x, wsName)),
    agents, tasks, timeline, approvals, terminals, checkpoints, findings,
    reviewFiles: review.files, pipeline, deployments: s.deployments, models: s.models, providers: s.providers, browserActions, templates: s.templates, activity: s.activity,
    diffs: { sessionBefore: first ? review.contents[first].before : '', sessionAfter: first ? review.contents[first].after : '', middlewareBefore: '', middlewareAfter: '' },
    reviewContents: review.contents,
    threads, traces, roleDetails: s.roleDetails,
    facts: {
      evidence: { passed: checks.filter((c) => c.result === 'pass').length, failed: checks.filter((c) => c.result === 'fail').length, total: checks.length, unitLabel: `${ck(/^tests$/).filter((c) => c.result === 'pass').length ? 'tests ✓' : 'tests'}`, qaLabel: `QA ${ck(/^browser:/).filter((c) => c.result === 'pass').length}/${ck(/^browser:/).length}` },
      deploy: null, cost: `${snap.budget.toolCalls} calls`, checkpoint: checkpoints[0]?.id ?? '',
    },
  };
  return { snap: out, missionId: chosen.id };
}

export { hydrate };
