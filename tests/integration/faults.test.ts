// Evolution Phase 8: end-to-end reality check with injected faults. Each case drives a full mission (real git
// repository, real sandboxed commands, real gate) and injects one fault from outside the happy path. The
// assertion is always about what the operator is told and what is left on disk, not about internal state alone.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FakeRuntime, forTask, sampleSlugifyScript, type FakeScript } from '@atlas/runtime-fake';
import { AtlasError, type AgentInput } from '@atlas/contracts';
import { detectSandbox } from '@atlas/terminal';
import { sampleRepo, sh } from '../helpers';
import { autoDecide, explainChecks, makeOrchestrator, startMission, waitFor } from './harness';

/** A model connection that drops on the coder's first attempt, as a typed network error or as an untyped one. */
class FlakyRuntime extends FakeRuntime {
  private failures = 1;
  constructor(scripts: FakeScript[], private readonly typed: boolean) { super(scripts, 0); }
  override async start(input: AgentInput) {
    if (input.roleId === 'coder' && this.failures-- > 0) {
      throw this.typed ? new AtlasError('network_unavailable', 'model connection reset by peer') : new Error('model connection reset by peer');
    }
    return super.start(input);
  }
}

describe('fault injection (evolution Phase 8)', () => {
  it('the model connection drops (typed network error): the attempt is recorded as failed, a fresh attempt finishes, the result is verified', async () => {
    const h = makeOrchestrator({ runtime: new FlakyRuntime([sampleSlugifyScript], true) });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    const coder = h.repo.attempts(id).filter((a) => h.repo.task(a.taskId)!.role === 'coder');
    expect(coder.map((a) => a.state)).toEqual(['failed', 'succeeded']);
    expect(coder[0].error).toMatch(/connection reset/);
    expect(h.repo.mission(id)!.verdict, explainChecks(h, id)).toBe('verified');
  });

  it('an unclassified runtime error is not retried blindly (manual §40): the mission fails and says why', async () => {
    const h = makeOrchestrator({ runtime: new FlakyRuntime([sampleSlugifyScript], false) });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    const coder = h.repo.attempts(id).filter((a) => h.repo.task(a.taskId)!.role === 'coder');
    expect(coder.map((a) => a.state)).toEqual(['failed']);
    expect(h.repo.mission(id)!.state).toBe('failed');
    expect(h.repo.mission(id)!.outcome).toMatch(/implement failed/);
  });

  it.skipIf(detectSandbox().kind !== 'bwrap')('an agent command is killed from outside (OOM killer, the user): the failure is reported, never a pass', async () => {
    const steps = [{ tool: 'shell_exec', args: { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] } }, { claim: 'All good.' }];
    const h = makeOrchestrator({ scripts: [forTask('implement', steps)] });
    const id = await startMission(h, sampleRepo());
    const stop = autoDecide(h, id, 'shell_exec');
    const started = await waitFor(() => h.events.find((e) => e.type === 'process.started'));
    process.kill(-Number(started.payload.pid), 'SIGKILL');
    await h.orch.settle(id);
    stop();
    const exited = h.events.find((e) => e.type === 'process.exited')!;
    expect(exited.payload.exitCode).not.toBe(0);
    // The agent's claim is not evidence: nothing changed, so the gate cannot pass on its word.
    expect(h.repo.mission(id)!.verdict).not.toBe('verified');
  });

  it('the user keeps working on their branch during the mission: their commits and checkout are untouched, the mission still integrates on its base', async () => {
    const root = sampleRepo();
    const base = sh(root, 'git', ['rev-parse', 'HEAD']);
    const slow: FakeScript = { ...sampleSlugifyScript, name: 'slow', steps: async (i) => [{ wait: 400 }, ...(await sampleSlugifyScript.steps(i))] };
    const h = makeOrchestrator({ scripts: [slow] });
    const id = await startMission(h, root);
    writeFileSync(path.join(root, 'USER_NOTES.md'), 'my own work\n');
    sh(root, 'git', ['add', 'USER_NOTES.md']);
    sh(root, 'git', ['-c', 'user.name=u', '-c', 'user.email=u@u', 'commit', '-qm', 'user work during the mission']);
    const userHead = sh(root, 'git', ['rev-parse', 'HEAD']);
    writeFileSync(path.join(root, 'scratch.txt'), 'uncommitted\n');
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.verdict, explainChecks(h, id)).toBe('verified');
    expect(m.baseCommit).toBe(base);
    expect(sh(root, 'git', ['rev-parse', 'HEAD'])).toBe(userHead);
    expect(readFileSync(path.join(root, 'scratch.txt'), 'utf8')).toBe('uncommitted\n');
    expect(sh(root, 'git', ['merge-base', '--is-ancestor', base, m.integrationCommit!])).toBe('');
    // The user's commit is not silently pulled into the agent's result.
    expect(sh(root, 'git', ['ls-tree', '--name-only', m.integrationCommit!])).not.toContain('USER_NOTES.md');
  });

  it('evidence corrupted on disk after the fact is detected on read, and another installation refuses to import it', async () => {
    const h = makeOrchestrator();
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    const log = h.repo.checks(id).find((c) => c.name === 'tests')!;
    writeFileSync(path.join(h.dataDir, 'artifacts', log.artifactId!), 'tests passed (forged)\n');
    expect(h.artifacts.read(log.artifactId!).intact).toBe(false);
    const out = path.join(h.dataDir, 'export.jsonl');
    h.orch.exportMission(id, out);
    // Before the fix, export re-hashed the forged bytes and the import accepted them as intact.
    expect(() => makeOrchestrator().orch.importMission(out)).toThrow(/failed their checksum before export/);
    // Flipping the flag in the file breaks the trailer hash.
    writeFileSync(out, readFileSync(out, 'utf8').replace('"intact":false', '"intact":true'));
    expect(() => makeOrchestrator().orch.importMission(out)).toThrow(/integrity check/);
  });
});
