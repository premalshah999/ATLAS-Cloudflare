import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@atlas/workspace', () => ({ gitOk: vi.fn() }));
vi.mock('@atlas/terminal', async (original) => ({ ...await original<typeof import('@atlas/terminal')>(), run: vi.fn() }));
import { gitOk } from '@atlas/workspace';
import { run } from '@atlas/terminal';
import { publishMission } from '../src';

const sha = 'a'.repeat(40), taskSha = 'b'.repeat(40);
const remote = `https://${'c'.repeat(32)}.artifacts.cloudflare.net/git/atlas/atlas-msn_test.git`;
const options = { root: '/tmp/atlas-test', missionId: 'msn_test', baseCommit: sha, url: 'https://atlas.example', secret: 'owner-secret-at-least-32-characters-long' };
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
function setup(matching = true, target = remote) {
  vi.mocked(gitOk).mockResolvedValue(`${taskSha} refs/heads/atlas/msn_test/integration`);
  vi.mocked(run).mockResolvedValue({ exitCode: 0 } as any);
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ remote: target, token: 'art_v1_TEST_SECRET' })).mockResolvedValueOnce(Response.json({
    name: 'atlas-msn_test', verified: matching, checkedAt: new Date().toISOString(), refs: [
      { ref: 'refs/heads/main', expected: sha, actual: sha, matches: true },
      { ref: 'refs/heads/atlas/msn_test/integration', expected: taskSha, actual: matching ? taskSha : sha, matches: matching },
    ],
  }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
describe('publication protocol (mocked service)', () => {
  it('pushes immutable commit IDs without credentials in argv and independently reads them back', async () => {
    const fetcher = setup();
    const result = await publishMission(options);
    expect(result.verified).toBe(true);
    const command = vi.mocked(run).mock.calls[0][0];
    expect(command.args).toContain(`${taskSha}:refs/heads/atlas/msn_test/integration`);
    expect(JSON.stringify(command.args)).not.toContain('TEST_SECRET');
    expect(command.env?.GIT_CONFIG_VALUE_4).toBe('Authorization: Bearer art_v1_TEST_SECRET');
    expect(fetcher.mock.calls[1][0]).toContain('/verify');
  });
  it('refuses to claim success when readback differs', async () => {
    setup(false);
    await expect(publishMission(options)).rejects.toThrow('unverified');
  });
  it('never sends Git credentials to an arbitrary remote', async () => {
    setup(true, 'https://evil.example/git/atlas/demo.git');
    await expect(publishMission(options)).rejects.toThrow('Cloudflare Artifacts');
    expect(run).not.toHaveBeenCalled();
  });
  it('fails before publishing when connection credentials are missing', async () => {
    const fetcher = setup();
    await expect(publishMission({ ...options, secret: '' })).rejects.toThrow('connection token');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
