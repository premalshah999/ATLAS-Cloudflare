import path from 'node:path';
import { openAtlas } from './session.mjs';
const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../docs/screenshots/live');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, page } = await openAtlas();
try {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: 'Dashboard' }).first().click();
  await page.waitForFunction(() => !!window.__atlasPreview);
  await page.evaluate(() => window.__atlasPreview.go('computer')); await wait(2500);
  const input = page.locator('.lv-lb-url input').first();
  await input.fill(process.argv[2]); await input.press('Enter'); await wait(8000);
  await page.mouse.move(1590, 990); await page.screenshot({ path: path.join(out, 'browser.png') }); console.log('saved browser');
} finally { await app.close(); }
