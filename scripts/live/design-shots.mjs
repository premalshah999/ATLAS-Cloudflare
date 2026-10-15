import { _electron as electron } from '@playwright/test';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const root = '/Users/premalshah/Desktop/ATLAS-Cloudflare';
const out = process.env.OUT; fs.mkdirSync(out, { recursive: true });
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')) + '/sample-app'; execFileSync(process.execPath, [`${root}/scripts/seed-sample.mjs`, repo]);
const env = { ...process.env, ATLAS_E2E: '1', ATLAS_NO_GH_CLI: '1', ATLAS_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'lv-')), ATLAS_E2E_OPEN_DIR: repo }; delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (/_API_KEY$/.test(k)) delete env[k];
const app = await electron.launch({ args: [`${root}/apps/desktop`], cwd: `${root}/apps/desktop`, env });
const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' || m.text().startsWith('[design]')) errs.push(m.text().slice(0, 300)); });
await page.getByTestId('daemon-status').and(page.locator('[data-state="ready"]')).waitFor();
await page.getByRole('button', { name: 'Open repository' }).first().click();
await page.getByRole('button', { name: 'New mission' }).first().click();
await page.getByTestId('mission-title').fill('Parallel implementation and regression coverage');
await page.getByTestId('mission-goal').fill('[parallel sample] Fix slugify and add regression coverage in parallel, then review and verify the integrated result.');
await page.getByTestId('preflight').and(page.locator('[data-ready="true"]')).waitFor();
await page.getByTestId('plan-mission').click(); await page.getByTestId('approve-plan').click();
await page.getByTestId('mission').and(page.locator('[data-state="completed"]')).waitFor({ timeout: 90_000 });
await page.getByRole('button', { name: 'Dashboard' }).click(); await page.waitForTimeout(3000);
for (const s of (process.env.SCREENS ?? 'home,workspaces,create,mission,graph,agent,terminal,review,computer,deploy,studio,settings,report,activity,welcome').split(',')) {
  await page.evaluate((s) => window.__atlasPreview.go(s), s); await page.waitForTimeout(900);
  const guards = await page.locator('[data-testid^="guard-"]').allTextContents();
  if (guards.length) errs.push(`${s}: ${guards.join(' | ').slice(0, 400)}`);
  await page.screenshot({ path: `${out}/${s}.png` });
}
fs.writeFileSync(`${out}/errors.txt`, errs.join('\n'));
await app.close();
