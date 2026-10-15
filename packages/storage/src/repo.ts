// Typed persistence for the domain model. State-machine rules live in @atlas/orchestrator; this layer only stores.
import { DEFAULT_BUDGET, nowIso, redactDeep, type Approval, type Attempt, type AtlasEvent, type CheckRecord, type Deployment, type Finding, type Mission, type NewEvent, type Plan, type ProcessJournal, type Task, type Workspace } from '@atlas/contracts';
import { tx, type Db } from './db';

type Row = Record<string, any>;
const j = (v: unknown) => JSON.stringify(v);
const p = <T>(v: string): T => JSON.parse(v) as T;

const toEvent = (r: Row): AtlasEvent => ({
  missionId: r.mission_id, seq: r.seq, type: r.type, ts: r.ts, actor: p(r.actor), taskId: r.task_id, attemptId: r.attempt_id, payload: p(r.payload), artifactIds: p(r.artifact_ids),
});

export class Repo {
  private listeners = new Set<(e: AtlasEvent) => void>();
  constructor(readonly db: Db) {}

  /* ---------- events: append-only, monotonic per mission ---------- */
  onEvent(fn: (e: AtlasEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  append(e: NewEvent): AtlasEvent {
    const ev = tx(this.db, () => {
      const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE mission_id = ?').get(e.missionId) as { s: number };
      const full: AtlasEvent = { ...e, seq: r.s + 1, ts: e.ts ?? nowIso(), payload: redactDeep(e.payload) };
      this.db.prepare('INSERT INTO events (mission_id, seq, type, ts, actor, task_id, attempt_id, payload, artifact_ids) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(full.missionId, full.seq, full.type, full.ts, j(full.actor), full.taskId, full.attemptId, j(full.payload), j(full.artifactIds));
      return full;
    });
    for (const l of this.listeners) { try { l(ev); } catch { /* a listener never breaks the log */ } }
    return ev;
  }

  eventsSince(missionId: string, afterSeq: number, limit = 2000): AtlasEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE mission_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(missionId, afterSeq, limit) as Row[]).map(toEvent);
  }

  /**
   * A mission's events chosen in SQL by type, task or attempt, oldest first. `last` keeps only the newest n. Without
   * `last` every match is returned: a filter, never a silent cap (reading a whole log and filtering in memory dropped
   * everything after its first 100,000 events).
   */
  events(missionId: string, f: { types?: readonly string[]; taskId?: string; attemptId?: string; last?: number } = {}): AtlasEvent[] {
    const where = ['mission_id = ?'];
    const args: (string | number)[] = [missionId];
    if (f.types?.length) { where.push(`type IN (${f.types.map(() => '?').join(',')})`); args.push(...f.types); }
    if (f.taskId) { where.push('task_id = ?'); args.push(f.taskId); }
    if (f.attemptId) { where.push('attempt_id = ?'); args.push(f.attemptId); }
    const sql = `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ${f.last ? 'DESC LIMIT ?' : 'ASC'}`;
    if (f.last) args.push(f.last);
    const rows = (this.db.prepare(sql).all(...args) as Row[]).map(toEvent);
    return f.last ? rows.reverse() : rows;
  }

  /** The newest event of a type, or null. */
  lastEvent(missionId: string, type: string): AtlasEvent | null { return this.events(missionId, { types: [type], last: 1 })[0] ?? null; }

  /** Per skill: the missions that loaded it, and how many of those ended verified or failed (ADR 0029). */
  skillUsage(): Record<string, { missions: number; verified: number; failed: number }> {
    const rows = this.db.prepare(`SELECT json_extract(e.payload, '$.skill') AS skill, e.mission_id AS mission, m.verdict AS verdict
      FROM events e JOIN missions m ON m.id = e.mission_id WHERE e.type = 'skill.loaded' GROUP BY skill, mission`).all() as Row[];
    const out: Record<string, { missions: number; verified: number; failed: number }> = {};
    for (const r of rows) {
      if (!r.skill) continue;
      const u = (out[r.skill] ??= { missions: 0, verified: 0, failed: 0 });
      u.missions++;
      if (r.verdict === 'verified') u.verified++;
      else if (r.verdict === 'failed') u.failed++;
    }
    return out;
  }

  /** How many events of a type a mission has, counted in SQL. */
  countEvents(missionId: string, type: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE mission_id = ? AND type = ?').get(missionId, type) as Row).n);
  }

  /** The sequence number of a mission's newest event (0 when it has none). */
  lastSeq(missionId: string): number {
    return Number((this.db.prepare('SELECT MAX(seq) AS s FROM events WHERE mission_id = ?').get(missionId) as Row | undefined)?.s ?? 0);
  }

  /* ---------- process journal (orphan reaping after a crash) ---------- */
  processJournal(): ProcessJournal {
    return {
      add: (e) => { this.db.prepare('INSERT OR REPLACE INTO process_journal (pid, identity, kind, command, started_at) VALUES (?,?,?,?,?)').run(e.pid, e.identity, e.kind, e.command.slice(0, 500), e.startedAt); },
      remove: (pid, identity) => { this.db.prepare('DELETE FROM process_journal WHERE pid = ? AND identity = ?').run(pid, identity); },
      list: () => (this.db.prepare('SELECT * FROM process_journal ORDER BY started_at').all() as Row[]).map((r) => ({ pid: r.pid, identity: r.identity, kind: r.kind, command: r.command, startedAt: r.started_at })),
      clear: () => { this.db.prepare('DELETE FROM process_journal').run(); },
    };
  }

  /* ---------- settings (operator preferences, never secrets) ---------- */
  setting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : fallback;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(value), nowIso());
  }
  settings(): Record<string, unknown> {
    return Object.fromEntries((this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((r) => [r.key, JSON.parse(r.value)]));
  }

  /* ---------- workspaces ---------- */
  upsertWorkspace(w: Workspace): Workspace {
    this.db.prepare(`INSERT INTO workspaces (id, name, root, is_git, branch, head, dirty, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(root) DO UPDATE SET name=excluded.name, is_git=excluded.is_git, branch=excluded.branch, head=excluded.head, dirty=excluded.dirty, updated_at=excluded.updated_at`)
      .run(w.id, w.name, w.root, w.isGit ? 1 : 0, w.branch, w.head, w.dirty, w.createdAt, w.updatedAt);
    return this.workspaceByRoot(w.root)!;
  }
  workspace(id: string): Workspace | null { const r = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined; return r ? toWorkspace(r) : null; }
  workspaceByRoot(root: string): Workspace | null { const r = this.db.prepare('SELECT * FROM workspaces WHERE root = ?').get(root) as Row | undefined; return r ? toWorkspace(r) : null; }
  workspaces(): Workspace[] { return (this.db.prepare('SELECT * FROM workspaces ORDER BY updated_at DESC').all() as Row[]).map(toWorkspace); }

  /* ---------- missions ---------- */
  insertMission(m: Mission) {
    this.db.prepare(`INSERT INTO missions (id, workspace_id, title, goal, constraints, approval_mode, runtime, base_commit, state, plan_version, policy_id, outcome, decision, budget, integration_branch, integration_commit, archived, target_environment, verdict, follow_up, model, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(m.id, m.workspaceId, m.title, m.goal, m.constraints, m.approvalMode, m.runtime, m.baseCommit, m.state, m.planVersion, m.policyId, m.outcome, m.decision, j(m.budget), m.integrationBranch, m.integrationCommit, m.archived ? 1 : 0, m.targetEnvironment ?? null, m.verdict ?? null, m.followUp ? j(m.followUp) : null, m.model ?? null, m.createdAt, m.updatedAt);
  }
  updateMission(id: string, patch: Partial<Pick<Mission, 'state' | 'planVersion' | 'baseCommit' | 'outcome' | 'decision' | 'integrationBranch' | 'integrationCommit' | 'verdict'>>) {
    const cols: Record<string, string> = { state: 'state', planVersion: 'plan_version', baseCommit: 'base_commit', outcome: 'outcome', decision: 'decision', integrationBranch: 'integration_branch', integrationCommit: 'integration_commit', verdict: 'verdict' };
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sql = `UPDATE missions SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => patch[k] as any), nowIso(), id);
  }
  mission(id: string): Mission | null { const r = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as Row | undefined; return r ? toMission(r) : null; }
  missions(workspaceId?: string): Mission[] {
    const rows = workspaceId ? this.db.prepare('SELECT * FROM missions WHERE workspace_id = ? ORDER BY updated_at DESC').all(workspaceId) : this.db.prepare('SELECT * FROM missions ORDER BY updated_at DESC').all();
    return (rows as Row[]).map(toMission);
  }
  missionsInState(states: string[]): Mission[] {
    return (this.db.prepare(`SELECT * FROM missions WHERE state IN (${states.map(() => '?').join(',')})`).all(...states) as Row[]).map(toMission);
  }

  /* ---------- plans: revisions are kept, never overwritten ---------- */
  insertPlan(missionId: string, plan: Plan, status: 'proposed' | 'approved' | 'rejected') {
    this.db.prepare('INSERT INTO plans (mission_id, version, body, status, created_at) VALUES (?,?,?,?,?)').run(missionId, plan.version, j(plan), status, nowIso());
  }
  setPlanStatus(missionId: string, version: number, status: 'approved' | 'rejected') {
    this.db.prepare('UPDATE plans SET status = ? WHERE mission_id = ? AND version = ?').run(status, missionId, version);
  }
  plan(missionId: string, version?: number): { plan: Plan; status: string } | null {
    const r = (version
      ? this.db.prepare('SELECT * FROM plans WHERE mission_id = ? AND version = ?').get(missionId, version)
      : this.db.prepare('SELECT * FROM plans WHERE mission_id = ? ORDER BY version DESC LIMIT 1').get(missionId)) as Row | undefined;
    return r ? { plan: p<Plan>(r.body), status: r.status } : null;
  }

  /* ---------- tasks & attempts ---------- */
  insertTask(t: Task) {
    this.db.prepare('INSERT INTO tasks (id, mission_id, key, title, role, dependencies, state, retries, acceptance, result_ref, worktree, branch, checkpoint, parent_task_id, depth) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, t.missionId, t.key, t.title, t.role, j(t.dependencies), t.state, t.retries, j(t.acceptance), t.resultRef, t.worktree, t.branch, t.checkpoint, t.parentTaskId, t.depth);
  }
  updateTask(id: string, patch: Partial<Pick<Task, 'state' | 'retries' | 'resultRef' | 'worktree' | 'branch' | 'checkpoint'>>) {
    const cols: Record<string, string> = { state: 'state', retries: 'retries', resultRef: 'result_ref', worktree: 'worktree', branch: 'branch', checkpoint: 'checkpoint' };
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE tasks SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] as any), id);
  }
  task(id: string): Task | null { const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined; return r ? toTask(r) : null; }
  tasks(missionId: string): Task[] { return (this.db.prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY rowid').all(missionId) as Row[]).map(toTask); }

  insertAttempt(a: Attempt) {
    this.db.prepare('INSERT INTO attempts (id, task_id, mission_id, number, state, runtime, pid, started_at, ended_at, error, tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.taskId, a.missionId, a.number, a.state, a.runtime, a.pid, a.startedAt, a.endedAt, a.error, a.tokens);
  }
  updateAttempt(id: string, patch: Partial<Pick<Attempt, 'state' | 'pid' | 'endedAt' | 'error' | 'tokens'>>) {
    const cols: Record<string, string> = { state: 'state', pid: 'pid', endedAt: 'ended_at', error: 'error', tokens: 'tokens' };
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE attempts SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] as any), id);
  }
  attempts(missionId: string): Attempt[] { return (this.db.prepare('SELECT * FROM attempts WHERE mission_id = ? ORDER BY started_at').all(missionId) as Row[]).map(toAttempt); }
  attemptsInState(states: string[]): Attempt[] {
    return (this.db.prepare(`SELECT * FROM attempts WHERE state IN (${states.map(() => '?').join(',')})`).all(...states) as Row[]).map(toAttempt);
  }

  /* ---------- approvals ---------- */
  insertApproval(a: Approval) {
    this.db.prepare(`INSERT INTO approvals (id, mission_id, task_id, agent_role, tool, capability, action, environment, resources, reason, risk, scope, status, requested_at, expires_at, decided_at, decided_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(a.id, a.missionId, a.taskId, a.agentRole, a.tool, a.capability, a.action, a.environment, j(a.resources), a.reason, a.risk, a.scope, a.status, a.requestedAt, a.expiresAt, a.decidedAt, a.decidedBy);
  }
  /** Decide a pending approval exactly once. Returns false if it was no longer pending. */
  decideApproval(id: string, status: 'approved' | 'denied' | 'expired', by: string | null): boolean {
    const r = this.db.prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").run(status, nowIso(), by, id);
    return Number(r.changes) === 1;
  }
  approval(id: string): Approval | null { const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined; return r ? toApproval(r) : null; }
  approvals(missionId: string): Approval[] { return (this.db.prepare('SELECT * FROM approvals WHERE mission_id = ? ORDER BY requested_at').all(missionId) as Row[]).map(toApproval); }
  pendingApprovals(): Approval[] { return (this.db.prepare("SELECT * FROM approvals WHERE status = 'pending'").all() as Row[]).map(toApproval); }

  /* ---------- findings (manual §29) ---------- */
  /** Insert a finding; a duplicate fingerprint within the mission returns the existing one (deduplication). */
  insertFinding(f: Finding): { finding: Finding; duplicate: boolean } {
    const existing = this.db.prepare('SELECT * FROM findings WHERE mission_id = ? AND fingerprint = ?').get(f.missionId, f.fingerprint) as Row | undefined;
    if (existing) return { finding: toFinding(existing), duplicate: true };
    this.db.prepare(`INSERT INTO findings (id, mission_id, task_id, file, line, end_line, severity, kind, title, observation, recommendation, evidence, reproduction_artifact_id, confidence, status, fingerprint, created_at, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.id, f.missionId, f.taskId, f.file, f.line, f.endLine, f.severity, f.kind, f.title, f.observation, f.recommendation, f.evidence, f.reproductionArtifactId, f.confidence, f.status, f.fingerprint, f.createdAt, f.source ?? 'review');
    return { finding: f, duplicate: false };
  }
  findings(missionId: string): Finding[] { return (this.db.prepare('SELECT * FROM findings WHERE mission_id = ? ORDER BY created_at').all(missionId) as Row[]).map(toFinding); }
  finding(id: string): Finding | null { const r = this.db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as Row | undefined; return r ? toFinding(r) : null; }
  setFindingStatus(id: string, status: Finding['status']) { this.db.prepare('UPDATE findings SET status = ? WHERE id = ?').run(status, id); }

  /** Insert an event exactly as exported (import of an archived mission). */
  insertRawEvent(e: AtlasEvent) {
    this.db.prepare('INSERT INTO events (mission_id, seq, type, ts, actor, task_id, attempt_id, payload, artifact_ids) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(e.missionId, e.seq, e.type, e.ts, j(e.actor), e.taskId, e.attemptId, j(e.payload), j(e.artifactIds));
  }
  setArchived(id: string) { this.db.prepare('UPDATE missions SET archived = 1 WHERE id = ?').run(id); }
  missionsOlderThan(iso: string): Mission[] {
    return (this.db.prepare("SELECT * FROM missions WHERE updated_at < ? AND (decision IS NOT NULL OR archived = 1 OR state = 'cancelled')").all(iso) as Row[]).map(toMission);
  }

  /* ---------- deployments (manual §30–32) ---------- */
  insertDeployment(d: Deployment) {
    this.db.prepare(`INSERT INTO deployments (id, mission_id, target, provider, revision, url, external_id, status, verified, release_dir, previous_id, detail, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.id, d.missionId, d.target, d.provider, d.revision, d.url, d.externalId, d.status, d.verified ? 1 : 0, d.releaseDir, d.previousId, d.detail, d.createdAt, d.updatedAt);
  }
  updateDeployment(id: string, patch: Partial<Pick<Deployment, 'status' | 'url' | 'externalId' | 'verified' | 'detail' | 'releaseDir'>>) {
    const cols: Record<string, string> = { status: 'status', url: 'url', externalId: 'external_id', verified: 'verified', detail: 'detail', releaseDir: 'release_dir' };
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE deployments SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => (k === 'verified' ? (patch[k] ? 1 : 0) : patch[k]) as any), nowIso(), id);
  }
  deployment(id: string): Deployment | null { const r = this.db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as Row | undefined; return r ? toDeployment(r) : null; }
  deployments(filter: { target?: string; missionId?: string } = {}): Deployment[] {
    const where: string[] = []; const args: string[] = [];
    if (filter.target) { where.push('target = ?'); args.push(filter.target); }
    if (filter.missionId) { where.push('mission_id = ?'); args.push(filter.missionId); }
    return (this.db.prepare(`SELECT * FROM deployments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC`).all(...args) as Row[]).map(toDeployment);
  }
  liveDeployment(target: string): Deployment | null {
    const r = this.db.prepare("SELECT * FROM deployments WHERE target = ? AND status = 'live' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(target) as Row | undefined;
    return r ? toDeployment(r) : null;
  }
  lastVerified(target: string, exceptId?: string): Deployment | null {
    const r = this.db.prepare("SELECT * FROM deployments WHERE target = ? AND verified = 1 AND id != ? AND release_dir IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get(target, exceptId ?? '') as Row | undefined;
    return r ? toDeployment(r) : null;
  }

  /* ---------- deletion (manual §43) ---------- */
  /** Remove every row of a mission. Artifact files are removed by the ArtifactStore. */
  deleteMission(id: string) {
    tx(this.db, () => {
      for (const t of ['events', 'findings', 'checks', 'artifacts', 'approvals', 'attempts', 'plans']) this.db.prepare(`DELETE FROM ${t} WHERE mission_id = ?`).run(id);
      // Deployment history belongs to the target; it outlives the mission that produced it.
      this.db.prepare('UPDATE deployments SET mission_id = NULL WHERE mission_id = ?').run(id);
      this.db.prepare('UPDATE tasks SET parent_task_id = NULL WHERE mission_id = ?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE mission_id = ?').run(id);
      this.db.prepare('DELETE FROM missions WHERE id = ?').run(id);
    });
  }

  /* ---------- checks ---------- */
  insertCheck(c: CheckRecord) {
    this.db.prepare('INSERT INTO checks (id, mission_id, name, command, required, result, exit_code, duration_ms, reason, artifact_id, commit_sha) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(c.id, c.missionId, c.name, c.command, c.required ? 1 : 0, c.result, c.exitCode, c.durationMs, c.reason, c.artifactId, c.commit);
  }
  checks(missionId: string): CheckRecord[] {
    return (this.db.prepare('SELECT * FROM checks WHERE mission_id = ? ORDER BY rowid').all(missionId) as Row[]).map((r) => ({
      id: r.id, missionId: r.mission_id, name: r.name, command: r.command, required: !!r.required, result: r.result, exitCode: r.exit_code, durationMs: r.duration_ms, reason: r.reason, artifactId: r.artifact_id, commit: r.commit_sha,
    }));
  }
}

const toWorkspace = (r: Row): Workspace => ({ id: r.id, name: r.name, root: r.root, isGit: !!r.is_git, branch: r.branch, head: r.head, dirty: r.dirty, createdAt: r.created_at, updatedAt: r.updated_at });
const toMission = (r: Row): Mission => ({
  id: r.id, workspaceId: r.workspace_id, title: r.title, goal: r.goal, constraints: r.constraints, approvalMode: r.approval_mode, runtime: r.runtime, baseCommit: r.base_commit,
  state: r.state, planVersion: r.plan_version, policyId: r.policy_id, outcome: r.outcome, decision: r.decision,
  budget: { ...DEFAULT_BUDGET, ...p<object>(r.budget ?? '{}') }, integrationBranch: r.integration_branch ?? null, integrationCommit: r.integration_commit ?? null, archived: !!r.archived,
  targetEnvironment: r.target_environment ?? null, verdict: r.verdict ?? null, followUp: r.follow_up ? p(r.follow_up) : null, model: r.model ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toTask = (r: Row): Task => ({ id: r.id, missionId: r.mission_id, key: r.key, title: r.title, role: r.role, dependencies: p(r.dependencies), state: r.state, retries: r.retries, acceptance: p(r.acceptance), resultRef: r.result_ref, worktree: r.worktree, branch: r.branch, checkpoint: r.checkpoint ?? null, parentTaskId: r.parent_task_id ?? null, depth: r.depth ?? 0 });
const toDeployment = (r: Row): Deployment => ({
  id: r.id, missionId: r.mission_id, target: r.target, provider: r.provider, revision: r.revision, url: r.url, externalId: r.external_id, status: r.status, verified: !!r.verified,
  releaseDir: r.release_dir, previousId: r.previous_id, detail: r.detail, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toFinding = (r: Row): Finding => ({
  id: r.id, missionId: r.mission_id, taskId: r.task_id, file: r.file, line: r.line, endLine: r.end_line, severity: r.severity, kind: r.kind, title: r.title, observation: r.observation,
  recommendation: r.recommendation, evidence: r.evidence, reproductionArtifactId: r.reproduction_artifact_id, confidence: r.confidence, status: r.status, fingerprint: r.fingerprint, createdAt: r.created_at, source: r.source === 'security' ? 'security' : 'review',
});
const toAttempt = (r: Row): Attempt => ({ id: r.id, taskId: r.task_id, missionId: r.mission_id, number: r.number, state: r.state, runtime: r.runtime, pid: r.pid, startedAt: r.started_at, endedAt: r.ended_at, error: r.error, tokens: r.tokens });
const toApproval = (r: Row): Approval => ({
  id: r.id, missionId: r.mission_id, taskId: r.task_id, agentRole: r.agent_role, tool: r.tool, capability: r.capability, action: r.action, environment: r.environment, resources: p(r.resources),
  reason: r.reason, risk: r.risk, scope: r.scope, status: r.status, requestedAt: r.requested_at, expiresAt: r.expires_at, decidedAt: r.decided_at, decidedBy: r.decided_by,
});
