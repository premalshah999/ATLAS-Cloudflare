// Scoring for the golden mission corpus (manual §45). Pure functions; no I/O.

export type Verdict = 'verified' | 'unverified' | 'failed' | 'none';

export interface CaseResult {
  id: string;
  category: string;
  title: string;
  status: 'ran' | 'skipped' | 'error';
  skipReason?: string;
  /** What the release gate said (or 'none' if the mission never reached the gate). */
  verdict: Verdict;
  /** What a correct system should say for this scenario, given what is knowable from the project. */
  expected: Verdict;
  /** Independent ground truth: does the delivered result actually do what was asked? null = not applicable. */
  oracle: boolean | null;
  oracleDetail: string;
  /** For fault-injection cases: did the system reach a stable, consistent final state? */
  recovered?: boolean;
  missionId: string | null;
  outcome: string;
  durationMs: number;
  resources: { toolCalls: number; commands: number; approvals: number; artifactBytes: number; tokens: number; skillLoads?: number };
  /** Traceable evidence for anything that went wrong: event seqs, check names, artifact ids. */
  trace: string[];
  note?: string;
}

/** Wilson score interval (95%). Honest for small samples, unlike the normal approximation. */
export function wilson(successes: number, n: number, z = 1.96): { rate: number | null; low: number | null; high: number | null } {
  if (n === 0) return { rate: null, low: null, high: null };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { rate: p, low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

export interface Summary {
  ran: number; skipped: number; errors: number;
  expectationMet: ReturnType<typeof wilson> & { k: number; n: number };
  taskSuccess: ReturnType<typeof wilson> & { k: number; n: number };
  /** Of the missions the gate marked verified, how many were actually wrong per the oracle. */
  falsePass: ReturnType<typeof wilson> & { k: number; n: number };
  /** Of the missions whose result was actually correct, how many the gate failed to verify. */
  falseFail: ReturnType<typeof wilson> & { k: number; n: number };
  recovery: ReturnType<typeof wilson> & { k: number; n: number };
  medianDurationMs: number | null;
  totals: CaseResult['resources'];
}

const rate = (k: number, n: number) => ({ ...wilson(k, n), k, n });

export function summarize(results: CaseResult[]): Summary {
  const ran = results.filter((r) => r.status === 'ran');
  const judged = ran.filter((r) => r.oracle !== null);
  const verified = judged.filter((r) => r.verdict === 'verified');
  const correct = judged.filter((r) => r.oracle === true);
  const rec = ran.filter((r) => r.recovered !== undefined);
  const durations = ran.map((r) => r.durationMs).sort((a, b) => a - b);
  const totals = { toolCalls: 0, commands: 0, approvals: 0, artifactBytes: 0, tokens: 0 };
  for (const r of ran) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r.resources[k];
  return {
    ran: ran.length, skipped: results.filter((r) => r.status === 'skipped').length, errors: results.filter((r) => r.status === 'error').length,
    expectationMet: rate(ran.filter((r) => r.verdict === r.expected).length, ran.length),
    taskSuccess: rate(judged.filter((r) => r.verdict === 'verified' && r.oracle === true).length, judged.length),
    falsePass: rate(verified.filter((r) => r.oracle === false).length, verified.length),
    falseFail: rate(correct.filter((r) => r.verdict !== 'verified').length, correct.length),
    recovery: rate(rec.filter((r) => r.recovered).length, rec.length),
    medianDurationMs: durations.length ? durations[Math.floor((durations.length - 1) / 2)] : null,
    totals,
  };
}

export interface RunMeta { runtime: string; model: string | null; /** Skill variant (Skill Laboratory): none, bundled, or a directory. */ skills?: string; atlasCommit: string; startedAt: string; platform: string; node: string; sandbox: string; browser: string | null }

/**
 * Compare against a baseline run. Only matched cases (same id) with the same runtime and model are compared;
 * anything else is reported as not comparable rather than as a regression or an improvement.
 */
export function compare(current: { meta: RunMeta; results: CaseResult[] }, baseline: { meta: RunMeta; results: CaseResult[] }) {
  if (current.meta.runtime !== baseline.meta.runtime || current.meta.model !== baseline.meta.model) {
    return { comparable: false as const, reason: `Different settings: ${baseline.meta.runtime}/${baseline.meta.model ?? 'default'} vs ${current.meta.runtime}/${current.meta.model ?? 'default'}`, regressions: [], improvements: [] };
  }
  const base = new Map(baseline.results.filter((r) => r.status === 'ran').map((r) => [r.id, r]));
  const ok = (r: CaseResult) => r.verdict === r.expected && !(r.verdict === 'verified' && r.oracle === false);
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const r of current.results.filter((x) => x.status === 'ran')) {
    const b = base.get(r.id);
    if (!b) continue;
    if (ok(b) && !ok(r)) regressions.push(r.id);
    if (!ok(b) && ok(r)) improvements.push(r.id);
  }
  return { comparable: true as const, reason: '', regressions, improvements };
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(0)}%`);
const ci = (r: ReturnType<typeof rate>) => (r.n ? `${pct(r.rate)} (${r.k}/${r.n}; 95% CI ${pct(r.low)}–${pct(r.high)})` : 'n/a (0 cases)');

const oneLine = (x: string) => x.replace(/\r?\n/g, '⏎').replace(/\t/g, '⇥').replace(/\|/g, '\\|');

export function renderMarkdown(meta: RunMeta, results: CaseResult[], s: Summary, cmp?: ReturnType<typeof compare> | null): string {
  const L: string[] = [];
  L.push('# ATLAS evaluation report', '');
  L.push(`Generated by \`pnpm eval\` on ${meta.startedAt} from commit \`${meta.atlasCommit.slice(0, 12)}\`. Runtime: **${meta.runtime}**${meta.model ? ` (${meta.model})` : ''}. Platform: ${meta.platform}, Node ${meta.node}, sandbox: ${meta.sandbox}, browser: ${meta.browser ?? 'none'}.`, '');
  if (meta.runtime === 'fake') L.push('> The scripted runtime makes the agent\'s decisions deterministic. These numbers measure ATLAS\'s gates, isolation and recovery against known agent behavior, **not** a model\'s coding ability, and say nothing about how ATLAS compares with other products. Run with `ATLAS_EVAL_RUNTIME=pi` and a provider key to evaluate a real model.', '');
  L.push('## Summary', '', '| Metric | Value |', '| --- | --- |');
  L.push(`| Cases run / skipped / errored | ${s.ran} / ${s.skipped} / ${s.errors} |`);
  L.push(`| System behaved as expected | ${ci(s.expectationMet)} |`);
  L.push(`| Task success (verified and actually correct) | ${ci(s.taskSuccess)} |`);
  L.push(`| **False pass rate** (verified but actually wrong) | ${ci(s.falsePass)} |`);
  L.push(`| False fail rate (correct but not verified) | ${ci(s.falseFail)} |`);
  L.push(`| Recovery after fault injection | ${ci(s.recovery)} |`);
  L.push(`| Median mission wall time | ${s.medianDurationMs === null ? '—' : `${(s.medianDurationMs / 1000).toFixed(1)} s`} |`);
  L.push(`| Totals | ${s.totals.toolCalls} tool calls, ${s.totals.commands} commands, ${s.totals.approvals} approvals, ${(s.totals.artifactBytes / 1024).toFixed(0)} KiB artifacts, ${s.totals.tokens} tokens |`, '');
  if (cmp) L.push('## Against the baseline', '', cmp.comparable ? `Regressions: ${cmp.regressions.join(', ') || 'none'}. Improvements: ${cmp.improvements.join(', ') || 'none'}.` : `Not comparable: ${cmp.reason}.`, '');
  L.push('## Cases', '', '| Case | Category | Gate verdict | Expected | Oracle | Time | Tools · cmds · approvals |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    if (r.status !== 'ran') { L.push(`| ${r.id} | ${r.category} | ${r.status}: ${r.skipReason ?? ''} | ${r.expected} | — | — | — |`); continue; }
    const flag = r.verdict === 'verified' && r.oracle === false ? ' ⚠ false pass' : r.verdict !== r.expected ? ' ✗ unexpected' : ' ✓';
    L.push(`| ${r.id} | ${r.category} | ${r.verdict}${flag} | ${r.expected} | ${r.oracle === null ? 'n/a' : r.oracle ? 'correct' : 'wrong'} | ${(r.durationMs / 1000).toFixed(1)} s | ${r.resources.toolCalls} · ${r.resources.commands} · ${r.resources.approvals} |`);
  }
  L.push('', '## Details and traces', '');
  for (const r of results) {
    L.push(`### ${r.id} — ${r.title}`, '');
    if (r.status !== 'ran') { L.push(`${r.status === 'skipped' ? 'Skipped' : 'Errored'}: ${r.skipReason ?? ''}`, ''); continue; }
    L.push(`- Mission \`${r.missionId}\`; outcome: ${oneLine(r.outcome || '(none)')}`);
    L.push(`- Oracle: ${oneLine(r.oracleDetail)}`);
    if (r.recovered !== undefined) L.push(`- Recovered: ${r.recovered ? 'yes' : 'no'}`);
    if (r.note) L.push(`- Note: ${oneLine(r.note)}`);
    for (const t of r.trace) L.push(`- ${oneLine(t)}`);
    L.push('');
  }
  return L.join('\n');
}
