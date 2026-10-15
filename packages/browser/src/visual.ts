// Visual proof (ADR 0027): ATLAS renders the app's pages at the mission's base and at its result, in the sandbox, and
// records before, after and a pixel diff for each. Reviewers see what changed on screen, measured, not described.
import { existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AtlasConfig, ReleaseStage, StageContext } from '@atlas/contracts';
import { git, loadConfig } from '@atlas/workspace';
import { BrowserSession } from './session';
import { startApp } from './app';
import { resolveBrowser } from './resolve';

export interface PageShot { png: Buffer | null; status: number | null; error: string | null }
export interface PixelDiff { width: number; height: number; changed: number; total: number; bbox: { x: number; y: number; w: number; h: number } | null; png: Buffer }

/** Tallest page captured, in CSS pixels: long pages are compared over their first 6,000 pixels. */
const MAX_HEIGHT = 6000;
/**
 * Sum of per-channel differences above which a pixel counts as changed. Both sides render in the same Chromium, so
 * unchanged pixels are identical; this only absorbs rounding. Higher values missed pale backgrounds (#eef2ff on white
 * differs by 30).
 */
const TOLERANCE = 10;

/** The pages compared: configured, else "/" and every page the browser flows open (at most 5). */
export function visualPages(config: AtlasConfig): { name: string; path: string }[] {
  if (config.visual?.pages?.length) return config.visual.pages;
  const paths = ['/', ...(config.browser?.flows ?? []).flatMap((f) => f.steps.flatMap((s) => (s.action === 'goto' ? [s.path] : [])))];
  return [...new Set(paths)].slice(0, 5).map((p) => ({ name: p, path: p }));
}

/** Render one page as a full-page PNG (up to MAX_HEIGHT), animations stopped and the caret hidden. */
export async function capturePage(s: BrowserSession, baseUrl: string, pagePath: string): Promise<PageShot> {
  const page = s.page!;
  try {
    const res = await page.goto(new URL(pagePath, baseUrl).toString(), { waitUntil: 'load', timeout: 15_000 });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.evaluate('document.fonts && document.fonts.ready').catch(() => {});
    const height = Math.min(MAX_HEIGHT, await page.evaluate('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)') as number);
    const width = page.viewportSize()!.width;
    const png = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide', clip: { x: 0, y: 0, width, height: Math.max(1, height) } });
    return { png, status: res?.status() ?? null, error: null };
  } catch (e) {
    return { png: null, status: null, error: (e as Error).message.split('\n')[0].slice(0, 300) };
  }
}

/** Runs in a blank page: both images on canvases, changed pixels in red over a faded copy of the result. */
const DIFF_SCRIPT = `async ({ a, b, tolerance }) => {
  const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('could not decode a screenshot')); i.src = 'data:image/png;base64,' + src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
  const pixels = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
  const pa = pixels(ia), pb = pixels(ib);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const ox = out.getContext('2d'); const od = ox.createImageData(w, h); const o = od.data;
  let changed = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inA = x < ia.width && y < ia.height, inB = x < ib.width && y < ib.height;
    const d = inA !== inB || Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > tolerance;
    if (d) { changed++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; o[i] = 229; o[i + 1] = 41; o[i + 2] = 72; o[i + 3] = 255; }
    else { const g = inB ? pb[i] * 0.3 + pb[i + 1] * 0.59 + pb[i + 2] * 0.11 : 255; const f = 255 - (255 - g) * 0.22; o[i] = f; o[i + 1] = f; o[i + 2] = f; o[i + 3] = 255; }
  }
  ox.putImageData(od, 0, 0);
  return { width: w, height: h, changed, total: w * h, bbox: changed ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null, png: out.toDataURL('image/png').split(',')[1] };
}`;
const diffFn = new Function(`return ${DIFF_SCRIPT}`)() as (a: { a: string; b: string; tolerance: number }) => Promise<Omit<PixelDiff, 'png'> & { png: string }>;

/** Compare two PNGs in the browser. Images of different sizes compare over the larger; the rest counts as changed. */
export async function pixelDiff(s: BrowserSession, before: Buffer, after: Buffer): Promise<PixelDiff> {
  const page = await s.scratchPage();
  try {
    const r = await page.evaluate(diffFn, { a: before.toString('base64'), b: after.toString('base64'), tolerance: TOLERANCE });
    return { ...r, png: Buffer.from(r.png, 'base64') };
  } finally { await page.close().catch(() => {}); }
}

/**
 * The base commit's files, for the "before" app: a plain tree (no git metadata) inside the integration worktree, so
 * the same sandbox root covers it. Installed dependencies (node_modules) are linked from the result, not reinstalled.
 */
export async function materializeBase(worktree: string, base: string): Promise<string> {
  const dir = path.join(worktree, '.atlas-visual', 'base');
  rmSync(path.join(worktree, '.atlas-visual'), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const index = path.join(os.tmpdir(), `atlas-visual-index-${process.pid}-${Date.now()}`);
  try {
    const read = await git(worktree, ['read-tree', base], 60_000, { GIT_INDEX_FILE: index });
    if (read.code !== 0) throw new Error(`git read-tree failed: ${read.out.slice(0, 300)}`);
    const out = await git(worktree, ['checkout-index', '-a', '-f', `--prefix=${dir.replace(/\\/g, '/')}/`], 120_000, { GIT_INDEX_FILE: index });
    if (out.code !== 0) throw new Error(`git checkout-index failed: ${out.out.slice(0, 300)}`);
  } finally { rmSync(index, { force: true }); }
  const deps = path.join(worktree, 'node_modules');
  if (existsSync(deps) && !existsSync(path.join(dir, 'node_modules'))) symlinkSync(deps, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return dir;
}

export function removeBase(worktree: string) {
  const root = path.join(worktree, '.atlas-visual');
  const link = path.join(root, 'base', 'node_modules');
  // The link first, so removing the tree never follows it into the result's dependencies.
  try { if (lstatSync(link).isSymbolicLink() || process.platform === 'win32') unlinkSync(link); } catch { /* none */ }
  rmSync(root, { recursive: true, force: true });
}

const pct = (n: number) => (n >= 10 ? n.toFixed(0) : n >= 0.1 ? n.toFixed(1) : n > 0 ? n.toFixed(2) : '0');

export function visualStage(): ReleaseStage {
  return {
    name: 'visual',
    applies(ctx) {
      if (!ctx.setting('visual.enabled', true) || !ctx.mission.baseCommit || ctx.mission.baseCommit === ctx.commit) return false;
      const { config } = loadConfig(ctx.worktree);
      return !!config?.app && config.visual?.enabled !== false && visualPages(config).length > 0 && !!resolveBrowser().path;
    },
    async run(ctx) { await runVisual(ctx); },
  };
}

type Side = { shots: Map<string, PageShot>; started: string | null };

async function renderSide(ctx: StageContext, config: AtlasConfig, cwd: string | undefined, label: string, pages: { name: string; path: string }[]): Promise<Side> {
  const shots = new Map<string, PageShot>();
  let app: Awaited<ReturnType<typeof startApp>> | null = null;
  try {
    app = await startApp(ctx.sandbox, config.app!, { cwd, env: { ATLAS_REVISION: label }, signal: ctx.signal });
  } catch (e) {
    return { shots, started: (e as Error).message.split('\n')[0].slice(0, 300) };
  }
  const s = new BrowserSession(app.baseUrl);
  try {
    await s.open();
    const vp = config.visual?.viewport ?? { width: 1280, height: 800 };
    await s.page!.setViewportSize(vp);
    for (const p of pages) {
      if (ctx.signal.aborted) break;
      shots.set(p.path, await capturePage(s, app.baseUrl, p.path));
    }
  } finally {
    await s.close();
    await app.stop();
  }
  return { shots, started: null };
}

export async function runVisual(ctx: StageContext) {
  const { config } = loadConfig(ctx.worktree) as { config: AtlasConfig };
  const pages = visualPages(config);
  const threshold = config.visual?.thresholdPercent ?? 0.1;
  const t0 = Date.now();
  let before: Side;
  try {
    const dir = await materializeBase(ctx.worktree, ctx.mission.baseCommit!);
    before = await renderSide(ctx, config, dir, ctx.mission.baseCommit!, pages);
  } catch (e) {
    before = { shots: new Map(), started: (e as Error).message.split('\n')[0] };
  } finally { removeBase(ctx.worktree); }
  const after = await renderSide(ctx, config, undefined, ctx.commit, pages);

  const differ = new BrowserSession('http://127.0.0.1/');
  const rows: { name: string; path: string; result: 'changed' | 'unchanged' | 'new' | 'broken' | 'missing'; percent: number | null; bbox: PixelDiff['bbox']; before: string | null; after: string | null; diff: string | null; beforeStatus: number | null; afterStatus: number | null; note: string | null }[] = [];
  try {
    await differ.open();
    for (const p of pages) {
      const b = before.shots.get(p.path), a = after.shots.get(p.path);
      const put = (side: string, png: Buffer | null | undefined) => (png ? ctx.putArtifact({ kind: 'screenshot', name: `Visual · ${p.name} · ${side}`, bytes: png }).id : null);
      const beforeId = put('before', b?.png), afterId = put('after', a?.png);
      const okA = !!a?.png && (a.status ?? 0) < 400, okB = !!b?.png && (b.status ?? 0) < 400;
      let row: (typeof rows)[number];
      if (!okA) {
        row = { name: p.name, path: p.path, result: okB ? 'broken' : 'missing', percent: null, bbox: null, before: beforeId, after: afterId, diff: null, beforeStatus: b?.status ?? null, afterStatus: a?.status ?? null, note: a?.error ?? after.started ?? (a?.status ? `HTTP ${a.status}` : 'not rendered') };
      } else if (!okB) {
        row = { name: p.name, path: p.path, result: 'new', percent: null, bbox: null, before: beforeId, after: afterId, diff: null, beforeStatus: b?.status ?? null, afterStatus: a!.status, note: b?.error ?? before.started ?? (b?.status ? `HTTP ${b.status} before` : 'not rendered before') };
      } else {
        const d = await pixelDiff(differ, b!.png!, a!.png!);
        const percent = (d.changed / d.total) * 100;
        const diffId = d.changed ? ctx.putArtifact({ kind: 'screenshot', name: `Visual · ${p.name} · diff`, bytes: d.png }).id : null;
        row = { name: p.name, path: p.path, result: percent > threshold ? 'changed' : 'unchanged', percent, bbox: d.bbox, before: beforeId, after: afterId, diff: diffId, beforeStatus: b!.status, afterStatus: a!.status, note: null };
      }
      rows.push(row);
      ctx.emit('visual.page', { name: row.name, path: row.path, result: row.result, percent: row.percent, bbox: row.bbox, before: row.before, after: row.after, diff: row.diff, note: row.note }, [row.before, row.after, row.diff].filter((x): x is string => !!x));
    }
  } finally { await differ.close(); }

  const report = ctx.putArtifact({ kind: 'evidence', name: 'Visual changes', content: JSON.stringify({ base: ctx.mission.baseCommit, result: ctx.commit, thresholdPercent: threshold, viewport: config.visual?.viewport ?? { width: 1280, height: 800 }, beforeApp: before.started ?? 'started', afterApp: after.started ?? 'started', pages: rows }, null, 2) });
  const changed = rows.filter((r) => r.result === 'changed');
  const broken = rows.filter((r) => r.result === 'broken');
  const parts = [
    changed.length ? `${changed.length} of ${rows.length} page${rows.length === 1 ? '' : 's'} changed: ${changed.map((r) => `${r.name} (${pct(r.percent!)}%)`).join(', ')}` : `No visual change on ${rows.length} page${rows.length === 1 ? '' : 's'}`,
    ...rows.filter((r) => r.result === 'new').map((r) => `${r.name} is new`),
    ...broken.map((r) => `${r.name} rendered before but not now (${r.note})`),
    ...rows.filter((r) => r.result === 'missing').map((r) => `${r.name} did not render (${r.note})`),
  ];
  // Evidence, not a gate: a change can be the point of the mission. A page that stopped rendering is flagged.
  ctx.check({ name: 'visual', command: `${rows.length} page${rows.length === 1 ? '' : 's'} at ${ctx.mission.baseCommit!.slice(0, 7)} and ${ctx.commit.slice(0, 7)}`, required: false, result: broken.length ? 'fail' : 'pass', exitCode: null, durationMs: Date.now() - t0, reason: parts.join('; '), artifactId: report.id });
}
