// README screenshots from the installed ATLAS on the operator's profile (real missions, real data).
// Usage: node scripts/live/readme-shots.mjs <repo> <verifiedMissionId> <deployMissionId> [liveUrl]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openAtlas } from './session.mjs';

const [repo, verifiedId, deployId, liveUrl] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.join(root, 'docs/screenshots/live');
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, page } = await openAtlas({ openDir: repo });
try {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: 'Dashboard' }).first().click().catch(async () => { await page.evaluate(() => localStorage.setItem('atlas:route', JSON.stringify({ screen: 'preview' }))); await page.reload(); });
  await page.waitForFunction(() => !!window.__atlasPreview, null, { timeout: 30_000 });
  const go = async (s, extra = {}) => { await page.evaluate(([s, e]) => window.__atlasPreview.go(s, e), [s, extra]); await wait(2200); await page.mouse.move(1590, 990); };
  const shot = async (name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log('saved', name); };
  await page.evaluate((id) => window.__atlasPreview.set({ missionId: id }), verifiedId); await wait(4000);
  await go('home'); await shot('home');
  await go('mission'); await shot('mission-control');
  await go('graph'); await shot('task-graph');
  const coder = process.env.AGENT ?? 'csp-font-fix';
  await go('agent', { agent: coder }); await shot('agent');
  await go('review'); await shot('review');
  await go('studio'); await shot('studio');
  await page.getByRole('button', { name: /New agent/ }).first().click().catch(() => {}); await wait(900); await page.mouse.move(1590, 990); await shot('studio-new-agent');
  await page.getByRole('button', { name: /Add connector/ }).first().click().catch(() => {}); await wait(900); await page.mouse.move(1590, 990); await shot('studio-connector');
  await go('mission'); await page.getByTestId('open-full-record').click().catch(() => {}); await wait(2500);
  await page.getByRole('tab', { name: /Evidence/ }).click().catch(() => {}); await wait(1500); await shot('evidence');
  await page.getByRole('tab', { name: 'Cloudflare' }).click().catch(() => {}); await wait(2500); await shot('cloudflare');
  await go('preferences'); await shot('settings');
  await page.evaluate((id) => window.__atlasPreview.set({ missionId: id }), deployId); await wait(4000);
  await go('deploy'); await shot('deployments');
  await go('computer'); await wait(2500);
  if (liveUrl) {
    const input = page.locator('.lv-lb-url input').first();
    if (await input.count()) { await input.fill(liveUrl); await input.press('Enter'); await wait(7000); }
    await page.mouse.move(1590, 990); await shot('browser');
    await page.locator('.lv-lb-stage img, .lv-lb-stage').first().click({ position: { x: 300, y: 300 } }).catch(() => {}); await wait(2500);
  }
  await shot('browser');
} finally { await app.close(); }
