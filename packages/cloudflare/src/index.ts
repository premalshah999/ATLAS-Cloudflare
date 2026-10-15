import { registerSecret } from '@atlas/contracts';
import { run, sanitizedEnv } from '@atlas/terminal';
import { gitOk } from '@atlas/workspace';

export function workerUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Use the HTTPS Worker origin, without a path or credentials.');
  return u.origin;
}
export function artifactsRemote(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(u.hostname) || u.port || u.username || u.password || u.search || u.hash || !/^\/git\/[^/]+\/[^/]+\.git$/.test(u.pathname)) throw new Error('Worker did not return a Cloudflare Artifacts Git remote.');
  return u.href;
}
export type Publication = { name: string; remote: string; verified: boolean; refs: { ref: string; expected: string; actual: string | null; matches: boolean }[]; checkedAt: string };

/** Explicit operator action; trusted Git plumbing, never an agent-requested command. */
export async function publishMission(o: { root: string; missionId: string; baseCommit: string; url: string; secret: string }): Promise<Publication> {
  if (!/^msn_[a-zA-Z0-9_-]+$/.test(o.missionId) || !/^[a-f0-9]{40}$/.test(o.baseCommit)) throw new Error('Invalid mission identity');
  if (o.secret.length < 32) throw new Error('Set the Cloudflare connection token in Settings first.');
  const origin = workerUrl(o.url);
  registerSecret(o.secret);
  const name = `atlas-${o.missionId}`;
  const api = async (action: string, body: unknown) => {
    const r = await fetch(`${origin}/repos/${name}/${action}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${o.secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Cloudflare ${action} failed (HTTP ${r.status}). Check the Worker URL, connection token and Artifacts access.`);
    return r.json();
  };
  // Snapshot commit IDs before pushing: concurrent local ref changes cannot change what we publish.
  const lines = await gitOk(o.root, ['for-each-ref', '--format=%(objectname) %(refname)', `refs/heads/atlas/${o.missionId}/`]);
  const refs = [{ sha: o.baseCommit, ref: 'refs/heads/main' }, ...lines.split('\n').filter(Boolean).map((line) => {
    const [sha, ref] = line.split(' ');
    if (!/^[a-f0-9]{40}$/.test(sha) || !ref.startsWith(`refs/heads/atlas/${o.missionId}/`) || !/^[a-zA-Z0-9_/-]+$/.test(ref)) throw new Error('Invalid mission branch');
    return { sha, ref };
  })];
  if (refs.length < 2) throw new Error('No mission checkpoints to publish yet.');
  const connection = await api('connect', {}) as { remote: string; token: string };
  const remote = artifactsRemote(connection.remote);
  if (typeof connection.token !== 'string' || !/^art_v\d+_[A-Za-z0-9_]+(\?expires=\d+)?$/.test(connection.token)) throw new Error('Invalid repository token');
  registerSecret(connection.token);
  // Credentials are scoped to this exact remote, passed in environment, never argv or git config.
  const config: Record<string, string> = {
    'core.hooksPath': '/dev/null', 'core.fsmonitor': 'false', 'credential.helper': '', 'http.followRedirects': 'false',
    [`http.${remote}.extraHeader`]: `Authorization: Bearer ${connection.token}`,
  };
  const env = sanitizedEnv({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: String(Object.keys(config).length) });
  Object.entries(config).forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  const pushed = await run({ command: 'git', args: ['push', '--porcelain', remote, ...refs.map(({ sha, ref }) => `${sha}:${ref}`)], cwd: o.root, timeoutMs: 120_000, env });
  if (pushed.exitCode !== 0) throw new Error(`Artifacts push failed: ${pushed.output.slice(0, 1000)}`);
  const checked = await api('verify', { refs }) as Omit<Publication, 'remote'>;
  if (!checked.verified || checked.refs?.length !== refs.length || refs.some((r) => !checked.refs.some((c) => c.ref === r.ref && c.actual === r.sha && c.matches))) {
    const bad = refs.filter((r) => !checked.refs?.some((c) => c.ref === r.ref && c.actual === r.sha && c.matches)).map((r) => `${r.ref} expected ${r.sha.slice(0, 12)}, got ${checked.refs?.find((c) => c.ref === r.ref)?.actual?.slice(0, 12) ?? 'nothing'}`);
    throw new Error(`Artifacts did not confirm every published commit (${bad.join('; ')}). Publication is unverified; retry after checking the remote.`);
  }
  return { ...checked, remote };
}
