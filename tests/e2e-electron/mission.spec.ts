// v0.1 demonstration (manual §49, E8): import a repo, describe a change, approve the plan, the agent edits
// in an isolated worktree, tests run, the dashboard shows evidence, the user accepts, and the app survives restarts.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sampleRepo } from '../helpers';
import { launch } from './app';
import { fileURLToPath as __f } from 'node:url';
const here = path.dirname(__f(import.meta.url));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('sample mission end to end, with daemon crash and app restart recovery', async () => {
  const repo = sampleRepo();
  const head = git(repo, 'rev-parse', 'HEAD');
  const first = await launch({ openDir: repo });
  const userData = first.userData;
  let { app, page } = first;
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('sample-app');

    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Fix slug generation');
    await page.getByTestId('mission-goal').fill('slugify() should lowercase, drop punctuation and collapse separators so the tests pass.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('plan-mission').click();

    await expect(page.getByTestId('plan')).toContainText('Acceptance criteria');
    await page.getByTestId('approve-plan').click();

    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
    await expect(page.getByTestId('outcome')).toContainText(/Verified: tests, api:slug-endpoint, api:health, browser:make-a-slug/);
    await expect(page.getByTestId('check-row').first()).toHaveAttribute('data-result', 'pass');
    await expect(page.getByTestId('mission-state')).toHaveAttribute('data-verdict', 'verified');
    await expect(page.getByTestId('mission-state')).toContainText('Verified');

    // Timeline integrity: each event appears once, and every filter shows exactly what its chip counts.
    await page.getByRole('tab', { name: /Activity/ }).click();
    const seqs = await page.locator('[data-testid="timeline"] [data-seq]').evaluateAll((els) => els.map((e) => e.getAttribute('data-seq')));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const name of ['Agent', 'Commands', 'Policy & approvals', 'Checks', 'All']) {
      const chip = page.locator('.lv-chip', { hasText: name }).first();
      await chip.click();
      const count = Number(await chip.locator('span').innerText());
      await expect(page.locator('[data-testid="timeline"] [data-seq]')).toHaveCount(count);
    }

    await page.getByRole('tab', { name: /Changes/ }).click();
    await expect(page.getByTestId('changes')).toContainText('.toLowerCase()');
    await page.screenshot({ path: path.resolve(here, '../../test-results/e2e-electron/mission-changes.png') });

    // The user checkout was never touched.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(repo, 'src/slugify.js'), 'utf8')).toContain('ATLAS-SAMPLE');

    // Daemon crash: the shell restarts it and the view resyncs without losing history.
    await page.evaluate(() => (window as any).atlas.e2e.crashDaemon());
    await expect(page.getByTestId('daemon-status')).toHaveAttribute('data-state', 'restarting', { timeout: 10_000 });
    await expect(page.getByTestId('daemon-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await page.getByRole('tab', { name: /Activity/ }).click();
    await expect(page.getByTestId('timeline')).toContainText('Plan v1 approved');

    await page.getByTestId('accept').click();
    await expect(page.getByText('Accepted by you')).toBeVisible();
    const branches = git(repo, 'branch', '--list', 'atlas/*');
    expect(branches).toMatch(/atlas\/msn_/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);

    // Full app restart with the same data: the mission and its evidence are still there.
    await app.close();
    ({ app, page } = await launch({ userData, openDir: repo }));
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed');
    await expect(page.getByText('Accepted by you')).toBeVisible();
    await page.getByRole('tab', { name: /Evidence/ }).click();
    await expect(page.getByTestId('evidence')).toContainText(/Verified: tests, api:slug-endpoint, api:health, browser:make-a-slug/);
  } finally { await app.close(); }
});

test('approval card states who, what, where and scope; approve once continues the mission', async () => {
  const repo = sampleRepo();
  const { app, page } = await launch({ openDir: repo });
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Fix slugify with approvals');
    await page.getByTestId('mission-goal').fill('Fix slugify.');
    await page.getByRole('radio', { name: 'Ask for every write' }).click();
    await page.getByTestId('plan-mission').click();
    await page.getByTestId('approve-plan').click();

    const card = page.getByTestId('approval').first();
    await expect(card).toContainText('src/slugify.js', { timeout: 30_000 });
    await expect(card).toContainText('Coder agent');
    await expect(card).toContainText('This command, once');
    // The pending decision is visible everywhere, not only on the mission screen.
    await expect(page.getByTestId('awaiting-count')).toHaveText('1 awaiting you');
    await expect(page.getByTestId('needs-you-chip')).toContainText('1 needs you');
    expect(await page.title()).toMatch(/^\(1\) /);
    await card.getByTestId('approve').click();
    await expect(page.getByTestId('awaiting-count')).toHaveText('0 awaiting you');
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
    await expect(page.getByTestId('outcome')).toContainText(/^Verified/);
  } finally { await app.close(); }
});

test('command palette navigates to missions and screens from the keyboard', async () => {
  const repo = sampleRepo();
  const { app, page } = await launch({ openDir: repo });
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Palette target mission');
    await page.getByTestId('mission-goal').fill('Fix slugify.');
    await page.getByTestId('plan-mission').click();
    await expect(page.getByTestId('plan')).toBeVisible();

    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.keyboard.type('settings');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('settings')).toBeVisible();

    await page.getByTestId('open-palette').click();
    await page.keyboard.type('palette target');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'awaiting_approval');

    await page.keyboard.press('Control+k');
    await page.keyboard.type('zzzz-no-such-thing');
    await expect(page.getByTestId('palette')).toContainText('Nothing matches');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toHaveCount(0);
  } finally { await app.close(); }
});

test('UI reload and full app restart in the middle of a mission resume accurately (manual §35)', async () => {
  const repo = sampleRepo();
  const first = await launch({ openDir: repo });
  let { app, page } = first;
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Mid-mission restart');
    await page.getByTestId('mission-goal').fill('Fix slugify.');
    await page.getByRole('radio', { name: 'Ask for every write' }).click();
    await page.getByTestId('plan-mission').click();
    await page.getByTestId('approve-plan').click();
    await expect(page.getByTestId('approval').first()).toContainText('src/slugify.js', { timeout: 30_000 });
    const seqsBefore = await page.locator('[data-testid="timeline"] [data-seq]').count();

    // 1. Renderer reload: the view resyncs from the event log, the pending approval is still there.
    await page.reload();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'running');
    await expect(page.getByTestId('approval').first()).toContainText('src/slugify.js');
    await page.getByRole('tab', { name: /Activity/ }).click();
    const seqs = await page.locator('[data-testid="timeline"] [data-seq]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-seq'))));
    expect(seqs.length).toBeGreaterThanOrEqual(seqsBefore);
    expect(new Set(seqs).size).toBe(seqs.length);

    // 2. Full restart while the agent waits: the daemon stops with the app. On restart the unanswered approval
    // is expired (never silently executed), the lost attempt is recorded, and the work resumes in a new attempt.
    await app.close();
    ({ app, page } = await launch({ userData: first.userData, openDir: repo }));
    await expect(page.getByTestId('mission')).toBeVisible();
    await page.getByRole('tab', { name: /Activity/ }).click();
    await expect(page.getByTestId('timeline')).toContainText('Recovered after a daemon restart', { timeout: 30_000 });
    const card = page.getByTestId('approval').first();
    await expect(card).toContainText('src/slugify.js', { timeout: 30_000 });
    await card.getByTestId('approve').click();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
    await expect(page.getByTestId('outcome')).toContainText(/^Verified/);
    await page.getByRole('tab', { name: /Activity/ }).click();
    await expect(page.getByTestId('timeline')).toContainText('Approval expired');
  } finally { await app.close(); }
});
