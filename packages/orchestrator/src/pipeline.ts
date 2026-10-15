// The automated delivery pipeline (ADR 0022). Per repository, the operator can let ATLAS carry an accepted change
// the rest of the way: push it and open the pull request, watch CI, and when CI fails, run a fix mission and push
// the fix to the same pull request, a bounded number of times. Every automatic step is recorded as
// `pipeline.step` by the `pipeline` actor.
//
// What it never does: merge, deploy to production, answer a tool approval (those stay with a person, ToolGate
// unchanged), approve a plan other than a CI fix it started itself, approve a plan with a high-risk task, or accept a
// change that is not verified or has a blocking finding.
import { DEFAULT_PIPELINE, PipelineSettings, type Actor, type AtlasEvent, type Mission } from '@atlas/contracts';
import type { Repo } from '@atlas/storage';
import type { Orchestrator } from './orchestrator';
import { blockingFindings } from './findings';
import { TERMINAL_MISSION } from './states';

export const PIPELINE: Actor = { kind: 'system', component: 'pipeline' };
const settingKey = (workspaceId: string) => `pipeline.${workspaceId}`;

export class Pipeline {
  private readonly busy = new Set<string>();
  /** Runs started by the pipeline (tests await them). */
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly orch: Orchestrator, private readonly repo: Repo) {
    repo.onEvent((e) => this.on(e));
  }

  settings(workspaceId: string): PipelineSettings {
    const r = PipelineSettings.safeParse(this.repo.setting<unknown>(settingKey(workspaceId), {}));
    return r.success ? r.data : DEFAULT_PIPELINE;
  }

  setSettings(workspaceId: string, patch: Partial<PipelineSettings>): PipelineSettings {
    const next = PipelineSettings.parse({ ...this.settings(workspaceId), ...patch });
    this.repo.setSetting(settingKey(workspaceId), next);
    return next;
  }

  /** Wait for automatic steps in flight (and the ones they trigger). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private on(e: AtlasEvent) {
    if (!['mission.decision', 'forge.ci', 'mission.state'].includes(e.type)) return;
    // Let the action that emitted the event finish first (state written, response returned).
    const p = new Promise<void>((r) => setImmediate(r)).then(() => this.handle(e)).catch((err: Error) => {
      try { if (this.repo.mission(e.missionId)) this.note(e.missionId, 'error', false, `Automatic step failed: ${err.message.slice(0, 300)}`); } catch { /* storage closed: nothing left to record into */ }
    });
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private note(missionId: string, step: string, ok: boolean, text: string, extra: Record<string, unknown> = {}) {
    this.repo.append({ missionId, taskId: null, attemptId: null, type: 'pipeline.step', actor: PIPELINE, payload: { step, ok, text, ...extra }, artifactIds: [] });
  }

  private startedByPipeline(m: Mission) {
    const first = this.repo.eventsSince(m.id, 0, 1)[0];
    return first?.type === 'mission.created' && first.actor.kind === 'system' && first.actor.component === 'pipeline';
  }

  private async once(key: string, fn: () => Promise<void>) {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try { await fn(); } finally { this.busy.delete(key); }
  }

  private async handle(e: AtlasEvent) {
    const m = this.repo.mission(e.missionId);
    if (!m || m.archived) return;
    const s = this.settings(m.workspaceId);

    if (e.type === 'mission.decision' && e.payload.decision === 'accept') {
      // A fix the pipeline accepted is always pushed: that is the point of running it.
      if (!s.autoPublish && !(m.followUp && this.startedByPipeline(m) && s.fixCi === 'auto')) return;
      await this.once(`publish:${m.id}`, async () => {
        const view = await this.orch.forgeView(m.id);
        if (view.published?.headSha === m.integrationCommit) return;
        if (view.blocker) { this.note(m.id, 'publish', false, `Not published automatically: ${view.blocker}`); return; }
        const v = await this.orch.publish(m.id, undefined, PIPELINE);
        this.note(m.id, 'publish', true, `Pushed ${v.published!.branch} and ${v.published!.created ? 'opened' : 'updated'} pull request #${v.published!.number}.`, { number: v.published!.number });
      });
      return;
    }

    if (e.type === 'forge.ci') {
      const state = String(e.payload.state);
      const number = Number(e.payload.number);
      const head = String(e.payload.headSha);
      if (state === 'success') {
        this.note(m.id, 'ready', true, `CI passed on #${number}: ready to merge. ATLAS does not merge; a person does.`, { number, headSha: head });
        // The CI fix chain is done: tell the mission it fixed, too.
        if (m.followUp) this.note(m.followUp.parentMissionId, 'ready', true, `CI passed on #${number} after the fix in “${m.title}”: ready to merge.`, { number, headSha: head });
        return;
      }
      if (state !== 'failure' || s.fixCi === 'off') return;
      await this.once(`fix:${number}:${head}`, async () => {
        const view = await this.orch.forgeView(m.id);
        if (!view.canFixCi) return;
        const all = this.repo.missions(m.workspaceId).filter((x) => x.followUp?.pullRequest === number);
        // One fix at a time per head: a fix already running (or waiting for a person) is not duplicated.
        if (all.some((x) => x.followUp!.headSha === head && !TERMINAL_MISSION.has(x.state))) return;
        if (all.some((x) => x.followUp!.headSha === head && x.decision === null && x.state === 'completed')) return;
        const rounds = all.filter((x) => this.startedByPipeline(x)).length;
        if (rounds >= s.maxFixRounds) {
          this.note(m.id, 'stopped', false, `CI still fails on #${number} after ${rounds} automatic fix${rounds === 1 ? '' : 'es'}. A person needs to look.`, { number });
          return;
        }
        const follow = await this.orch.fixCi(m.id, PIPELINE);
        const round = rounds + 1;
        this.note(m.id, 'fix', true, `CI failed on #${number}: started fix mission ${follow.id} (round ${round} of ${s.maxFixRounds}).`, { number, followUp: follow.id, round });
        this.note(follow.id, 'fix', true, `Started by the pipeline to fix CI on #${number} (round ${round} of ${s.maxFixRounds}).`, { number, round });
        const planned = await this.orch.plan(follow.id);
        if (s.fixCi !== 'auto' || planned.state !== 'awaiting_approval') {
          if (planned.state === 'awaiting_approval') this.note(follow.id, 'plan', false, 'Plan ready: waiting for a person to approve it.');
          return;
        }
        const plan = this.repo.plan(follow.id, planned.planVersion)!.plan;
        const high = plan.tasks.filter((t) => t.risk === 'high');
        if (high.length) {
          this.note(follow.id, 'plan', false, `Plan not approved automatically: ${high.map((t) => t.key).join(', ')} ${high.length === 1 ? 'is' : 'are'} high-risk. A person needs to approve it.`);
          return;
        }
        await this.orch.approvePlan(follow.id, PIPELINE);
        this.note(follow.id, 'plan', true, `Plan v${plan.version} approved automatically: a CI fix with no high-risk task. Risky commands still ask a person.`);
      });
      return;
    }

    if (e.type === 'mission.state' && (e.payload.to === 'completed' || e.payload.to === 'failed')) {
      if (!m.followUp || s.fixCi !== 'auto' || !this.startedByPipeline(m)) return;
      await this.once(`accept:${m.id}`, async () => {
        const cur = this.repo.mission(m.id)!;
        if (cur.decision) return;
        if (!s.autoAcceptFixes) { this.note(m.id, 'accept', false, 'Fix finished: waiting for a person to accept it (automatic acceptance is off).'); return; }
        if (cur.verdict !== 'verified') { this.note(m.id, 'accept', false, `Not accepted automatically: the fix is ${cur.verdict ?? 'not verified'}. A person needs to look.`); return; }
        const blocking = blockingFindings(this.repo.findings(m.id));
        if (blocking.length) { this.note(m.id, 'accept', false, `Not accepted automatically: ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} (${blocking[0].title}).`); return; }
        await this.orch.decide(m.id, 'accept', PIPELINE);
        this.note(m.id, 'accept', true, 'Accepted automatically: verified, no blocking finding.');
      });
    }
  }
}
