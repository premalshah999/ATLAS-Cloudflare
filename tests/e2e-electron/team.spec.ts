// ADR 0021 through the real app: two ATLAS installations (two app instances, two data directories, two clones) that
// share only a git origin. Alice starts a team space and invites Bob with a code; Bob joins, adds work for Alice;
// Alice runs it as a mission; the change touches a path Bob's team owns, so publishing waits for Bob's approval,
// which he gives from his machine after reading the diff.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sampleRepo, tmpDir } from '../helpers';
import { launch } from './app';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function openTeam(page: Page) {
  await page.getByRole('button', { name: 'Open repository' }).first().click();
  await expect(page.getByTestId('workspace-card')).toBeVisible();
  await page.getByRole('button', { name: 'Team' }).click();
  await expect(page.getByTestId('team')).toBeVisible();
}
/** Sync now and wait for that sync to finish: the status is already "idle" from the last one, so wait for its time to change. */
const sync = async (page: Page) => {
  const pill = page.getByTestId('team-sync');
  const before = await pill.getAttribute('data-at');
  await page.getByTestId('team-sync-now').click();
  await expect(pill).not.toHaveAttribute('data-at', before ?? '', { timeout: 30_000 });
  await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
};

test('two people collaborate through a team space: invite, board, mission, owner review', async () => {
  test.setTimeout(process.platform === 'win32' ? 420_000 : 240_000);
  const seed = sampleRepo();
  const origin = path.join(tmpDir(), 'origin.git');
  git(tmpDir(), 'clone', '-q', '--bare', seed, origin);
  const clone = (name: string) => { const d = path.join(tmpDir(), name); git(tmpDir(), 'clone', '-q', origin, d); git(d, 'config', 'user.name', name); return d; };
  const a = await launch({ openDir: clone('Alice') });
  const b = await launch({ openDir: clone('Bob') });
  try {
    // Alice starts the space, creates the Web team owning src/, and invites Bob into it.
    await openTeam(a.page);
    await expect(a.page.getByTestId('team-my-name').first()).toHaveValue('Alice');
    await a.page.getByTestId('team-space-name').fill('Acme web');
    await a.page.getByTestId('team-create').click();
    await expect(a.page.getByTestId('team-board')).toBeVisible();
    await a.page.getByRole('tab', { name: /People/ }).click();
    await a.page.getByTestId('team-new-team').click();
    await a.page.getByTestId('team-team-name').fill('Web');
    await a.page.getByTestId('team-team-owns').fill('src/');
    await a.page.getByTestId('team-team-save').click();
    await expect(a.page.getByTestId('team-team')).toContainText('Owns src/');
    await a.page.getByRole('checkbox', { name: 'Web', exact: true }).click();
    await a.page.getByTestId('team-invite').click();
    const code = (await a.page.getByTestId('team-invite-code').innerText()).trim();
    expect(code).toMatch(/^ATLAS(-[0-9A-Z]{4}){6}$/);
    await sync(a.page);

    // Bob joins with the code: no account, no approval step.
    await openTeam(b.page);
    await b.page.getByTestId('team-code').fill(code);
    await b.page.getByTestId('team-join').click();
    await expect(b.page.getByTestId('team-board')).toBeVisible({ timeout: 30_000 });
    await b.page.getByRole('tab', { name: /People/ }).click();
    await expect(b.page.locator('[data-testid="team-member"][data-name="Bob"]')).toContainText('Web');

    // Bob adds work for Alice.
    await b.page.getByRole('tab', { name: /Board/ }).click();
    await b.page.getByTestId('team-item-title').fill('Fix slug generation');
    await b.page.getByTestId('team-item-detail').fill('slugify() should lowercase, drop punctuation and collapse separators so the tests pass.');
    await b.page.getByTestId('team-item-assignee').selectOption({ label: 'Alice' });
    await b.page.getByTestId('team-item-add').click();
    await expect(b.page.getByTestId('team-col-open')).toContainText('Fix slug generation');
    await sync(b.page);

    // Alice sees it, starts a mission for it, and runs it.
    await a.page.getByRole('tab', { name: /Board/ }).click();
    const item = a.page.locator('[data-testid="team-item"][data-title="Fix slug generation"] .lv-item-main');
    await expect(async () => { await sync(a.page); await expect(item).toBeVisible({ timeout: 1000 }); }).toPass({ timeout: 30_000, intervals: [1000, 2000, 3000] });
    await item.click();
    await a.page.getByTestId('team-item-start').click();
    await expect(a.page.getByTestId('mission-for-item')).toContainText('Fix slug generation');
    await expect(a.page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await a.page.getByTestId('plan-mission').click();
    await a.page.getByTestId('approve-plan').click();
    await expect(a.page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 150_000 });
    await expect(a.page.getByTestId('mission-state')).toHaveAttribute('data-verdict', 'verified');
    await expect(a.page.getByTestId('pipeline')).toHaveAttribute('data-summary', /waiting for acceptance/);
    await a.page.getByTestId('accept').click();
    // Alice is not in Web, which owns src/: publishing waits for Web's approval of this commit.
    await expect(a.page.getByTestId('pull-request')).toContainText('Needs an approving review of this commit from Web', { timeout: 15_000 });
    await expect(a.page.getByTestId('publish')).toBeDisabled();

    // Bob reads the change on his machine and approves it.
    await b.page.getByRole('tab', { name: /Missions/ }).click();
    const card = b.page.locator('[data-testid="team-mission"][data-title="Fix slug generation"]');
    // Alice's ATLAS shares the verified mission on its own; sync until it has arrived.
    await expect(async () => {
      await sync(b.page);
      await expect(card.getByTestId('team-view-diff')).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 30_000, intervals: [1000, 2000, 3000] });
    await expect(card).toContainText('needs you');
    await expect(card.getByTestId('team-owners')).toContainText('Web: needs approval');
    await card.getByTestId('team-view-diff').click();
    await expect(card.getByTestId('team-diff')).toContainText('src/slugify.js');
    await card.getByTestId('team-approve').click();
    // Alice's ATLAS moves the item to review when her mission verified and pushes it on its own (keep in sync is on);
    // Bob sees it once his sync comes after that push. Sync again until it does, within a bound.
    await b.page.getByRole('tab', { name: /Board/ }).click();
    await expect(async () => {
      await sync(b.page);
      await expect(b.page.getByTestId('team-col-review')).toContainText('Fix slug generation', { timeout: 1000 });
    }).toPass({ timeout: 30_000, intervals: [1000, 2000, 3000] });

    // Back on Alice's machine: the approval arrived, the team blocker is gone, and her timeline shows who approved.
    await a.page.getByRole('button', { name: 'Team' }).click();
    await a.page.getByRole('tab', { name: /Missions/ }).click();
    await expect(async () => {
      await sync(a.page);
      await expect(a.page.locator('[data-testid="team-mission"][data-title="Fix slug generation"] [data-testid="team-owners"]')).toContainText('Web: approved by Bob', { timeout: 1000 });
    }).toPass({ timeout: 30_000, intervals: [1000, 2000, 3000] });
    await a.page.locator('[data-testid="team-mission"][data-title="Fix slug generation"]').getByTestId('team-mission-open').click();
    await expect(a.page.getByTestId('pull-request')).not.toContainText('Needs an approving review', { timeout: 15_000 });
    await a.page.getByRole('tab', { name: /Activity/ }).click();
    await expect(a.page.getByTestId('timeline')).toContainText('Bob approved');
  } finally {
    await a.app.close();
    await b.app.close();
  }
});
