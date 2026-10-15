// The daemon side of team spaces (ADR 0021): one TeamSpace per repository, keeping the operator's shared missions up to
// date in the record, syncing it with the origin, acting on teammates' plan approvals when the operator allowed it,
// gating publishing on owner approval, and running work items assigned to agents when this machine is a runner.
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  AtlasError, pipelineOf, PIPELINE_EVENT_TYPES, redact, SharedMission, TeamSettingsPatch, type Actor, type AtlasEvent, type EntryKind, type Mission, type TeamSettings,
  type TeamSyncStatus, type TeamView,
} from '@atlas/contracts';
import { canonical, gitx, ownership, teamParts, TeamSpace, type TeamState } from '@atlas/team';
import type { Orchestrator, Forge } from '@atlas/orchestrator';
import { parseRemote } from '@atlas/orchestrator';
import type { Repo } from '@atlas/storage';
import type { z } from 'zod';
import type { Logger } from './log';

const DEFAULT_SETTINGS: TeamSettings = { autoSync: true, shareAll: false, acceptPlanApprovals: false, runner: { enabled: false, teams: [], runtime: 'pi', approvalMode: 'ask_risky' } };
const RUNNER: Actor = { kind: 'system', component: 'team-runner' };
const PATCH_MAX = 200_000;
/** Mission events that change what teammates see. */
const SHARED_ON = new Set<AtlasEvent['type']>(['mission.state', 'plan.proposed', 'plan.approved', 'mission.decision', 'forge.published', 'forge.ci', 'pipeline.step', 'task.state']);

export interface TeamHubOptions { repo: Repo; orch: Orchestrator; log: Logger; forge: () => Forge | null }

export class TeamHub {
  private readonly spaces = new Map<string, TeamSpace>();
  private readonly status = new Map<string, TeamSyncStatus>();
  private readonly shareTimers = new Map<string, NodeJS.Timeout>();
  private readonly syncTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastShared = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly o: TeamHubOptions) {
    o.repo.onEvent((e) => this.onMissionEvent(e));
  }

  start() {
    // Background sync only for repositories whose operator turned the team space on here (auto sync is per repository
    // and needs a space); nothing is fetched for repositories without one (§43: no unexplained requests).
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const t of [...this.shareTimers.values(), ...this.syncTimers.values()]) clearTimeout(t);
  }

  // ---- plumbing ----

  private workspace(id: string) {
    const w = this.o.repo.workspace(id);
    if (!w) throw new AtlasError('invalid_request', 'Unknown workspace');
    if (!w.isGit) throw new AtlasError('invalid_request', 'Team spaces live in a git repository');
    return w;
  }

  space(workspaceId: string): TeamSpace {
    let s = this.spaces.get(workspaceId);
    if (!s) {
      const w = this.workspace(workspaceId);
      s = new TeamSpace({ root: w.root, signer: this.o.orch.signer, netEnv: () => this.netEnv(w.root) });
      this.spaces.set(workspaceId, s);
    }
    return s;
  }

  /** ATLAS's GitHub token for a github.com origin (never in arguments); otherwise the operator's own git setup. */
  private async netEnv(root: string): Promise<Record<string, string>> {
    const url = (await gitx(root, ['config', '--get', 'remote.origin.url'])).stdout.trim();
    const forge = this.o.forge();
    return url && parseRemote(url) && forge ? forge.gitEnv() : {};
  }

  settings(workspaceId: string): TeamSettings {
    return { ...DEFAULT_SETTINGS, ...this.o.repo.setting<Partial<TeamSettings>>(`team.settings.${workspaceId}`, {}) };
  }

  setSettings(workspaceId: string, patch: z.infer<typeof TeamSettingsPatch>): TeamSettings {
    const next = { ...this.settings(workspaceId), ...TeamSettingsPatch.parse(patch) };
    this.o.repo.setSetting(`team.settings.${workspaceId}`, next);
    this.o.log.warn('team settings changed', { workspaceId, ...next });
    return next;
  }

  private async identity(root: string) {
    const get = async (k: string) => (await gitx(root, ['config', '--get', k])).stdout.trim() || null;
    return { name: (await get('user.name')) ?? os.userInfo().username ?? 'Me', email: await get('user.email') };
  }

  private shared(): Record<string, string | null> { return this.o.repo.setting<Record<string, string | null>>('team.shared', {}); }

  // ---- view ----

  async view(workspaceId: string): Promise<TeamView> {
    const w = this.workspace(workspaceId);
    const sp = this.space(workspaceId);
    const st = await sp.state();
    const origin = (await gitx(w.root, ['config', '--get', 'remote.origin.url'])).stdout.trim();
    const me = st.members.get(sp.me);
    const id = await this.identity(w.root);
    return {
      workspaceId,
      remote: origin ? redact(origin.replace(/(https?:\/\/)[^@/\s]+@/, '$1***@')) : null,
      me: { keyId: sp.me, name: me?.name ?? id.name, email: me?.email ?? id.email, member: !!me, maintainer: me?.role === 'maintainer', requested: st.joinRequests.has(sp.me) },
      space: st.space,
      ...teamParts(st, sp.me),
      sync: this.status.get(workspaceId) ?? { state: origin ? 'idle' : 'local', at: null, error: null, pulled: 0, pushed: 0 },
      settings: this.settings(workspaceId),
    };
  }

  // ---- writes ----

  async write<K extends EntryKind>(workspaceId: string, kind: K, body: z.input<(typeof import('@atlas/contracts').EntryBodies)[K]>): Promise<string> {
    const { id } = await this.space(workspaceId).write(kind, body);
    this.o.log.info('team entry', { workspaceId, kind, id });
    this.soon(workspaceId);
    return id;
  }

  async create(workspaceId: string, p: { name: string; displayName: string; email?: string }) {
    const sp = this.space(workspaceId);
    // Someone may have started one already: look at the origin first, so two spaces are not started by accident.
    if (await sp.store.origin()) await this.sync(workspaceId).catch(() => {});
    await sp.create(p.name, { name: p.displayName, email: p.email || undefined });
    this.soon(workspaceId, 0);
  }

  async join(workspaceId: string, p: { displayName: string; email?: string; code?: string }) {
    const sp = this.space(workspaceId);
    if (await sp.store.origin()) await this.sync(workspaceId);
    await sp.join({ name: p.displayName, email: p.email || undefined }, p.code || undefined);
    await this.sync(workspaceId).catch(() => {});
  }

  async invite(workspaceId: string, p: { role: 'maintainer' | 'member'; teams: string[]; uses: number; days: number; note?: string }) {
    const r = await this.space(workspaceId).invite(p);
    this.o.log.warn('team invitation created', { workspaceId, id: r.id, role: p.role, uses: p.uses, days: p.days });
    this.soon(workspaceId, 0);
    return r;
  }

  /** Mark one of the operator's missions as shared (and link it to an item); its snapshot follows it from now on. */
  async shareMission(missionId: string, p: { item?: string | null; teams?: string[]; people?: string[] } = {}) {
    const m = this.o.repo.mission(missionId);
    if (!m || m.archived) throw new AtlasError('invalid_request', 'Unknown mission');
    const st = await this.space(m.workspaceId).state();
    if (!st.members.has(this.space(m.workspaceId).me)) throw new AtlasError('invalid_request', 'Join the team space first.');
    const shared = this.shared();
    this.o.repo.setSetting('team.shared', { ...shared, [missionId]: p.item ?? shared[missionId] ?? null });
    if (p.teams || p.people) this.o.repo.setSetting(`team.requested.${missionId}`, { teams: p.teams ?? [], people: p.people ?? [] });
    await this.publishSnapshot(m.id, true);
    this.o.repo.append({ missionId, taskId: null, attemptId: null, type: 'team.shared', actor: { kind: 'operator' }, payload: { item: p.item ?? null, teams: p.teams ?? [], people: p.people ?? [] }, artifactIds: [] });
  }

  async patch(workspaceId: string, missionId: string): Promise<string | null> {
    const st = await this.space(workspaceId).state();
    return st.missions.get(missionId)?.snapshot.patch ?? null;
  }

  /** Approve a teammate's plan as it is shared now (the version and hash the approval binds to). */
  async approvePlan(workspaceId: string, missionId: string) {
    const st = await this.space(workspaceId).state();
    const m = st.missions.get(missionId);
    if (!m?.snapshot.plan) throw new AtlasError('invalid_request', 'That mission has no shared plan.');
    if (!m.snapshot.plan.awaitingApproval) throw new AtlasError('invalid_request', 'That plan is not waiting for approval.');
    await this.write(workspaceId, 'plan.approve', { missionId, planVersion: m.snapshot.plan.version, planHash: m.snapshot.plan.hash });
  }

  // ---- sync ----

  /** Sync soon (coalesced), when auto sync is on. */
  private soon(workspaceId: string, ms = 800) {
    if (this.stopped || !this.settings(workspaceId).autoSync) return;
    clearTimeout(this.syncTimers.get(workspaceId));
    this.syncTimers.set(workspaceId, setTimeout(() => { this.syncTimers.delete(workspaceId); void this.sync(workspaceId).catch(() => {}); }, ms));
  }

  async sync(workspaceId: string): Promise<TeamSyncStatus> {
    const sp = this.space(workspaceId);
    if (!(await sp.store.origin())) {
      const s: TeamSyncStatus = { state: 'local', at: null, error: 'This repository has no origin remote: the team record stays on this machine.', pulled: 0, pushed: 0 };
      this.status.set(workspaceId, s);
      return s;
    }
    const prev = this.status.get(workspaceId);
    this.status.set(workspaceId, { ...(prev ?? { at: null, error: null, pulled: 0, pushed: 0 }), state: 'syncing' });
    try {
      const r = await sp.sync();
      const s: TeamSyncStatus = { state: 'idle', at: new Date().toISOString(), error: null, pulled: r.pulled, pushed: r.pushed };
      this.status.set(workspaceId, s);
      if (r.pulled || r.pushed) this.o.log.info('team synced', { workspaceId, ...r });
      await this.react(workspaceId);
      return s;
    } catch (e) {
      const s: TeamSyncStatus = { state: 'error', at: new Date().toISOString(), error: redact((e as Error).message), pulled: 0, pushed: 0 };
      this.status.set(workspaceId, s);
      throw new AtlasError('network_unavailable', s.error!);
    }
  }

  private async tick() {
    for (const w of this.o.repo.workspaces()) {
      if (this.stopped || !w.isGit || !this.settings(w.id).autoSync) continue;
      try {
        const st = await this.space(w.id).state();
        if (!st.space) continue;
        await this.sync(w.id);
      } catch { /* recorded in the status */ }
    }
  }

  // ---- keeping shared missions current ----

  private onMissionEvent(e: AtlasEvent) {
    if (!SHARED_ON.has(e.type) || this.stopped) return;
    const m = this.o.repo.mission(e.missionId);
    if (!m || m.archived) return;
    const shareAll = this.settings(m.workspaceId).shareAll;
    if (!shareAll && !(e.missionId in this.shared())) return;
    clearTimeout(this.shareTimers.get(e.missionId));
    this.shareTimers.set(e.missionId, setTimeout(() => {
      this.shareTimers.delete(e.missionId);
      // Coalesced: react to the mission as it is now, not to whichever event came last (CI: a task.state event
      // closing the window meant the linked item never moved to review).
      void this.publishSnapshot(e.missionId, false).then(() => this.reactMission(e.missionId)).catch((err: Error) => this.o.log.warn('team share failed', { missionId: e.missionId, error: err.message }));
    }, 600));
  }

  private async snapshot(m: Mission): Promise<SharedMission> {
    const w = this.o.repo.workspace(m.workspaceId)!;
    const plan = m.planVersion ? this.o.repo.plan(m.id, m.planVersion) : null;
    const pub = this.o.repo.lastEvent(m.id, 'forge.published');
    const lastCi = pub ? this.o.repo.lastEvent(m.id, 'forge.ci') : null;
    const ci = lastCi && pub && lastCi.seq > pub.seq ? lastCi : undefined;
    let patch: string | null = null, truncated = false;
    if (m.baseCommit && m.integrationCommit) {
      const d = await gitx(w.root, ['diff', '--no-color', '--no-ext-diff', m.baseCommit, m.integrationCommit]);
      if (d.code === 0) { const red = redact(d.stdout); truncated = red.length > PATCH_MAX; patch = red.slice(0, PATCH_MAX); }
    }
    const requested = this.o.repo.setting<{ teams: string[]; people: string[] }>(`team.requested.${m.id}`, { teams: [], people: [] });
    return SharedMission.parse({
      missionId: m.id, item: this.shared()[m.id] ?? null, title: m.title.slice(0, 200), goal: redact(m.goal).slice(0, 8000), state: m.state, verdict: m.verdict, decision: m.decision,
      runtime: m.runtime, model: m.model ?? null, baseCommit: m.baseCommit, commit: m.integrationCommit,
      files: (await this.o.orch.changedFiles(m.id)).slice(0, 500),
      checks: this.o.repo.checks(m.id).filter((c) => !m.integrationCommit || !c.commit || c.commit === m.integrationCommit).slice(0, 100).map((c) => ({ name: c.name.slice(0, 200), result: c.result, required: c.required })),
      tasks: this.o.repo.tasks(m.id).slice(0, 60).map((t) => ({ key: t.key, title: t.title.slice(0, 200), role: t.role, state: t.state })),
      plan: plan ? { version: plan.plan.version, summary: redact(plan.plan.summary).slice(0, 2000), hash: planHash(plan.plan), awaitingApproval: m.state === 'awaiting_approval' } : null,
      pullRequest: pub ? { number: Number(pub.payload.number), url: String(pub.payload.url), ci: ci ? (String(ci.payload.state) as 'pending') : null } : null,
      pipeline: pipelineOf(m, this.o.repo.events(m.id, { types: PIPELINE_EVENT_TYPES })).summary.slice(0, 200),
      patch, patchTruncated: truncated, requested,
    });
  }

  /** Write a new snapshot when what teammates would see changed. */
  async publishSnapshot(missionId: string, force: boolean) {
    const m = this.o.repo.mission(missionId);
    if (!m) return;
    const sp = this.space(m.workspaceId);
    const st = await sp.state();
    if (!st.space || !st.members.has(sp.me)) return;
    const snap = await this.snapshot(m);
    const digest = createHash('sha256').update(canonical(snap)).digest('hex');
    const known = this.lastShared.get(missionId) ?? (st.missions.get(missionId) ? createHash('sha256').update(canonical(st.missions.get(missionId)!.snapshot)).digest('hex') : null);
    if (!force && digest === known) return;
    await this.write(m.workspaceId, 'mission.share', snap);
    this.lastShared.set(missionId, digest);
    if (!(missionId in this.shared())) this.o.repo.setSetting('team.shared', { ...this.shared(), [missionId]: snap.item });
  }

  // ---- reacting to what teammates did ----

  /** After a sync: teammates' plan approvals and reviews for missions here, and items for this runner. */
  private async react(workspaceId: string) {
    const sp = this.space(workspaceId);
    const st = await sp.state();
    if (!st.space || !st.members.has(sp.me)) return;
    const seen = new Set(this.o.repo.setting<string[]>(`team.seen.${workspaceId}`, []));
    const fresh: string[] = [];
    for (const [missionId, sh] of st.missions) {
      if (sh.author !== sp.me) continue;
      const m = this.o.repo.mission(missionId);
      if (!m || m.archived) continue;
      for (const r of sh.reviews) {
        if (seen.has(r.id)) continue;
        fresh.push(r.id);
        this.o.repo.append({ missionId, taskId: null, attemptId: null, type: 'team.review', actor: this.teammate(st, r.by), payload: { verdict: r.verdict, commit: r.commit, note: r.note, current: r.commit === m.integrationCommit }, artifactIds: [] });
      }
      await this.maybeApprovePlan(workspaceId, st, m);
    }
    if (fresh.length) this.o.repo.setSetting(`team.seen.${workspaceId}`, [...seen, ...fresh].slice(-5000));
    await this.runner(workspaceId, st);
  }

  private async reactMission(missionId: string) {
    const m = this.o.repo.mission(missionId);
    if (!m) return;
    const sp = this.space(m.workspaceId);
    const st = await sp.state();
    await this.maybeApprovePlan(m.workspaceId, st, m);
    await this.followItem(m.workspaceId, st, m);
  }

  private teammate(st: TeamState, keyId: string): Actor {
    return { kind: 'teammate', keyId, name: st.members.get(keyId)?.name ?? st.names.get(keyId) ?? keyId.slice(0, 8) };
  }

  private runnerMissions(workspaceId: string): Record<string, string> { return this.o.repo.setting<Record<string, string>>(`team.runnerMissions.${workspaceId}`, {}); }

  /** A teammate approved the plan that is waiting here, at this exact version and content: start it, if allowed. */
  private async maybeApprovePlan(workspaceId: string, st: TeamState, m: Mission) {
    if (m.state !== 'awaiting_approval') return;
    const allowed = this.settings(workspaceId).acceptPlanApprovals || m.id in this.runnerMissions(workspaceId);
    if (!allowed) return;
    const sh = st.missions.get(m.id);
    const plan = this.o.repo.plan(m.id, m.planVersion);
    if (!sh || !plan) return;
    const hash = planHash(plan.plan);
    const ok = sh.planApprovals.find((a) => a.planVersion === plan.plan.version && a.planHash === hash && st.members.has(a.by));
    if (!ok) return;
    try {
      await this.o.orch.approvePlan(m.id, this.teammate(st, ok.by));
      this.o.log.warn('plan approved by a teammate', { missionId: m.id, by: ok.by, version: plan.plan.version });
    } catch (err) { this.o.log.warn('teammate plan approval not applied', { missionId: m.id, error: (err as Error).message }); }
  }

  /** Items assigned to the agents of this runner's teams: claim one, run it as a mission here, share it. */
  private async runner(workspaceId: string, st: TeamState) {
    const r = this.settings(workspaceId).runner;
    const sp = this.space(workspaceId);
    const mine = this.runnerMissions(workspaceId);
    // Lost a claim race (another runner's claim came first): stop the mission before it does anything.
    for (const [missionId, itemId] of Object.entries(mine)) {
      const it = st.items.get(itemId);
      const m = this.o.repo.mission(missionId);
      if (it && it.assignee !== sp.me && m && ['draft', 'planning', 'awaiting_approval'].includes(m.state)) {
        await this.o.orch.cancelMission(missionId).catch(() => {});
        this.o.log.warn('runner lost the claim; mission cancelled', { missionId, item: itemId });
      }
    }
    if (!r.enabled) return;
    const busy = Object.values(mine).filter((itemId) => st.items.get(itemId)?.status === 'in_progress').length;
    if (busy >= 2) return;
    const next = [...st.items.values()]
      .filter((i) => i.assignee === 'agents' && i.status === 'open' && i.team && r.teams.includes(i.team))
      .sort((a, b) => prio(b.priority) - prio(a.priority) || (a.createdAt < b.createdAt ? -1 : 1))[0];
    if (!next) return;
    const team = st.teams.get(next.team!);
    const m = this.o.orch.createMission({
      workspaceId, title: next.title, goal: next.detail || next.title, constraints: '', approvalMode: r.approvalMode, runtime: r.runtime, model: team?.model ?? null,
    }, RUNNER);
    try {
      await this.write(workspaceId, 'item.claim', { item: next.id, missionId: m.id });
    } catch (err) {
      await this.o.orch.deleteMission(m.id).catch(() => {});
      this.o.log.info('runner could not claim', { item: next.id, error: (err as Error).message });
      return;
    }
    this.o.repo.setSetting(`team.runnerMissions.${workspaceId}`, { ...mine, [m.id]: next.id });
    this.o.repo.setSetting('team.shared', { ...this.shared(), [m.id]: next.id });
    this.o.log.warn('runner picked up an item', { item: next.id, missionId: m.id, team: next.team });
    await this.o.orch.plan(m.id);
    await this.publishSnapshot(m.id, true);
  }

  /** Move a linked item along as its mission does: in review once verified, done when CI passed on its pull request. */
  private async followItem(workspaceId: string, st: TeamState, m: Mission) {
    const itemId = this.shared()[m.id];
    const it = itemId ? st.items.get(itemId) : undefined;
    const sp = this.space(workspaceId);
    if (!it || it.assignee !== sp.me || it.status === 'done' || it.status === 'closed') return;
    const ready = this.o.repo.events(m.id, { types: ['pipeline.step'] }).some((x) => x.payload.step === 'ready');
    const status = ready ? 'done' : m.state === 'completed' && m.verdict === 'verified' && it.status === 'in_progress' ? 'review' : null;
    if (status && status !== it.status) await this.write(workspaceId, 'item.update', { item: it.id, status }).catch(() => {});
  }

  /** Publish gate (ADR 0021): teams owning touched paths must have approved this commit. */
  async gate(m: Mission, files: string[]): Promise<string | null> {
    let sp: TeamSpace;
    try { sp = this.space(m.workspaceId); } catch { return null; }
    const st = await sp.state();
    if (!st.space || !st.members.has(sp.me) || !files.length) return null;
    const reviews = st.missions.get(m.id)?.reviews ?? [];
    const missing = ownership(st, sp.me, files, m.integrationCommit, reviews).filter((o) => !o.approvedBy);
    if (!missing.length) return null;
    const names = missing.map((o) => `${st.teams.get(o.team)?.name ?? o.team} (${o.paths.slice(0, 3).join(', ')}${o.paths.length > 3 ? ', …' : ''})`);
    return `Needs an approving review of this commit from ${names.join(' and ')} in the team space${st.missions.has(m.id) ? '' : ': share the mission with the team to ask for it'}.`;
  }
}

const prio = (p: string) => ({ urgent: 3, high: 2, normal: 1, low: 0 } as Record<string, number>)[p] ?? 1;
export const planHash = (plan: unknown) => createHash('sha256').update(canonical(plan)).digest('hex');
