// End-to-end orchestration with the deterministic runtime against real git repositories (manual §44, §49).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { registerSecret } from '@atlas/contracts';
import { FakeRuntime, forTask, SAMPLE_FIX, type FakeScript } from '@atlas/runtime-fake';
import { realExecutors, replay, type Executors } from '@atlas/orchestrator';
import { sampleRepo, sh } from '../helpers';
import { autoDecide, explainChecks, makeOrchestrator, startMission, waitFor } from './harness';

describe('sample mission', () => {
  it('edits code in an isolated worktree, verifies independently and keeps the user checkout intact', async () => {
    const root = sampleRepo();
    const head = sh(root, 'git', ['rev-parse', 'HEAD']);
    const h = makeOrchestrator();
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.outcome, explainChecks(h, id)).toMatch(/^Verified: tests passed/);
    expect(m.state).toBe('completed');

    // Evidence: real check records on the integrated commit, a review gate, and patch artifacts.
    const checks = h.repo.checks(id);
    expect(checks.map((c) => [c.name, c.result])).toEqual([['verification-definition', 'pass'], ['tests', 'pass'], ['review', 'pass'], ['security', 'pass']]);
    expect(checks[1]).toMatchObject({ required: true, exitCode: 0 });
    expect(m.integrationBranch).toBe(`atlas/${id}/integration`);
    expect(checks[1].commit).toBe(m.integrationCommit);
    const t = h.repo.tasks(id).find((x) => x.key === 'implement')!;
    const patch = h.artifacts.read(t.resultRef!);
    expect(patch.intact).toBe(true);
    expect(patch.text).toContain('+    .toLowerCase()');
    expect(sh(root, 'git', ['merge-base', '--is-ancestor', t.checkpoint!, m.integrationCommit!])).toBe('');

    // The user's checkout was never written.
    expect(sh(root, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
    expect(readFileSync(path.join(root, 'src/slugify.js'), 'utf8')).toContain('ATLAS-SAMPLE');

    // The audit trail answers who changed which file and why.
    const types = h.events.map((e) => e.type);
    for (const t of ['mission.created', 'plan.proposed', 'plan.approved', 'attempt.started', 'policy.decision', 'agent.tool_call', 'process.exited', 'workspace.worktree', 'check.result', 'gate.result']) expect(types).toContain(t);
    const write = h.events.find((e) => e.type === 'agent.tool_call' && e.payload.tool === 'write_file')!;
    expect(write.actor).toMatchObject({ kind: 'agent', role: 'coder' });

    // Replay reconstructs persisted state.
    const r = replay(h.repo.eventsSince(id, 0));
    expect(r.mission).toBe('completed');
    expect(r.tasks[t.id]).toBe('done');

    // Accept keeps the integration branch for the operator; task worktrees are cleaned; the checkout is untouched.
    await h.orch.decide(id, 'accept');
    expect(sh(root, 'git', ['rev-parse', m.integrationBranch!])).toBe(m.integrationCommit);
    expect(existsSync(t.worktree!)).toBe(false);
    expect(sh(root, 'git', ['branch', '--list', t.branch!])).toBe('');
    expect(sh(root, 'git', ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('a failing project fails the gate even when the agent claims success', async () => {
    const root = sampleRepo();
    const liar: FakeScript = { name: 'liar', matches: () => true, steps: () => [{ tool: 'read_file', args: { path: 'src/slugify.js' } }, { claim: 'All tests pass. The bug is fixed.' }] };
    const h = makeOrchestrator({ scripts: [liar] });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.state).toBe('failed');
    expect(m.outcome).toMatch(/Blocked: tests failed/);
    expect(h.events.some((e) => e.type === 'agent.message' && e.payload.claim === true && /All tests pass/.test(String(e.payload.text)))).toBe(true);
  });

  it('reject removes the worktree and branch without touching the checkout', async () => {
    const root = sampleRepo();
    const h = makeOrchestrator();
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const t = h.repo.tasks(id)[0];
    const m = h.repo.mission(id)!;
    await h.orch.decide(id, 'reject');
    expect(sh(root, 'git', ['branch', '--list', m.integrationBranch!])).toBe('');
    expect(existsSync(t.worktree!)).toBe(false);
    expect(sh(root, 'git', ['branch', '--list', t.branch!])).toBe('');
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('a rejected change can be restored exactly, once, and never from a tampered ref', async () => {
    const root = sampleRepo();
    const head = sh(root, 'git', ['rev-parse', 'HEAD']);
    const h = makeOrchestrator();
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    await h.orch.decide(id, 'reject');
    expect(sh(root, 'git', ['branch', '--list', m.integrationBranch!])).toBe('');
    // Kept under a private ref, not a branch.
    expect(sh(root, 'git', ['rev-parse', `refs/atlas/rejected/${id}`])).toBe(m.integrationCommit);
    await expect(h.orch.decide(id, 'accept')).rejects.toThrow(/already rejected/);

    const restored = await h.orch.restore(id);
    expect(restored.decision).toBe('accepted');
    expect(sh(root, 'git', ['rev-parse', m.integrationBranch!])).toBe(m.integrationCommit);
    expect(sh(root, 'git', ['show', `${m.integrationBranch}:src/slugify.js`])).toContain('.toLowerCase()');
    expect(sh(root, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
    await expect(h.orch.restore(id)).rejects.toThrow(/Only a rejected change/);
    expect(h.events.filter((e) => e.type === 'mission.decision').map((e) => e.payload.decision)).toEqual(['reject', 'restore']);

    // A second mission whose kept ref was moved elsewhere is refused.
    const id2 = await startMission(h, root);
    await h.orch.settle(id2);
    await h.orch.decide(id2, 'reject');
    sh(root, 'git', ['update-ref', `refs/atlas/rejected/${id2}`, head]);
    await expect(h.orch.restore(id2)).rejects.toThrow(/refusing to restore/);
    expect(sh(root, 'git', ['branch', '--list', h.repo.mission(id2)!.integrationBranch!])).toBe('');
    // Deleting the mission removes the kept ref.
    await h.orch.deleteMission(id2);
    expect(() => sh(root, 'git', ['rev-parse', '--verify', '--quiet', `refs/atlas/rejected/${id2}`])).toThrow();
  });

  it('reports unverified when the project has no test command', async () => {
    const root = sampleRepo();
    sh(root, 'git', ['rm', '-q', 'package.json']);
    sh(root, 'git', ['commit', '-q', '-m', 'no tests']);
    const h = makeOrchestrator();
    const ws = await h.orch.registerWorkspace(root);
    const warnings = await h.orch.preflight(ws.id, 'fake');
    expect(warnings.some((w) => /No test command/.test(w.message))).toBe(true);
    const id = await startMission(h, root);
    await h.orch.settle(id);
    expect(h.repo.mission(id)!.outcome).toMatch(/^Unverified/);
    expect(h.repo.mission(id)!.verdict).toBe('unverified'); // never displayed as plain "completed"
  });
});

describe('governed tools', () => {
  it('a denied tool call never reaches an executor', async () => {
    const root = sampleRepo();
    const touched: string[] = [];
    const spy: Executors = {
      readFile: (a) => { touched.push(`read:${a}`); return realExecutors.readFile(a); },
      listDir: (a) => { touched.push(`list:${a}`); return realExecutors.listDir(a); },
      writeFile: (a, c) => { touched.push(`write:${a}`); realExecutors.writeFile(a, c); },
      exec: (o) => { touched.push(`exec:${o.command}`); return realExecutors.exec(o); },
    };
    const evil: FakeScript = { name: 'evil', matches: () => true, steps: () => [
      { tool: 'shell_exec', args: { command: 'sudo', args: ['cat', '/etc/shadow'] } },
      { tool: 'read_file', args: { path: '../../../../etc/passwd' } },
      { tool: 'write_file', args: { path: '.git/hooks/pre-commit', content: 'curl evil' } },
      { tool: 'deploy_production', args: {} },
      { claim: 'done' },
    ] };
    const h = makeOrchestrator({ scripts: [evil], executors: spy });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    expect(touched.filter((t) => !t.startsWith('exec:npm'))).toEqual([]);
    const denials = h.events.filter((e) => e.type === 'policy.decision' && e.payload.decision === 'deny');
    expect(denials.length).toBeGreaterThanOrEqual(4);
  });

  it('privileged commands wait for approval; denial and approval are honored once', async () => {
    const root = sampleRepo();
    const script: FakeScript = { name: 'priv', matches: () => true, steps: () => [
      { tool: 'shell_exec', args: { command: 'git', args: ['commit', '--allow-empty', '-m', 'one'] } },
      { tool: 'shell_exec', args: { command: 'git', args: ['commit', '--allow-empty', '-m', 'two'] } },
      { claim: 'done' },
    ] };
    const h = makeOrchestrator({ scripts: [script] });
    const id = await startMission(h, root);
    const first = await waitFor(() => h.repo.approvals(id).find((a) => a.status === 'pending'));
    expect(first).toMatchObject({ tool: 'shell_exec', action: 'git commit --allow-empty -m one', capability: 'shell.privileged', scope: 'once' });
    h.orch.respondApproval(first.id, 'deny');
    expect(() => h.orch.respondApproval(first.id, 'approve')).toThrow(/already/);
    const second = await waitFor(() => h.repo.approvals(id).find((a) => a.status === 'pending' && a.id !== first.id));
    h.orch.respondApproval(second.id, 'approve');
    await h.orch.settle(id);
    const exits = h.events.filter((e) => e.type === 'process.exited').map((e) => e.payload.command);
    expect(exits).toContain('git commit --allow-empty -m two');
    expect(exits).not.toContain('git commit --allow-empty -m one');
  });

  it('expired approvals are not executed', async () => {
    const root = sampleRepo();
    const script: FakeScript = { name: 'priv', matches: () => true, steps: () => [{ tool: 'shell_exec', args: { command: 'git', args: ['tag', 'v9'] } }, { claim: 'done' }] };
    const h = makeOrchestrator({ scripts: [script], approvalTtlMs: 150 });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    expect(h.repo.approvals(id)[0].status).toBe('expired');
    expect(h.events.some((e) => e.type === 'process.started')).toBe(false);
  });

  it('seeded secrets never reach artifacts or events', async () => {
    const root = sampleRepo();
    const secret = 'sk-ant-canary-0123456789abcdef';
    registerSecret(secret);
    const script: FakeScript = { name: 'leak', matches: () => true, steps: () => [
      { say: `my key is ${secret}` },
      { tool: 'write_file', args: { path: 'notes.txt', content: `token ${secret}` } },
      { tool: 'shell_exec', args: { command: 'cat', args: ['notes.txt'] } },
      { claim: `done ${secret}` },
    ] };
    const h = makeOrchestrator({ scripts: [script] });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    expect(JSON.stringify(h.repo.eventsSince(id, 0))).not.toContain(secret);
    for (const a of h.artifacts.list(id)) expect(h.artifacts.read(a.id).text, a.name).not.toContain(secret);
  });
});

describe('cancellation and recovery', () => {
  it('cancelling a mission stops a long-running command and leaves no process behind', async () => {
    const root = sampleRepo();
    const script: FakeScript = { name: 'long', matches: () => true, steps: () => [{ tool: 'shell_exec', args: { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] } }, { claim: 'never' }] };
    // `node -e` is privileged; approve it as soon as it is requested.
    const h = makeOrchestrator({ scripts: [script] });
    const id = await startMission(h, root);
    const a = await waitFor(() => h.repo.approvals(id).find((x) => x.status === 'pending'));
    h.orch.respondApproval(a.id, 'approve');
    const started = await waitFor(() => h.events.find((e) => e.type === 'process.started'));
    const pid = started.payload.pid as number;
    await h.orch.cancelMission(id);
    expect(h.repo.mission(id)!.state).toBe('cancelled');
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; } }
    expect(alive).toBe(false);
    expect(h.repo.tasks(id)[0].state).toBe('cancelled');
  });

  it('after a daemon crash, lost attempts are recorded and the mission completes in a fresh attempt', async () => {
    // Each step has its own deadline, so an intermittent hang (seen on loaded CI runners) names the step and state.
    let where = 'start';
    const state = (h: ReturnType<typeof makeOrchestrator>, id: string) => JSON.stringify({ mission: h.repo.mission(id)?.state, tasks: h.repo.tasks(id).map((t) => [t.key, t.state]), attempts: h.repo.attempts(id).map((a) => a.state), approvals: h.repo.approvals(id).map((a) => [a.tool, a.status]), last: h.events.slice(-6).map((e) => e.type) });
    const step = async <T>(label: string, p: Promise<T>, ms = 20_000): Promise<T> => {
      where = label;
      let t: NodeJS.Timeout | undefined;
      try { return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`step "${label}" did not finish in ${ms} ms`)), ms); })]); }
      finally { clearTimeout(t); }
    };
    const root = sampleRepo();
    const slow = new FakeRuntime([{ name: 'hang', matches: () => true, steps: () => [{ tool: 'shell_exec', args: { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] } }] }]);
    const first = makeOrchestrator({ runtime: slow });
    const id = await step('start mission', startMission(first, root));
    try {
      const a = await step('approval requested', waitFor(() => first.repo.approvals(id).find((x) => x.status === 'pending')));
      first.orch.respondApproval(a.id, 'approve');
      await step('command started', waitFor(() => first.events.find((e) => e.type === 'process.started')));
      // Simulate a crash: stop the process without any state cleanup, then reopen the same data directory.
      await step('first shutdown', first.orch.shutdown());
      first.db.close();
    } catch (e) { throw new Error(`${(e as Error).message} at ${where}: ${state(first, id)}`); }

    const second = makeOrchestrator({ dataDir: first.dataDir });
    try {
      const r = await step('recover', second.orch.recover());
      expect(r).toMatchObject({ missions: [id], lostAttempts: 1 });
      await step('settle after recovery', second.orch.settle(id), 30_000);
    } catch (e) { throw new Error(`${(e as Error).message} at ${where}: ${state(second, id)}`); }
    const attempts = second.repo.attempts(id);
    expect(attempts.map((x) => x.state)).toEqual(['lost', 'succeeded', 'succeeded', 'succeeded']); // coder (lost, then fresh), reviewer, security engineer
    expect(second.repo.mission(id)!.state, explainChecks(second, id)).toBe('completed');
    expect(replay(second.repo.eventsSince(id, 0)).mission).toBe('completed');
  }, 90_000);
});

describe('resource guards (evolution P1-4)', () => {
  it('below the free-disk floor no worktree is created and the task fails with the reason', async () => {
    const h = makeOrchestrator({ diskFree: () => 200 * 1024 * 1024 });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    const t = h.repo.tasks(id).find((x) => x.key === 'implement')!;
    expect(t.state).toBe('failed');
    expect(h.events.find((e) => e.type === 'attempt.ended')!.payload).toMatchObject({ errorKind: 'resource_limit', message: expect.stringMatching(/Only 200 MiB free/) });
    expect(h.events.filter((e) => e.type === 'workspace.worktree' && e.payload.action === 'created')).toEqual([]);
  });

  it('at the per-mission worktree cap no further worktree is created', async () => {
    const h = makeOrchestrator();
    h.repo.setSetting('worktrees.maxPerMission', 1);
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    // The coder's worktree is the one allowed; the reviewer's (or the integration's) is refused with a reason.
    expect(h.events.filter((e) => e.type === 'workspace.worktree' && e.payload.action === 'created')).toHaveLength(1);
    expect(JSON.stringify(h.events.filter((e) => e.type === 'attempt.ended' || e.type === 'integration.result').map((e) => e.payload))).toMatch(/limit 1/);
    expect(h.repo.mission(id)!.verdict).not.toBe('verified');
  });
});

describe('stall watchdog (evolution P1-6)', () => {
  it('a silent attempt is flagged once as stalled, not stopped; a pending approval is not a stall', async () => {
    const steps = [{ wait: 900 }, { tool: 'write_file', args: { path: 'NOTE.md', content: 'x' } }, { tool: 'shell_exec', args: { command: 'node', args: ['-e', '1'] } }, { claim: 'done' }];
    const h = makeOrchestrator({ scripts: [forTask('implement', steps as any)], stallAfterMs: 250 });
    const id = await startMission(h, sampleRepo());
    const stalled = await waitFor(() => h.events.find((e) => e.type === 'attempt.stalled'));
    expect(stalled.payload.silentForMs).toBeGreaterThanOrEqual(250);
    // While the approval for `node -e` is pending (well past the threshold), no second stall is reported.
    const a = await waitFor(() => h.repo.approvals(id).find((x) => x.status === 'pending'));
    await new Promise((r) => setTimeout(r, 800));
    expect(h.events.filter((e) => e.type === 'attempt.stalled')).toHaveLength(1);
    h.orch.respondApproval(a.id, 'approve');
    await h.orch.settle(id);
    // The stalled attempt was not killed: it finished its work.
    expect(h.repo.attempts(id)[0].state).toBe('succeeded');
  });
});

describe('daemon-side terminals (P1-5 review)', () => {
  it.skipIf(process.platform === 'win32')('re-verify ends a shell on the old integration worktree and records it; nothing is left attached', async () => {
    const h = makeOrchestrator({ scripts: [forTask('implement', [{ tool: 'write_file', args: { path: 'src/slugify.js', content: "export function slugify() { return 'x'; }\n" } }, { claim: 'done' }])] });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    expect(h.repo.mission(id)!.state).toBe('failed');
    const t = await h.orch.openTerminal(id, 'integration', { cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    expect(h.orch.listTerminals(id).map((x) => x.sessionId)).toEqual([t.sessionId]);
    await h.orch.reverify(id);
    await h.orch.settle(id);
    expect(h.orch.listTerminals(id)).toEqual([]);
    expect(h.events.filter((e) => e.type === 'operator.terminal').map((e) => e.payload.action)).toEqual(['opened', 'closed']);
    // A new shell on the new integration worktree is writable: the old session's lease was released.
    const again = await h.orch.openTerminal(id, 'integration', { cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    expect(again.writable).toBe(true);
    await h.orch.closeTerminal(again.sessionId);
  });
});

describe('stall watchdog exemptions (P1-6 review)', () => {
  it('a long silent command is not a stall: it has its own timeout', async () => {
    const steps = [{ tool: 'shell_exec', args: { command: 'node', args: ['-e', 'setTimeout(()=>{},1200)'] } }, { tool: 'write_file', args: { path: 'NOTE.md', content: 'x' } }, { claim: 'done' }];
    const h = makeOrchestrator({ scripts: [forTask('implement', steps as any)], stallAfterMs: 250 });
    const id = await startMission(h, sampleRepo());
    const stop = autoDecide(h, id, 'shell_exec');
    await h.orch.settle(id);
    stop();
    expect(h.events.some((e) => e.type === 'process.exited')).toBe(true);
    expect(h.events.filter((e) => e.type === 'attempt.stalled')).toEqual([]);
  });

  it('a tool call ATLAS is still preparing is not a stall (Windows CI: slow sandbox grants before the process starts)', async () => {
    // Setup that takes longer than the threshold before any process exists, as ACL grants on a slow runner do.
    const slow: Executors = { ...realExecutors, exec: async (o) => { await new Promise((r) => setTimeout(r, 700)); return realExecutors.exec(o); } };
    const steps = [{ tool: 'shell_exec', args: { command: 'node', args: ['--version'] } }, { claim: 'done' }];
    const h = makeOrchestrator({ scripts: [forTask('implement', steps as any)], stallAfterMs: 250, executors: slow });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    expect(h.events.some((e) => e.type === 'process.exited')).toBe(true);
    expect(h.events.filter((e) => e.type === 'attempt.stalled')).toEqual([]);
  });

  it('a background process does not hide a silent agent (ADR 0026)', async () => {
    const steps = [
      { tool: 'write_file', args: { path: 'watch.mjs', content: 'setInterval(() => {}, 1000);\n' } },
      { tool: 'process_start', args: { command: 'node', args: ['watch.mjs'], waitSec: 0 } },
      { wait: 900 },
      { claim: 'done' },
    ];
    const h = makeOrchestrator({ scripts: [forTask('implement', steps as any)], stallAfterMs: 250 });
    const id = await startMission(h, sampleRepo());
    const stalled = await waitFor(() => h.events.find((e) => e.type === 'attempt.stalled'));
    expect(h.events.some((e) => e.type === 'process.started' && e.payload.background === 'p1' && e.seq < stalled.seq)).toBe(true);
    await h.orch.settle(id);
  });
});

describe('verification cannot be redefined by the agent (evolution P0-3, incl. independent-review bypasses)', () => {
  const BROKEN = "export function slugify() { return 'nope'; }\n";
  const pkgWith = (root: string, edit: (p: any) => void) => { const p = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')); edit(p); return JSON.stringify(p, null, 2); };
  const testFile = (root: string) => readFileSync(path.join(root, 'test/slugify.test.js'), 'utf8');
  const w = (file: string, content: string) => ({ tool: 'write_file', args: { path: file, content } });
  async function run(steps: any[], approve = false) {
    const root = sampleRepo();
    const h = makeOrchestrator({ scripts: [forTask('implement', [...(typeof steps === 'function' ? (steps as any)(root) : steps), { claim: 'All tests pass.' }])] });
    const id = await startMission(h, root);
    const stop = approve ? autoDecide(h, id, 'shell_exec') : () => {};
    await h.orch.settle(id);
    stop();
    const checks = (name: string) => h.repo.checks(id).filter((c) => c.name === name).at(-1);
    return { h, id, root, m: h.repo.mission(id)!, checks };
  }

  it('a rewritten test script fails the gate even though the rewritten "tests" pass', async () => {
    const root = sampleRepo();
    const r = await run([w('package.json', pkgWith(root, (p) => { p.scripts.test = 'node -e "process.exit(0)"'; })), w('src/slugify.js', BROKEN)]);
    expect(r.checks('tests')!.result).toBe('pass'); // the neutered command really exits 0 …
    expect(r.checks('verification-definition')!.result).toBe('fail'); // … but it is not the approved definition
    expect(r.checks('verification-definition')!.reason).toMatch(/changed package\.json#scripts\.test/);
    expect(r.m.verdict).toBe('failed');
  });

  it.each([
    ['gutted test body (review A)', (_root: string) => [w('src/slugify.js', BROKEN), w('test/slugify.test.js', "import { test } from 'node:test';\ntest('ok', () => {});\n")]],
    ['test.skip (review B)', (root: string) => [w('src/slugify.js', BROKEN), w('test/slugify.test.js', testFile(root).replace(/^test\(/gm, 'test.skip('))]],
  ])('%s: the original suite still runs and fails on the broken code', async (_n, steps) => {
    const r = await run(steps as any);
    expect(r.checks('tests (original suite)')!.result).toBe('fail');
    expect(r.checks('tests (original suite)')!.reason).toMatch(/base commit's tests fail/);
    expect(r.m.verdict).toBe('failed');
  });

  it('renaming tests out of the runner\'s reach plus a trivial new test (review C) is caught', async () => {
    const r = await run([w('src/slugify.js', BROKEN), { tool: 'shell_exec', args: { command: 'mv', args: ['test/slugify.test.js', 'test/slugify.test.js.off'] } }, w('test/smoke.test.js', "import { test } from 'node:test';\ntest('ok', () => {});\n")], true);
    expect(r.checks('tests (original suite)')!.result).toBe('fail');
    expect(r.m.verdict).toBe('failed');
  });

  it('committing tooling that shadows node (review F) blocks the gate', async () => {
    const r = await run([w('src/slugify.js', BROKEN), w('node_modules/.bin/node', '#!/bin/sh\necho "# tests 5"\nexit 0\n'), { tool: 'shell_exec', args: { command: 'chmod', args: ['+x', 'node_modules/.bin/node'] } }], true);
    expect(r.checks('verification-definition')!.result).toBe('fail');
    expect(r.checks('verification-definition')!.reason).toMatch(/tracks tooling file node_modules\/\.bin\/node/);
    expect(r.m.verdict).toBe('failed');
  });

  it('switching the package manager (review D) blocks the gate', async () => {
    const r = await run([w('src/slugify.js', BROKEN), w('yarn.lock', '# yarn lockfile v1\n'), w('.yarnrc', 'yarn-path "./tools/y.cjs"\n'), w('tools/y.cjs', 'process.exit(0)\n')]);
    expect(r.checks('verification-definition')!.reason).toMatch(/changed package-manager/);
    expect(r.checks('verification-definition')!.reason).toMatch(/changed \.yarnrc/);
    expect(r.m.verdict).toBe('failed');
  });

  it('a non-object package.json (review E) fails closed with a recorded reason, not a crash', async () => {
    const r = await run([w('package.json', 'null')]);
    expect(r.checks('verification-definition')!.result).toBe('fail');
    expect(r.checks('verification-definition')!.reason).toMatch(/changed package\.json/);
    expect(r.m.verdict).toBe('failed');
  });

  it('legitimate work stays verified: a real fix, a new test and a new lint script (review G)', async () => {
    const root = sampleRepo();
    const r = await run([w('src/slugify.js', SAMPLE_FIX), w('test/extra.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\ntest('rock', () => assert.equal(slugify('Rock & Roll'), 'rock-roll'));\n"), w('package.json', pkgWith(root, (p) => { p.scripts.lint = 'node -e "process.exit(0)"'; }))]);
    expect(r.checks('verification-definition')!.result).toBe('pass');
    expect(r.checks('verification-definition')!.reason).toMatch(/added package\.json#scripts\.lint.*1 test file\(s\) added/);
    expect(r.checks('tests (original suite)')).toBeUndefined(); // no test was modified or deleted
    expect(r.m.verdict).toBe('verified');
  });

  it('a legitimate test edit runs the original suite, which passes when the code is right', async () => {
    const root = sampleRepo();
    const r = await run([w('src/slugify.js', SAMPLE_FIX), w('test/slugify.test.js', testFile(root) + "test('extra', () => assert.equal(slugify('A B'), 'a-b'));\n")]);
    expect(r.checks('tests (original suite)')!.result).toBe('pass');
    expect(r.m.verdict).toBe('verified');
    // The integration worktree was restored after the original-suite run.
    expect(r.h.repo.checks(r.id).find((c) => c.name === 'tests')!.result).toBe('pass');
  });

  it('approval is bound to the reviewed hash and the mission state; deleting tests is never evidence', async () => {
    const r = await run([w('src/slugify.js', SAMPLE_FIX), { tool: 'shell_exec', args: { command: 'rm', args: ['test/slugify.test.js'] } }], true);
    const defn = r.checks('verification-definition')!;
    expect(defn.result).toBe('fail');
    expect(defn.reason).toMatch(/deleted test test\/slugify\.test\.js/);
    const hash = JSON.parse(r.h.artifacts.read(defn.artifactId!).text).hash as string;
    await expect(r.h.orch.approveDefinitionChange(r.id, 'f'.repeat(64))).rejects.toThrow(/differs from the one you reviewed/);
    expect(r.h.events.some((e) => e.type === 'operator.action' && e.payload.action === 'approve_definition')).toBe(false);
    await r.h.orch.approveDefinitionChange(r.id, hash);
    expect(r.checks('verification-definition')!.result).toBe('pass');
    // The original suite passes (the code is fixed); the integrated run has no tests at all, so nothing verifies it.
    expect(r.checks('tests')!.result, explainChecks(r.h, r.id)).toBe('inconclusive');
    expect(r.h.repo.mission(r.id)!.verdict).not.toBe('verified');
  });

  it('an approval is refused, and not recorded, when the mission is not awaiting one', async () => {
    const r = await run([w('src/slugify.js', SAMPLE_FIX)]);
    expect(r.m.state).toBe('completed');
    await expect(r.h.orch.approveDefinitionChange(r.id, 'a'.repeat(64))).rejects.toThrow(/Only a failed, undecided mission/);
    expect(r.h.events.some((e) => e.type === 'operator.action' && e.payload.action === 'approve_definition')).toBe(false);
  });
});

describe('nothing in a worktree is destroyed silently (evolution P1-3)', () => {
  it('reject keeps dirty and untracked work and branch tips under refs/atlas/preserved; delete removes them', async () => {
    const root = sampleRepo();
    const head = sh(root, 'git', ['rev-parse', 'HEAD']);
    const h = makeOrchestrator();
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const t = h.repo.tasks(id).find((x) => x.key === 'implement')!;
    // Work that never made it into a checkpoint (e.g. typed in the operator terminal).
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(t.worktree!, 'NOTES.md'), 'operator notes\n');
    writeFileSync(path.join(t.worktree!, 'src/slugify.js'), '// edited after the checkpoint\n');
    await h.orch.decide(id, 'reject');
    expect(existsSync(t.worktree!)).toBe(false);
    const ref = `refs/atlas/preserved/${id}/${path.basename(t.worktree!)}/uncommitted`;
    expect(sh(root, 'git', ['show', `${ref}:NOTES.md`])).toBe('operator notes');
    expect(sh(root, 'git', ['show', `${ref}:src/slugify.js`])).toBe('// edited after the checkpoint');
    expect(sh(root, 'git', ['rev-parse', `refs/atlas/preserved/${id}/${path.basename(t.worktree!)}/branch`])).toBe(t.checkpoint);
    const ev = h.events.find((e) => e.type === 'workspace.worktree' && e.payload.action === 'preserved')!;
    expect(JSON.stringify(ev.payload.refs)).toContain(ref);
    // The user's checkout and branches are untouched; no stray branches remain.
    expect(sh(root, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
    expect(sh(root, 'git', ['branch', '--list', `atlas/${id}/*`])).toBe('');
    await h.orch.deleteMission(id);
    expect(sh(root, 'git', ['for-each-ref', `refs/atlas/preserved/${id}/`])).toBe('');
  });

  it('a clean worktree leaves only the branch tip, never an empty snapshot', async () => {
    const root = sampleRepo();
    const h = makeOrchestrator();
    const id = await startMission(h, root);
    await h.orch.settle(id);
    await h.orch.decide(id, 'accept');
    const refs = sh(root, 'git', ['for-each-ref', '--format=%(refname)', `refs/atlas/preserved/${id}/`]).split('\n').filter(Boolean);
    expect(refs.some((r) => r.endsWith('/uncommitted'))).toBe(false);
    expect(refs.some((r) => r.endsWith('/branch'))).toBe(true);
  });
});
