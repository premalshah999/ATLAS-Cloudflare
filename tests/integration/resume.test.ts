// Durable Pi sessions across a daemon restart: the real Pi adapter, driven by Pi's scripted faux model (no network,
// no credentials). Attempt 1 writes the fix and starts a long command; the daemon stops; the restarted daemon's next
// attempt continues attempt 1's conversation on a snapshot of its files.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import type { AgentRuntime } from '@atlas/contracts';
import { PiRuntime } from '@atlas/runtime-pi';
import { SAMPLE_FIX } from '@atlas/runtime-fake';
import { git } from '@atlas/workspace';
import { sampleRepo, tmpDir } from '../helpers';
import { autoDecide, explainChecks, makeOrchestrator, startMission, waitFor } from './harness';

/** The Pi adapter over a faux model. Planning is left to the deterministic planner (no `plan`). */
function pi(agentDir: string, responses: FauxResponseStep[]): AgentRuntime & { canResume(id: string): boolean } {
  const faux = createFauxCore({ provider: 'atlas-faux' });
  const fm = faux.getModel();
  faux.setResponses(responses);
  const rt = new PiRuntime({
    agentDir, model: `atlas-faux/${fm.id}`,
    configure: (r) => r.registerProvider('atlas-faux', {
      name: 'Faux', baseUrl: 'http://faux.invalid', apiKey: 'test-only', api: faux.api, streamSimple: faux.streamSimple as any,
      models: [{ id: fm.id, name: 'Faux', reasoning: false, input: ['text'], cost: fm.cost, contextWindow: 100_000, maxTokens: 4096 }],
    }),
  });
  return {
    kind: 'pi', health: () => rt.health(), start: (i) => rt.start(i), stream: (h) => rt.stream(h), interrupt: (h) => rt.interrupt(h),
    resume: () => rt.resume(), dispose: (h) => rt.dispose(h), canResume: (id) => rt.canResume(id), discard: (id) => rt.discard(id),
  };
}

const text = (m: any): string => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c: any) => c.text ?? '').join(''));
const isTask = (ctx: any, key: string) => ctx.messages.some((m: any) => m.role === 'user' && text(m).includes(`Work on task ${key} now.`));

const attempt1: FauxResponseStep[] = [
  fauxAssistantMessage([fauxText('Writing the fix.'), fauxToolCall('write_file', { path: 'src/slugify.js', content: SAMPLE_FIX })], { stopReason: 'toolUse' }),
  fauxAssistantMessage([fauxToolCall('shell_exec', { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] })], { stopReason: 'toolUse' }),
];

async function interruptedMission() {
  const root = sampleRepo();
  // Pi's directory lives in the ATLAS data directory, as in the daemon, so the restarted daemon finds it.
  const dataDir = tmpDir('atlas-data-');
  const piDir = path.join(dataDir, 'pi');
  const first = makeOrchestrator({ dataDir, runtimeKind: 'pi', runtime: pi(piDir, attempt1) });
  const id = await startMission(first, root, { runtime: 'pi' });
  const stop = autoDecide(first, id, 'shell_exec');
  await waitFor(() => first.events.find((e) => e.type === 'process.started'), 30_000);
  stop();
  await first.orch.shutdown();
  const lost = first.repo.attempts(id)[0];
  first.db.close();
  return { root, id, dataDir, piDir, lost };
}

describe('durable Pi sessions across a daemon restart', () => {
  it('the next attempt continues the lost conversation on the lost files, and the mission verifies', async () => {
    const { root, id, dataDir, piDir, lost } = await interruptedMission();

    let resumedContext: any[] = [];
    const answer: FauxResponseStep = (ctx) => {
      if (isTask(ctx, 'review')) return fauxAssistantMessage('Reviewed the change; it matches the acceptance criteria.');
      if (isTask(ctx, 'security')) return fauxAssistantMessage('No security problems in this change.');
      resumedContext = ctx.messages;
      return fauxAssistantMessage('The fix was written before the restart; the command I started was stopped. Done.');
    };
    const rt = pi(piDir, [answer, answer, answer, answer]);
    expect(rt.canResume(lost.id)).toBe(true);
    const second = makeOrchestrator({ dataDir, runtimeKind: 'pi', runtime: rt });
    const r = await second.orch.recover();
    expect(r).toMatchObject({ missions: [id], lostAttempts: 1 });
    await second.orch.settle(id);

    const attempts = second.repo.attempts(id);
    expect(attempts.map((a) => a.state)).toEqual(['lost', 'succeeded', 'succeeded', 'succeeded']); // coder (lost, resumed), reviewer, security engineer
    const started = second.events.find((e) => e.type === 'attempt.started' && e.attemptId === attempts[1].id)!;
    expect(started.payload.resumedFrom).toMatchObject({ attemptId: lost.id, number: 1 });

    // The model saw its own earlier turns: the task prompt, the write it made, then the resume note.
    const users = resumedContext.filter((m) => m.role === 'user').map(text);
    expect(users[0]).toContain('Work on task implement now.');
    expect(users.at(-1)).toMatch(/^ATLAS restarted while you were working on task implement/);
    expect(resumedContext.some((m) => m.role === 'toolResult' && m.toolName === 'write_file')).toBe(true);

    // The lost attempt's uncommitted write is preserved on its branch and carried into the result.
    const snapshot = (started.payload.resumedFrom as { commit: string }).commit;
    expect((await git(root, ['log', '-1', '--format=%s', snapshot])).out).toMatch(/attempt 1 \(interrupted\)/);
    const patch = second.events.find((e) => e.type === 'workspace.worktree' && e.payload.action === 'checkpoint' && e.attemptId === attempts[1].id)!;
    expect((patch.payload.files as { path: string }[]).map((f) => f.path)).toContain('src/slugify.js');
    expect(second.repo.mission(id)!.verdict, explainChecks(second, id)).toBe('verified');

    // Saved conversations are deleted once attempts end.
    expect(existsSync(path.join(piDir, 'sessions')) ? readdirSync(path.join(piDir, 'sessions')) : []).toEqual([]);
  }, 120_000);

  it('without the lost worktree the next attempt starts fresh, and the saved conversation is deleted', async () => {
    const { id, dataDir, piDir, lost } = await interruptedMission();
    rmSync(path.join(dataDir, 'worktrees', id, 'implement-1'), { recursive: true, force: true });

    let fresh: any[] = [];
    const answer: FauxResponseStep = (ctx) => {
      if (isTask(ctx, 'implement') && !fresh.length) {
        fresh = ctx.messages;
        return fauxAssistantMessage([fauxToolCall('write_file', { path: 'src/slugify.js', content: SAMPLE_FIX })], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('Done.');
    };
    const rt = pi(piDir, [answer, answer, answer, answer, answer]);
    const second = makeOrchestrator({ dataDir, runtimeKind: 'pi', runtime: rt });
    await second.orch.recover();
    expect(rt.canResume(lost.id)).toBe(false);
    await second.orch.settle(id);

    const attempts = second.repo.attempts(id);
    const started = second.events.find((e) => e.type === 'attempt.started' && e.attemptId === attempts[1].id)!;
    expect(started.payload.resumedFrom).toBeUndefined();
    expect(fresh.filter((m) => m.role === 'user')).toHaveLength(1); // only the task prompt: no earlier conversation
    expect(second.repo.mission(id)!.verdict, explainChecks(second, id)).toBe('verified');
  }, 120_000);
});
