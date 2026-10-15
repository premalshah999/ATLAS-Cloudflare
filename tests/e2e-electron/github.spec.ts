// Pull request and CI loop through the real UI (ADR 0015): a fake GitHub API, and a bare repository standing in for
// github.com through the repository's own insteadOf setting. No network, no real token.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sampleRepo, tmpDir } from '../helpers';
import { FakeGitHub } from '../integration/fake-github';
import { launch } from './app';

const TOKEN = 'ghp_test_token_123456';

test('accept, open a pull request, read failing CI, and start a follow-up that fixes it', async () => {
  const gh = await new FakeGitHub().start();
  const repo = sampleRepo();
  const bare = path.join(tmpDir(), 'app.git');
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git(repo, 'push', '-q', bare, 'main');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git');
  const { app, page } = await launch({ openDir: repo, env: { ATLAS_GITHUB_TOKEN: TOKEN, ATLAS_GITHUB_API: gh.url } });
  page.on('dialog', (d) => void d.accept());
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Fix slug generation');
    await page.getByTestId('mission-goal').fill('slugify() should lowercase, drop punctuation and collapse separators.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('plan-mission').click();
    await page.getByTestId('approve-plan').click();
    await expect(page.getByTestId('mission-state')).toHaveAttribute('data-verdict', 'verified', { timeout: 90_000 });
    await page.getByTestId('accept').click();

    await page.getByTestId('publish').click();
    await expect(page.getByTestId('pr-link')).toHaveText('#41');
    const pr = gh.pulls[0];
    expect(git(bare, 'rev-parse', `refs/heads/${pr.head}`)).toMatch(/^[0-9a-f]{40}$/);
    const sha = git(bare, 'rev-parse', `refs/heads/${pr.head}`);

    gh.checks.set(sha, [{ id: 8, name: 'lint', status: 'completed', conclusion: 'failure', log: 'src/slugify.js:3 error no-unused-vars' }]);
    await page.getByTestId('ci-refresh').click();
    await expect(page.getByTestId('pull-request')).toHaveAttribute('data-ci', 'failure');
    await expect(page.getByTestId('ci-state')).toContainText('CI failed: lint');

    await page.getByTestId('fix-ci').click();
    // If the follow-up is refused, the error toast says why (CI run 38125385152 failed here without a reason).
    const followUp = page.getByTestId('follow-up');
    await expect.poll(async () => (await followUp.count()) ? 'shown' : (await page.locator('.at-toast[data-tone="danger"]').allInnerTexts()).join(' | ') || 'waiting', { timeout: 30_000 }).toBe('shown');
    await expect(followUp).toContainText('Fixes CI on pull request #41');
    await expect(page.getByTestId('approve-plan')).toBeVisible({ timeout: 30_000 });
    expect(gh.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  } finally { await app.close(); await gh.close(); }
});
