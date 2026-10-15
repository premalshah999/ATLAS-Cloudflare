// `pnpm eval`: runs the golden corpus and writes docs/eval/latest.{md,json} (manual §45).
// Fails only when the system misbehaves on a deterministic (scripted) case; a false pass is always reported.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveBrowser } from '@atlas/browser';
import { PiRuntime } from '@atlas/runtime-pi';
import { detectSandbox } from '@atlas/terminal';
import { tmpDir } from '../tests/helpers';
import { makeOrchestrator } from '../tests/integration/harness';
import { CORPUS, ensureDir, type CaseRun } from './corpus';
import { compare, renderMarkdown, summarize, type CaseResult, type RunMeta } from './metrics';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = ensureDir(process.env.ATLAS_EVAL_OUT ?? path.join(root, 'docs/eval'));
const runtime = process.env.ATLAS_EVAL_RUNTIME === 'pi' ? 'pi' : 'fake';
const only = process.env.ATLAS_EVAL_CASES?.split(',').filter(Boolean);
/** Skill Laboratory variant: no skills (default), the bundled library, or another skill directory. */
const skillsVariant = process.env.ATLAS_EVAL_SKILLS ?? 'none';
const skillsDir = skillsVariant === 'none' ? undefined : skillsVariant === 'bundled' ? path.join(root, 'skills') : path.resolve(skillsVariant);

function piRuntime() {
  const keys: Record<string, string> = {};
  for (const [p, env] of Object.entries({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' })) if (process.env[env]) keys[p] = process.env[env]!;
  if (!Object.keys(keys).length) throw new Error('ATLAS_EVAL_RUNTIME=pi needs a provider key in the environment');
  return new PiRuntime({ agentDir: tmpDir('atlas-eval-pi-'), apiKeys: keys, model: process.env.ATLAS_EVAL_MODEL });
}

it('golden mission corpus', async () => {
  const meta: RunMeta = {
    runtime, model: runtime === 'pi' ? process.env.ATLAS_EVAL_MODEL ?? 'default' : null, skills: skillsVariant,
    atlasCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    startedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.versions.node,
    sandbox: detectSandbox().kind, browser: resolveBrowser().path ? 'chromium' : null,
  };
  // The real-model run replaces the scripted agent; the repositories, oracles and gates stay identical.
  const make = (o: Parameters<typeof makeOrchestrator>[0]) => makeOrchestrator({ ...(runtime === 'pi' && !o?.runtime ? { ...o, runtime: piRuntime(), scripts: undefined } : o), skillsDir });
  const results: CaseResult[] = [];
  for (const c of CORPUS.filter((x) => !only || only.includes(x.id))) {
    const base = { id: c.id, category: c.category, title: c.title, expected: c.expected, verdict: 'none' as const, oracle: null, oracleDetail: '', missionId: null, outcome: '', durationMs: 0, resources: { toolCalls: 0, commands: 0, approvals: 0, artifactBytes: 0, tokens: 0 }, trace: [] };
    const missing = c.requires?.();
    if (missing) { results.push({ ...base, status: 'skipped', skipReason: missing }); continue; }
    const t0 = Date.now();
    let run: CaseRun | null = null;
    try {
      run = await c.run(make);
      const durationMs = Date.now() - t0;
      const { h, missionId } = run;
      const ev = h.repo.eventsSince(missionId, 0, 100_000);
      const gate = [...ev].reverse().find((e) => e.type === 'gate.result');
      const m = h.repo.mission(missionId)!;
      const verdict = (gate?.payload.verdict as CaseResult['verdict']) ?? 'none';
      const o = c.oracle(run);
      const trace: string[] = [];
      for (const ch of h.repo.checks(missionId).filter((x) => x.result !== 'pass')) trace.push(`check \`${ch.name}\` ${ch.result}${ch.required ? ' (required)' : ''}: ${ch.reason ?? ''}${ch.artifactId ? ` · log ${ch.artifactId}` : ''}`);
      for (const e of ev.filter((x) => (x.type === 'policy.decision' && x.payload.decision === 'deny') || (x.type === 'agent.tool_result' && x.payload.ok === false) || x.type === 'error' || x.type === 'integration.result' && x.payload.ok === false || x.type === 'rollback.result')) {
        trace.push(`event #${e.seq} \`${e.type}\`: ${JSON.stringify(e.payload).slice(0, 220)}`);
      }
      if (gate) trace.push(`event #${gate.seq} \`gate.result\`: ${gate.payload.summary}`);
      const exportFile = path.join(ensureDir(path.join(root, 'evals/out')), `${c.id}.jsonl`);
      try { await h.orch.exportMission(missionId, exportFile); trace.push(`audit export: evals/out/${c.id}.jsonl (local, not committed)`); } catch (e) { trace.push(`audit export failed: ${(e as Error).message}`); }
      results.push({
        ...base, status: 'ran', verdict, oracle: o.ok, oracleDetail: o.detail, missionId, outcome: m.outcome ?? '', durationMs, recovered: run.recovered, note: run.note && !run.note.startsWith('canary=') ? run.note : undefined, trace,
        resources: {
          toolCalls: ev.filter((e) => e.type === 'agent.tool_call').length, commands: ev.filter((e) => e.type === 'process.started').length,
          approvals: h.repo.approvals(missionId).length, artifactBytes: h.artifacts.list(missionId).reduce((n, a) => n + a.size, 0),
          tokens: ev.filter((e) => e.type === 'agent.usage').reduce((n, e) => n + Number(e.payload.inputTokens ?? 0) + Number(e.payload.outputTokens ?? 0), 0),
          skillLoads: ev.filter((e) => e.type === 'skill.loaded').length,
        },
      });
    } catch (e) {
      results.push({ ...base, status: 'error', skipReason: (e as Error).stack?.split('\n').slice(0, 3).join(' ') ?? String(e), durationMs: Date.now() - t0 });
    } finally {
      await run?.cleanup?.();
      await run?.h.orch.shutdown().catch(() => {});
    }
  }
  const summary = summarize(results);
  const prevFile = process.env.ATLAS_EVAL_BASELINE ?? path.join(outDir, 'latest.json');
  const prev = existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, 'utf8')) : null;
  const cmp = prev ? compare({ meta, results }, prev) : null;
  writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify({ meta, summary, results, comparison: cmp }, null, 2) + '\n');
  writeFileSync(path.join(outDir, 'latest.md'), renderMarkdown(meta, results, summary, cmp) + '\n');
  console.log(`eval: ${summary.ran} ran, ${summary.skipped} skipped, ${summary.errors} errors; expected behavior ${summary.expectationMet.k}/${summary.expectationMet.n}; false passes ${summary.falsePass.k}/${summary.falsePass.n}. Report: ${path.join(outDir, 'latest.md')}`);

  expect(results.filter((r) => r.status === 'error').map((r) => `${r.id}: ${r.skipReason}`)).toEqual([]);
  if (runtime === 'fake') {
    // Scripted agents are deterministic: any deviation from the expected verdict is an ATLAS regression.
    expect(results.filter((r) => r.status === 'ran' && r.verdict !== r.expected).map((r) => `${r.id}: got ${r.verdict}, expected ${r.expected} — ${r.outcome}`)).toEqual([]);
    expect(results.filter((r) => r.recovered === false).map((r) => r.id)).toEqual([]);
  }
}, 30 * 60_000);
