// The design preview's Home, Activity, Agents and Report screens, live: every value comes from the daemon.
import { expect, test } from '@playwright/test';
import { sampleRepo } from '../helpers';
import { launch } from './app';
import path from 'node:path';
import { fileURLToPath as __f } from 'node:url';
const shot = (name: string) => path.resolve(path.dirname(__f(import.meta.url)), `../../test-results/e2e-electron/${name}.png`);

test('home, activity, agents and the mission report show real mission data', async () => {
  const { app, page } = await launch({ openDir: sampleRepo() });
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('sample-app');

    await page.getByRole('button', { name: 'Home' }).first().click();
    await expect(page.getByTestId('home-setup')).toContainText('Open a repository');
    await expect(page.getByTestId('home-recent')).toContainText('No missions yet');

    // A real scripted mission: plan, approve, agents run, checks verify.
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Fix slug generation');
    await page.getByTestId('mission-goal').fill('slugify() should lowercase, drop punctuation and collapse separators so the tests pass.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('plan-mission').click();
    await page.getByTestId('approve-plan').click();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });

    await page.getByRole('tab', { name: /Report/ }).click();
    const report = page.getByTestId('report-panel');
    await expect(report).toContainText('Fix slug generation');
    await expect(report).toContainText('Verified');
    await expect(page.getByTestId('report-checks')).toContainText('tests');
    await expect(report).toContainText('Awaiting your decision');
    await page.screenshot({ path: shot('live-report') });

    await page.getByRole('button', { name: 'Home' }).first().click();
    await expect(page.getByTestId('home-ready-for-review')).toContainText('Fix slug generation');
    await expect(page.getByTestId('home-stats')).toContainText('Verified');
    await page.waitForTimeout(500); // screen transition
    await page.screenshot({ path: shot('live-home') });
    await page.getByTestId('home-ready-for-review').getByTestId('home-mission').first().click();
    await expect(page.getByTestId('mission')).toBeVisible();

    await page.getByRole('button', { name: 'Activity' }).first().click();
    await expect(page.getByTestId('activity-row').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('global-activity')).toContainText('Fix slug generation');
    await page.screenshot({ path: shot('live-activity') });

    await page.getByRole('button', { name: 'Agents' }).first().click();
    await expect(page.getByTestId('agent-role').first()).toBeVisible();
    expect(await page.getByTestId('agent-role').count()).toBeGreaterThan(2);
    await expect(page.getByTestId('agent-detail')).toContainText('Tools');
    await expect(page.getByTestId('agent-detail')).toContainText('Instructions');
    await page.screenshot({ path: shot('live-agents') });
  } finally { await app.close(); }
});
