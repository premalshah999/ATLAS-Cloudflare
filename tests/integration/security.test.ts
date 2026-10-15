// The security engineer layer (ADR 0023) on real missions: ATLAS's scan runs on every integrated change and blocks
// on what it confirms; the security engineer role reviews in parallel with the reviewer and uses the same scan.
import { describe, expect, it } from 'vitest';
import { forTask, SAMPLE_FIX, sampleSlugifyScript } from '@atlas/runtime-fake';
import { validatePlan } from '@atlas/orchestrator';
import { sampleRepo } from '../helpers';
import { explainChecks, makeOrchestrator, startMission } from './harness';

// A Stripe live key: a format ATLAS's redaction does not mask, so it reaches the file and only the scan can catch it.
const stripe = 'sk' + '_live_' + 'R8xq2LmN0pV7tY4wZ1kC9bHs';
// The coder fixes slugify (a real fix), and also adds a helper that leaks a key and builds a shell command.
const leaky = forTask('implement', [
  { tool: 'write_file', args: { path: 'src/deploy.js', content: `import { exec } from 'node:child_process';\nconst KEY = '${stripe}';\nexport const deploy = (branch) => exec(\`git push origin \${branch}\`);\n` } },
  { tool: 'write_file', args: { path: 'src/slugify.js', content: SAMPLE_FIX } },
  { claim: 'Fixed slugify and added a deploy helper.' },
]);

describe('security engineer layer (ADR 0023)', () => {
  it('a clean change passes the security gate; the security engineer runs the scan in parallel with the review', async () => {
    const h = makeOrchestrator({ scripts: [sampleSlugifyScript] });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.verdict, explainChecks(h, id)).toBe('verified');
    expect(m.outcome).toMatch(/review passed, security passed/);
    const sec = h.repo.checks(id).find((c) => c.name === 'security')!;
    expect(sec).toMatchObject({ required: true, result: 'pass', reason: 'No security problems found in the change' });
    expect(h.artifacts.read(sec.artifactId!).text).toMatch(/nothing found/);
    const task = h.repo.tasks(id).find((t) => t.key === 'security')!;
    expect(task).toMatchObject({ role: 'security_reviewer', state: 'done', dependencies: [h.repo.tasks(id).find((t) => t.key === 'implement')!.id] });
    expect(h.events.some((e) => e.type === 'agent.tool_call' && e.taskId === task.id && e.payload.tool === 'security_scan')).toBe(true);
  }, 120_000);

  it('blocks a change that leaks a credential and builds a shell command, until the operator resolves it', async () => {
    const h = makeOrchestrator({ scripts: [leaky] });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.verdict).toBe('failed');
    expect(m.outcome).toMatch(/Blocked: security failed/);
    const found = h.repo.findings(id).filter((f) => f.source === 'security');
    expect(found.map((f) => [f.severity, f.kind, f.file, f.line, f.title]).sort()).toEqual([
      ['high', 'confirmed', 'src/deploy.js', 2, 'Stripe live secret key committed'],
      ['high', 'confirmed', 'src/deploy.js', 3, 'Shell command built from a string'],
    ]);
    // The evidence masks the key; nothing in the record carries it.
    expect(JSON.stringify(found)).not.toContain(stripe);
    expect(h.events.filter((e) => e.type === 'finding.reported' && e.actor.kind === 'system').length).toBe(2);
    // The agent review is unaffected: the scan has its own check.
    expect(h.repo.checks(id).find((c) => c.name === 'review')!.result).toBe('pass');

    // The operator dismisses both (e.g. a test key and a trusted input); re-verification passes, and the
    // dismissal survives because the scan finds the same results again.
    for (const f of found) h.orch.updateFinding(f.id, 'dismissed');
    await h.orch.reverify(id);
    expect(h.repo.mission(id)!.verdict, explainChecks(h, id)).toBe('verified');
    expect(h.repo.findings(id).filter((f) => f.source === 'security')).toHaveLength(2);
  }, 120_000);

  it('advisory mode records the same results without blocking; with the AI review off there is no security task', async () => {
    const h = makeOrchestrator({ scripts: [leaky] });
    h.repo.setSetting('security.gate', 'advisory');
    h.repo.setSetting('security.aiReview', false);
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    expect(h.repo.mission(id)!.verdict, explainChecks(h, id)).toBe('verified');
    expect(h.repo.findings(id).filter((f) => f.source === 'security').map((f) => f.kind)).toEqual(['suspected', 'suspected']);
    expect(h.repo.checks(id).find((c) => c.name === 'security')!.reason).toMatch(/advisory mode/);
    expect(h.repo.tasks(id).map((t) => t.key)).toEqual(['implement', 'review']);
  }, 120_000);

  it('only the security engineer may be given the scan; a plan giving it to the coder is rejected', () => {
    const plan = (role: string) => validatePlan({ version: 1, summary: 's', scope: 's', verification: [], tasks: [{ key: 'a', title: 't', role, dependsOn: [], acceptance: ['x'], tools: ['security_scan'], risk: 'low' }] });
    expect(plan('security_reviewer').ok).toBe(true);
    const r = plan('coder');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].message).toMatch(/role coder may not use security_scan/);
  });
});
