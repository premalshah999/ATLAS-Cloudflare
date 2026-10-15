import { run, sanitizedEnv } from '@atlas/terminal';

export interface GitResult { code: number | null; out: string; /** Output beyond the kept maximum was dropped. */ truncated?: boolean }

/** Repository config is untrusted: no ATLAS git call runs its hooks, fsmonitor or external diff program. */
export const BASE_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'protocol.file.allow=user'];

/** Spawn git with exactly these arguments (an array, never a shell string) and a sanitized environment. */
export async function spawnGit(cwd: string, args: string[], timeoutMs = 30_000, extraEnv: Record<string, string> = {}, maxOutput = 8 * 1024 * 1024): Promise<GitResult> {
  const r = await run({
    command: 'git', args, cwd, timeoutMs,
    env: sanitizedEnv({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'ATLAS', GIT_AUTHOR_EMAIL: 'atlas@localhost', GIT_COMMITTER_NAME: 'ATLAS', GIT_COMMITTER_EMAIL: 'atlas@localhost', ...extraEnv }),
    maxOutput,
  });
  return { code: r.exitCode, out: r.output.trimEnd(), ...(r.truncated ? { truncated: true } : {}) };
}
