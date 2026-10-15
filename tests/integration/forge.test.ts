// Pull request and CI feedback loop (ADR 0015), offline: a fake GitHub API, and a bare repository standing in for
// github.com through the repository's own `url.<bare>.insteadOf` setting (real git, no network, no test hooks).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { GitHubForge } from '@atlas/orchestrator';
import { forTask, sampleSlugifyScript } from '@atlas/runtime-fake';
import { sampleRepo, tmpDir } from '../helpers';
import { explainChecks, makeOrchestrator, startMission } from './harness';
import { FakeGitHub } from './fake-github';

const TOKEN = 'ghp_test_token_123456';
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

let gh: FakeGitHub;
beforeEach(async () => { gh = await new FakeGitHub().start(); });
afterEach(async () => { await gh.close(); });

function setup(opts: { token?: boolean; remote?: string } = {}) {
  const root = sampleRepo();
  const bare = path.join(tmpDir(), 'app.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  sh(root, 'push', '-q', bare, 'main');
  sh(root, 'remote', 'add', 'origin', opts.remote ?? 'https://github.com/acme/app.git');
  sh(root, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git');
  const forge = opts.token === false ? null : new GitHubForge({ token: TOKEN, apiBase: gh.url });
  const h = makeOrchestrator({
    forge: () => forge,
    scripts: [sampleSlugifyScript, forTask('implement', [{ tool: 'write_file', args: { path: 'CI.md', content: 'lint fixed\n' } }, { claim: 'Fixed the lint failure.' }])],
  });
  return { root, bare, h };
}

async function verifiedAndAccepted(h: ReturnType<typeof makeOrchestrator>, root: string) {
  const id = await startMission(h, root);
  await h.orch.settle(id);
  expect(h.repo.mission(id)!.verdict, explainChecks(h, id)).toBe('verified');
  await h.orch.decide(id, 'accept');
  return id;
}

describe('pull request and CI loop (ADR 0015)', () => {
  it('publishes an accepted, verified result, reads failing CI, and fixes it in a follow-up on the same pull request', async () => {
    const { root, bare, h } = setup();
    const id = await startMission(h, root);
    await h.orch.settle(id);
    // Nothing is published before the operator accepts.
    await expect(h.orch.publish(id)).rejects.toThrow(/Accept the mission first/);
    await h.orch.decide(id, 'accept');
    const m = h.repo.mission(id)!;

    const view = await h.orch.publish(id);
    expect(view.published).toMatchObject({ owner: 'acme', repo: 'app', number: 41, branch: m.integrationBranch, headSha: m.integrationCommit, created: true });
    expect(sh(bare, 'rev-parse', `refs/heads/${m.integrationBranch}`)).toBe(m.integrationCommit);
    expect(gh.pulls[0]).toMatchObject({ head: m.integrationBranch, base: 'main', title: m.title });
    expect(gh.pulls[0].body).toMatch(/ATLAS verdict: verified/);

    // CI: one job fails with a log; the failure is recorded with its output as an artifact.
    gh.checks.set(m.integrationCommit!, [
      { id: 7, name: 'build', status: 'completed', conclusion: 'success' },
      { id: 8, name: 'lint', status: 'completed', conclusion: 'failure', title: 'eslint found 1 error', annotations: [{ path: 'src/slugify.js', start_line: 3, annotation_level: 'failure', message: 'no-unused-vars' }], log: 'step 1\nnpm run lint\nsrc/slugify.js:3 error no-unused-vars\nexit code 1' },
    ]);
    const ci = await h.orch.ciRefresh(id);
    expect(ci.ci).toMatchObject({ state: 'failure', number: 41 });
    expect(ci.canFixCi).toBe(true);
    const ciEvent = h.events.filter((e) => e.type === 'forge.ci').at(-1)!;
    const log = h.artifacts.read(ciEvent.artifactIds[0]).text;
    expect(log).toMatch(/src\/slugify.js:3 failure: no-unused-vars/);
    expect(log).toMatch(/exit code 1/);
    // Unchanged CI is not recorded twice.
    await h.orch.ciRefresh(id);
    expect(h.events.filter((e) => e.type === 'forge.ci')).toHaveLength(1);

    // The follow-up starts from the pull request head, carries the output as quoted data, and needs approval.
    const follow = await h.orch.fixCi(id);
    expect(follow.followUp).toEqual({ parentMissionId: id, branch: m.integrationBranch, headSha: m.integrationCommit, pullRequest: 41 });
    expect(follow.goal).toMatch(/Failing checks: lint/);
    expect(follow.goal).toMatch(/<ci-output>[\s\S]*no-unused-vars[\s\S]*<\/ci-output>/);
    expect(follow.state).toBe('draft');
    await h.orch.plan(follow.id);
    await h.orch.approvePlan(follow.id);
    expect(h.repo.mission(follow.id)!.baseCommit).toBe(m.integrationCommit);
    await h.orch.settle(follow.id);
    expect(h.repo.mission(follow.id)!.verdict, explainChecks(h, follow.id)).toBe('verified');
    await h.orch.decide(follow.id, 'accept');

    // Publishing the follow-up fast-forwards the same branch and reuses the pull request.
    const fv = await h.orch.publish(follow.id);
    const fm = h.repo.mission(follow.id)!;
    expect(fv.published).toMatchObject({ number: 41, branch: m.integrationBranch, headSha: fm.integrationCommit, created: false });
    expect(sh(bare, 'rev-parse', `refs/heads/${m.integrationBranch}`)).toBe(fm.integrationCommit);
    expect(sh(bare, 'merge-base', '--is-ancestor', m.integrationCommit!, fm.integrationCommit!)).toBe('');
    expect(gh.pulls).toHaveLength(1);

    // The token went only to the API, and nowhere into the record.
    expect(gh.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    const record = JSON.stringify([...h.repo.eventsSince(id, 0), ...h.repo.eventsSince(follow.id, 0)]) + log;
    expect(record).not.toContain(TOKEN);
    expect(record).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
  }, 120_000);

  it('never force-pushes: a branch someone else moved is refused and left as it is', async () => {
    const { root, bare, h } = setup();
    const id = await verifiedAndAccepted(h, root);
    const m = h.repo.mission(id)!;
    await h.orch.publish(id);
    gh.checks.set(m.integrationCommit!, [{ id: 9, name: 'test', status: 'completed', conclusion: 'failure', log: 'boom' }]);
    await h.orch.ciRefresh(id);
    const follow = await h.orch.fixCi(id);
    // Someone pushes to the pull request branch while the follow-up runs.
    const other = path.join(tmpDir(), 'other');
    execFileSync('git', ['clone', '-q', '-b', m.integrationBranch!, bare, other]);
    writeFileSync(path.join(other, 'theirs.txt'), 'x');
    sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'theirs'); sh(other, 'push', '-q', 'origin', m.integrationBranch!);
    const theirs = sh(other, 'rev-parse', 'HEAD');

    await h.orch.plan(follow.id);
    await h.orch.approvePlan(follow.id);
    await h.orch.settle(follow.id);
    await h.orch.decide(follow.id, 'accept');
    await expect(h.orch.publish(follow.id)).rejects.toThrow(/never force-pushes/);
    expect(sh(bare, 'rev-parse', `refs/heads/${m.integrationBranch}`)).toBe(theirs);
    expect(h.events.filter((e) => e.missionId === follow.id && e.type === 'forge.published')).toEqual([]);
  }, 120_000);

  it('a follow-up created after someone pushed starts from their commit', async () => {
    const { root, bare, h } = setup();
    const id = await verifiedAndAccepted(h, root);
    const m = h.repo.mission(id)!;
    await h.orch.publish(id);
    const other = path.join(tmpDir(), 'other');
    execFileSync('git', ['clone', '-q', '-b', m.integrationBranch!, bare, other]);
    writeFileSync(path.join(other, 'theirs.txt'), 'x');
    sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'theirs'); sh(other, 'push', '-q', 'origin', m.integrationBranch!);
    gh.checks.set(m.integrationCommit!, [{ id: 10, name: 'test', status: 'completed', conclusion: 'failure' }]);
    await h.orch.ciRefresh(id);
    const follow = await h.orch.fixCi(id);
    expect(follow.followUp!.headSha).toBe(sh(other, 'rev-parse', 'HEAD'));
  }, 120_000);

  it('refuses without a token, without a github.com origin, for unverified results, and before CI failed', async () => {
    const a = setup({ token: false });
    const id = await verifiedAndAccepted(a.h, a.root);
    expect((await a.h.orch.forgeView(id)).blocker).toMatch(/Add a GitHub token/);
    await expect(a.h.orch.publish(id)).rejects.toThrow(/Add a GitHub token/);

    const b = setup({ remote: 'https://gitlab.example.com/acme/app.git' });
    const id2 = await verifiedAndAccepted(b.h, b.root);
    await expect(b.h.orch.publish(id2)).rejects.toThrow(/not a github.com repository/);

    const c = setup();
    const id3 = await verifiedAndAccepted(c.h, c.root);
    await expect(c.h.orch.fixCi(id3)).rejects.toThrow(/CI has not failed/);
    await c.h.orch.publish(id3);
    c.h.repo.updateMission(id3, { verdict: 'unverified' });
    await expect(c.h.orch.publish(id3)).rejects.toThrow(/Only verified results/);
    gh.checks.set(c.h.repo.mission(id3)!.integrationCommit!, [{ id: 11, name: 'test', status: 'in_progress', conclusion: null }]);
    expect((await c.h.orch.ciRefresh(id3)).ci?.state).toBe('pending');
    await expect(c.h.orch.fixCi(id3)).rejects.toThrow(/CI has not failed/);
  }, 180_000);
});
