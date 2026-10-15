// Visual proof in the built app (ADR 0027): a mission that changes the page shows before, after, a diff and a compare
// slider under Visual, with how much of the page changed.
import { expect, test } from '@playwright/test';
import { sampleRepo } from '../helpers';
import { launch } from './app';

test('a mission that changes the page shows what changed on screen', async () => {
  if (process.platform === 'win32') test.setTimeout(420_000);
  const { app, page } = await launch({ openDir: sampleRepo() });
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('sample-app');
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Make the slug page clearer');
    await page.getByTestId('mission-goal').fill('[ui sample] Fix slugify, explain the tool under the heading and show the slug in a card.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('plan-mission').click();
    await page.getByTestId('approve-plan').click();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', /completed|failed/, { timeout: process.platform === 'win32' ? 300_000 : 120_000 });
    await expect(page.getByTestId('outcome')).toContainText('Verified');

    await page.getByRole('tab', { name: /Visual/ }).click();
    await expect(page.getByTestId('visual-summary')).toHaveText(/^1 of 1 page changed: \/ \(\d+(\.\d+)?%\)$/);
    const card = page.getByTestId('visual-page');
    await expect(card).toHaveAttribute('data-result', 'changed');
    await expect(card).toContainText(/\d+(\.\d+)?% changed/);
    // The diff first; then the slider over before and after.
    await expect(card.getByRole('img', { name: '/ diff' })).toBeVisible();
    await card.getByRole('radio', { name: 'Compare' }).click();
    const slider = page.getByTestId('visual-compare');
    await expect(slider.getByRole('img', { name: '/ before' })).toBeVisible();
    await expect(slider.getByRole('img', { name: '/ after' })).toBeVisible();
    await slider.getByRole('slider', { name: 'Before and after split' }).fill('20');
    await expect(slider.getByRole('img', { name: '/ before' })).toHaveAttribute('style', /inset\(0px 80% 0px 0px\)|inset\(0 80% 0 0\)/);
    await card.getByRole('radio', { name: 'Before' }).click();
    await expect(card.getByRole('img', { name: '/ before' })).toBeVisible();
  } finally {
    await app.close();
  }
});
