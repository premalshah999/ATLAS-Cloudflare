// Mission orchestration (manual §12–19, §28–29, §32, §38–41). Deterministic code owns planning validation,
// scheduling, authorization, integration and completion; agents only propose actions through the ToolGate.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  AtlasError, DEFAULT_BUDGET, MissionBudget, newId, nowIso, RETRYABLE, type AgentRuntime, type Approval, type ApprovalMode, type Attempt, type AtlasEvent,
  type CheckRecord, type Mission, type MissionState, type NewEvent, type Plan, type ReleaseStage, type RuntimeKind, type StageContext, type Task, type TaskState,
  type ToolResult, type Workspace,
} from '@atlas/contracts';
import type { ArtifactStore, Repo } from '@atlas/storage';
import { checkpoint, diffSince, git, gitOk, inspectRepo, Leases, removeWorktree } from '@atlas/workspace';
import { detectSandbox, openPty, ptySupported, run, sanitizedEnv, startProcess, type PtyHandle, type SandboxSpec } from '@atlas/terminal';
import { assertMission, assertTask, TERMINAL_TASK } from './states';
import { defaultPlan, validatePlan } from './plan';
import { ROLES, role } from './roles';
import { ToolGate, realExecutors, type Executors, type Isolation } from './toolgate';
import { detectRecipes, gate, type Verdict } from './verification';
import { buildContext, repoMap } from './context';
import { mergeInto, topoOrder, worktreeFromBases } from './integration';
import { blockingFindings, makeFinding, type FindingArgs } from './findings';
import { deleteMission, exportMission, importMission } from './archive';
import { mkdirSync, writeFileSync } from 'node:fs';

export interface OrchestratorOptions {
  repo: Repo;
  artifacts: ArtifactStore;
  runtimes: Partial<Record<RuntimeKind, AgentRuntime>>;
  /** Where task worktrees live. Never inside the user's checkout. */
  worktreeDir: string;
  /** Operator-maintained project facts, one file per workspace (manual §17). */
  factsDir?: string;
  maxAttempts?: number;
  approvalTtlMs?: number;
  executors?: Executors;
  /** Release stages after build/test checks and review: browser QA, staging deploy, staging verification. */
  stages?: ReleaseStage[];
  /** Factories for service-backed tools (browser_action, desktop_action, inspect_logs), one instance per attempt. */
  toolFactories?: Record<string, (ctx: ToolFactoryContext) => ExtraTool>;
}

export interface ExtraTool { invoke(args: unknown, signal: AbortSignal): Promise<ToolResult>; dispose(): Promise<void> }
export interface ToolFactoryContext {
  missionId: string;
  taskId: string;
  attemptId: string;
  worktree: string;
  sandbox: StageContext['sandbox'];
  putArtifact: StageContext['putArtifact'];
  emit(type: NewEvent['type'], payload: Record<string, unknown>, artifactIds?: string[]): void;
  requestApproval: StageContext['requestApproval'];
  setting: StageContext['setting'];
}

const SYSTEM = (component: string) => ({ kind: 'system' as const, component });
const OPERATOR = { kind: 'operator' as const };
type Outcome = { kind: 'completed'; summary: string } | { kind: 'error'; errorKind: string; message: string };

export class Orchestrator {
  private readonly repo: Repo;
  private readonly artifacts: ArtifactStore;
  private readonly leases = new Leases();
  private readonly aborts = new Map<string, AbortController>();
  private readonly taskAborts = new Map<string, AbortController>();
  private readonly waiters = new Map<string, (a: Approval) => void>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly activeAgents = new Map<string, number>();
  private readonly budgetTimers = new Map<string, NodeJS.Timeout>();
  private readonly maxAttempts: number;
  private readonly approvalTtlMs: number;
  private stopping = false;

  constructor(private readonly o: OrchestratorOptions) {
    this.repo = o.repo;
    this.artifacts = o.artifacts;
    this.maxAttempts = o.maxAttempts ?? 2;
    this.approvalTtlMs = o.approvalTtlMs ?? 15 * 60_000;
  }

  /** Swap a runtime (e.g. after credentials change). Running attempts keep the instance they started with. */
  setRuntime(kind: RuntimeKind, rt: AgentRuntime) { this.o.runtimes[kind] = rt; }
  addStage(stage: ReleaseStage) { (this.o.stages ??= []).push(stage); }

  private emit(e: Omit<NewEvent, 'artifactIds' | 'taskId' | 'attemptId'> & Partial<Pick<NewEvent, 'artifactIds' | 'taskId' | 'attemptId'>>): AtlasEvent {
    return this.repo.append({ taskId: null, attemptId: null, artifactIds: [], ...e });
  }

  /* ---------------- isolation ---------------- */

  /** Sandbox for a worktree: its git admin dir is writable, the shared object store read-only. Fails closed. */
  async isolationFor(worktree: string): Promise<Isolation> {
    const sb = detectSandbox();
    if (sb.kind === 'none') {
      return this.repo.setting('execution.allowUnsandboxed', false) ? { mode: 'unsandboxed' } : { mode: 'unavailable', detail: sb.detail };
    }
    const r = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
    const [gitDir, common] = r.code === 0 ? r.out.split('\n') : [];
    return { mode: 'sandbox', readOnly: common ? [common] : [], readWrite: gitDir ? [gitDir] : [] };
  }

  private sandboxSpec(iso: Isolation, worktree: string, network = false): SandboxSpec | undefined | null {
    if (iso.mode === 'unavailable') return null;
    if (iso.mode === 'unsandboxed') return undefined;
    return { root: worktree, writable: true, network, readOnly: iso.readOnly, readWrite: iso.readWrite, limits: { cpuSeconds: 1800, fileSizeBytes: 1024 ** 3, openFiles: 4096 } };
  }

  /* ---------------- workspaces ---------------- */

  async registerWorkspace(dir: string): Promise<Workspace> {
    const info = await inspectRepo(dir);
    const existing = this.repo.workspaceByRoot(info.root);
    const now = nowIso();
    return this.repo.upsertWorkspace({ id: existing?.id ?? newId('ws'), name: info.name, root: info.root, isGit: info.isGit, branch: info.branch, head: info.head, dirty: info.dirty, createdAt: existing?.createdAt ?? now, updatedAt: now });
  }

  async refreshWorkspace(id: string): Promise<Workspace> {
    const w = this.repo.workspace(id);
    if (!w) throw new AtlasError('invalid_request', 'Unknown workspace');
    return this.registerWorkspace(w.root);
  }

  /** Operator-maintained project facts (manual §17): stored as a file per workspace, versioned by content hash. */
  facts(workspaceId: string): string | null {
    if (!this.o.factsDir) return null;
    const f = path.join(this.o.factsDir, `${workspaceId}.md`);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  }

  setFacts(workspaceId: string, text: string) {
    if (!this.o.factsDir) throw new AtlasError('invalid_request', 'Project facts are not enabled');
    if (!this.repo.workspace(workspaceId)) throw new AtlasError('invalid_request', 'Unknown workspace');
    mkdirSync(this.o.factsDir, { recursive: true });
    writeFileSync(path.join(this.o.factsDir, `${workspaceId}.md`), text, { mode: 0o600 });
  }

  /* ---------------- export, import, delete, retention (manual §38–39, §43) ---------------- */

  exportMission(missionId: string, file: string) { return exportMission(this.repo, this.artifacts, missionId, file); }
  importMission(file: string) { return importMission(this.repo, this.artifacts, file); }
  async deleteMission(missionId: string) { await deleteMission(this.repo, this.artifacts, missionId, this.o.worktreeDir); }

  /** Delete decided/archived/cancelled missions not updated for `days` days. Returns the ids removed. */
  async purgeOlderThan(days: number): Promise<string[]> {
    if (!days || days < 1) return [];
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const out: string[] = [];
    for (const m of this.repo.missionsOlderThan(cutoff)) { await this.deleteMission(m.id).then(() => out.push(m.id)).catch(() => {}); }
    return out;
  }

  /** Preflight warnings shown before a mission starts (manual §34). */
  async preflight(workspaceId: string, runtime?: RuntimeKind): Promise<{ level: 'block' | 'warn' | 'info'; message: string }[]> {
    const w = await this.refreshWorkspace(workspaceId);
    const out: { level: 'block' | 'warn' | 'info'; message: string }[] = [];
    if (!w.isGit) out.push({ level: 'block', message: 'Not a git repository. ATLAS needs git to create isolated worktrees.' });
    else if (!w.head) out.push({ level: 'block', message: 'The repository has no commits yet. Commit once so ATLAS has a base to branch from.' });
    if (w.dirty) out.push({ level: 'warn', message: `${w.dirty} uncommitted change${w.dirty === 1 ? '' : 's'} in your checkout will not be visible to agents: worktrees start from HEAD ${w.head?.slice(0, 7)}.` });
    if (w.isGit && !detectRecipes(w.root).some((r) => r.name === 'tests')) out.push({ level: 'warn', message: 'No test command detected. Results will be reported as unverified.' });
    const sb = detectSandbox();
    if (sb.kind === 'none') {
      if (this.repo.setting('execution.allowUnsandboxed', false)) out.push({ level: 'warn', message: `No OS sandbox (${sb.detail}). You allowed unsandboxed execution: repository scripts will run as your user.` });
      else out.push({ level: 'block', message: `No OS sandbox: ${sb.detail} Agent commands and checks will not run until one is available, or until you allow unsandboxed execution in Settings.` });
    }
    for (const st of this.o.stages ?? []) {
      const note = (st as ReleaseStage & { preflight?: (root: string) => { level: 'block' | 'warn' | 'info'; message: string } | null }).preflight?.(w.root);
      if (note) out.push(note);
    }
    if (runtime) {
      const rt = this.o.runtimes[runtime];
      if (!rt) out.push({ level: 'block', message: `Runtime "${runtime}" is not available in this build.` });
      else { const h = await rt.health(); if (!h.ok) out.push({ level: 'block', message: h.detail }); }
    }
    return out;
  }

  /* ---------------- mission lifecycle ---------------- */

  createMission(input: { workspaceId: string; title: string; goal: string; constraints: string; approvalMode: ApprovalMode; runtime: RuntimeKind; budget?: Partial<MissionBudget>; targetEnvironment?: string | null }): Mission {
    const w = this.repo.workspace(input.workspaceId);
    if (!w) throw new AtlasError('invalid_request', 'Unknown workspace');
    const now = nowIso();
    const budget = MissionBudget.parse({ ...DEFAULT_BUDGET, ...(input.budget ?? {}) });
    const m: Mission = {
      id: newId('msn'), workspaceId: input.workspaceId, title: input.title, goal: input.goal, constraints: input.constraints, approvalMode: input.approvalMode, runtime: input.runtime,
      baseCommit: null, state: 'draft', planVersion: 0, policyId: 'default@2', outcome: null, decision: null, budget, integrationBranch: null, integrationCommit: null, archived: false, targetEnvironment: input.targetEnvironment ?? null, createdAt: now, updatedAt: now,
    };
    this.repo.insertMission(m);
    this.emit({ missionId: m.id, type: 'mission.created', actor: OPERATOR, payload: { title: m.title, goal: m.goal, constraints: m.constraints, approvalMode: m.approvalMode, runtime: m.runtime, workspace: w.name, budget, targetEnvironment: m.targetEnvironment } });
    return m;
  }

  private setMission(m: Mission, to: MissionState, extra: Record<string, unknown> = {}) {
    assertMission(m.state, to);
    this.repo.updateMission(m.id, { state: to });
    this.emit({ missionId: m.id, type: 'mission.state', actor: SYSTEM('orchestrator'), payload: { from: m.state, to, ...extra } });
    m.state = to;
  }

  private setTask(t: Task, to: TaskState, extra: Record<string, unknown> = {}) {
    assertTask(t.state, to);
    this.repo.updateTask(t.id, { state: to });
    this.emit({ missionId: t.missionId, taskId: t.id, type: 'task.state', actor: SYSTEM('scheduler'), payload: { key: t.key, from: t.state, to, ...extra } });
    t.state = to;
  }

  private mission(id: string): Mission {
    const m = this.repo.mission(id);
    if (!m) throw new AtlasError('invalid_request', 'Unknown mission');
    if (m.archived) throw new AtlasError('invalid_request', 'This mission was imported from an export and is read-only');
    return m;
  }

  private async excerpts(root: string): Promise<{ path: string; text: string }[]> {
    const ls = await git(root, ['ls-tree', '--name-only', 'HEAD']);
    const names = ls.code === 0 ? ls.out.split('\n') : [];
    const pick = names.filter((n) => /^(readme(\.md)?|package\.json|pyproject\.toml|cargo\.toml|go\.mod|atlas\.config\.json)$/i.test(n)).slice(0, 5);
    const out: { path: string; text: string }[] = [];
    for (const p of pick) {
      const r = await git(root, ['show', `HEAD:${p}`]);
      if (r.code === 0) out.push({ path: p, text: r.out.slice(0, 6000) });
    }
    return out;
  }

  /**
   * Propose (or re-propose) a plan. A model plan is untrusted: it must pass the validator (one repair round);
   * otherwise the rejection is recorded and the deterministic plan is offered instead.
   */
  async plan(missionId: string, proposed?: unknown, options: { skipModel?: boolean } = {}): Promise<Mission> {
    const m = this.mission(missionId);
    const w = this.repo.workspace(m.workspaceId)!;
    if (m.state === 'draft' || m.state === 'awaiting_approval') this.setMission(m, 'planning');
    else if (m.state !== 'planning') throw new AtlasError('invalid_request', `Cannot plan a mission in state ${m.state}`);
    const version = m.planVersion + 1;
    const hasTests = w.isGit && detectRecipes(w.root).some((r) => r.name === 'tests');
    const verification = [{ name: 'tests', required: hasTests }];
    let candidate: unknown = proposed;
    let source: 'operator' | 'model' | 'default' = proposed ? 'operator' : 'default';
    const rt = this.o.runtimes[m.runtime];
    if (!candidate && !options.skipModel && rt?.plan && w.isGit && w.head) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5 * 60_000);
      try {
        const req = {
          missionId, title: m.title, objective: m.goal, constraints: m.constraints, approvalMode: m.approvalMode, repoMap: await repoMap(w.root), excerpts: await this.excerpts(w.root),
          roles: Object.values(ROLES).filter((r) => r.id !== 'orchestrator').map((r) => ({ id: r.id, title: r.title, tools: r.tools })),
          verification, maxTasks: m.budget.maxTasks, signal: ac.signal,
        };
        let p = await rt.plan(req);
        // A runtime may decline to plan (e.g. the scripted runtime outside its samples): use the deterministic plan.
        if (p.plan == null) throw Object.assign(new Error('declined'), { declined: true });
        let v = validatePlan({ ...(p.plan as object), version }, { maxTasks: m.budget.maxTasks });
        if (!v.ok) {
          this.emit({ missionId, type: 'plan.rejected', actor: SYSTEM('plan-validator'), payload: { version, source: 'model', issues: v.issues, repair: true } });
          p = await rt.plan({ ...req, previousIssues: v.issues.map((i) => i.message) });
          v = validatePlan({ ...(p.plan as object), version }, { maxTasks: m.budget.maxTasks });
        }
        this.emit({ missionId, type: 'plan.planner', actor: SYSTEM('planner'), payload: { runtime: m.runtime, rationale: p.rationale, inputTokens: p.inputTokens, outputTokens: p.outputTokens, valid: v.ok } });
        if (v.ok) { candidate = v.plan; source = 'model'; }
        else this.emit({ missionId, type: 'plan.rejected', actor: SYSTEM('plan-validator'), payload: { version, source: 'model', issues: v.issues, fallback: 'default' } });
      } catch (e) {
        if (!(e as { declined?: boolean }).declined) this.emit({ missionId, type: 'plan.rejected', actor: SYSTEM('planner'), payload: { version, source: 'model', issues: [{ code: 'planner_error', message: (e as Error).message }], fallback: 'default' } });
      } finally { clearTimeout(timer); }
    }
    candidate ??= defaultPlan(m, version, hasTests);
    const v = validatePlan(candidate, { maxTasks: m.budget.maxTasks });
    if (!v.ok) {
      this.emit({ missionId, type: 'plan.rejected', actor: SYSTEM('plan-validator'), payload: { version, source, issues: v.issues } });
      this.setMission(m, 'failed', { reason: 'Plan failed validation' });
      this.repo.updateMission(m.id, { outcome: `Plan rejected: ${v.issues.map((i) => i.message).join('; ')}` });
      return this.mission(missionId);
    }
    const plan: Plan = { ...v.plan, version, verification: v.plan.verification.length ? v.plan.verification : verification };
    this.repo.insertPlan(missionId, plan, 'proposed');
    this.repo.updateMission(m.id, { planVersion: version });
    const art = this.artifacts.put({ missionId, taskId: null, kind: 'plan', name: `Plan v${version}`, content: JSON.stringify({ source, ...plan }, null, 2) });
    this.emit({ missionId, type: 'plan.proposed', actor: SYSTEM('planner'), payload: { version, source, summary: plan.summary, tasks: plan.tasks.map((t) => ({ key: t.key, title: t.title, role: t.role, tools: t.tools, dependsOn: t.dependsOn, risk: t.risk, files: t.files ?? [] })) }, artifactIds: [art.id] });
    this.setMission(m, 'awaiting_approval');
    return this.mission(missionId);
  }

  /**
   * Operator approves the current plan: snapshot the base commit, materialize tasks, start scheduling.
   * Writers that declare overlapping files are serialized so they never edit the same paths in parallel (§13).
   */
  async approvePlan(missionId: string): Promise<Mission> {
    const m = this.mission(missionId);
    if (m.state !== 'awaiting_approval') throw new AtlasError('invalid_request', `Mission is ${m.state}, not awaiting approval`);
    const w = await this.refreshWorkspace(m.workspaceId);
    if (!w.isGit || !w.head) throw new AtlasError('workspace_conflict', 'Workspace needs a git repository with at least one commit');
    const rt = this.o.runtimes[m.runtime];
    if (!rt) throw new AtlasError('model_unavailable', `Runtime ${m.runtime} is not available`);
    const health = await rt.health();
    if (!health.ok) throw new AtlasError('model_unavailable', health.detail);
    const p = this.repo.plan(missionId, m.planVersion)!;
    this.repo.setPlanStatus(missionId, p.plan.version, 'approved');
    this.repo.updateMission(m.id, { baseCommit: w.head });
    this.emit({ missionId, type: 'plan.approved', actor: OPERATOR, payload: { version: p.plan.version, baseCommit: w.head } });

    const deps = new Map(p.plan.tasks.map((t) => [t.key, new Set(t.dependsOn)]));
    const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
      if (from === to) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return [...(deps.get(from) ?? [])].some((d) => reaches(d, to, seen));
    };
    const writers = p.plan.tasks.filter((t) => ROLES[t.role].writes && t.files?.length);
    for (let i = 0; i < writers.length; i++) {
      for (let j = i + 1; j < writers.length; j++) {
        const a = writers[i], b = writers[j];
        const overlap = a.files!.filter((f) => b.files!.some((g) => f === g || f.startsWith(`${g}/`) || g.startsWith(`${f}/`)));
        if (overlap.length && !reaches(a.key, b.key) && !reaches(b.key, a.key)) {
          deps.get(b.key)!.add(a.key);
          this.emit({ missionId, type: 'plan.proposed', actor: SYSTEM('scheduler'), payload: { version: p.plan.version, serialized: { first: a.key, then: b.key, files: overlap } } });
        }
      }
    }

    const byKey = new Map<string, string>();
    for (const pt of p.plan.tasks) byKey.set(pt.key, newId('tsk'));
    for (const pt of p.plan.tasks) {
      const t: Task = {
        id: byKey.get(pt.key)!, missionId, key: pt.key, title: pt.title, role: pt.role, dependencies: [...deps.get(pt.key)!].map((d) => byKey.get(d)!), state: 'queued', retries: 0,
        acceptance: pt.acceptance, resultRef: null, worktree: null, branch: null, checkpoint: null, parentTaskId: null, depth: 0,
      };
      this.repo.insertTask(t);
      this.emit({ missionId, taskId: t.id, type: 'task.state', actor: SYSTEM('scheduler'), payload: { key: t.key, from: null, to: 'queued', title: t.title, role: t.role, dependsOn: [...deps.get(pt.key)!] } });
    }
    this.setMission(m, 'running', { baseCommit: w.head });
    this.kick(missionId);
    return this.mission(missionId);
  }

  /** Start the mission loop if it is not already running in this process. */
  kick(missionId: string) {
    if (this.running.has(missionId)) return;
    const ac = this.aborts.get(missionId) ?? new AbortController();
    this.aborts.set(missionId, ac);
    const m = this.repo.mission(missionId)!;
    const startedAt = this.repo.eventsSince(missionId, 0).find((e) => e.type === 'mission.state' && e.payload.to === 'running')?.ts ?? nowIso();
    const left = new Date(startedAt).getTime() + m.budget.maxWallClockMinutes * 60_000 - Date.now();
    this.budgetTimers.set(missionId, setTimeout(() => this.exceedBudget(missionId, `Wall-clock budget of ${m.budget.maxWallClockMinutes} min exhausted`), Math.max(0, left)));
    const p = this.loop(missionId, ac.signal)
      .catch((e) => {
        this.emit({ missionId, type: 'error', actor: SYSTEM('orchestrator'), payload: { kind: e instanceof AtlasError ? e.kind : 'internal', message: (e as Error).message } });
        const cur = this.repo.mission(missionId);
        if (cur && (cur.state === 'running' || cur.state === 'verifying')) { this.setMission(cur, 'failed', { reason: (e as Error).message }); this.repo.updateMission(missionId, { outcome: `Failed: ${(e as Error).message}` }); }
      })
      .finally(() => { this.running.delete(missionId); clearTimeout(this.budgetTimers.get(missionId)); this.budgetTimers.delete(missionId); });
    this.running.set(missionId, p);
  }

  /** Wait for the mission loop (tests and shutdown). */
  async settle(missionId: string) { await this.running.get(missionId); }

  /* ---------------- budgets (manual §16, §41) ---------------- */

  private tokensUsed(missionId: string): number {
    return this.repo.attempts(missionId).reduce((a, x) => a + x.tokens, 0) + (this.liveTokens.get(missionId) ?? 0);
  }
  private readonly liveTokens = new Map<string, number>();

  private exceedBudget(missionId: string, reason: string) {
    const m = this.repo.mission(missionId);
    if (!m || !['running', 'verifying'].includes(m.state)) return;
    this.emit({ missionId, type: 'budget.exceeded', actor: SYSTEM('governor'), payload: { reason, budget: m.budget, tokensUsed: this.tokensUsed(missionId) } });
    this.repo.updateMission(missionId, { outcome: `Stopped: ${reason}` });
    this.budgetStops.add(missionId);
    this.aborts.get(missionId)?.abort();
  }
  private readonly budgetStops = new Set<string>();

  budgetReport(missionId: string) {
    const m = this.repo.mission(missionId)!;
    const events = this.repo.eventsSince(missionId, 0, 100_000);
    const running = events.find((e) => e.type === 'mission.state' && e.payload.to === 'running')?.ts;
    const end = [...events].reverse().find((e) => e.type === 'mission.state' && ['completed', 'failed', 'cancelled'].includes(String(e.payload.to)))?.ts;
    return {
      budget: m.budget,
      tokens: this.tokensUsed(missionId),
      toolCalls: events.filter((e) => e.type === 'agent.tool_call').length,
      tasks: this.repo.tasks(missionId).length,
      agentsNow: this.activeAgents.get(missionId) ?? 0,
      elapsedMs: running ? new Date(end ?? nowIso()).getTime() - new Date(running).getTime() : 0,
    };
  }

  /* ---------------- scheduler (manual §13) ---------------- */

  private async loop(missionId: string, signal: AbortSignal) {
    const inflight = new Map<string, Promise<void>>();
    for (;;) {
      if (signal.aborted) break;
      const m = this.mission(missionId);
      if (m.state !== 'running') break;
      // Delegated subtasks are run by their parent, never by the scheduler directly.
      const tasks = this.repo.tasks(missionId).filter((t) => !t.parentTaskId);
      const state = new Map(tasks.map((t) => [t.id, t.state]));
      for (const t of tasks) {
        if (t.state !== 'queued' && t.state !== 'blocked') continue;
        const deps = t.dependencies.map((d) => state.get(d));
        if (deps.some((s) => s === 'failed' || s === 'cancelled')) { if (t.state === 'queued') this.setTask(t, 'blocked', { reason: 'A dependency failed' }); this.setTask(t, 'failed', { reason: 'Dependency failed' }); continue; }
        if (deps.every((s) => s === 'done')) this.setTask(t, 'ready');
        else if (t.state === 'queued') this.setTask(t, 'blocked', { waitingOn: t.dependencies.filter((d) => state.get(d) !== 'done') });
      }
      const fresh = this.repo.tasks(missionId).filter((t) => !t.parentTaskId);
      for (const t of fresh) {
        // Admission control: never exceed the mission's concurrent agent budget (subagents count too).
        // runTask registers itself as an active agent synchronously, so this count is always current.
        if (t.state !== 'ready' || inflight.has(t.id) || (this.activeAgents.get(missionId) ?? 0) >= m.budget.maxConcurrentAgents) continue;
        const p = this.runTask(m, t, signal).finally(() => inflight.delete(t.id));
        inflight.set(t.id, p);
      }
      if (fresh.every((t) => TERMINAL_TASK.has(t.state))) break;
      if (inflight.size === 0) {
        if (!fresh.some((t) => t.state === 'ready')) break;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      await Promise.race(inflight.values());
    }
    await Promise.allSettled(inflight.values());
    if (this.stopping) return;
    if (signal.aborted) {
      if (this.budgetStops.has(missionId)) { this.budgetStops.delete(missionId); await this.finishStopped(missionId); }
      return;
    }
    const m = this.mission(missionId);
    if (m.state === 'running' || m.state === 'verifying') await this.release(m);
  }
  private async finishStopped(missionId: string) {
    const m = this.repo.mission(missionId)!;
    for (const t of this.repo.tasks(missionId)) if (!TERMINAL_TASK.has(t.state)) this.setTask(t, 'cancelled', { reason: 'Budget exceeded' });
    if (['running', 'verifying'].includes(m.state)) this.setMission(m, 'failed', { reason: m.outcome ?? 'Budget exceeded' });
  }

  private permittedTools(m: Mission, t: Task): string[] {
    const planTask = this.repo.plan(m.id, m.planVersion)?.plan.tasks.find((x) => x.key === t.key);
    let tools = planTask ? planTask.tools : [...ROLES[t.role].tools];
    if (m.approvalMode === 'plan_only') tools = tools.filter((x) => !['write_file', 'delegate'].includes(x));
    if (t.depth >= m.budget.maxDelegationDepth) tools = tools.filter((x) => x !== 'delegate');
    return tools;
  }

  /** Bases for a task's worktree: the checkpoints of its dependencies, or the mission base. */
  private basesFor(m: Mission, t: Task, override?: string[]): string[] {
    if (override?.length) return override;
    const deps = t.dependencies.map((d) => this.repo.task(d)!).filter(Boolean);
    const commits = [...new Set(deps.map((d) => d.checkpoint).filter((c): c is string => !!c))];
    return commits.length ? commits : [m.baseCommit!];
  }

  private async runTask(m: Mission, t: Task, missionSignal: AbortSignal, baseOverride?: string[]): Promise<void> {
    const w = this.repo.workspace(m.workspaceId)!;
    const def = role(t.role);
    const plan = this.repo.plan(m.id, m.planVersion)!.plan;
    const number = this.repo.attempts(m.id).filter((a) => a.taskId === t.id).length + 1;
    const attempt: Attempt = { id: newId('att'), taskId: t.id, missionId: m.id, number, state: 'starting', runtime: m.runtime, pid: null, startedAt: nowIso(), endedAt: null, error: null, tokens: 0 };
    // Persist start intent before any worker exists (manual §13).
    this.repo.insertAttempt(attempt);
    this.setTask(t, 'running', { attempt: number });
    this.activeAgents.set(m.id, (this.activeAgents.get(m.id) ?? 0) + 1);
    try {
      await this.runAttempt(m, w, t, def, plan, attempt, number, missionSignal, baseOverride);
    } finally {
      this.activeAgents.set(m.id, Math.max(0, (this.activeAgents.get(m.id) ?? 1) - 1));
    }
  }

  private async runAttempt(m: Mission, w: Workspace, t: Task, def: ReturnType<typeof role>, plan: Plan, attempt: Attempt, number: number, missionSignal: AbortSignal, baseOverride?: string[]) {
    const dir = path.join(this.o.worktreeDir, m.id, `${t.key}-${number}`);
    const branch = `atlas/${m.id}/${t.key}-${number}`;
    const bases = this.basesFor(m, t, baseOverride);
    try {
      const r = await worktreeFromBases(w.root, dir, branch, bases);
      if (!r.ok) throw new AtlasError('workspace_conflict', `Dependencies conflict: ${r.message}`);
    } catch (e) {
      const message = `Could not prepare worktree: ${(e as Error).message}`;
      this.repo.updateAttempt(attempt.id, { state: 'failed', endedAt: nowIso(), error: message });
      this.emit({ missionId: m.id, taskId: t.id, attemptId: attempt.id, type: 'attempt.ended', actor: SYSTEM('scheduler'), payload: { number, state: 'failed', errorKind: 'workspace_conflict', message } });
      this.setTask(t, 'failed', { errorKind: 'workspace_conflict', reason: message });
      return;
    }
    const startCommit = await gitOk(dir, ['rev-parse', 'HEAD']);
    this.repo.updateTask(t.id, { worktree: dir, branch });
    this.emit({ missionId: m.id, taskId: t.id, attemptId: attempt.id, type: 'workspace.worktree', actor: SYSTEM('workspace'), payload: { action: 'created', path: dir, branch, base: m.baseCommit, startedFrom: bases } });
    if (!this.leases.acquire(dir, attempt.id)) throw new AtlasError('workspace_conflict', `Worktree ${dir} already has a writer`);

    const ac = new AbortController();
    const onMission = () => ac.abort();
    missionSignal.addEventListener('abort', onMission, { once: true });
    this.taskAborts.set(t.id, ac);

    const rt = this.o.runtimes[m.runtime]!;
    const permitted = this.permittedTools(m, t);
    const isolation = await this.isolationFor(dir);
    const extras: Record<string, ExtraTool> = {};
    const stageLike = this.stageContext(m, dir, startCommit, isolation, ac.signal, [], { role: t.role, taskId: t.id });
    for (const [name, make] of Object.entries(this.o.toolFactories ?? {})) {
      if (!permitted.includes(name)) continue;
      extras[name] = make({
        missionId: m.id, taskId: t.id, attemptId: attempt.id, worktree: dir, sandbox: stageLike.sandbox,
        putArtifact: (a) => (a.bytes ? this.artifacts.putBytes({ missionId: m.id, taskId: t.id, kind: a.kind, name: a.name, bytes: Buffer.from(a.bytes) }) : this.artifacts.put({ missionId: m.id, taskId: t.id, kind: a.kind, name: a.name, content: a.content ?? '' })),
        emit: (type, payload, artifactIds = []) => { this.emit({ missionId: m.id, taskId: t.id, attemptId: attempt.id, type, actor: { kind: 'agent', role: t.role, taskId: t.id }, payload, artifactIds }); },
        requestApproval: stageLike.requestApproval, setting: stageLike.setting,
      });
    }
    const tools = new ToolGate({
      extra: extras,
      isolation, missionId: m.id, taskId: t.id, attemptId: attempt.id, role: t.role, mode: m.approvalMode, cwd: dir, permitted, base: m.baseCommit!,
      approvalTtlMs: this.approvalTtlMs, awaitApproval: (a: Approval, s: AbortSignal) => this.awaitApproval(a, s),
      onFinding: (args, failing) => this.recordFinding(m, t, attempt.id, args, failing),
      delegate: (args, s) => this.delegate(m, t, dir, args, s),
    }, this.repo, this.artifacts, this.o.executors ?? realExecutors);

    const decisions = this.repo.eventsSince(m.id, 0, 100_000)
      .filter((e) => ['plan.approved', 'approval.decided', 'attempt.ended', 'delegation.result', 'finding.reported'].includes(e.type))
      .map((e) => `${e.ts} ${e.type}: ${JSON.stringify(e.payload).slice(0, 240)}`);
    const ctx = await buildContext({
      worktree: dir, base: m.baseCommit!, role: t.role, objective: m.goal, constraints: m.constraints, task: t, planSummary: `${plan.summary}\nTasks: ${plan.tasks.map((x) => `${x.key} (${x.role})`).join(', ')}`,
      facts: this.facts(w.id), decisions, includeDiff: t.role === 'reviewer' || t.role === 'tester',
    });
    const ctxArt = this.artifacts.put({ missionId: m.id, taskId: t.id, kind: 'context', name: `Context · ${t.key} attempt ${number}`, content: ctx.text });
    this.emit({ missionId: m.id, taskId: t.id, attemptId: attempt.id, type: 'context.built', actor: SYSTEM('context'), payload: { sources: ctx.sources, chars: ctx.text.length } });
    const prompt = `Mission: ${m.title}\n\n${ctx.text}\n\nWork on task ${t.key} now.`;

    this.repo.updateAttempt(attempt.id, { state: 'running' });
    this.emit({ missionId: m.id, taskId: t.id, attemptId: attempt.id, type: 'attempt.started', actor: SYSTEM('scheduler'), payload: { number, runtime: m.runtime, role: t.role, roleVersion: def.version, worktree: dir, branch, tools: permitted, depth: t.depth, contextArtifact: ctxArt.id, sandbox: isolation.mode }, artifactIds: [ctxArt.id] });

    const agent = { kind: 'agent' as const, role: t.role, taskId: t.id };
    let outcome: Outcome = { kind: 'error', errorKind: 'internal', message: 'Runtime ended without a result' };
    let tokens = 0;
    let handle: Awaited<ReturnType<AgentRuntime['start']>> | null = null;
    try {
      handle = await rt.start({
        missionId: m.id, taskId: t.id, attemptId: attempt.id, workspaceId: w.id, roleId: t.role, cwd: dir, instructions: def.instructions, prompt,
        permittedTools: permitted, contextRefs: [ctxArt.id], budget: def.budget, tools, signal: ac.signal,
      });
      for await (const ev of rt.stream(handle)) {
        const base = { missionId: m.id, taskId: t.id, attemptId: attempt.id, actor: agent };
        if (ev.type === 'message') this.emit({ ...base, type: 'agent.message', payload: { text: ev.text } });
        else if (ev.type === 'tool_call') this.emit({ ...base, type: 'agent.tool_call', payload: { callId: ev.callId, tool: ev.tool, args: ev.args } });
        else if (ev.type === 'tool_result') this.emit({ ...base, type: 'agent.tool_result', payload: { callId: ev.callId, tool: ev.tool, ok: ev.ok, summary: ev.summary.slice(0, 4000) } });
        else if (ev.type === 'usage') {
          tokens += ev.inputTokens + ev.outputTokens;
          this.liveTokens.set(m.id, (this.liveTokens.get(m.id) ?? 0) + ev.inputTokens + ev.outputTokens);
          this.emit({ ...base, type: 'agent.usage', payload: { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, total: tokens } });
          if (this.tokensUsed(m.id) > m.budget.maxTokens) this.exceedBudget(m.id, `Token budget of ${m.budget.maxTokens.toLocaleString('en')} exhausted`);
        }
        else if (ev.type === 'completed') outcome = { kind: 'completed', summary: ev.summary };
        else if (ev.type === 'error') outcome = { kind: 'error', errorKind: ev.kind, message: ev.message };
      }
    } catch (e) {
      outcome = { kind: 'error', errorKind: ac.signal.aborted ? 'cancelled' : 'internal', message: (e as Error).message };
    } finally {
      if (handle) await rt.dispose(handle).catch(() => {});
      for (const x of Object.values(extras)) await x.dispose().catch(() => {});
      missionSignal.removeEventListener('abort', onMission);
      this.taskAborts.delete(t.id);
      this.leases.release(dir, attempt.id);
      this.liveTokens.set(m.id, Math.max(0, (this.liveTokens.get(m.id) ?? 0) - tokens));
    }
    // On shutdown the attempt is left as running; recovery records it as lost on the next start.
    if (this.stopping) return;

    const cur = this.repo.task(t.id)!;
    if (outcome.kind === 'completed') {
      // The agent's summary is recorded as a claim. Evidence comes from the checkpoint and checks.
      const transcript = this.artifacts.put({ missionId: m.id, taskId: t.id, kind: 'transcript', name: `Attempt ${number} transcript`, content: this.repo.eventsSince(m.id, 0, 100_000).filter((e) => e.attemptId === attempt.id).map((e) => `${e.ts} ${e.type} ${JSON.stringify(e.payload)}`).join('\n') });
      this.emit({ missionId: m.id, taskId: t.id, attemptId: attempt.id, type: 'agent.message', actor: agent, payload: { text: outcome.summary, claim: true }, artifactIds: [transcript.id] });
      // Only writing roles produce integrated changes; anything else a non-writer touched is discarded.
      // A writer's result is its current HEAD: work may already be committed mid-attempt (e.g. before delegating).
      const sha = def.writes ? await checkpoint(dir, `ATLAS ${m.id} ${t.key} attempt ${number}`) : null;
      const head = def.writes ? await gitOk(dir, ['rev-parse', 'HEAD']) : startCommit;
      let artifactIds: string[] = [];
      let files: { path: string; add: number; del: number }[] = [];
      if (head !== startCommit) {
        const d = await diffSince(dir, startCommit);
        files = d.files;
        const patch = this.artifacts.put({ missionId: m.id, taskId: t.id, kind: 'patch', name: `${t.key} · ${files.length} file${files.length === 1 ? '' : 's'}`, content: d.patch });
        artifactIds = [patch.id];
        this.repo.updateTask(t.id, { resultRef: patch.id });
      }
      this.repo.updateTask(t.id, { checkpoint: head });
      this.emit({ missionId: m.id, taskId: t.id, attemptId: attempt.id, type: 'workspace.worktree', actor: SYSTEM('workspace'), payload: { action: 'checkpoint', commit: sha, head, files }, artifactIds });
      this.repo.updateAttempt(attempt.id, { state: 'succeeded', endedAt: nowIso(), tokens });
      this.emit({ missionId: m.id, taskId: t.id, attemptId: attempt.id, type: 'attempt.ended', actor: SYSTEM('scheduler'), payload: { number, state: 'succeeded', tokens } });
      this.setTask(cur, 'done', { checkpoint: head });
      return;
    }

    const cancelled = outcome.errorKind === 'cancelled' || ac.signal.aborted;
    this.repo.updateAttempt(attempt.id, { state: cancelled ? 'cancelled' : 'failed', endedAt: nowIso(), error: outcome.message, tokens });
    this.emit({ missionId: m.id, taskId: t.id, attemptId: attempt.id, type: 'attempt.ended', actor: SYSTEM('scheduler'), payload: { number, state: cancelled ? 'cancelled' : 'failed', errorKind: outcome.errorKind, message: outcome.message, tokens } });
    if (cancelled) { if (!TERMINAL_TASK.has(cur.state)) this.setTask(cur, 'cancelled'); return; }
    const retryable = RETRYABLE.has(outcome.errorKind as never);
    if (retryable && number < this.maxAttempts && !cur.parentTaskId) {
      this.repo.updateTask(t.id, { retries: cur.retries + 1 });
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** number)));
      this.setTask(cur, 'ready', { retry: number + 1, reason: outcome.message });
      return;
    }
    this.setTask(cur, 'failed', { errorKind: outcome.errorKind, reason: outcome.message });
  }

  /* ---------------- review findings (manual §29) ---------------- */

  private recordFinding(m: Mission, t: Task, attemptId: string, args: FindingArgs, failingRuns: ReadonlySet<string>): string {
    const { finding, downgraded } = makeFinding(args, { missionId: m.id, taskId: t.id, failingRuns });
    const { finding: stored, duplicate } = this.repo.insertFinding(finding);
    if (duplicate) return `Duplicate of ${stored.id} ("${stored.title}"); not recorded again.`;
    this.emit({ missionId: m.id, taskId: t.id, attemptId, type: 'finding.reported', actor: { kind: 'agent', role: t.role, taskId: t.id }, payload: { findingId: stored.id, file: stored.file, line: stored.line, severity: stored.severity, kind: stored.kind, title: stored.title, downgraded }, artifactIds: stored.reproductionArtifactId ? [stored.reproductionArtifactId] : [] });
    return `Recorded ${stored.id} as ${stored.kind}${downgraded ? ' (downgraded: no failing reproduction from this review was referenced)' : ''}.`;
  }

  updateFinding(findingId: string, status: 'accepted' | 'dismissed' | 'fixed' | 'open') {
    const f = this.repo.finding(findingId);
    if (!f) throw new AtlasError('invalid_request', 'Unknown finding');
    this.repo.setFindingStatus(findingId, status);
    this.emit({ missionId: f.missionId, taskId: f.taskId, type: 'finding.updated', actor: OPERATOR, payload: { findingId, from: f.status, to: status, title: f.title } });
    return this.repo.finding(findingId)!;
  }

  /* ---------------- delegation (manual §16) ---------------- */

  private async delegate(m: Mission, parent: Task, parentDir: string, args: { role: 'coder' | 'tester' | 'reviewer'; title: string; reason: string; acceptance: string[] }, signal: AbortSignal): Promise<ToolResult> {
    const deny = (reason: string): ToolResult => {
      this.emit({ missionId: m.id, taskId: parent.id, type: 'delegation.result', actor: SYSTEM('governor'), payload: { parentKey: parent.key, title: args.title, status: 'denied', reason } });
      return { ok: false, output: `Delegation refused: ${reason}`, exitCode: null, artifactIds: [], error: 'policy_denied' };
    };
    const cur = this.mission(m.id);
    if (parent.depth + 1 > cur.budget.maxDelegationDepth) return deny(`maximum delegation depth ${cur.budget.maxDelegationDepth} reached`);
    if (this.repo.tasks(m.id).length >= cur.budget.maxTasks) return deny(`mission task budget of ${cur.budget.maxTasks} reached`);
    if ((this.activeAgents.get(m.id) ?? 0) >= cur.budget.maxConcurrentAgents) return deny(`concurrent agent budget of ${cur.budget.maxConcurrentAgents} reached`);
    if (this.tokensUsed(m.id) >= cur.budget.maxTokens * 0.9) return deny('less than 10% of the token budget remains');

    // The child starts from the parent's current work, checkpointed.
    const base = (await checkpoint(parentDir, `ATLAS ${m.id} ${parent.key}: checkpoint before delegation`)) ?? (await gitOk(parentDir, ['rev-parse', 'HEAD']));
    const n = this.repo.tasks(m.id).filter((x) => x.parentTaskId === parent.id).length + 1;
    const child: Task = {
      id: newId('tsk'), missionId: m.id, key: `${parent.key}.d${n}`, title: args.title, role: args.role, dependencies: [], state: 'queued', retries: 0, acceptance: args.acceptance,
      resultRef: null, worktree: null, branch: null, checkpoint: null, parentTaskId: parent.id, depth: parent.depth + 1,
    };
    this.repo.insertTask(child);
    this.emit({ missionId: m.id, taskId: child.id, type: 'delegation.requested', actor: { kind: 'agent', role: parent.role, taskId: parent.id }, payload: { parentKey: parent.key, childKey: child.key, role: args.role, title: args.title, reason: args.reason, depth: child.depth, base } });
    this.emit({ missionId: m.id, taskId: child.id, type: 'task.state', actor: SYSTEM('scheduler'), payload: { key: child.key, from: null, to: 'queued', title: child.title, role: child.role, parentKey: parent.key } });
    this.setTask(child, 'ready');
    await this.runTask(cur, child, signal, [base]);

    const done = this.repo.task(child.id)!;
    const claim = [...this.repo.eventsSince(m.id, 0, 100_000)].reverse().find((e) => e.taskId === child.id && e.type === 'agent.message' && e.payload.claim)?.payload.text;
    if (done.state !== 'done') {
      this.emit({ missionId: m.id, taskId: child.id, type: 'delegation.result', actor: SYSTEM('scheduler'), payload: { parentKey: parent.key, childKey: child.key, status: done.state } });
      return { ok: false, output: `Subtask ${child.key} ended ${done.state}. No changes were merged.`, exitCode: null, artifactIds: [], error: 'process_failed' };
    }
    let merge = 'no file changes';
    if (ROLES[done.role].writes && done.checkpoint && done.checkpoint !== base) {
      const r = await mergeInto(parentDir, done.checkpoint, `ATLAS: merge subtask ${child.key}`);
      merge = r.ok ? `merged at ${r.commit!.slice(0, 12)}` : `NOT merged — ${r.message}`;
      if (!r.ok) {
        this.emit({ missionId: m.id, taskId: child.id, type: 'delegation.result', actor: SYSTEM('scheduler'), payload: { parentKey: parent.key, childKey: child.key, status: 'conflict', conflicts: r.conflicts } });
        return { ok: false, output: `Subtask ${child.key} finished but its change conflicts with yours: ${r.message}`, exitCode: null, artifactIds: done.resultRef ? [done.resultRef] : [], error: 'process_failed' };
      }
    }
    const result = { childKey: child.key, role: done.role, status: 'done', merge, summary: claim ?? '', patch: done.resultRef };
    const art = this.artifacts.put({ missionId: m.id, taskId: child.id, kind: 'evidence', name: `Delegation result · ${child.key}`, content: JSON.stringify(result, null, 2) });
    this.emit({ missionId: m.id, taskId: child.id, type: 'delegation.result', actor: SYSTEM('scheduler'), payload: { parentKey: parent.key, ...result }, artifactIds: [art.id] });
    return { ok: true, output: `Subtask ${child.key} done (${merge}).\nIts summary (a claim, not evidence): ${claim ?? '(none)'}`, exitCode: null, artifactIds: [art.id], error: null };
  }

  /* ---------------- integration and release (manual §19, §28, §32) ---------------- */

  private async integrate(m: Mission): Promise<{ ok: true; dir: string; commit: string } | { ok: false; message: string }> {
    const w = this.repo.workspace(m.workspaceId)!;
    const tasks = this.repo.tasks(m.id).filter((t) => !t.parentTaskId);
    const writers = topoOrder(tasks).map((id) => tasks.find((t) => t.id === id)!).filter((t) => ROLES[t.role].writes && t.state === 'done' && t.checkpoint);
    const dir = path.join(this.o.worktreeDir, m.id, 'integration');
    const branch = `atlas/${m.id}/integration`;
    if (existsSync(dir)) await removeWorktree(w.root, dir, branch);
    const r = await worktreeFromBases(w.root, dir, branch, [m.baseCommit!]);
    if (!r.ok) return { ok: false, message: r.message };
    for (const t of writers) {
      const mr = await mergeInto(dir, t.checkpoint!, `ATLAS: integrate ${t.key}`);
      if (!mr.ok) {
        this.emit({ missionId: m.id, type: 'integration.result', actor: SYSTEM('integration'), payload: { ok: false, task: t.key, conflicts: mr.conflicts, message: mr.message } });
        return { ok: false, message: `Integration conflict while merging ${t.key}: ${mr.message}` };
      }
    }
    const commit = await gitOk(dir, ['rev-parse', 'HEAD']);
    const d = await diffSince(dir, m.baseCommit!);
    const patch = d.files.length ? this.artifacts.put({ missionId: m.id, taskId: null, kind: 'patch', name: `Integration · ${d.files.length} file${d.files.length === 1 ? '' : 's'}`, content: d.patch }) : null;
    this.repo.updateMission(m.id, { integrationBranch: branch, integrationCommit: commit });
    this.emit({ missionId: m.id, type: 'integration.result', actor: SYSTEM('integration'), payload: { ok: true, branch, commit, merged: writers.map((t) => t.key), files: d.files }, artifactIds: patch ? [patch.id] : [] });
    return { ok: true, dir, commit };
  }

  private stageContext(m: Mission, dir: string, commit: string, iso: Isolation, signal: AbortSignal, checks: CheckRecord[], who: { role: Task['role']; taskId: string | null } = { role: 'deployment_verifier', taskId: null }): StageContext {
    const spec = (network = false) => this.sandboxSpec(iso, dir, network);
    return {
      mission: m, worktree: dir, commit, signal,
      sandbox: {
        available: iso.mode !== 'unavailable',
        detail: iso.mode === 'unavailable' ? iso.detail : iso.mode,
        run: async (o) => {
          const s = spec(!!o.network);
          if (s === null) return { exitCode: null, output: '', durationMs: 0, timedOut: false, cancelled: false, spawnError: `No OS sandbox: ${detectSandbox().detail}`, pid: null };
          const r = await run({ command: o.command, args: o.args, cwd: o.cwd ?? dir, timeoutMs: o.timeoutMs, signal: o.signal ?? signal, env: sanitizedEnv(), sandbox: s, onOutput: o.onOutput ? (_s, t) => o.onOutput!(t) : undefined });
          return { exitCode: r.exitCode, output: r.output, durationMs: r.durationMs, timedOut: r.timedOut, cancelled: r.cancelled, spawnError: r.spawnError, pid: r.pid };
        },
        start: async (o) => {
          const s = spec(o.network);
          if (s === null) return { pid: null, spawnError: `No OS sandbox: ${detectSandbox().detail}`, stop: async () => {}, output: () => '', exited: () => ({ code: null }) };
          return startProcess({ command: o.command, args: o.args, cwd: o.cwd ?? dir, env: sanitizedEnv(o.env ?? {}), sandbox: s, onOutput: o.onOutput });
        },
      },
      putArtifact: (a) => (a.bytes ? this.artifacts.putBytes({ missionId: m.id, taskId: null, kind: a.kind, name: a.name, bytes: Buffer.from(a.bytes) }) : this.artifacts.put({ missionId: m.id, taskId: null, kind: a.kind, name: a.name, content: a.content ?? '' })),
      emit: (type, payload, artifactIds = []) => { this.emit({ missionId: m.id, type, actor: SYSTEM('release'), payload, artifactIds }); },
      check: (c) => {
        const rec: CheckRecord = { id: newId('chk'), missionId: m.id, commit: c.commit ?? commit, ...c };
        this.repo.insertCheck(rec);
        checks.push(rec);
        this.emit({ missionId: m.id, type: 'check.result', actor: SYSTEM('verification'), payload: { ...rec }, artifactIds: rec.artifactId ? [rec.artifactId] : [] });
        return rec;
      },
      requestApproval: (a) => {
        const now = Date.now();
        const approval: Approval = {
          id: newId('apr'), missionId: m.id, taskId: who.taskId, agentRole: who.role, ...a, scope: 'once', status: 'pending',
          requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.approvalTtlMs).toISOString(), decidedAt: null, decidedBy: null,
        };
        this.repo.insertApproval(approval);
        this.emit({ missionId: m.id, taskId: who.taskId, type: 'approval.requested', actor: SYSTEM('release'), payload: { approvalId: approval.id, tool: a.tool, action: a.action, risk: a.risk, reason: a.reason, expiresAt: approval.expiresAt } });
        return this.awaitApproval(approval, signal);
      },
      setting: (key, fallback) => this.repo.setting(key, fallback),
      checks: () => checks,
      repoDeployments: (missionId) => this.repo.deployments({ missionId }),
      repoDeployment: (id) => this.repo.deployment(id),
      markDeployment: (id, verified) => this.repo.updateDeployment(id, { verified }),
    };
  }

  /** Integrate, then run every release stage on the integrated commit, then apply the gate. */
  private async release(m: Mission) {
    if (m.state !== 'verifying') this.setMission(m, 'verifying');
    const signal = this.aborts.get(m.id)?.signal ?? new AbortController().signal;
    const top = this.repo.tasks(m.id).filter((t) => !t.parentTaskId);
    const failed = top.filter((t) => t.state !== 'done');
    const checks: CheckRecord[] = [];
    let verdict: Verdict;
    let summary: string;
    if (failed.length) {
      verdict = 'failed';
      summary = `Failed: ${failed.map((t) => `${t.key} ${t.state}`).join(', ')}`;
    } else {
      const integ = await this.integrate(m);
      if (!integ.ok) {
        verdict = 'failed';
        summary = `Failed: ${integ.message}`;
      } else {
        const iso = await this.isolationFor(integ.dir);
        const ctx = this.stageContext(this.repo.mission(m.id)!, integ.dir, integ.commit, iso, signal, checks);
        await this.checksStage(ctx);
        this.findingsStage(ctx);
        for (const st of this.o.stages ?? []) {
          if (signal.aborted) break;
          try {
            if (await st.applies(ctx)) await st.run(ctx);
          } catch (e) {
            ctx.check({ name: st.name, command: null, required: true, result: 'inconclusive', exitCode: null, durationMs: null, reason: `Stage error: ${(e as Error).message}`, artifactId: null });
          }
        }
        ({ verdict, summary } = gate(checks));
      }
    }
    const current = this.repo.mission(m.id)!;
    if (current.state !== 'verifying' || signal.aborted) return;
    this.emit({ missionId: m.id, type: 'gate.result', actor: SYSTEM('release-gate'), payload: { verdict, summary, commit: current.integrationCommit, checks: checks.map((c) => ({ name: c.name, required: c.required, result: c.result, commit: c.commit })) } });
    this.repo.updateMission(m.id, { outcome: summary });
    this.setMission(current, verdict === 'failed' ? 'failed' : 'completed', { verdict });
  }

  /** Build/test checks from project recipes, on the integrated commit, in the sandbox. */
  private async checksStage(ctx: StageContext) {
    const recipes = detectRecipes(ctx.worktree);
    if (!recipes.some((r) => r.name === 'tests')) ctx.check({ name: 'tests', command: null, required: false, result: 'not_configured', exitCode: null, durationMs: null, reason: 'No test command found in package.json', artifactId: null });
    for (const r of recipes) {
      const res = await ctx.sandbox.run({ command: r.command, args: r.args, timeoutMs: r.timeoutMs });
      const log = ctx.putArtifact({ kind: 'test_report', name: `${r.name} @ ${ctx.commit.slice(0, 7)}`, content: `$ ${[r.command, ...r.args].join(' ')}\n${res.output}\n[exit ${res.exitCode ?? 'none'} · ${res.durationMs} ms]` });
      const result = res.cancelled || res.timedOut || res.spawnError ? 'inconclusive' : res.exitCode === 0 ? 'pass' : 'fail';
      ctx.check({
        name: r.name, command: [r.command, ...r.args].join(' '), required: r.required, result, exitCode: res.exitCode, durationMs: res.durationMs,
        reason: res.spawnError ? `Could not start: ${res.spawnError}` : res.timedOut ? 'Timed out' : res.cancelled ? 'Cancelled' : `Exit code ${res.exitCode}`, artifactId: log.id,
      });
    }
  }

  /** Review gate: open, confirmed, high/medium findings block; suspected and informational do not. */
  private findingsStage(ctx: StageContext) {
    const all = this.repo.findings(ctx.mission.id);
    const reviewed = this.repo.tasks(ctx.mission.id).some((t) => t.role === 'reviewer' && t.state === 'done');
    if (!reviewed && !all.length) return;
    const blocking = blockingFindings(all);
    ctx.check({
      name: 'review', command: null, required: true, result: blocking.length ? 'fail' : 'pass', exitCode: null, durationMs: null, artifactId: null,
      reason: blocking.length
        ? `${blocking.length} confirmed finding${blocking.length === 1 ? '' : 's'} open: ${blocking.map((f) => `${f.title} (${f.file}${f.line ? `:${f.line}` : ''})`).join('; ')}`
        : `${all.length} finding${all.length === 1 ? '' : 's'}; none confirmed and blocking (${all.filter((f) => f.kind === 'suspected').length} suspected, ${all.filter((f) => f.kind === 'informational').length} informational)`,
    });
  }

  /** Re-run the release gate after the operator resolves findings (no agent work is repeated). */
  async reverify(missionId: string): Promise<Mission> {
    const m = this.mission(missionId);
    if (m.state !== 'failed' || !m.integrationCommit || m.decision) throw new AtlasError('invalid_request', 'Only a failed, undecided mission with an integrated commit can be re-verified');
    if (this.repo.tasks(missionId).some((t) => !t.parentTaskId && t.state !== 'done')) throw new AtlasError('invalid_request', 'Some tasks did not complete; re-verification cannot help');
    this.repo.updateMission(missionId, { state: 'verifying' });
    this.emit({ missionId, type: 'mission.state', actor: OPERATOR, payload: { from: 'failed', to: 'verifying', reason: 'Operator requested re-verification' } });
    this.aborts.set(missionId, new AbortController());
    const p = this.release(this.repo.mission(missionId)!).finally(() => this.running.delete(missionId));
    this.running.set(missionId, p);
    await p;
    return this.mission(missionId);
  }

  /* ---------------- operator terminals (manual §20, §27) ---------------- */

  private readonly terminals = new Map<string, { pty: PtyHandle; missionId: string; dir: string; writable: boolean; startedAt: number }>();

  /**
   * Open an interactive terminal in a task or integration worktree. Writes are serialized with agents:
   * if an agent holds the worktree, the operator's session is read-only.
   */
  async openTerminal(missionId: string, target: string, size: { cols: number; rows: number }, io: { onData(sessionId: string, text: string): void; onExit(sessionId: string, code: number | null): void }) {
    const m = this.repo.mission(missionId);
    if (!m || m.archived) throw new AtlasError('invalid_request', 'Unknown or archived mission');
    const pty = ptySupported();
    if (!pty.ok) throw new AtlasError('invalid_request', pty.detail);
    const dir = target === 'integration' ? path.join(this.o.worktreeDir, m.id, 'integration') : this.repo.task(target)?.worktree;
    if (!dir || !existsSync(dir) || (target !== 'integration' && this.repo.task(target)?.missionId !== missionId)) throw new AtlasError('invalid_request', 'That worktree no longer exists');
    const iso = await this.isolationFor(dir);
    if (iso.mode === 'unavailable') throw new AtlasError('invalid_request', `No OS sandbox: ${iso.detail}`);
    const sessionId = newId('trm');
    const writable = this.leases.acquire(dir, `operator:${sessionId}`);
    const spec = this.sandboxSpec(iso, dir) ?? undefined;
    const handle = openPty({
      cwd: dir, cols: size.cols, rows: size.rows, sandbox: spec ? { ...spec, writable, limits: undefined } : undefined,
      onData: (t) => io.onData(sessionId, t),
      onExit: (code) => { void this.closeTerminal(sessionId, code); io.onExit(sessionId, code); },
    });
    this.terminals.set(sessionId, { pty: handle, missionId, dir, writable, startedAt: Date.now() });
    this.emit({ missionId, type: 'operator.terminal', actor: OPERATOR, payload: { action: 'opened', sessionId, worktree: dir, writable, sandboxed: !!spec } });
    return { sessionId, writable, worktree: dir };
  }

  terminalInput(sessionId: string, data: string) {
    const t = this.terminals.get(sessionId);
    if (!t) throw new AtlasError('invalid_request', 'Terminal session ended');
    t.pty.write(data);
  }

  async closeTerminal(sessionId: string, code: number | null = null) {
    const t = this.terminals.get(sessionId);
    if (!t) return;
    this.terminals.delete(sessionId);
    await t.pty.close();
    if (t.writable) this.leases.release(t.dir, `operator:${sessionId}`);
    // Human interventions are first-class events with their transcript as evidence (manual §2).
    const art = this.artifacts.put({ missionId: t.missionId, taskId: null, kind: 'transcript', name: `Operator terminal ${sessionId}`, content: t.pty.transcript() });
    this.emit({ missionId: t.missionId, type: 'operator.terminal', actor: OPERATOR, payload: { action: 'closed', sessionId, exitCode: code, durationMs: Date.now() - t.startedAt }, artifactIds: [art.id] });
  }

  /* ---------------- approvals ---------------- */

  private awaitApproval(a: Approval, signal: AbortSignal): Promise<Approval> {
    return new Promise((resolve) => {
      const done = (x: Approval) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); this.waiters.delete(a.id); resolve(x); };
      const expire = () => {
        if (this.repo.decideApproval(a.id, 'expired', null)) this.emit({ missionId: a.missionId, taskId: a.taskId, type: 'approval.decided', actor: SYSTEM('policy'), payload: { approvalId: a.id, status: 'expired' } });
        done(this.repo.approval(a.id)!);
      };
      const timer = setTimeout(expire, Math.max(0, new Date(a.expiresAt).getTime() - Date.now()));
      const onAbort = () => expire();
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(a.id, done);
    });
  }

  respondApproval(approvalId: string, decision: 'approve' | 'deny'): Approval {
    const a = this.repo.approval(approvalId);
    if (!a) throw new AtlasError('invalid_request', 'Unknown approval');
    if (new Date(a.expiresAt) <= new Date() && a.status === 'pending') {
      this.repo.decideApproval(a.id, 'expired', null);
      this.emit({ missionId: a.missionId, taskId: a.taskId, type: 'approval.decided', actor: SYSTEM('policy'), payload: { approvalId, status: 'expired' } });
      this.waiters.get(a.id)?.(this.repo.approval(a.id)!);
      throw new AtlasError('policy_deny', 'Approval expired before a decision');
    }
    const status = decision === 'approve' ? 'approved' : 'denied';
    if (!this.repo.decideApproval(a.id, status, 'operator')) throw new AtlasError('invalid_request', `Approval is already ${a.status}`);
    this.emit({ missionId: a.missionId, taskId: a.taskId, type: 'approval.decided', actor: OPERATOR, payload: { approvalId, status, tool: a.tool, action: a.action } });
    const updated = this.repo.approval(a.id)!;
    this.waiters.get(a.id)?.(updated);
    return updated;
  }

  /* ---------------- operator controls ---------------- */

  async cancelMission(missionId: string): Promise<Mission> {
    const m = this.mission(missionId);
    if (['completed', 'failed', 'cancelled'].includes(m.state)) return m;
    this.emit({ missionId, type: 'operator.action', actor: OPERATOR, payload: { action: 'cancel' } });
    this.aborts.get(missionId)?.abort();
    await this.settle(missionId);
    const cur = this.mission(missionId);
    for (const t of this.repo.tasks(missionId)) if (!TERMINAL_TASK.has(t.state)) this.setTask(t, 'cancelled');
    if (!['completed', 'failed', 'cancelled'].includes(cur.state)) {
      this.setMission(cur, 'cancelled');
      this.repo.updateMission(missionId, { outcome: 'Cancelled by operator' });
    }
    return this.mission(missionId);
  }

  async cancelTask(taskId: string): Promise<Task> {
    const t = this.repo.task(taskId);
    if (!t) throw new AtlasError('invalid_request', 'Unknown task');
    this.emit({ missionId: t.missionId, taskId, type: 'operator.action', actor: OPERATOR, payload: { action: 'cancel_task', key: t.key } });
    const ac = this.taskAborts.get(taskId);
    if (ac) ac.abort();
    else if (!TERMINAL_TASK.has(t.state)) this.setTask(t, 'cancelled');
    return this.repo.task(taskId)!;
  }

  /**
   * Accept keeps the integration branch for the operator to merge; reject removes it. Task worktrees and
   * branches are always cleaned. The user checkout is never touched.
   */
  async decide(missionId: string, decision: 'accept' | 'reject'): Promise<Mission> {
    const m = this.mission(missionId);
    if (!['completed', 'failed'].includes(m.state)) throw new AtlasError('invalid_request', 'Only finished missions can be accepted or rejected');
    if (m.decision) throw new AtlasError('invalid_request', `Mission already ${m.decision}`);
    if (decision === 'accept' && !m.integrationCommit) throw new AtlasError('invalid_request', 'Nothing to accept: the mission produced no integrated change');
    const w = this.repo.workspace(m.workspaceId)!;
    for (const t of this.repo.tasks(missionId)) if (t.worktree) await removeWorktree(w.root, t.worktree, t.branch);
    const integDir = path.join(this.o.worktreeDir, m.id, 'integration');
    const kept: string[] = [];
    if (m.integrationBranch) {
      if (decision === 'accept') { await removeWorktree(w.root, integDir, null); kept.push(m.integrationBranch); }
      else await removeWorktree(w.root, integDir, m.integrationBranch);
    }
    for (const st of this.o.stages ?? []) await (st as ReleaseStage & { onDecision?: (m: Mission, d: string) => Promise<void> }).onDecision?.(m, decision).catch(() => {});
    this.repo.updateMission(missionId, { decision: decision === 'accept' ? 'accepted' : 'rejected' });
    this.emit({ missionId, type: 'mission.decision', actor: OPERATOR, payload: { decision, branches: kept, commit: m.integrationCommit, note: decision === 'accept' ? `Changes kept on ${kept.join(', ')} at ${m.integrationCommit?.slice(0, 7)}; merge them when ready.` : 'Worktrees and branches removed. Your checkout was not modified.' } });
    return this.mission(missionId);
  }

  /* ---------------- recovery (manual §40) ---------------- */

  /** Reconcile state after a daemon restart. Lost attempts are recorded; work restarts as new attempts in fresh worktrees. */
  async recover(): Promise<{ missions: string[]; lostAttempts: number; expiredApprovals: number }> {
    let lostAttempts = 0;
    let expiredApprovals = 0;
    for (const a of this.repo.pendingApprovals()) {
      if (this.repo.decideApproval(a.id, 'expired', null)) {
        expiredApprovals++;
        this.emit({ missionId: a.missionId, taskId: a.taskId, type: 'approval.decided', actor: SYSTEM('recovery'), payload: { approvalId: a.id, status: 'expired', reason: 'Daemon restarted while waiting' } });
      }
    }
    for (const a of this.repo.attemptsInState(['starting', 'running'])) {
      lostAttempts++;
      this.repo.updateAttempt(a.id, { state: 'lost', endedAt: nowIso(), error: 'Daemon restarted during the attempt' });
      this.emit({ missionId: a.missionId, taskId: a.taskId, attemptId: a.id, type: 'attempt.ended', actor: SYSTEM('recovery'), payload: { number: a.number, state: 'lost' } });
      const t = this.repo.task(a.taskId);
      if (!t || t.state !== 'running') continue;
      // A subtask belongs to its parent's attempt; the parent restarts and delegates again if it needs to.
      if (t.parentTaskId) this.setTask(t, 'cancelled', { reason: 'Parent attempt lost in a daemon restart' });
      else if (a.number < this.maxAttempts) this.setTask(t, 'ready', { reason: 'Restarting in a fresh worktree after daemon restart' });
      else this.setTask(t, 'failed', { reason: 'Attempt lost and no retries left' });
    }
    for (const t of this.repo.missionsInState(['running']).flatMap((m) => this.repo.tasks(m.id))) {
      if (t.parentTaskId && !TERMINAL_TASK.has(t.state)) this.setTask(t, 'cancelled', { reason: 'Parent attempt lost in a daemon restart' });
    }
    const missions: string[] = [];
    for (const m of this.repo.missionsInState(['planning', 'running', 'verifying'])) {
      if (m.archived) continue;
      missions.push(m.id);
      this.emit({ missionId: m.id, type: 'daemon.recovered', actor: SYSTEM('recovery'), payload: { state: m.state } });
      // Startup must not wait on an external provider or silently repeat a billable request.
      // Offer a deterministic proposal for operator review; explicit replanning can use the model.
      if (m.state === 'planning') await this.plan(m.id, undefined, { skipModel: true });
      else this.kick(m.id); // running: reschedule; verifying: integration and checks re-run deterministically
    }
    return { missions, lostAttempts, expiredApprovals };
  }

  /** Abort everything (daemon shutdown). */
  async shutdown() {
    this.stopping = true;
    for (const id of [...this.terminals.keys()]) await this.closeTerminal(id).catch(() => {});
    for (const ac of this.aborts.values()) ac.abort();
    for (const t of this.budgetTimers.values()) clearTimeout(t);
    await Promise.allSettled(this.running.values());
  }
}
