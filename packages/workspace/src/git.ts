import { BASE_FLAGS, spawnGit, type GitResult } from './exec';
import { gitPinned, pinFor } from './pinned';

export type { GitResult } from './exec';

/**
 * Run git with an argument array and a sanitized environment. Never interpolates a shell string.
 * In a worktree ATLAS created (or anywhere under a managed worktree root) the call is pinned (ADR 0031): explicit
 * --git-dir/--work-tree, verified metadata, no global config, no attribute drivers. Elsewhere (the user's own
 * checkout) it runs as before.
 */
export async function git(cwd: string, args: string[], timeoutMs = 30_000, extraEnv: Record<string, string> = {}): Promise<GitResult> {
  const pin = await pinFor(cwd);
  if (pin) return gitPinned(pin.worktree, pin.adminDir, args, { pin, cwd, timeoutMs, env: extraEnv });
  return spawnGit(cwd, [...BASE_FLAGS, ...args], timeoutMs, extraEnv);
}

export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.slice(0, 400)}`);
  return r.out;
}
