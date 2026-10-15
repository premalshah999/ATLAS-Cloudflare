// Independent acceptance verification: the operator's holdout suite, which no agent can see, catches an
// overfit change that passes every visible test (the eval's `weak-tests` false pass).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { forTask, SAMPLE_FIX } from '@atlas/runtime-fake';
import { detectSandbox } from '@atlas/terminal';
import { sampleRepo } from '../helpers';
import { explainChecks, makeOrchestrator, startMission } from './harness';

const OVERFIT = "const known = { 'Hello World': 'hello-world', 'a   b -- c': 'a-b-c', 'What’s new, ATLAS?': 'whats-new-atlas', '  --Ship it--  ': 'ship-it', 'Release 2.0 notes': 'release-20-notes' };\nexport function slugify(t) { return known[t] ?? t.trim().replace(/ /g, '-'); }\n";
const SECRET = 'HOLDOUT-ONLY-CASE-7f3a';
const SUITE = {
  command: 'node', args: ['--test', '.atlas-acceptance/slug.accept.test.js'],
  files: { 'slug.accept.test.js': `// ${SECRET}\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\ntest('ampersands', () => assert.equal(slugify('Rock & Roll'), 'rock-roll'));\ntest('apostrophes', () => assert.equal(slugify("It's 9 o'clock"), 'its-9-oclock'));\ntest('case', () => assert.equal(slugify('UPPER lower'), 'upper-lower'));\n` },
};
const w = (file: string, content: string) => ({ tool: 'write_file', args: { path: file, content } });

async function run(steps: any[], withSuite = true) {
  const root = sampleRepo();
  const h = makeOrchestrator({ scripts: [forTask('implement', [...steps, { claim: 'All tests pass.' }])] });
  const ws = await h.orch.registerWorkspace(root);
  if (withSuite) h.orch.acceptance.set(ws.id, SUITE);
  const id = await startMission(h, root);
  await h.orch.settle(id);
  return { h, id, root, m: h.repo.mission(id)!, check: (n: string) => h.repo.checks(id).filter((c) => c.name === n).at(-1) };
}

describe('holdout acceptance suites', () => {
  it('an overfit fix that passes every visible test is not verified', async () => {
    const r = await run([w('src/slugify.js', OVERFIT)]);
    expect(r.check('tests')!.result).toBe('pass'); // the visible tests really pass …
    expect(r.check('acceptance (holdout)')).toMatchObject({ result: 'fail', required: true }); // … the holdout does not
    expect(r.m.verdict).toBe('failed');
  });

  it('a real fix passes the holdout and is verified; the check names the suite by hash', async () => {
    const r = await run([w('src/slugify.js', SAMPLE_FIX)]);
    expect(r.check('acceptance (holdout)')!.result, explainChecks(r.h, r.id)).toBe('pass');
    expect(r.check('acceptance (holdout)')!.reason).toMatch(/acceptance suite [0-9a-f]{12}/);
    expect(r.m.verdict).toBe('verified');
    // Nothing of the suite is left in the integration worktree.
    expect(existsSync(path.join(r.h.dataDir, 'worktrees', r.id, 'integration', '.atlas-acceptance'))).toBe(false);
  });

  it('without a suite nothing changes (the limitation stays visible: weak tests can still pass)', async () => {
    const r = await run([w('src/slugify.js', OVERFIT)], false);
    expect(r.check('acceptance (holdout)')).toBeUndefined();
    expect(r.m.verdict).toBe('verified');
  });

  it.skipIf(detectSandbox().kind !== 'bwrap')('an agent cannot read the suite, even knowing where it is stored', async () => {
    const probe = (p: string) => ({ tool: 'shell_exec', args: { command: 'cat', args: [p] } });
    const root = sampleRepo();
    const h0 = makeOrchestrator();
    const file = path.join(h0.dataDir, 'acceptance');
    const h = makeOrchestrator({ dataDir: h0.dataDir, scripts: [forTask('implement', [probe(path.join(file, 'x.json')), w('src/slugify.js', SAMPLE_FIX), { claim: 'done' }])] });
    const ws = await h.orch.registerWorkspace(root);
    h.orch.acceptance.set(ws.id, SUITE);
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const out = h.events.filter((e) => e.type === 'agent.tool_result').map((e) => String(e.payload.summary)).join('\n');
    expect(out).toMatch(/No such file|Permission denied/); // the probe really ran, and saw nothing
    expect(out).not.toContain(SECRET);
    for (const a of h.artifacts.list(id)) if (a.kind !== 'test_report') expect(h.artifacts.read(a.id).text).not.toContain(SECRET);
  });

  it('a symlink planted at .atlas-acceptance cannot redirect where the suite is written', async () => {
    const root = sampleRepo();
    const outside = path.join(root, '..', `outside-${Date.now()}`);
    const h = makeOrchestrator({ scripts: [forTask('implement', [w('src/slugify.js', SAMPLE_FIX), { tool: 'shell_exec', args: { command: 'ln', args: ['-s', outside, '.atlas-acceptance'] } }, { claim: 'done' }])] });
    const ws = await h.orch.registerWorkspace(root);
    h.orch.acceptance.set(ws.id, SUITE);
    const id = await startMission(h, root);
    const { autoDecide } = await import('./harness');
    const stop = autoDecide(h, id, 'shell_exec');
    await h.orch.settle(id);
    stop();
    const { sh } = await import('../helpers');
    const entry = sh(root, 'git', ['ls-tree', h.repo.mission(id)!.integrationCommit!, '.atlas-acceptance']);
    // Linux and macOS: the symlink is really in the change. Windows: a standard account cannot create symbolic links
    // (ADR 0020), so the planted link never exists; the rest of the test still holds.
    if (process.platform === 'win32') expect(entry).not.toMatch(/^120000 /);
    else expect(entry).toMatch(/^120000 /);
    expect(existsSync(outside)).toBe(false);
    expect(h.repo.checks(id).find((c) => c.name === 'acceptance (holdout)')!.result).toBe('pass');
  });
});

describe('acceptance store validation', () => {
  it.each([['../escape.js'], ['/abs.js'], ['C:\\x.js'], ['.git/hooks/x'], ['a//b.js']])('rejects path %s', async (p) => {
    const h = makeOrchestrator();
    expect(() => h.orch.acceptance.set('ws_x', { command: 'node', args: [], files: { [p]: 'x' } })).toThrow(/Invalid acceptance file path/);
  });
  it('rejects a command given as a path, and an empty suite', () => {
    const h = makeOrchestrator();
    expect(() => h.orch.acceptance.set('ws_x', { command: './run.sh', args: [], files: { 'a.js': '' } })).toThrow(/program name/);
    expect(() => h.orch.acceptance.set('ws_x', { command: 'node', args: [], files: {} })).toThrow(/at least one file/);
  });
  it('is stored outside every repository, in the data directory', () => {
    const h = makeOrchestrator();
    h.orch.acceptance.set('ws_x', SUITE);
    expect(readFileSync(path.join(h.dataDir, 'acceptance', 'ws_x.json'), 'utf8')).toContain(SECRET);
  });
});
