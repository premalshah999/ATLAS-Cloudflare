// Repository manager (manual §18–19): inspection, per-task worktrees, checkpoints and diffs.
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtlasError } from '@atlas/contracts';
import { git, gitOk } from './git';
import { adminDirOf, forgetWorktree, gitPinned, pinFor, pinWorktree, WorktreeTampered, type WorktreePin } from './pinned';

export { resolveInside } from './paths';
export { git, gitOk } from './git';
export {
  EMPTY_TREE, WorktreeTampered, attributeDrivers, forceGitVersionForTests, forgetWorktree, gitHardening, gitPinned, manageWorktrees, onWorktreeTampered, pinFor, pinWorktree,
  preserveTampered, registeredPin, verifyWorktreeMetadata, type GitHardening, type TamperField, type WorktreePin,
} from './pinned';

export interface RepoInfo { root: string; name: string; isGit: boolean; branch: string | null; head: string | null; dirty: number }

export async function inspectRepo(dir: string): Promise<RepoInfo> {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { root: dir, name: path.basename(dir), isGit: false, branch: null, head: null, dirty: 0 };
  const root = top.out;
  const [branch, head, status] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['status', '--porcelain']),
  ]);
  return {
    root, name: path.basename(root), isGit: true,
    branch: branch.code === 0 ? branch.out : null,
    head: head.code === 0 ? head.out : null,
    dirty: status.code === 0 ? status.out.split('\n').filter(Boolean).length : 0,
  };
}

/** Writer leases: at most one writer per checkout (manual §13). */
export class Leases {
  private held = new Map<string, string>();
  acquire(checkout: string, owner: string): boolean {
    const k = path.resolve(checkout);
    const cur = this.held.get(k);
    if (cur && cur !== owner) return false;
    this.held.set(k, owner);
    return true;
  }
  release(checkout: string, owner: string) {
    const k = path.resolve(checkout);
    if (this.held.get(k) === owner) this.held.delete(k);
  }
  holder(checkout: string) { return this.held.get(path.resolve(checkout)) ?? null; }
}

/** Create an isolated worktree on a new branch at `base`. The user's checkout is never written. */
export async function createWorktree(repoRoot: string, dir: string, branch: string, base: string): Promise<void> {
  mkdirSync(path.dirname(dir), { recursive: true });
  if (existsSync(dir)) throw new Error(`worktree path already exists: ${dir}`);
  await addWorktree(repoRoot, dir, branch, base);
}

const adding = new Map<string, Promise<unknown>>();

/**
 * `git worktree add -b` for one repository at a time. Parallel tasks (a reviewer and a security engineer starting from
 * the same checkpoint) otherwise race on the repository's admin directory and ref locks, and on slow disks a lost race
 * failed the task. A failed add is undone (its branch and partial directory) and tried again, twice at most; a branch
 * that already existed is never retried or deleted.
 */
export async function addWorktree(repoRoot: string, dir: string, branch: string, base: string, attempts = 3): Promise<void> {
  const key = path.resolve(repoRoot);
  const prev = adding.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    if ((await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) throw new Error(`git worktree failed: branch ${branch} already exists`);
    for (let i = 1; ; i++) {
      const r = await git(repoRoot, ['worktree', 'add', '-b', branch, dir, base], 120_000);
      if (r.code === 0) {
        // Record the metadata git just wrote, before any agent can touch the tree (ADR 0031).
        try { await pinWorktree(repoRoot, dir, { branch }); return; }
        catch (e) { await removeWorktree(repoRoot, dir, branch); throw e; }
      }
      if (i >= attempts) throw new Error(`git worktree failed: ${r.out.slice(0, 400)}`);
      await removeWorktree(repoRoot, dir, (await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0 ? branch : null);
      await new Promise((res) => setTimeout(res, 250 * i));
    }
  });
  adding.set(key, run);
  try { await run; } finally { if (adding.get(key) === run) adding.delete(key); }
}

export async function removeWorktree(repoRoot: string, dir: string, branch: string | null): Promise<void> {
  // The admin dir as the repository knows it, never as the worktree's `.git` file claims: an agent could point that
  // file at another worktree's metadata (ADR 0031).
  const admin = await adminDirOf(repoRoot, dir);
  await git(repoRoot, ['worktree', 'remove', '--force', dir]);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  // Only this worktree's metadata. `git worktree prune` would also drop the user's own worktrees that are
  // temporarily missing (an unmounted drive, a moved directory): never run it on the user's repository.
  if (admin && existsSync(admin) && path.basename(path.dirname(admin)) === 'worktrees') rmSync(admin, { recursive: true, force: true });
  forgetWorktree(dir);
  if (branch) await git(repoRoot, ['branch', '-D', branch]);
}

export interface PreservedRef { ref: string; sha: string; what: 'uncommitted' | 'branch' }

/** Work a snapshot cannot hold. The worktree must then be kept, not removed. */
export class PreserveError extends Error {}

/**
 * Keep a worktree's work reachable before it is removed (evolution P1-3, concept from agent-orchestrator and
 * limboo): uncommitted and untracked changes are snapshotted through a throwaway index into a commit under
 * `<refBase>/uncommitted`, and the branch tip is kept at `<refBase>/branch`. The user's checkout, the
 * worktree's own index and its files are never modified. Ignored files are not captured.
 */
export async function preserveWorktree(repoRoot: string, dir: string, branch: string | null, refBase: string): Promise<PreservedRef[]> {
  try { return await preserveSnapshot(repoRoot, dir, branch, refBase); }
  catch (e) {
    // Tampered metadata: no git runs there, so the worktree is kept as it is (ADR 0031).
    if (e instanceof WorktreeTampered) throw new PreserveError(`its git metadata was tampered with (${e.field}), so it is kept for audit`);
    throw e;
  }
}

async function preserveSnapshot(repoRoot: string, dir: string, branch: string | null, refBase: string): Promise<PreservedRef[]> {
  const out: PreservedRef[] = [];
  if (existsSync(dir)) {
    await pinWorktree(repoRoot, dir);
    const status = await git(dir, ['status', '--porcelain', '--untracked-files=all']);
    const head = await git(dir, ['rev-parse', '--verify', 'HEAD']);
    if (status.code !== 0 || head.code !== 0) throw new PreserveError(`its state could not be read: ${(status.code !== 0 ? status : head).out.slice(0, 200)}`);
    if (status.out.trim()) {
      const index = path.join(mkdtempSync(path.join(os.tmpdir(), 'atlas-idx-')), 'index');
      const env = { GIT_INDEX_FILE: index };
      try {
        const steps = [await git(dir, ['read-tree', 'HEAD'], 30_000, env), await git(dir, ['add', '-A'], 120_000, env)];
        const tree = await git(dir, ['write-tree'], 30_000, env);
        const failed = [...steps, tree].find((r) => r.code !== 0);
        if (failed) throw new PreserveError(`uncommitted changes could not be snapshotted: ${failed.out.slice(0, 200)}`);
        // A nested repository (an agent ran `git init`, `create-vite`, `cargo new`) is recorded only as a gitlink:
        // its files and history are not in this object store, so a snapshot would silently lose them.
        const links = async (t: string) => (await git(dir, ['ls-tree', '-r', '-z', t], 60_000, env)).out.split('\0').filter((l) => l.startsWith('160000 '));
        const atHead = new Set(await links('HEAD'));
        const fresh = (await links(tree.out.trim())).filter((l) => !atHead.has(l));
        if (fresh.length) throw new PreserveError(`it contains a nested repository that a snapshot cannot hold: ${fresh.map((l) => l.split('\t')[1]).join(', ')}`);
        const commit = await git(dir, ['commit-tree', tree.out.trim(), '-p', head.out.trim(), '-m', `ATLAS: preserved uncommitted work from ${path.basename(dir)}`]);
        if (commit.code !== 0) throw new PreserveError(`uncommitted changes could not be committed: ${commit.out.slice(0, 200)}`);
        const ref = `${refBase}/uncommitted`;
        await gitOk(repoRoot, ['update-ref', ref, commit.out.trim()]);
        out.push({ ref, sha: commit.out.trim(), what: 'uncommitted' });
      } finally { rmSync(path.dirname(index), { recursive: true, force: true }); }
    }
  }
  if (branch) {
    const tip = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (tip.code === 0 && tip.out.trim()) {
      const ref = `${refBase}/branch`;
      await gitOk(repoRoot, ['update-ref', ref, tip.out.trim()]);
      out.push({ ref, sha: tip.out.trim(), what: 'branch' });
    }
  }
  return out;
}

export interface RetireResult { refs: PreservedRef[]; /** Why the worktree was kept on disk instead of removed. */ retained: string | null }

/**
 * Preserve, then remove. Use this wherever work might still be in the worktree. When the work cannot be
 * preserved completely, nothing is removed (not the directory, not the branch) and the reason is returned.
 */
export async function retireWorktree(repoRoot: string, dir: string, branch: string | null, refBase: string): Promise<RetireResult> {
  let refs: PreservedRef[];
  try { refs = await preserveWorktree(repoRoot, dir, branch, refBase); }
  catch (e) {
    if (e instanceof PreserveError) return { refs: [], retained: `${path.basename(dir)} was kept at ${dir}: ${e.message}` };
    throw e;
  }
  await removeWorktree(repoRoot, dir, branch);
  return { refs, retained: null };
}

/** Delete every ref under a prefix (used when a mission is deleted). */
export async function deleteRefs(repoRoot: string, prefix: string): Promise<number> {
  const refs = (await git(repoRoot, ['for-each-ref', '--format=%(refname)', prefix])).out.split('\n').filter(Boolean);
  for (const r of refs) await git(repoRoot, ['update-ref', '-d', r]);
  return refs.length;
}

/** Pinned git for a worktree ATLAS created (ADR 0031). Any other directory is refused, never discovered. */
async function pinnedGit(worktree: string): Promise<(args: string[]) => ReturnType<typeof gitPinned>> {
  const pin: WorktreePin | null = await pinFor(worktree);
  if (!pin) throw new AtlasError('workspace_conflict', `${worktree} is not a worktree ATLAS created`);
  return (args) => gitPinned(pin.worktree, pin.adminDir, args, { pin, cwd: worktree, timeoutMs: 120_000 });
}

const ok = async (r: ReturnType<typeof gitPinned>, what: string) => {
  const x = await r;
  if (x.code !== 0) throw new Error(`git ${what} failed: ${x.out.slice(0, 400)}`);
  return x.out;
};

/**
 * Commit everything in a task worktree as a checkpoint. Returns the commit, or null when nothing changed.
 * Pinned: planted metadata fails closed with WorktreeTampered, and no driver named in the tree runs.
 */
export async function checkpoint(worktree: string, message: string): Promise<string | null> {
  const g = await pinnedGit(worktree);
  await ok(g(['add', '-A']), 'add');
  if ((await g(['diff', '--cached', '--quiet'])).code === 0) return null;
  await ok(g(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message]), 'commit');
  return ok(g(['rev-parse', 'HEAD']), 'rev-parse');
}

export interface DiffSummary { patch: string; files: { path: string; add: number; del: number }[] }

export async function diffSince(worktree: string, base: string): Promise<DiffSummary> {
  const g = await pinnedGit(worktree);
  const patch = await ok(g(['diff', '--no-color', '--no-ext-diff', '--no-textconv', base, 'HEAD']), 'diff');
  const stat = await ok(g(['diff', '--numstat', base, 'HEAD']), 'diff');
  const files = stat.split('\n').filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split('\t');
    return { path: p.join('\t'), add: a === '-' ? 0 : Number(a), del: d === '-' ? 0 : Number(d) };
  });
  return { patch, files };
}
export { loadConfig } from './config';
