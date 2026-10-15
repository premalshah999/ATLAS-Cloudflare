import path from 'node:path';
import type { AgentRuntime, AtlasEvent, Mission, MissionBudget, PlanRequest, ReleaseStage } from '@atlas/contracts';
import { ArtifactStore, openDb, Repo } from '@atlas/storage';
import { Orchestrator, type Executors, type OrchestratorOptions } from '@atlas/orchestrator';
import { FakeRuntime, sampleSlugifyScript, type FakeScript } from '@atlas/runtime-fake';
import { tmpDir } from '../helpers';

export function makeOrchestrator(opts: { scripts?: FakeScript[]; runtime?: AgentRuntime; executors?: Executors; dataDir?: string; approvalTtlMs?: number; planner?: (req: PlanRequest) => unknown; stages?: ReleaseStage[]; toolFactories?: OrchestratorOptions['toolFactories']; stallAfterMs?: number; diskFree?: (dir: string) => number; skillsDir?: string; runtimeKind?: 'fake' | 'pi'; forge?: OrchestratorOptions['forge']; mcp?: OrchestratorOptions['mcp']; web?: OrchestratorOptions['web']; publishGate?: OrchestratorOptions['publishGate'] } = {}) {
  const dataDir = opts.dataDir ?? tmpDir('atlas-data-');
  const db = openDb(path.join(dataDir, 'atlas.db'));
  const repo = new Repo(db);
  const artifacts = new ArtifactStore(db, path.join(dataDir, 'artifacts'));
  const runtime = opts.runtime ?? new FakeRuntime(opts.scripts ?? [sampleSlugifyScript], 0, opts.planner);
  const orch = new Orchestrator({ repo, artifacts, runtimes: { [opts.runtimeKind ?? 'fake']: runtime }, worktreeDir: path.join(dataDir, 'worktrees'), executors: opts.executors, approvalTtlMs: opts.approvalTtlMs, stages: opts.stages, toolFactories: opts.toolFactories, factsDir: path.join(dataDir, 'facts'), stallAfterMs: opts.stallAfterMs, diskFree: opts.diskFree, skillDirs: { bundled: opts.skillsDir, operator: path.join(dataDir, 'skills') }, forge: opts.forge, mcp: opts.mcp, web: opts.web, publishGate: opts.publishGate });
  const events: AtlasEvent[] = [];
  repo.onEvent((e) => events.push(e));
  return { orch, repo, artifacts, db, dataDir, events };
}

export async function waitFor<T>(fn: () => T | undefined | null | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function startMission(h: ReturnType<typeof makeOrchestrator>, root: string, over: Partial<Pick<Mission, 'approvalMode' | 'goal' | 'runtime'>> & { budget?: Partial<MissionBudget>; targetEnvironment?: string } = {}) {
  const ws = await h.orch.registerWorkspace(root);
  const m = h.orch.createMission({ workspaceId: ws.id, title: 'Fix slugify', goal: over.goal ?? 'Make slugify produce valid URL slugs.', constraints: '', approvalMode: over.approvalMode ?? 'ask_risky', runtime: over.runtime ?? 'fake', budget: over.budget, targetEnvironment: over.targetEnvironment });
  await h.orch.plan(m.id);
  await h.orch.approvePlan(m.id);
  return m.id;
}

/** Approve (or deny) every pending approval for a tool while the returned stop() is not called. */
export function autoDecide(h: ReturnType<typeof makeOrchestrator>, missionId: string, tool: string, decision: 'approve' | 'deny' = 'approve') {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    for (const a of h.repo.approvals(missionId)) if (a.status === 'pending' && a.tool === tool) { try { h.orch.respondApproval(a.id, decision); } catch { /* raced */ } }
    setTimeout(tick, 25);
  };
  tick();
  return () => { stopped = true; };
}

/** Failed checks with their reason and output tail: the assertion message when a platform fails a mission. */
export function explainChecks(h: ReturnType<typeof makeOrchestrator>, missionId: string): string {
  const checks = h.repo.checks(missionId).filter((c) => c.result !== 'pass').map((c) => {
    const out = c.artifactId ? h.artifacts.read(c.artifactId).text.slice(-1500) : '';
    return `[${c.name}: ${c.result}] ${c.command ?? ''}\n${c.reason}\n${out}`;
  }).join('\n---\n') || '(all checks passed)';
  // A failed task fails the mission without a failed check; name it and its last error so CI logs say why.
  const failed = h.repo.tasks(missionId).filter((t) => t.state === 'failed').map((t) => {
    const last = h.repo.attempts(missionId).filter((a) => a.taskId === t.id).at(-1);
    return `[task ${t.key} (${t.role}): ${t.state}] ${last?.error ?? ''}`;
  });
  return failed.length ? `${checks}\n---\n${failed.join('\n')}` : checks;
}
