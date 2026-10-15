// M2–M5 in the built app: settings, staging deploy with approval and independent verification, the task
// graph, browser steps, the operator terminal, audit export/import, and desktop takeover.
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sampleRepo, tmpDir } from '../helpers';
import { launch } from './app';

test('staging deploy, task graph, browser steps, terminal, export and read-only import', async () => {
  // Windows runs each sandboxed command as the sandbox account (ADR 0020): a logon per command makes missions slower.
  if (process.platform === 'win32') test.setTimeout(420_000);
  const repo = sampleRepo();
  const exportFile = path.join(tmpDir('atlas-e2e-export-'), 'mission.jsonl');
  const first = await launch({ openDir: repo, env: { ATLAS_E2E_SAVE_PATH: exportFile } });
  const { app, page } = first;
  const missionTitle = 'Fix slugify and deploy to staging';
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('sample-app');

    // Settings: allowlist the staging target; roles are listed with their capabilities.
    await page.keyboard.press('Control+,');
    await page.getByTestId('allow-target').fill('local-staging');
    await page.getByRole('button', { name: 'Allow target' }).click();
    await expect(page.getByTestId('deploy-settings')).toContainText('local-staging');
    await expect(page.getByTestId('roles')).toContainText('Desktop operator');
    await expect(page.getByTestId('roles')).toContainText('desktop.input');

    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill(missionTitle);
    await page.getByTestId('mission-goal').fill('Fix slugify so the tests pass, then deploy to staging.');
    await page.getByRole('radio', { name: /local-staging · staging/ }).click();
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('plan-mission').click();
    await expect(page.getByTestId('plan')).toContainText('Deploying to local-staging needs its own approval');
    await page.getByTestId('approve-plan').click();

    const card = page.getByTestId('approval').first();
    await expect(card).toContainText('local-staging', { timeout: 90_000 });
    await card.getByTestId('approve').click();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', /completed|failed/, { timeout: process.platform === 'win32' ? 300_000 : 120_000 });
    // On failure, say why: the outcome and every check that did not pass, with the end of its output.
    const why = await page.evaluate(async () => {
      const a = (window as any).atlas;
      const [m] = (await a.invoke('mission.list', {})) as { id: string; state: string }[];
      const s = await a.invoke('mission.get', { missionId: m.id });
      const checks = (s.checks as { name: string; result: string; reason: string; artifactId: string | null }[]).filter((c) => c.result !== 'pass');
      const out = await Promise.all(checks.map(async (c) => `[${c.name}: ${c.result}] ${c.reason}${c.artifactId ? `\n${String((await a.invoke('artifact.read', { artifactId: c.artifactId })).text ?? '').slice(-1500)}` : ''}`));
      return `${s.mission.state}: ${s.mission.outcome ?? ''}\n${out.join('\n---\n')}`;
    });
    expect(why.startsWith('completed'), why).toBe(true);
    await expect(page.getByTestId('outcome')).toContainText('staging:revision');

    await page.getByRole('tab', { name: /Tasks/ }).click();
    expect(await page.getByTestId('graph-node').count()).toBeGreaterThanOrEqual(2);

    await page.getByRole('tab', { name: /Browser/ }).click();
    await expect(page.getByTestId('browser-step').first()).toBeVisible();

    await page.getByRole('tab', { name: /Deploy/ }).click();
    const row = page.getByTestId('deployment-row').filter({ hasText: 'this mission' });
    await expect(row).toContainText('live');
    await expect(row).toContainText('yes');

    await page.getByRole('tab', { name: /Terminal/ }).click();
    await page.getByTestId('open-terminal').click();
    await expect(page.getByTestId('terminal')).toContainText('sandboxed', { timeout: 15_000 });
    await page.locator('.lv-term').click();
    await page.keyboard.type('ls\n');
    await expect(page.locator('.lv-term')).toContainText('package.json', { timeout: 15_000 });
    // P1-5: switching away unmounts the view, not the shell. Coming back re-attaches with the history intact.
    await page.locator('.lv-term').click();
    // The Windows terminal is PowerShell.
    const win = process.platform === 'win32';
    await page.keyboard.type(win ? "$env:ATLAS_KEPT='still-here'\n" : 'export ATLAS_KEPT=still-here\n');
    await page.getByRole('tab', { name: /Deploy/ }).click();
    await expect(page.getByTestId('deployment-row').first()).toBeVisible();
    await page.getByRole('tab', { name: /Terminal/ }).click();
    await expect(page.locator('.lv-term')).toContainText('package.json', { timeout: 15_000 });
    await expect(page.getByTestId('open-terminal')).toHaveCount(0);
    await page.locator('.lv-term').click();
    await page.keyboard.type(win ? 'echo "$env:ATLAS_KEPT-$(40+2)"\n' : 'echo "$ATLAS_KEPT-$((40+2))"\n');
    await expect(page.locator('.lv-term')).toContainText('still-here-42', { timeout: 15_000 });
    await page.getByTestId('close-terminal').click();
    await expect(page.getByTestId('open-terminal')).toBeVisible();

    await page.getByTestId('mission-menu').click();
    await page.getByRole('menuitem', { name: /Export audit log/ }).click();
    await expect.poll(() => existsSync(exportFile), { timeout: 15_000 }).toBe(true);
    expect(readFileSync(exportFile, 'utf8')).toContain('"sha256"');
  } finally { await app.close(); }

  // A different installation imports the log, verifies its checksums and shows it read-only.
  const second = await launch({ env: { ATLAS_E2E_IMPORT_PATH: exportFile } });
  try {
    await second.page.getByTestId('import-mission').click();
    await expect(second.page.getByTestId('mission')).toBeVisible({ timeout: 15_000 });
    await expect(second.page.getByText('imported archive · read-only')).toBeVisible();
    // A different installation: signed, but by a key it does not trust yet.
    await expect(second.page.getByTestId('provenance')).toContainText('signed by untrusted key');
    await expect(second.page.locator('h1')).toContainText(missionTitle);
    await second.page.getByRole('tab', { name: /Evidence/ }).click();
    await expect(second.page.getByTestId('evidence')).toContainText('staging:revision');
  } finally { await second.app.close(); }
});

test('desktop control: consent, session approval, operator takeover and recorded frames', async () => {
  const repo = sampleRepo();
  const { app, page } = await launch({ openDir: repo });
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await page.keyboard.press('Control+,');
    const desk = page.getByTestId('desktop-settings');
    await expect(desk).not.toContainText('Checking');
    test.skip((await desk.innerText()).includes('Unavailable'), 'Xvfb/xdotool not installed');
    await desk.getByRole('switch').click();
    await expect(desk).toContainText('Enabled');

    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Desktop sample');
    await page.getByTestId('mission-goal').fill('[desktop sample] Operate the virtual desktop.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('plan-mission').click();
    await expect(page.getByTestId('plan')).toContainText('Operate the virtual desktop');
    await page.getByTestId('approve-plan').click();

    const card = page.getByTestId('approval').first();
    await expect(card).toContainText('virtual desktop', { timeout: 30_000 });
    await card.getByTestId('approve').click();

    await page.getByRole('tab', { name: /Desktop/ }).click();
    const ctl = page.getByTestId('desktop-controller');
    await expect(ctl).toHaveAttribute('data-controller', 'agent', { timeout: 15_000 });
    await expect(page.locator('img.lv-desk')).toBeVisible();
    await page.getByTestId('desktop-takeover').click();
    await expect(ctl).toHaveAttribute('data-controller', 'operator');
    await page.locator('img.lv-desk').click({ position: { x: 40, y: 40 } });
    await page.screenshot({ path: path.resolve('test-results/e2e-electron/desktop-takeover.png') });

    // The agent's next input is refused while the operator holds the display.
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', /completed|failed/, { timeout: 60_000 });
    await page.getByRole('tab', { name: /Activity/ }).click();
    await expect(page.getByTestId('timeline')).toContainText('Desktop takeover');
    await expect(page.getByTestId('timeline')).toContainText('Desktop type refused');
    await page.getByRole('tab', { name: /Desktop/ }).click();
    await expect(page.getByTestId('desktop')).toContainText('Recorded frames');
  } finally { await app.close(); }
});
