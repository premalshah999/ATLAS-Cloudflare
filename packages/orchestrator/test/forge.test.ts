import { describe, expect, it } from 'vitest';
import { ciState, GitHubForge, parseRemote, type CiCheck } from '../src/forge';

describe('parseRemote', () => {
  it('accepts github.com in https and ssh forms', () => {
    for (const u of ['https://github.com/acme/app.git', 'https://github.com/acme/app', 'https://x-access-token@github.com/acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app.git', 'https://github.com/acme/my.app/'])
      expect(parseRemote(u), u).toMatchObject({ host: 'github.com', owner: 'acme' });
    expect(parseRemote('https://github.com/acme/my.app.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'my.app' });
  });
  it('rejects look-alike hosts, paths and traversal', () => {
    for (const u of ['https://github.com.evil.example/acme/app.git', 'https://evil.example/github.com/acme/app.git', 'http://github.com/acme/app.git', 'git@github.com:acme/../app.git',
      'https://github.com/acme/app/extra', 'https://github.com/acme/..', 'git@gitlab.com:acme/app.git', '/srv/git/app.git', 'https://github.com/ac me/app', 'file:///github.com/acme/app'])
      expect(parseRemote(u), u).toBeNull();
  });
});

describe('ciState', () => {
  const c = (status: string, conclusion: string | null): CiCheck => ({ id: 1, name: 'x', status, conclusion, url: null, summary: '' });
  it('fails on any failure, waits on anything unfinished, passes only when all finished cleanly', () => {
    expect(ciState([])).toBe('none');
    expect(ciState([c('completed', 'success'), c('in_progress', null)])).toBe('pending');
    expect(ciState([c('completed', 'failure'), c('in_progress', null)])).toBe('failure');
    expect(ciState([c('completed', 'timed_out')])).toBe('failure');
    expect(ciState([c('completed', 'cancelled')])).toBe('failure');
    expect(ciState([c('completed', 'success'), c('completed', 'skipped'), c('completed', 'neutral')])).toBe('success');
  });
});

describe('GitHubForge', () => {
  const reply = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  it('keeps the token out of git arguments: config travels in the environment, base64-encoded', () => {
    const env = new GitHubForge({ token: 'ghp_abcdefgh12345678' }).gitEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('http.https://github.com/.extraheader');
    expect(Buffer.from(env.GIT_CONFIG_VALUE_1.replace('AUTHORIZATION: basic ', ''), 'base64').toString()).toBe('x-access-token:ghp_abcdefgh12345678');
  });
  it('maps API failures to typed errors with a hint, never retrying silently', async () => {
    const r = { host: 'github.com', owner: 'a', repo: 'b' };
    await expect(new GitHubForge({ token: 't0000000', fetch: async () => reply(401, { message: 'Bad credentials' }) }).defaultBranch(r)).rejects.toMatchObject({ kind: 'invalid_request', message: expect.stringMatching(/401.*Bad credentials.*token in Settings/) });
    await expect(new GitHubForge({ token: 't0000000', fetch: async () => reply(502, 'gateway') }).defaultBranch(r)).rejects.toMatchObject({ kind: 'network_unavailable' });
    await expect(new GitHubForge({ token: 't0000000', fetch: async () => { throw new TypeError('fetch failed'); } }).defaultBranch(r)).rejects.toMatchObject({ kind: 'network_unavailable', message: expect.stringMatching(/Could not reach GitHub/) });
  });
  it('maps legacy commit statuses onto checks', async () => {
    const f = new GitHubForge({ token: 't0000000', fetch: async (u) => String(u).endsWith('/status') ? reply(200, { statuses: [{ context: 'ci/jenkins', state: 'failure', target_url: 'https://ci', description: 'red' }] }) : reply(200, { check_runs: [] }) });
    const checks = await f.checks({ host: 'github.com', owner: 'a', repo: 'b' }, 'abc');
    expect(checks).toEqual([{ id: null, name: 'ci/jenkins', status: 'completed', conclusion: 'failure', url: 'https://ci', summary: 'red' }]);
    expect(ciState(checks)).toBe('failure');
  });
  it('requires a token', () => { expect(() => new GitHubForge({ token: '' })).toThrow(/token is required/); });
});
