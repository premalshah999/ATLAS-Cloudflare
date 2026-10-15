// Independent acceptance verification through the real UI: the operator saves a holdout suite on the project,
// a mission runs, and the gate's evidence shows the holdout check (agents never see the suite).
import { expect, test } from '@playwright/test';
import { sampleRepo } from '../helpers';
import { launch } from './app';

test('a holdout acceptance suite saved in the UI runs at the gate and is required', async () => {
  const repo = sampleRepo();
  const { app, page } = await launch({ openDir: repo });
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('sample-app');
    await page.getByTestId('acceptance-toggle').click();
    await page.getByTestId('acceptance-code').fill("import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\ntest('symbols', () => assert.equal(slugify('Fish & Chips!'), 'fish-chips'));\n");
    await page.getByTestId('acceptance-save').click();
    await expect(page.getByTestId('acceptance-toggle')).toContainText(/Holdout acceptance tests · [0-9a-f]{12}/);

    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Fix slug generation');
    await page.getByTestId('mission-goal').fill('slugify() should lowercase, drop punctuation and collapse separators.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('plan-mission').click();
    await page.getByTestId('approve-plan').click();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', /^(completed|failed)$/, { timeout: 90_000 });
    if ((await page.getByTestId('mission').getAttribute('data-state')) !== 'completed') {
      // Say why: the outcome and every check (Windows CI rounds 4 and 10 failed here without either).
      const outcome = await page.getByTestId('outcome').textContent().catch(() => null);
      await page.getByRole('tab', { name: /Evidence/ }).click().catch(() => {});
      const rows = await page.getByTestId('check-row').allTextContents().catch(() => []);
      expect(null, `mission failed: ${outcome}\nchecks:\n${rows.join('\n')}`).toBe('completed');
    }
    await expect(page.getByTestId('mission-state')).toHaveAttribute('data-verdict', 'verified');
    await expect(page.getByTestId('check-row').filter({ hasText: 'acceptance (holdout)' })).toHaveAttribute('data-result', 'pass');
  } finally { await app.close(); }
});
