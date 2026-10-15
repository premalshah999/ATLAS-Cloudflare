// Captures README screenshots from the real built app driving a real sample mission.
// Run with `pnpm screenshots` (Linux: xvfb). Nothing here is mocked: every screen shows live daemon state.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyIdOf, TeamSpace } from '@atlas/team';
import { FIXTURE, tmpDir } from '../helpers';
import { launch } from './app';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Maya Chen', GIT_AUTHOR_EMAIL: 'maya@northwind.dev', GIT_COMMITTER_NAME: 'Maya Chen', GIT_COMMITTER_EMAIL: 'maya@northwind.dev' } }).trim();

/** The sample project under a realistic name, committed once; with `origin`, cloned from a bare origin (for teams). */
function projectRepo(name = 'northwind-blog', origin?: string): string {
  const dir = path.join(tmpDir(), name);
  if (origin) { git(path.dirname(dir), 'clone', '-q', origin, dir); }
  else {
    cpSync(FIXTURE, dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'Northwind blog: posts, slugs and the public API');
  }
  git(dir, 'config', 'user.name', 'Maya Chen'); git(dir, 'config', 'user.email', 'maya@northwind.dev');
  return dir;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (name: string) => path.resolve(here, '../../docs/screenshots', `${name}.png`);
const shot = async (page: Page, name: string) => {
  await page.mouse.move(1435, 600); // park the pointer on empty canvas so no tooltip or hover state leaks in
  await page.waitForTimeout(500);
  await page.screenshot({ path: out(name) });
};
const top = (page: Page) => page.evaluate(() => document.querySelectorAll('.lv-scroll').forEach((el) => el.scrollTo(0, 0)));

test('capture README screenshots', async () => {
  test.setTimeout(240_000);
  const repo = projectRepo();
  const { app, page } = await launch({ openDir: repo });
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 900); w.center(); });
    await page.waitForTimeout(500);
    await shot(page, '01-projects-empty');

    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('northwind-blog');
    await page.locator('.at-toast, [class*="toast"]').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    await shot(page, '02-projects');

    // Mission 1: ask for every write, to show the approval card.
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Fix URL slugs for blog post titles');
    await page.getByTestId('mission-goal').fill('slugify() should lowercase, drop punctuation and collapse separators so the tests in test/slugify.test.js pass.');
    await page.locator('textarea').nth(1).fill('Do not change the public function signature.');
    await page.getByRole('radio', { name: 'Ask for every write' }).click();
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await top(page);
    await shot(page, '03-new-mission');

    await page.getByTestId('plan-mission').click();
    await expect(page.getByTestId('plan')).toContainText('Acceptance criteria');
    await shot(page, '04-plan-review');

    await page.getByTestId('approve-plan').click();
    const card = page.getByTestId('approval').first();
    await expect(card).toContainText('src/slugify.js', { timeout: 30_000 });
    await shot(page, '05-approval');

    await card.getByTestId('approve').click();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
    await page.getByRole('tab', { name: /Activity/ }).click();
    await shot(page, '06-activity');
    await page.getByRole('button', { name: /^Policy & approvals/ }).click();
    await shot(page, '06b-activity-filtered');
    await page.getByRole('button', { name: /^All/ }).click();

    await page.getByRole('tab', { name: /Changes/ }).click();
    await expect(page.getByTestId('changes')).toContainText('.toLowerCase()');
    await shot(page, '07-changes');

    await page.getByRole('tab', { name: /Evidence/ }).click();
    await page.getByRole('button', { name: 'View log' }).first().click();
    await shot(page, '08-evidence');

    await page.keyboard.press('Control+k');
    await page.keyboard.type('mis');
    await shot(page, '09a-command-palette');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('runtime-fake')).toBeVisible();
    await shot(page, '09-settings');

    await page.getByRole('button', { name: 'Design preview' }).click();
    await page.waitForTimeout(800);
    await shot(page, '10-design-preview');
  } finally { await app.close(); }
});

test('capture M2–M5 screenshots', async () => {
  test.setTimeout(300_000);
  const repo = projectRepo();
  const { app, page } = await launch({ openDir: repo });
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 900); w.center(); });
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('northwind-blog');
    await page.locator('.at-toast, [class*="toast"]').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByTestId('allow-target').fill('local-staging');
    await page.getByRole('button', { name: 'Allow target' }).click();
    const desk = page.getByTestId('desktop-settings');
    await expect(desk).not.toContainText('Checking');
    const desktopOk = !(await desk.innerText()).includes('Unavailable');
    if (desktopOk) await desk.getByRole('switch').click();
    await page.getByTestId('desktop-settings').scrollIntoViewIfNeeded();
    await shot(page, '11-settings-desktop-deploy');
    await page.getByTestId('roles').scrollIntoViewIfNeeded();
    await shot(page, '12-agent-roles');

    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Fix post URLs and ship them to staging');
    await page.getByTestId('mission-goal').fill('Fix slugify so post URLs are clean and the tests pass, then deploy to staging and verify it there.');
    await page.getByRole('radio', { name: /local-staging · staging/ }).click();
    await page.getByRole('button', { name: 'Change' }).click();
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('budget-fields').scrollIntoViewIfNeeded();
    await shot(page, '13-composer-target-budget');
    await page.getByTestId('plan-mission').click();
    await page.getByTestId('approve-plan').click();
    const card = page.getByTestId('approval').first();
    await expect(card).toContainText('local-staging', { timeout: 90_000 });
    await shot(page, '14-deploy-approval');
    await card.getByTestId('approve').click();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 120_000 });

    await page.getByRole('tab', { name: /Tasks/ }).click();
    await shot(page, '15-task-graph');
    await page.getByRole('tab', { name: /Browser/ }).click();
    await page.getByRole('button', { name: 'Screenshot' }).last().click();
    await page.locator('img.lv-shot').waitFor();
    await shot(page, '16-browser-qa');
    await page.getByRole('tab', { name: /Deploy/ }).click();
    await expect(page.getByTestId('deployment-row').first()).toBeVisible();
    await shot(page, '17-staging-deploy');
    await page.getByRole('tab', { name: /Review/ }).click();
    await shot(page, '18-review');
    await page.getByRole('tab', { name: /Terminal/ }).click();
    await page.getByTestId('open-terminal').click();
    await page.locator('.lv-term').click();
    await page.keyboard.type('git log --oneline -3 && ls\n');
    await expect(page.locator('.lv-term')).toContainText('package.json', { timeout: 15_000 });
    await shot(page, '19-operator-terminal');

    if (desktopOk) {
      await page.getByRole('button', { name: 'New mission' }).first().click();
      await page.getByTestId('mission-title').fill('Check the release notes window');
      await page.getByTestId('mission-goal').fill('[desktop sample] Operate the virtual desktop.');
      await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
      await page.getByTestId('plan-mission').click();
      await page.getByTestId('approve-plan').click();
      const dc = page.getByTestId('approval').first();
      await expect(dc).toContainText('virtual desktop', { timeout: 30_000 });
      await shot(page, '20-desktop-approval');
      await dc.getByTestId('approve').click();
      await page.getByRole('tab', { name: /Desktop/ }).click();
      await expect(page.getByTestId('desktop-controller')).toHaveAttribute('data-controller', 'agent', { timeout: 15_000 });
      // Let the agent launch its app and click before taking over.
      await expect(page.getByTestId('desktop')).toContainText(/[2-9] inputs so far/, { timeout: 20_000 });
      await page.waitForTimeout(1500);
      await shot(page, '21a-desktop-agent');
      await page.getByTestId('desktop-takeover').click();
      await expect(page.getByTestId('desktop-controller')).toHaveAttribute('data-controller', 'operator');
      await page.waitForTimeout(1500);
      await shot(page, '21-desktop-takeover');
      await expect(page.getByTestId('mission')).toHaveAttribute('data-state', /completed|failed/, { timeout: 60_000 });
      await page.getByRole('tab', { name: /Activity/ }).click();
      await shot(page, '22-desktop-audit');
    }
  } finally { await app.close(); }
});

/** A second installation (a teammate on another machine), driven directly through the team record. */
function teammate(root: string) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pub = (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
  return new TeamSpace({ root, signer: { keyId: keyIdOf(pub), publicKey: pub, sign: (d) => ({ keyId: keyIdOf(pub), publicKey: pub, signature: sign(null, Buffer.from(d, 'utf8'), privateKey).toString('base64') }) } });
}

test('capture team, pipeline and settings screenshots', async () => {
  test.setTimeout(360_000);
  const origin = path.join(tmpDir(), 'northwind-blog.git');
  const seed = projectRepo('seed');
  git(path.dirname(origin), 'clone', '-q', '--bare', seed, origin);
  const repo = projectRepo('northwind-blog', origin);
  const priyaDir = projectRepo('northwind-blog', origin);
  const { app, page } = await launch({ openDir: repo });
  const syncUi = async () => {
    const pill = page.getByTestId('team-sync');
    const before = await pill.getAttribute('data-at');
    await page.getByTestId('team-sync-now').click();
    await expect(pill).not.toHaveAttribute('data-at', before ?? '', { timeout: 30_000 });
  };
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 900); w.center(); });
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('northwind-blog');
    await page.locator('.at-toast, [class*="toast"]').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

    // Maya starts the team space, with two teams that own parts of the code, and invites Priya into Web.
    await page.getByRole('button', { name: 'Team' }).click();
    await expect(page.getByTestId('team-my-name').first()).toHaveValue('Maya Chen');
    await page.getByTestId('team-space-name').fill('Northwind');
    await shot(page, '23-team-start');
    await page.getByTestId('team-create').click();
    await expect(page.getByTestId('team-board')).toBeVisible();
    await page.getByRole('tab', { name: /People/ }).click();
    for (const [name, owns] of [['Web', 'src/, public/'], ['Platform', 'server.js, package.json']]) {
      await page.getByTestId('team-new-team').click();
      await page.getByTestId('team-team-name').fill(name);
      await page.getByTestId('team-team-owns').fill(owns);
      await page.getByTestId('team-team-save').click();
      await expect(page.locator(`[data-testid="team-team"][data-slug="${name.toLowerCase()}"]`)).toBeVisible();
    }
    await page.getByRole('checkbox', { name: 'Web', exact: true }).click();
    await page.getByTestId('team-invite').click();
    const code = (await page.getByTestId('team-invite-code').innerText()).trim();
    await syncUi();

    // Priya, on her own machine: joins with the code and fills the board.
    const priya = teammate(priyaDir);
    await priya.sync();
    await priya.join({ name: 'Priya Natarajan', email: 'priya@northwind.dev' }, code);
    const maya = [...(await priya.state()).members.values()].find((m) => m.name === 'Maya Chen')!.keyId;
    const { id: slugs } = await priya.write('item.create', { title: 'Fix URL slugs for blog post titles', detail: 'slugify() should lowercase, drop punctuation and collapse separators so post URLs are clean and the tests pass.', team: 'web', assignee: maya, priority: 'high' });
    await priya.write('comment', { item: slugs, text: 'Readers keep sharing links with %20 in them. Can we get this in before Friday?' });
    await priya.write('item.create', { title: 'Add an RSS feed for new posts', detail: 'Serve /feed.xml with the 20 latest posts.', team: 'web', assignee: 'agents', priority: 'normal' });
    await priya.write('item.create', { title: 'Rate-limit the public slug API', detail: 'Limit /api/slug to 60 requests per minute per client.', team: 'platform', assignee: null, priority: 'urgent' });
    const { id: runbook } = await priya.write('item.create', { title: 'Write the staging deploy runbook', team: 'platform', assignee: null, priority: 'low' });
    await priya.write('item.claim', { item: runbook });
    await priya.sync();

    await syncUi();
    await page.getByRole('tab', { name: /Board/ }).click();
    await expect(page.locator('[data-testid="team-item"]')).toHaveCount(4);
    await page.locator('[data-testid="team-item"][data-title="Fix URL slugs for blog post titles"] .lv-item-main').click();
    await shot(page, '24-team-board');

    // Maya takes the item as a mission. The change touches src/, which Web owns: Priya has to approve it.
    await page.getByTestId('team-item-start').click();
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('plan-mission').click();
    await page.getByTestId('approve-plan').click();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 120_000 });
    await page.getByRole('tab', { name: /Evidence/ }).click();
    await shot(page, '25-pipeline-and-security');
    await page.getByTestId('accept').click();
    await expect(page.getByTestId('pull-request')).toContainText('Needs an approving review', { timeout: 15_000 });
    await shot(page, '26-owner-approval-needed');

    // Priya reviews it from her machine.
    await page.waitForTimeout(2500);
    for (let i = 0; i < 10 && !(await priya.sync().then(() => priya.state())).missions.size; i++) await page.waitForTimeout(1000);
    const shared = [...(await priya.state()).missions.values()][0];
    await priya.write('review', { missionId: shared.snapshot.missionId, commit: shared.snapshot.commit!, verdict: 'approve', note: 'Slugs look right; nice test coverage.' });
    await priya.write('comment', { missionId: shared.snapshot.missionId, text: 'Merging after lunch.' });
    await priya.sync();

    await page.getByRole('button', { name: 'Team' }).click();
    await page.getByRole('tab', { name: /Missions/ }).click();
    await syncUi();
    const card = page.locator('[data-testid="team-mission"]').first();
    await expect(card.getByTestId('team-owners')).toContainText('approved by Priya', { timeout: 15_000 });
    await card.getByTestId('team-view-diff').click();
    await shot(page, '27-team-missions');
    await page.getByRole('tab', { name: /People/ }).click();
    await shot(page, '28-team-people');
    await page.getByRole('tab', { name: /Activity/ }).click();
    await shot(page, '29-team-activity');
    await page.getByRole('tab', { name: /Automation/ }).click();
    await page.getByTestId('pipeline-autopublish').getByRole('switch').click();
    await page.getByTestId('pipeline-settings').getByRole('radio', { name: 'Fix automatically' }).click();
    await expect(page.getByTestId('pipeline-autoaccept')).toBeVisible();
    await shot(page, '30-team-automation');

    // Settings added since the first tour.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByTestId('models').scrollIntoViewIfNeeded();
    await shot(page, '31-settings-models');
    await page.getByTestId('mcp-servers').scrollIntoViewIfNeeded();
    await shot(page, '32-settings-mcp');
    await page.getByTestId('skills').scrollIntoViewIfNeeded();
    await shot(page, '33-settings-skills');
    await page.getByTestId('sync').scrollIntoViewIfNeeded();
    await shot(page, '34-settings-sync');
    await page.getByTestId('security-settings').scrollIntoViewIfNeeded();
    await shot(page, '35-settings-security-storage');
  } finally { await app.close(); }
});

test('capture visual proof screenshots', async () => {
  test.setTimeout(240_000);
  const repo = projectRepo();
  const { app, page } = await launch({ openDir: repo });
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 900); w.center(); });
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('northwind-blog');
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Explain post URLs on the slug page');
    await page.getByTestId('mission-goal').fill('[ui sample] Fix slugify, explain the tool under the heading and show the slug in a card.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('plan-mission').click();
    await page.getByTestId('approve-plan').click();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 120_000 });
    await page.getByRole('tab', { name: /Visual/ }).click();
    const card = page.getByTestId('visual-page');
    await card.getByRole('radio', { name: 'Compare' }).click();
    await page.getByTestId('visual-compare').getByRole('slider').fill('12');
    await page.getByTestId('visual-compare').getByRole('img', { name: '/ after' }).waitFor();
    await top(page);
    await shot(page, '36-visual-compare');
    await card.getByRole('radio', { name: 'Diff' }).click();
    await card.getByRole('img', { name: '/ diff' }).waitFor();
    await shot(page, '37-visual-diff');
  } finally {
    await app.close();
  }
});
