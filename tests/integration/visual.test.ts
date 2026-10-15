// Visual proof (ADR 0027): the app's pages rendered at the mission base and at its result, in the sandbox, compared
// pixel by pixel. Against the real sample app.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveBrowser, visualStage } from '@atlas/browser';
import { forTask, SAMPLE_FIX } from '@atlas/runtime-fake';
import { detectSandbox } from '@atlas/terminal';
import { sampleRepo, sh } from '../helpers';
import { explainChecks, makeOrchestrator, startMission } from './harness';

const ready = !!resolveBrowser().path && detectSandbox().kind === 'bwrap';
const SERVER = readFileSync(path.join(__dirname, '../../fixtures/sample-app/server.js'), 'utf8');
const PAGE = readFileSync(path.join(__dirname, '../../fixtures/sample-app/public/index.html'), 'utf8');
/** The sample repository with the operator's visual pages committed (a mission may not change its own verification). */
function repoWithPages(pages: { name: string; path: string }[]) {
  const root = sampleRepo();
  const file = path.join(root, 'atlas.config.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), visual: { pages } }, null, 2));
  sh(root, 'git', ['commit', '-qam', 'visual pages']);
  return root;
}
const png = (h: ReturnType<typeof makeOrchestrator>, id: string) => h.artifacts.readBytes(id).bytes;

describe.skipIf(!ready)('visual proof (ADR 0027)', () => {
  it('records before, after and a diff of a page the mission changed, and says how much changed', async () => {
    const h = makeOrchestrator({
      scripts: [forTask('implement', [
        { tool: 'write_file', args: { path: 'src/slugify.js', content: SAMPLE_FIX } },
        { tool: 'write_file', args: { path: 'public/index.html', content: PAGE.replace('<h1>Slug maker</h1>', '<h1>Slug maker</h1>\n  <p style="background:#ffd54f;padding:24px;min-height:900px">New: slugs drop punctuation.</p>') } },
        { claim: 'Fixed slugify and announced it on the page.' },
      ])],
      stages: [visualStage()],
    });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.verdict, explainChecks(h, id)).toBe('verified');

    const check = h.repo.checks(id).find((c) => c.name === 'visual')!;
    expect(check).toMatchObject({ required: false, result: 'pass' });
    expect(check.reason).toMatch(/^1 of 1 page changed: \/ \(\d+(\.\d+)?%\)$/);
    expect(check.command).toBe(`1 page at ${m.baseCommit!.slice(0, 7)} and ${m.integrationCommit!.slice(0, 7)}`);

    const ev = h.events.find((e) => e.type === 'visual.page')!;
    expect(ev.payload).toMatchObject({ name: '/', path: '/', result: 'changed' });
    const { before, after, diff, bbox, percent } = ev.payload as { before: string; after: string; diff: string; bbox: { x: number; y: number; w: number; h: number }; percent: number };
    for (const a of [before, after, diff]) expect(png(h, a).subarray(1, 4).toString()).toBe('PNG');
    expect(ev.artifactIds).toEqual([before, after, diff]);
    // The new banner sits under the heading: the changed area starts there and spans the page width.
    expect(bbox.y).toBeGreaterThan(40);
    expect(bbox.w).toBeGreaterThan(400);
    expect(percent).toBeGreaterThan(1);
    // The page grew, so the result is taller than the base.
    const height = (b: Buffer) => b.readUInt32BE(20);
    expect(height(png(h, after))).toBeGreaterThan(height(png(h, before)));

    const report = JSON.parse(h.artifacts.read(check.artifactId!).text);
    expect(report).toMatchObject({ base: m.baseCommit, result: m.integrationCommit, beforeApp: 'started', afterApp: 'started', pages: [{ name: '/', result: 'changed', beforeStatus: 200, afterStatus: 200 }] });
    // The base tree used for "before" is gone from the integration worktree.
    expect(existsSync(path.join(h.dataDir, 'worktrees', id, 'integration', '.atlas-visual'))).toBe(false);
  }, 240_000);

  it('a change that leaves the pages alone shows no visual change; a page that stops rendering is flagged', async () => {
    const quiet = makeOrchestrator({
      scripts: [forTask('implement', [
        { tool: 'write_file', args: { path: 'src/slugify.js', content: SAMPLE_FIX } },
        { claim: 'Fixed slugify.' },
      ])],
      stages: [visualStage()],
    });
    const q = await startMission(quiet, repoWithPages([{ name: 'home', path: '/' }, { name: 'health', path: '/healthz' }]));
    await quiet.orch.settle(q);
    const c = quiet.repo.checks(q).find((x) => x.name === 'visual')!;
    expect(c).toMatchObject({ result: 'pass', reason: 'No visual change on 2 pages' });
    // Nothing changed, so no diff image is stored.
    expect(quiet.events.filter((e) => e.type === 'visual.page').map((e) => [e.payload.name, e.payload.result, e.payload.diff])).toEqual([['home', 'unchanged', null], ['health', 'unchanged', null]]);

    const broken = makeOrchestrator({
      scripts: [forTask('implement', [
        { tool: 'write_file', args: { path: 'src/slugify.js', content: SAMPLE_FIX } },
        // The home page now fails at the server.
        { tool: 'write_file', args: { path: 'server.js', content: SERVER.replace(/if \(url\.pathname === '\/'\) return send\(res, 200,[^\n]*/, "if (url.pathname === '/') return send(res, 500, 'text/plain', 'boom');") } },
        { claim: 'Refactored the server.' },
      ])],
      stages: [visualStage()],
    });
    const b = await startMission(broken, repoWithPages([{ name: 'home', path: '/' }]));
    await broken.orch.settle(b);
    const v = broken.repo.checks(b).find((x) => x.name === 'visual')!;
    expect(v).toMatchObject({ required: false, result: 'fail' });
    expect(v.reason).toMatch(/home rendered before but not now \(HTTP 500\)/);
  }, 300_000);
});
