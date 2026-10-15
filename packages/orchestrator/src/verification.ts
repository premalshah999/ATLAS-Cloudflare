// Verification recipes and the release gate (manual §28, §32). A check passes only on a real exit code.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CheckRecord, CheckResult } from '@atlas/contracts';
import { loadConfig } from '@atlas/workspace';

export interface Recipe { name: string; command: string; args: string[]; required: boolean; timeoutMs: number }

function pkgManager(root: string): 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** Discover checks from project scripts. Unknown projects get no recipes (reported as not configured). */
export function detectRecipes(root: string): Recipe[] {
  // Explicit recipes from atlas.config.json come first; they run in the sandbox like everything else.
  const { config } = loadConfig(root);
  const fromConfig: Recipe[] = (config?.checks ?? []).map((c) => ({ name: c.name, command: c.command[0], args: c.command.slice(1), required: c.required, timeoutMs: c.timeoutSec * 1000 }));
  const names = new Set(fromConfig.map((r) => r.name));
  return [...fromConfig, ...detectScriptRecipes(root).filter((r) => !names.has(r.name))];
}

function detectScriptRecipes(root: string): Recipe[] {
  const file = path.join(root, 'package.json');
  if (!existsSync(file)) return [];
  let scripts: Record<string, string> = {};
  try { scripts = JSON.parse(readFileSync(file, 'utf8')).scripts ?? {}; } catch { return []; }
  const pm = pkgManager(root);
  const out: Recipe[] = [];
  const test = scripts.test;
  if (test && !/no test specified/.test(test)) out.push({ name: 'tests', command: pm, args: pm === 'npm' ? ['test'] : ['run', 'test'], required: true, timeoutMs: 10 * 60_000 });
  for (const s of ['typecheck', 'lint']) if (scripts[s]) out.push({ name: s, command: pm, args: ['run', s], required: false, timeoutMs: 10 * 60_000 });
  return out;
}

export type Verdict = 'verified' | 'unverified' | 'failed';

/**
 * Checks that gate release but are not evidence the software works: a clean review, an approval.
 * They can block; they can never on their own make a result "verified".
 */
export const GATE_ONLY = new Set(['review', 'verification-definition', 'security']);

/** Aggregate checks. Only `pass` satisfies a required check; missing checks never count as success. */
export function gate(checks: Pick<CheckRecord, 'name' | 'required' | 'result' | 'reason'>[]): { verdict: Verdict; summary: string } {
  const required = checks.filter((c) => c.required);
  const failedReq = required.filter((c) => c.result !== 'pass');
  if (failedReq.length) {
    return { verdict: 'failed', summary: `Blocked: ${failedReq.map((c) => `${c.name} ${label(c.result)}`).join(', ')}` };
  }
  const evidence = checks.filter((c) => c.result === 'pass' && !GATE_ONLY.has(c.name));
  // An unchanged verification definition is the normal case; say nothing about it in the summary.
  const gates = checks.filter((c) => c.result === 'pass' && GATE_ONLY.has(c.name) && c.name !== 'verification-definition');
  const other = checks.filter((c) => !c.required && c.result !== 'pass');
  const tail = [...gates.map((c) => `${c.name} passed`), ...other.map((c) => `${c.name} ${label(c.result)}`)];
  if (!evidence.length) {
    const what = checks.filter((c) => !GATE_ONLY.has(c.name));
    return { verdict: 'unverified', summary: `Unverified: no check ran to a pass${what.length ? ` (${what.map((c) => `${c.name} ${label(c.result)}`).join(', ')})` : ' — no test command configured'}${gates.length ? `; ${gates.map((c) => `${c.name} passed`).join(', ')}` : ''}` };
  }
  return { verdict: 'verified', summary: `Verified: ${evidence.map((c) => c.name).join(', ')} passed${tail.length ? `; ${tail.join(', ')}` : ''}` };
}

export function label(r: CheckResult): string {
  return { pass: 'passed', fail: 'failed', skipped: 'skipped', inconclusive: 'inconclusive', not_configured: 'not configured' }[r];
}

/**
 * A test run that executed zero tests (or skipped every test) is not evidence, even when it exits 0. Only the
 * runners' summary lines are read, and a run is "empty" only when every summary found reports zero, so a monorepo
 * with one empty package, or a test that prints "No tests found", is not misread. Returns a reason, or null.
 */
export function noTestsRan(output: string): string | null {
  // eslint-disable-next-line no-control-regex -- strip ANSI colour codes from runner output
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).slice(-200);
  const counts: number[] = [];
  let phrase: string | null = null;
  const num = (re: RegExp) => { for (const l of lines) { const m = re.exec(l); if (m) counts.push(Number(m[1])); } };
  num(/^(?:#|ℹ) tests (\d+)\s*$/); // node --test (TAP and spec reporters)
  num(/^Tests:\s+(?:.*?,\s*)?(\d+) total/); // jest
  num(/^\s*Tests\s+(?:.*?)\((\d+)\)\s*$/); // vitest summary "Tests  5 passed (5)"
  num(/^\s*(\d+) passing\b/); // mocha
  num(/^running (\d+) tests?$/); // cargo
  num(/^=+ .*?(\d+) passed/); // pytest "== 3 passed in 0.1s =="
  if (lines.some((l) => /^No tests found, exiting with code/.test(l))) phrase = 'The runner found no tests (jest)';
  if (lines.some((l) => /^No test files found, exiting with code/.test(l))) phrase = 'The runner found no test files (vitest)';
  if (lines.some((l) => /^=+ no tests ran\b/i.test(l))) phrase = 'The runner reported no tests ran (pytest)';
  if (lines.length && lines.filter((l) => /^(ok|FAIL|\?)\s/.test(l)).length && lines.filter((l) => /^(ok|FAIL|\?)\s/.test(l)).every((l) => /\[no test files\]/.test(l))) phrase = 'No package had test files (go test)';
  if (counts.some((c) => c > 0)) {
    // Something ran. Still empty if node --test reports every test skipped or todo.
    const pass = lines.map((l) => /^(?:#|ℹ) pass (\d+)\s*$/.exec(l)).find(Boolean);
    const fail = lines.map((l) => /^(?:#|ℹ) fail (\d+)\s*$/.exec(l)).find(Boolean);
    const skip = lines.map((l) => /^(?:#|ℹ) (?:skipped|todo) (\d+)\s*$/.exec(l)).filter(Boolean).reduce((n, m) => n + Number(m![1]), 0);
    if (pass && Number(pass[1]) === 0 && fail && Number(fail[1]) === 0 && skip > 0) return `Every test was skipped or todo (${skip})`;
    return null;
  }
  if (counts.length) return 'The runner reported 0 tests';
  return phrase;
}
