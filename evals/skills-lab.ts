// Skill Laboratory (ADR 0013): run the golden corpus without skills and with a skill set, on the same runtime and
// model, and compare. `pnpm lab:skills [bundled|<dir>]`; set ATLAS_EVAL_RUNTIME=pi (+ a provider key) for a
// meaningful comparison. The scripted runtime never reads skills, so a fake run only proves the harness works.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, type CaseResult, type RunMeta } from './metrics';
import { ensureDir } from './corpus';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const variant = process.argv[2] ?? 'bundled';
const repeat = Math.max(1, Number(process.env.ATLAS_LAB_REPEAT ?? 1));
const out = ensureDir(process.env.ATLAS_LAB_OUT ?? path.join(root, 'evals/out/skills-lab'));

type Run = { meta: RunMeta; summary: any; results: CaseResult[] };
function runOnce(skills: string, i: number): Run {
  const dir = ensureDir(path.join(out, `${skills === 'none' ? 'baseline' : 'skills'}-${i}`));
  try {
    execFileSync('pnpm', ['-s', 'vitest', 'run', '--project', 'eval'], { cwd: root, stdio: 'inherit', env: { ...process.env, ATLAS_EVAL_OUT: dir, ATLAS_EVAL_SKILLS: skills, ATLAS_EVAL_BASELINE: path.join(dir, 'none.json') } });
  } catch { /* a live model may miss expectations; the report still counts them */ }
  return JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8')) as Run;
}

const A: Run[] = [];
const B: Run[] = [];
for (let i = 0; i < repeat; i++) { A.push(runOnce('none', i)); B.push(runOnce(variant, i)); }

const agg = (runs: Run[]) => {
  const ran = runs.flatMap((r) => r.results.filter((x) => x.status === 'ran'));
  const verified = ran.filter((r) => r.verdict === 'verified' && r.oracle !== null);
  const sum = (f: (r: CaseResult) => number) => ran.reduce((n, r) => n + f(r), 0);
  return {
    cases: ran.length,
    expected: ran.filter((r) => r.verdict === r.expected).length,
    falsePass: `${verified.filter((r) => r.oracle === false).length}/${verified.length}`,
    correctDelivered: ran.filter((r) => r.oracle === true).length,
    toolCalls: sum((r) => r.resources.toolCalls),
    tokens: sum((r) => r.resources.tokens),
    skillLoads: sum((r) => r.resources.skillLoads ?? 0),
    seconds: Math.round(sum((r) => r.durationMs) / 1000),
  };
};
const a = agg(A), b = agg(B);
const meta = B[0].meta;
const cmp = A.map((x, i) => compare(B[i], x));
const lines = [
  '# Skill Laboratory report', '',
  `Runtime **${meta.runtime}**${meta.model ? ` (${meta.model})` : ''} · commit \`${meta.atlasCommit.slice(0, 12)}\` · ${repeat} repetition${repeat > 1 ? 's' : ''} per arm · variant **${variant}** vs **none**.`, '',
  ...(meta.runtime === 'fake' ? ['> **Harness check only.** The scripted runtime follows fixed scripts and never reads skills, so both arms behave identically by construction. Run with `ATLAS_EVAL_RUNTIME=pi` and a provider key to measure skills.', ''] : []),
  '| Metric | No skills | With skills |', '|---|---|---|',
  `| Cases run | ${a.cases} | ${b.cases} |`,
  `| Behaved as expected | ${a.expected} | ${b.expected} |`,
  `| False passes (verified but wrong) | ${a.falsePass} | ${b.falsePass} |`,
  `| Correct result delivered (oracle) | ${a.correctDelivered} | ${b.correctDelivered} |`,
  `| Tool calls | ${a.toolCalls} | ${b.toolCalls} |`,
  `| Tokens | ${a.tokens} | ${b.tokens} |`,
  `| Skill loads | ${a.skillLoads} | ${b.skillLoads} |`,
  `| Wall time (s) | ${a.seconds} | ${b.seconds} |`, '',
  '## Per-repetition comparison (cases that changed from expected/unexpected)',
  ...cmp.map((c, i) => `- repetition ${i + 1}: ${c.comparable ? `improved: ${c.improvements.join(', ') || 'none'}; regressed: ${c.regressions.join(', ') || 'none'}` : `not comparable: ${c.reason}`}`), '',
  'No claim is made from fewer than several repetitions on a live model; differences of one case are within noise.',
];
writeFileSync(path.join(out, 'report.md'), lines.join('\n') + '\n');
writeFileSync(path.join(out, 'report.json'), JSON.stringify({ variant, repeat, baseline: a, skills: b, comparisons: cmp, meta }, null, 2));
console.log(lines.join('\n'));
