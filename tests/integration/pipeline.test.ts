// The automated delivery pipeline (ADR 0022), offline: the fake GitHub API and a bare repository standing in for
// github.com, as in forge.test.ts. The pipeline carries an accepted change to a pull request, and turns failed CI into
// a fix pushed to the same pull request, within the limits the operator set, and never past them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { PlanRequest } from '@atlas/contracts';
import { GitHubForge } from '@atlas/orchestrator';
import { forTask, sampleSlugifyScript } from '@atlas/runtime-fake';
import { sampleRepo, tmpDir } from '../helpers';
import { explainChecks, makeOrchestrator, startMission } from './harness';
import { FakeGitHub } from './fake-github';

const TOKEN = 'ghp_test_token_123456';
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

let gh: FakeGitHub;
beforeEach(async () => { gh = await new FakeGitHub().start(); });
afterEach(async () => { await gh.close(); });

function setup(opts: { planner?: (r: PlanRequest) => unknown; publishGate?: NonNullable<Parameters<typeof makeOrchestrator>[0]>['publishGate'] } = {}) {
  const root = sampleRepo();
  const bare = path.join(tmpDir(), 'app.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  sh(root, 'push', '-q', bare, 'main');
  sh(root, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  sh(root, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git');
  const forge = new GitHubForge({ token: TOKEN, apiBase: gh.url });
  const h = makeOrchestrator({
    forge: () => forge, planner: opts.planner, publishGate: opts.publishGate,
    scripts: [sampleSlugifyScript, forTask('implement', [{ tool: 'write_file', args: { path: 'CI.md', content: 'lint fixed\n' } }, { claim: 'Fixed the lint failure.' }])],
  });
  return { root, bare, h };
}

/** Let the pipeline and every mission it started run to rest. */
async function drain(h: ReturnType<typeof makeOrchestrator>) {
  for (let i = 0; i < 20; i++) {
    await h.orch.pipeline.idle();
    await Promise.all(h.repo.missions().map((m) => h.orch.settle(m.id)));
    await h.orch.pipeline.idle();
    if (!h.repo.missions().some((m) => ['planning', 'running', 'verifying'].includes(m.state))) return;
  }
}

const steps = (h: ReturnType<typeof makeOrchestrator>, missionId?: string) => h.events.filter((e) => e.type === 'pipeline.step' && (!missionId || e.missionId === missionId));
const lint = (id: number) => ({ id, name: 'lint', status: 'completed', conclusion: 'failure', title: 'eslint found 1 error', log: 'src/slugify.js:3 error no-unused-vars' });

describe('automated delivery pipeline (ADR 0022)', () => {
  it('publishes on acceptance, fixes failing CI on the same pull request, and stops at ready to merge', async () => {
    const { root, bare, h } = setup();
    const ws = await h.orch.registerWorkspace(root);
    h.orch.pipeline.setSettings(ws.id, { autoPublish: true, fixCi: 'auto', autoAcceptFixes: true, maxFixRounds: 2 });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    expect(h.repo.mission(id)!.verdict, explainChecks(h, id)).toBe('verified');
    // Nothing moves before a person accepts.
    await drain(h);
    expect(gh.pulls).toHaveLength(0);

    await h.orch.decide(id, 'accept');
    await drain(h);
    const m = h.repo.mission(id)!;
    expect(gh.pulls).toHaveLength(1);
    expect(sh(bare, 'rev-parse', `refs/heads/${m.integrationBranch}`)).toBe(m.integrationCommit);
    const pub = h.events.find((e) => e.missionId === id && e.type === 'forge.published')!;
    expect(pub.actor).toEqual({ kind: 'system', component: 'pipeline' });
    expect(steps(h, id).map((e) => e.payload.step)).toEqual(['publish']);

    // CI fails: a fix mission starts from the pull request head, is planned and approved by the pipeline, runs,
    // verifies, is accepted and fast-forwards the same pull request.
    gh.checks.set(m.integrationCommit!, [lint(8)]);
    await h.orch.ciRefresh(id);
    await drain(h);
    const fix = h.repo.missions().find((x) => x.followUp?.parentMissionId === id)!;
    expect(fix.followUp).toMatchObject({ pullRequest: 41, headSha: m.integrationCommit });
    expect(h.repo.mission(fix.id)!.decision, explainChecks(h, fix.id)).toBe('accepted');
    const fixed = h.repo.mission(fix.id)!;
    expect(sh(bare, 'rev-parse', `refs/heads/${m.integrationBranch}`)).toBe(fixed.integrationCommit);
    expect(gh.pulls).toHaveLength(1);
    expect(steps(h, fix.id).map((e) => [e.payload.step, e.payload.ok])).toEqual([['fix', true], ['plan', true], ['accept', true], ['publish', true]]);
    for (const t of ['plan.approved', 'mission.decision', 'forge.published'] as const) {
      expect(h.events.find((e) => e.missionId === fix.id && e.type === t)!.actor).toEqual({ kind: 'system', component: 'pipeline' });
    }

    // CI passes on the fix: ready to merge, on both missions. ATLAS does not merge.
    gh.checks.set(fixed.integrationCommit!, [{ id: 9, name: 'lint', status: 'completed', conclusion: 'success' }]);
    await h.orch.ciRefresh(fix.id);
    await drain(h);
    expect(steps(h, fix.id).at(-1)!.payload).toMatchObject({ step: 'ready', ok: true });
    expect(steps(h, id).at(-1)!.payload.text).toMatch(/ready to merge/);
    expect(gh.requests.some((r) => /merge/.test(r.path))).toBe(false);
    expect(gh.pulls[0].state).toBe('open');
  }, 240_000);

  it('stops after the configured number of fix rounds and asks a person', async () => {
    const { root, h } = setup();
    const ws = await h.orch.registerWorkspace(root);
    h.orch.pipeline.setSettings(ws.id, { autoPublish: true, fixCi: 'auto', autoAcceptFixes: true, maxFixRounds: 1 });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    await h.orch.decide(id, 'accept');
    await drain(h);
    gh.checks.set(h.repo.mission(id)!.integrationCommit!, [lint(8)]);
    await h.orch.ciRefresh(id);
    await drain(h);
    const fix = h.repo.missions().find((x) => x.followUp?.parentMissionId === id)!;
    const fixed = h.repo.mission(fix.id)!;
    expect(fixed.decision, explainChecks(h, fix.id)).toBe('accepted');
    // The fix did not fix it.
    gh.checks.set(fixed.integrationCommit!, [lint(12)]);
    await h.orch.ciRefresh(fix.id);
    await drain(h);
    expect(h.repo.missions().filter((x) => x.followUp)).toHaveLength(1);
    expect(steps(h, fix.id).at(-1)!.payload).toMatchObject({ step: 'stopped', ok: false });
    expect(steps(h, fix.id).at(-1)!.payload.text).toMatch(/after 1 automatic fix\. A person needs to look/);
  }, 240_000);

  it('never approves a high-risk plan, never answers a tool approval, and never accepts without permission', async () => {
    // A planner that proposes a high-risk task for CI fixes.
    const planner = (r: PlanRequest) => /Fix CI/.test(r.title)
      ? { version: 1, summary: 'Rewrite the CI config', scope: 'ci', tasks: [{ key: 'implement', title: 'Rewrite CI', role: 'coder', acceptance: ['CI passes'], tools: ['write_file'], risk: 'high', rollback: 'git revert' }], verification: [] }
      : null;
    const a = setup({ planner });
    const wsA = await a.h.orch.registerWorkspace(a.root);
    a.h.orch.pipeline.setSettings(wsA.id, { autoPublish: true, fixCi: 'auto', autoAcceptFixes: true });
    const idA = await startMission(a.h, a.root);
    await a.h.orch.settle(idA);
    await a.h.orch.decide(idA, 'accept');
    await drain(a.h);
    gh.checks.set(a.h.repo.mission(idA)!.integrationCommit!, [lint(8)]);
    await a.h.orch.ciRefresh(idA);
    await drain(a.h);
    const fixA = a.h.repo.missions().find((x) => x.followUp)!;
    expect(a.h.repo.mission(fixA.id)!.state).toBe('awaiting_approval');
    expect(steps(a.h, fixA.id).at(-1)!.payload.text).toMatch(/implement is high-risk/);

    // Writes need approval in this mission: the pipeline approves the plan, but the write waits for a person.
    const b = setup();
    const wsB = await b.h.orch.registerWorkspace(b.root);
    b.h.orch.pipeline.setSettings(wsB.id, { autoPublish: true, fixCi: 'auto', autoAcceptFixes: true });
    const idB = await startMission(b.h, b.root, { approvalMode: 'ask_all_writes' });
    // The first mission's writes are approved by the operator (this test's stand-in).
    const stop = (() => { let on = true; const tick = () => { if (!on) return; for (const ap of b.h.repo.approvals(idB)) if (ap.status === 'pending') { try { b.h.orch.respondApproval(ap.id, 'approve'); } catch { /* raced */ } } setTimeout(tick, 25); }; tick(); return () => { on = false; }; })();
    await b.h.orch.settle(idB);
    stop();
    await b.h.orch.decide(idB, 'accept');
    await drain(b.h);
    gh.checks.set(b.h.repo.mission(idB)!.integrationCommit!, [lint(8)]);
    await b.h.orch.ciRefresh(idB);
    await b.h.orch.pipeline.idle();
    const fixB = b.h.repo.missions().find((x) => x.followUp)!;
    for (let i = 0; i < 200 && !b.h.repo.approvals(fixB.id).length; i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 500));
    expect(b.h.repo.approvals(fixB.id).map((x) => x.status)).toEqual(['pending']);
    expect(b.h.events.filter((e) => e.type === 'approval.decided' && e.missionId === fixB.id)).toEqual([]);
    await b.h.orch.cancelMission(fixB.id);

    // Automatic acceptance off: a verified fix waits for the operator.
    const c = setup();
    const wsC = await c.h.orch.registerWorkspace(c.root);
    c.h.orch.pipeline.setSettings(wsC.id, { autoPublish: true, fixCi: 'auto', autoAcceptFixes: false });
    const idC = await startMission(c.h, c.root);
    await c.h.orch.settle(idC);
    await c.h.orch.decide(idC, 'accept');
    await drain(c.h);
    gh.checks.set(c.h.repo.mission(idC)!.integrationCommit!, [lint(8)]);
    await c.h.orch.ciRefresh(idC);
    await drain(c.h);
    const fixC = c.h.repo.missions().find((x) => x.followUp)!;
    expect(c.h.repo.mission(fixC.id)!.verdict).toBe('verified');
    expect(c.h.repo.mission(fixC.id)!.decision).toBeNull();
    expect(steps(c.h, fixC.id).at(-1)!.payload.text).toMatch(/waiting for a person to accept/);
    expect(gh.pulls).toHaveLength(3);
  }, 300_000);


  it('does nothing when off, only proposes in propose mode, and records why a publish was held back', async () => {
    const { root, h } = setup();
    const ws = await h.orch.registerWorkspace(root);
    const id = await startMission(h, root);
    await h.orch.settle(id);
    await h.orch.decide(id, 'accept');
    await drain(h);
    expect(gh.pulls).toHaveLength(0);
    expect(steps(h)).toEqual([]);

    await h.orch.publish(id);
    h.orch.pipeline.setSettings(ws.id, { fixCi: 'propose' });
    gh.checks.set(h.repo.mission(id)!.integrationCommit!, [lint(8)]);
    await h.orch.ciRefresh(id);
    await drain(h);
    const fix = h.repo.missions().find((x) => x.followUp)!;
    expect(h.repo.mission(fix.id)!.state).toBe('awaiting_approval');
    expect(steps(h, fix.id).at(-1)!.payload.text).toMatch(/waiting for a person to approve/);

    // A publish gate (owner approval, ADR 0021) holds an automatic publish back, with the reason recorded.
    let files: string[] = [];
    const g = setup({ publishGate: async (_m, f) => { files = f; return 'Needs an approval from Platform (owns src/).'; } });
    const wsG = await g.h.orch.registerWorkspace(g.root);
    g.h.orch.pipeline.setSettings(wsG.id, { autoPublish: true });
    const idG = await startMission(g.h, g.root);
    await g.h.orch.settle(idG);
    await g.h.orch.decide(idG, 'accept');
    await drain(g.h);
    expect(steps(g.h, idG).map((e) => e.payload)).toEqual([{ step: 'publish', ok: false, text: 'Not published automatically: Needs an approval from Platform (owns src/).' }]);
    expect(files).toContain('src/slugify.js');
    await expect(g.h.orch.publish(idG)).rejects.toThrow(/Needs an approval from Platform/);
  }, 240_000);
});
