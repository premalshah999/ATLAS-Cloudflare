// M2 orchestration against real git repositories: model plans, DAG scheduling, integration, review
// findings, delegation and budgets (manual §13–17, §19, §29, §41).
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { forTask, sampleSlugifyScript, SAMPLE_FIX, type FakeScript } from '@atlas/runtime-fake';
import { sampleRepo, sh } from '../helpers';
import { explainChecks, makeOrchestrator, startMission } from './harness';

const task = (key: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({
  key, title: `Task ${key}`, role: 'coder', dependsOn, acceptance: [`${key} done`], tools: ['read_file', 'write_file', 'run_tests', 'delegate'], risk: 'low', ...extra,
});
const plan = (tasks: unknown[]) => ({ summary: 'scripted', scope: 'worktrees', tasks, verification: [{ name: 'tests', required: true }] });
const write = (file: string, content: string) => ({ tool: 'write_file', args: { path: file, content } });

describe('model planning', () => {
  it('runs a DAG: independent tasks in parallel, a dependent task on both checkpoints, one integrated result', async () => {
    const root = sampleRepo();
    const scripts: FakeScript[] = [
      forTask('a', [write('notes/a.md', 'A\n'), { wait: 300 }, { claim: 'a' }]),
      forTask('b', [write('notes/b.md', 'B\n'), { wait: 300 }, { claim: 'b' }]),
      forTask('c', [{ tool: 'read_file', args: { path: 'notes/a.md' } }, { tool: 'read_file', args: { path: 'notes/b.md' } }, write('src/slugify.js', SAMPLE_FIX), { claim: 'c' }]),
    ];
    const h = makeOrchestrator({ scripts, planner: () => plan([task('a'), task('b'), task('c', ['a', 'b'])]) });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.outcome).toMatch(/^Verified: tests passed/);
    const ev = h.events;
    const started = (k: string) => ev.findIndex((e) => e.type === 'attempt.started' && e.taskId === h.repo.tasks(id).find((t) => t.key === k)!.id);
    const ended = (k: string) => ev.findIndex((e) => e.type === 'attempt.ended' && e.taskId === h.repo.tasks(id).find((t) => t.key === k)!.id);
    expect(started('b')).toBeLessThan(ended('a')); // a and b overlapped
    expect(started('c')).toBeGreaterThan(Math.max(ended('a'), ended('b')));
    // c read both files without errors, so its worktree contained both dependencies' work.
    expect(ev.filter((e) => e.type === 'agent.tool_result' && e.payload.tool === 'read_file').every((e) => e.payload.ok)).toBe(true);
    for (const f of ['notes/a.md', 'notes/b.md']) expect(sh(root, 'git', ['show', `${m.integrationCommit}:${f}`])).toBeTruthy();
    expect(h.events.find((e) => e.type === 'plan.proposed')!.payload.source).toBe('model');
  });

  it('serializes writers that declare overlapping files', async () => {
    const root = sampleRepo();
    const scripts = [
      forTask('a', [write('src/shared.js', 'export const a = 1;\n'), { claim: 'a' }]),
      forTask('b', [{ tool: 'read_file', args: { path: 'src/shared.js' } }, write('src/shared.js', 'export const a = 1;\nexport const b = 2;\n'), { claim: 'b' }]),
    ];
    const h = makeOrchestrator({ scripts, planner: () => plan([task('a', [], { files: ['src/shared.js'] }), task('b', [], { files: ['src/shared.js'] })]) });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    expect(h.events.some((e) => e.type === 'plan.proposed' && (e.payload.serialized as any)?.then === 'b')).toBe(true);
    const m = h.repo.mission(id)!;
    expect(sh(root, 'git', ['show', `${m.integrationCommit}:src/shared.js`])).toContain('export const b = 2;');
    expect(h.events.find((e) => e.type === 'integration.result')!.payload).toMatchObject({ ok: true, merged: ['a', 'b'] });
  });

  it('surfaces integration conflicts instead of guessing', async () => {
    const root = sampleRepo();
    const scripts = [forTask('a', [write('README.md', 'from a\n'), { claim: 'a' }]), forTask('b', [write('README.md', 'from b\n'), { claim: 'b' }])];
    const h = makeOrchestrator({ scripts, planner: () => plan([task('a'), task('b')]) });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.state).toBe('failed');
    expect(m.outcome).toMatch(/Integration conflict while merging b: Merge conflict in README.md/);
    expect(h.events.find((e) => e.type === 'integration.result')!.payload).toMatchObject({ ok: false, conflicts: ['README.md'] });
  });

  it('rejects an invalid model plan (after one repair) before any tool action and falls back', async () => {
    const root = sampleRepo();
    let calls = 0;
    const h = makeOrchestrator({ planner: () => { calls++; return plan([task('a', ['c']), task('b', ['a']), task('c', ['b'], { tools: ['read_file', 'desktop_action'] })]); } });
    const ws = await h.orch.registerWorkspace(root);
    const mission = h.orch.createMission({ workspaceId: ws.id, title: 't', goal: 'Fix slugify', constraints: '', approvalMode: 'ask_risky', runtime: 'fake' });
    await h.orch.plan(mission.id);
    expect(calls).toBe(2);
    const rejected = h.events.filter((e) => e.type === 'plan.rejected');
    expect(rejected.length).toBe(2);
    expect(JSON.stringify(rejected[0].payload.issues)).toMatch(/cycle/);
    expect(JSON.stringify(rejected[0].payload.issues)).toMatch(/may not use desktop_action/);
    expect(h.events.find((e) => e.type === 'plan.proposed')!.payload.source).toBe('default');
    expect(h.events.some((e) => e.type === 'agent.tool_call' || e.type === 'process.started')).toBe(false);
  });
});

describe('review findings', () => {
  const reviewer = (steps: any[]): FakeScript => ({ name: 'rev', matches: (i) => i.roleId === 'reviewer', steps: () => steps });

  it('a confirmed finding backed by a failing reproduction blocks release', async () => {
    const root = sampleRepo();
    // The coder "fixes" nothing; the reviewer reproduces the failure and reports it as confirmed.
    const coder = forTask('implement', [{ tool: 'read_file', args: { path: 'src/slugify.js' } }, { claim: 'Fixed.' }]);
    const h = makeOrchestrator({ scripts: [coder, reviewer([{ tool: 'run_tests', args: {} }, { claim: 'reviewed' }])] });
    // Report using the failing run's artifact id, which the script cannot know in advance: patch the step at runtime.
    const id = await (async () => {
      const r = makeOrchestrator({
        scripts: [coder, {
          name: 'rev-dyn', matches: (i) => i.roleId === 'reviewer',
          steps: async (input) => {
            const res = await input.tools.invoke('run_tests', {}, input.signal);
            const art = res.artifactIds[0];
            return [{ tool: 'report_finding', args: { file: 'src/slugify.js', line: 4, severity: 'high', kind: 'confirmed', title: 'slugify does not lowercase', observation: 'Uppercase input stays uppercase.', evidence: 'npm test: lowercases fails', reproducedBy: art, recommendation: 'Lowercase the input.', confidence: 0.9 } }, { claim: 'One blocker.' }];
          },
        }],
      });
      Object.assign(h, r);
      return startMission(r, root);
    })();
    await h.orch.settle(id);
    const f = h.repo.findings(id);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'confirmed', severity: 'high', status: 'open' });
    expect(f[0].reproductionArtifactId).toMatch(/^art_/);
    const m = h.repo.mission(id)!;
    expect(m.state).toBe('failed');
    expect(m.outcome).toMatch(/review failed/);
  });

  it('an unproven "confirmed" claim is downgraded and does not block; harmless change has no blocker', async () => {
    const root = sampleRepo();
    const h = makeOrchestrator({
      scripts: [sampleSlugifyScript, reviewer([
        { tool: 'report_finding', args: { file: 'src/slugify.js', line: 3, severity: 'high', kind: 'confirmed', title: 'Possible unicode issue', observation: 'Might mishandle emoji.', evidence: 'Reasoning only.' } },
        { tool: 'report_finding', args: { file: 'src/slugify.js', line: 3, severity: 'high', kind: 'confirmed', title: 'Possible unicode issue', observation: 'dup', evidence: 'dup' } },
        { tool: 'report_finding', args: { file: 'README.md', severity: 'info', kind: 'informational', title: 'Docs could mention digits', observation: 'Minor.', evidence: 'README' } },
        { claim: 'Done.' },
      ])],
    });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const f = h.repo.findings(id);
    expect(f.map((x) => x.kind).sort()).toEqual(['informational', 'suspected']); // duplicate dropped, confirmed downgraded
    expect(f.find((x) => x.kind === 'suspected')!.evidence).toMatch(/no failing reproduction/);
    expect(h.repo.mission(id)!.outcome).toMatch(/^Verified: tests passed; review passed/);
  });

  it('operator can dismiss a blocking finding and re-verify without repeating agent work', async () => {
    const root = sampleRepo();
    const h = makeOrchestrator({
      planner: () => plan([
        task('implement'),
        { key: 'review', title: 'Review', role: 'reviewer', dependsOn: ['implement'], acceptance: ['reviewed'], tools: ['view_diff', 'shell_exec', 'report_finding'], risk: 'low' },
      ]),
      scripts: [forTask('implement', [write('src/slugify.js', SAMPLE_FIX), { claim: 'fixed' }]), {
        name: 'rev', matches: (i) => i.roleId === 'reviewer', steps: async (input) => {
          const fail = await input.tools.invoke('shell_exec', { command: 'false', args: [] }, input.signal);
          return [{ tool: 'report_finding', args: { file: 'src/slugify.js', line: 2, severity: 'medium', kind: 'confirmed', title: 'Edge case', observation: 'Empty titles produce an empty slug.', evidence: 'false exits 1', reproducedBy: fail.artifactIds[0] } }, { claim: 'one' }];
        },
      }],
    });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    expect(h.repo.findings(id)).toMatchObject([{ kind: 'confirmed', severity: 'medium' }]);
    expect(h.repo.mission(id)!.outcome).toMatch(/Blocked: review failed/);
    const attemptsBefore = h.repo.attempts(id).length;
    h.orch.updateFinding(h.repo.findings(id)[0].id, 'dismissed');
    await h.orch.reverify(id);
    expect(h.repo.mission(id)!.state, `${h.repo.mission(id)!.outcome}\n${explainChecks(h, id)}`).toBe('completed');
    expect(h.repo.attempts(id).length).toBe(attemptsBefore);
  });
});

describe('delegation and budgets', () => {
  it('a delegated subtask runs in its own worktree and its change is merged back', async () => {
    const root = sampleRepo();
    const scripts: FakeScript[] = [
      { name: 'child', matches: (i) => i.roleId === 'coder' && i.prompt.includes('Work on task implement.d1 now.'), steps: () => [write('src/extra.js', 'export const extra = true;\n'), { claim: 'extra written' }] },
      forTask('implement', [write('src/slugify.js', SAMPLE_FIX), { tool: 'delegate', args: { role: 'coder', title: 'Add extra module', reason: 'independent', acceptance: ['src/extra.js exists'] } }, { tool: 'read_file', args: { path: 'src/extra.js' } }, { claim: 'done' }]),
    ];
    const h = makeOrchestrator({ scripts });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.outcome).toMatch(/^Verified/);
    const child = h.repo.tasks(id).find((t) => t.key === 'implement.d1')!;
    expect(child).toMatchObject({ depth: 1, state: 'done' });
    expect(child.parentTaskId).toBe(h.repo.tasks(id).find((t) => t.key === 'implement')!.id);
    expect(sh(root, 'git', ['show', `${m.integrationCommit}:src/extra.js`])).toContain('extra');
    expect(h.events.find((e) => e.type === 'delegation.result' && e.payload.status === 'done')!.payload.merge).toMatch(/^merged/);
  });

  it('runaway delegation stops at the configured depth and says why', async () => {
    const root = sampleRepo();
    const recurse: FakeScript = { name: 'recurse', matches: (i) => i.roleId === 'coder', steps: () => [{ tool: 'delegate', args: { role: 'coder', title: 'Do it again', reason: 'recursion', acceptance: ['x'] } }, { claim: 'delegated' }] };
    const h = makeOrchestrator({ scripts: [recurse] });
    const id = await startMission(h, root, { budget: { maxDelegationDepth: 2, maxConcurrentAgents: 4 } });
    await h.orch.settle(id);
    const tasks = h.repo.tasks(id);
    expect(Math.max(...tasks.map((t) => t.depth))).toBe(2);
    // The depth-2 agent is not even offered the delegate tool; any attempt is refused by the gate.
    const deep = tasks.find((t) => t.depth === 2)!;
    expect(h.events.find((e) => e.type === 'attempt.started' && e.taskId === deep.id)!.payload.tools).not.toContain('delegate');
    expect(h.events.some((e) => e.type === 'policy.decision' && e.taskId === deep.id && e.payload.decision === 'deny' && /not permitted/.test(String(e.payload.reason)))).toBe(true);
  });

  it('token budget stops the mission with a reason', async () => {
    const root = sampleRepo();
    const spender: FakeScript = { name: 'spend', matches: (i) => i.roleId === 'coder', steps: () => [{ usage: 600 }, { wait: 50 }, { usage: 600 }, { wait: 2000 }, { claim: 'never' }] };
    const h = makeOrchestrator({ scripts: [spender] });
    const id = await startMission(h, root, { budget: { maxTokens: 1000 } });
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.state).toBe('failed');
    expect(m.outcome).toMatch(/Token budget of 1,000 exhausted/);
    expect(h.events.some((e) => e.type === 'budget.exceeded')).toBe(true);
  });

  it('respects the concurrent agent budget', async () => {
    const root = sampleRepo();
    const scripts = [forTask('a', [{ wait: 200 }, { claim: 'a' }]), forTask('b', [{ wait: 200 }, { claim: 'b' }])];
    const h = makeOrchestrator({ scripts, planner: () => plan([task('a'), task('b')]) });
    const id = await startMission(h, root, { budget: { maxConcurrentAgents: 1 } });
    await h.orch.settle(id);
    const order = h.events.filter((e) => e.type === 'attempt.started' || e.type === 'attempt.ended').map((e) => e.type);
    expect(order).toEqual(['attempt.started', 'attempt.ended', 'attempt.started', 'attempt.ended']);
  });

  it('stress: 12 parallel writers never exceed the agent cap and the control plane stays responsive (manual §41)', async () => {
    const { monitorEventLoopDelay } = await import('node:perf_hooks');
    const root = sampleRepo();
    const keys = Array.from({ length: 12 }, (_, i) => `w${i}`);
    const scripts = keys.map((k) => forTask(k, [write(`notes/${k}.md`, `${k}\n`), { tool: 'run_tests', args: {} }, { wait: 150 }, { claim: k }]));
    const h = makeOrchestrator({ scripts, planner: () => ({ ...plan(keys.map((k) => task(k, [], { files: [`notes/${k}.md`] }))), verification: [{ name: 'tests', required: false }] }) });
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    // While it runs, the UI's queries keep getting answered quickly.
    const queryTimes: number[] = [];
    let running = true;
    const poll = (async () => { while (running) { const t = performance.now(); h.repo.mission(h.repo.missions()[0]?.id ?? ''); h.repo.eventsSince(h.repo.missions()[0]?.id ?? '', 0, 2000); queryTimes.push(performance.now() - t); await new Promise((r) => setTimeout(r, 20)); } })();
    const id = await startMission(h, root, { budget: { maxConcurrentAgents: 3, maxTasks: 20 } });
    await h.orch.settle(id);
    running = false; await poll; lag.disable();
    let now = 0, peak = 0;
    for (const e of h.events) {
      if (e.type === 'attempt.started') peak = Math.max(peak, ++now);
      if (e.type === 'attempt.ended') now--;
    }
    expect(peak).toBe(3);
    expect(h.repo.attempts(id).filter((a) => a.state === 'succeeded').length).toBe(12);
    expect(h.repo.mission(id)!.integrationCommit).toBeTruthy();
    for (const k of keys) expect(sh(root, 'git', ['show', `${h.repo.mission(id)!.integrationCommit}:notes/${k}.md`])).toBe(k);
    const p99 = lag.percentile(99) / 1e6;
    queryTimes.sort((a, b) => a - b);
    expect(p99, `event loop p99 ${p99.toFixed(1)} ms`).toBeLessThan(200);
    expect(queryTimes[Math.floor(queryTimes.length * 0.99)], 'UI query p99 (ms)').toBeLessThan(100);
  }, 120_000);

  it('context bundles record their sources and include project facts', async () => {
    const root = sampleRepo();
    const h = makeOrchestrator();
    const ws = await h.orch.registerWorkspace(root);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(path.join(h.dataDir, 'facts'), { recursive: true });
    writeFileSync(path.join(h.dataDir, 'facts', `${ws.id}.md`), 'Slugs must stay ASCII.');
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const built = h.events.filter((e) => e.type === 'context.built');
    expect(built.length).toBe(3); // coder, reviewer, security engineer
    expect((built[0].payload.sources as any[]).map((s) => s.kind)).toEqual(expect.arrayContaining(['objective', 'task', 'plan', 'facts', 'repo-map']));
    // Both reviews see the diff, whichever started first.
    for (const b of built.slice(1)) expect((b.payload.sources as any[]).map((s) => s.kind)).toContain('diff');
    const ctxArt = h.artifacts.list(id).find((a) => a.kind === 'context')!;
    expect(h.artifacts.read(ctxArt.id).text).toContain('Slugs must stay ASCII.');
    expect(existsSync(path.join(h.dataDir, 'facts'))).toBe(true);
    void readFileSync;
  });
});
