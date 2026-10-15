// Pull request and CI feedback loop (P2, ADR 0015). After the operator accepts a verified mission, ATLAS can push
// its result branch and open a pull request, read the CI checks GitHub reports for that commit, and turn a failing
// run into a follow-up mission that starts from the pull request's head. Every outward step is an operator action:
// nothing is pushed or opened by an agent, and nothing is ever force-pushed.
import { AtlasError } from '@atlas/contracts';

export interface RemoteRef { host: string; owner: string; repo: string }

/** owner/repo of a github.com remote (https or ssh form); null for anything else. */
export function parseRemote(url: string): RemoteRef | null {
  const u = url.trim();
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(u);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { host: 'github.com', owner: m[1], repo: m[2] };
}

export type CiState = 'pending' | 'success' | 'failure' | 'none';
export interface CiCheck { id: number | null; name: string; status: string; conclusion: string | null; url: string | null; summary: string }
export interface PullRequest { number: number; url: string; head: string; state: string }

export interface Forge {
  readonly host: string;
  defaultBranch(r: RemoteRef): Promise<string>;
  findPullRequest(r: RemoteRef, branch: string): Promise<PullRequest | null>;
  openPullRequest(r: RemoteRef, p: { branch: string; base: string; title: string; body: string }): Promise<PullRequest>;
  checks(r: RemoteRef, sha: string): Promise<CiCheck[]>;
  /** Text a person would read to understand a failed check: its output, annotations and the tail of its job log. */
  failureDetail(r: RemoteRef, check: CiCheck): Promise<string>;
  /** Environment for `git push`/`git fetch` over https, carrying the credential without putting it in arguments. */
  gitEnv(): Record<string, string>;
}

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'error']);

/** One state for a commit's checks: any failure fails; anything unfinished is pending; all good is success. */
export function ciState(checks: CiCheck[]): CiState {
  if (!checks.length) return 'none';
  if (checks.some((c) => c.conclusion && FAILED.has(c.conclusion))) return 'failure';
  if (checks.some((c) => c.status !== 'completed')) return 'pending';
  return 'success';
}

export class GitHubForge implements Forge {
  readonly host = 'github.com';
  constructor(private readonly o: { token: string; apiBase?: string; fetch?: typeof fetch }) {
    if (!o.token) throw new AtlasError('invalid_request', 'A GitHub token is required');
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.o.apiBase ?? 'https://api.github.com'}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.o.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ATLAS', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new AtlasError('network_unavailable', `Could not reach GitHub: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try { message = (JSON.parse(text) as { message?: string }).message ?? message; } catch { /* not JSON */ }
      const hint = res.status === 401 ? ' Check the GitHub token in Settings.' : res.status === 403 || res.status === 404 ? ' The token may lack access to this repository.' : '';
      throw new AtlasError(res.status >= 500 ? 'network_unavailable' : 'invalid_request', `GitHub ${method} ${path.split('?')[0]} failed (${res.status}): ${message}.${hint}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async defaultBranch(r: RemoteRef) {
    return (await this.api<{ default_branch: string }>('GET', `/repos/${r.owner}/${r.repo}`)).default_branch;
  }

  async findPullRequest(r: RemoteRef, branch: string) {
    const list = await this.api<{ number: number; html_url: string; state: string; head: { sha: string } }[]>('GET', `/repos/${r.owner}/${r.repo}/pulls?state=open&head=${encodeURIComponent(`${r.owner}:${branch}`)}`);
    const p = list[0];
    return p ? { number: p.number, url: p.html_url, head: p.head.sha, state: p.state } : null;
  }

  async openPullRequest(r: RemoteRef, p: { branch: string; base: string; title: string; body: string }) {
    const pr = await this.api<{ number: number; html_url: string; state: string; head: { sha: string } }>('POST', `/repos/${r.owner}/${r.repo}/pulls`, { title: p.title, head: p.branch, base: p.base, body: p.body });
    return { number: pr.number, url: pr.html_url, head: pr.head.sha, state: pr.state };
  }

  async checks(r: RemoteRef, sha: string): Promise<CiCheck[]> {
    const runs = await this.api<{ check_runs: { id: number; name: string; status: string; conclusion: string | null; html_url: string | null; output?: { title?: string | null; summary?: string | null } }[] }>('GET', `/repos/${r.owner}/${r.repo}/commits/${sha}/check-runs?per_page=100`);
    const statuses = await this.api<{ statuses: { context: string; state: string; target_url: string | null; description: string | null }[] }>('GET', `/repos/${r.owner}/${r.repo}/commits/${sha}/status`);
    return [
      ...runs.check_runs.map((c) => ({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url, summary: [c.output?.title, c.output?.summary].filter(Boolean).join('\n') })),
      // Legacy commit statuses (other CI systems): map onto the check-run vocabulary.
      ...statuses.statuses.map((s) => ({ id: null, name: s.context, status: s.state === 'pending' ? 'in_progress' : 'completed', conclusion: s.state === 'pending' ? null : s.state === 'success' ? 'success' : s.state, url: s.target_url, summary: s.description ?? '' })),
    ];
  }

  async failureDetail(r: RemoteRef, c: CiCheck): Promise<string> {
    const parts = [`Check: ${c.name} (${c.conclusion ?? c.status})`, c.summary];
    if (c.id !== null) {
      try {
        const notes = await this.api<{ path: string; start_line: number; annotation_level: string; message: string }[]>('GET', `/repos/${r.owner}/${r.repo}/check-runs/${c.id}/annotations?per_page=50`);
        if (notes.length) parts.push('Annotations:', ...notes.map((a) => `${a.path}:${a.start_line} ${a.annotation_level}: ${a.message}`));
      } catch { /* annotations are optional */ }
      // For GitHub Actions the check run id is the job id. The log is a redirect to storage on another host: fetch
      // drops the Authorization header across origins, so the token is not sent there.
      try {
        const res = await (this.o.fetch ?? fetch)(`${this.o.apiBase ?? 'https://api.github.com'}/repos/${r.owner}/${r.repo}/actions/jobs/${c.id}/logs`, {
          headers: { authorization: `Bearer ${this.o.token}`, accept: 'application/vnd.github+json', 'user-agent': 'ATLAS' }, signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) parts.push('Log (last 150 lines):', (await res.text()).split(/\r?\n/).slice(-150).join('\n'));
      } catch { /* not an Actions job, or the log expired */ }
    }
    return parts.filter(Boolean).join('\n');
  }

  gitEnv(): Record<string, string> {
    // Config through the environment (GIT_CONFIG_COUNT), never through arguments that other processes can list.
    // The user's credential helpers are switched off: only this token is used, and git never prompts.
    return {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.o.token}`).toString('base64')}`,
    };
  }
}
