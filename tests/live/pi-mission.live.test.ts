// Live Pi integration (P0 "prove real autonomous coding works"). A real model plans and implements the sample
// fix through ATLAS's governed tools, inside the OS sandbox; the gate verifies it; and an oracle with cases the
// model never saw judges the delivered commit. Runs only with a provider key in the environment:
//   ANTHROPIC_API_KEY=… [ATLAS_LIVE_MODEL=provider/model] pnpm test:live
// Nothing is mocked. Privileged commands the model asks for are denied (the run must succeed with safe tools).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiRuntime } from '@atlas/runtime-pi';
import { sampleRepo, tmpDir } from '../helpers';
import { autoDecide, explainChecks, makeOrchestrator, startMission } from '../integration/harness';

const KEYS: Record<string, string> = {};
for (const [p, env] of Object.entries({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' })) if (process.env[env]) KEYS[p] = process.env[env]!;
const live = Object.keys(KEYS).length > 0;
const BUNDLED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');

/** Cases the model never sees: not in the repository, the prompt, or any tool output. */
const HIDDEN: [string, string][] = [['Rock & Roll', 'rock-roll'], ["It's 9 o'clock", 'its-9-oclock'], ['  Multiple   Spaces  ', 'multiple-spaces'], ['UPPER lower', 'upper-lower']];
function oracle(root: string, commit: string): string[] {
  const dir = tmpDir('atlas-live-oracle-');
  // A tar file inside the target, extracted with a relative name: GNU tar reads "C:\\…" as a remote host.
  execFileSync('git', ['-C', root, 'archive', '--format=tar', '-o', path.join(dir, '.export.tar'), commit]);
  execFileSync('tar', ['-xf', '.export.tar'], { cwd: dir });
  rmSync(path.join(dir, '.export.tar'), { force: true });
  writeFileSync(path.join(dir, 'o.mjs'), `import { slugify } from './src/slugify.js';\nconsole.log(JSON.stringify(${JSON.stringify(HIDDEN)}.filter(([i, o]) => slugify(i) !== o)));`);
  return JSON.parse(execFileSync('node', ['o.mjs'], { cwd: dir, encoding: 'utf8' }));
}

describe.skipIf(!live)(`live Pi mission (${live ? Object.keys(KEYS).join(', ') : 'no provider key: skipped'})`, () => {
  for (const variant of ['no skills', 'bundled skills'] as const) {
    it(`plans, implements and verifies the sample fix (${variant}); the hidden oracle agrees; no key leaks`, async () => {
      const root = sampleRepo();
      const runtime = new PiRuntime({ agentDir: tmpDir('atlas-live-pi-'), apiKeys: KEYS, model: process.env.ATLAS_LIVE_MODEL });
      const h = makeOrchestrator({ runtime, runtimeKind: 'pi', skillsDir: variant === 'bundled skills' ? BUNDLED : undefined });
      const id = await startMission(h, root, { runtime: 'pi', goal: 'slugify() in src/slugify.js should produce valid URL slugs: lowercase, words joined by single hyphens, punctuation removed, no leading or trailing hyphens. Make the existing tests pass.' });
      const stop = ['shell_exec', 'unsandboxed_run'].map((t) => autoDecide(h, id, t, 'deny'));
      await h.orch.settle(id);
      stop.forEach((s) => s());
      const m = h.repo.mission(id)!;
      const ev = h.repo.eventsSince(id, 0, 100_000);
      const usage = ev.filter((e) => e.type === 'agent.usage').reduce((n, e) => n + Number(e.payload.inputTokens ?? 0) + Number(e.payload.outputTokens ?? 0), 0);
      const report = { variant, verdict: m.verdict, outcome: m.outcome, toolCalls: ev.filter((e) => e.type === 'agent.tool_call').length, tokens: usage, skillLoads: ev.filter((e) => e.type === 'skill.loaded').map((e) => e.payload.skill) };
      console.log('live result', JSON.stringify(report));
      expect(m.verdict, explainChecks(h, id)).toBe('verified');
      expect(oracle(root, m.integrationCommit!)).toEqual([]);
      // Real model traffic never puts a provider key into the record.
      const file = path.join(tmpDir(), 'live.jsonl');
      h.orch.exportMission(id, file);
      const exported = readFileSync(file, 'utf8');
      for (const k of Object.values(KEYS)) expect(exported).not.toContain(k);
    });
  }
});

it.skipIf(live)('live tests need a provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY)', () => {
  expect(live).toBe(false);
});
