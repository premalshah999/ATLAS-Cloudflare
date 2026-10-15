// Controlled integration (manual §19): tasks start from their dependencies' checkpoints; the mission's
// result is one integration branch merged from task checkpoints, with conflicts surfaced, never guessed.
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { addWorktree, git, gitOk } from '@atlas/workspace';

export interface MergeResult { ok: boolean; commit: string | null; conflicts: string[]; message: string }

const ID = ['-c', 'user.name=ATLAS', '-c', 'user.email=atlas@localhost', '-c', 'commit.gpgsign=false'];

/** Create a worktree on `branch` starting at `bases[0]` and merge the remaining bases into it. */
export async function worktreeFromBases(repoRoot: string, dir: string, branch: string, bases: string[]): Promise<MergeResult> {
  mkdirSync(path.dirname(dir), { recursive: true });
  if (existsSync(dir)) throw new Error(`worktree path already exists: ${dir}`);
  await addWorktree(repoRoot, dir, branch, bases[0]);
  for (const b of bases.slice(1)) {
    const r = await mergeInto(dir, b, `ATLAS: merge dependency ${b.slice(0, 12)}`);
    if (!r.ok) return r;
  }
  const head = await gitOk(dir, ['rev-parse', 'HEAD']);
  return { ok: true, commit: head, conflicts: [], message: bases.length > 1 ? `Merged ${bases.length} dependency checkpoints` : 'Started from dependency checkpoint' };
}

/** Merge a commit into the worktree's HEAD. On conflict the merge is aborted and the files are reported. */
export async function mergeInto(worktree: string, commit: string, message: string): Promise<MergeResult> {
  const r = await git(worktree, [...ID, 'merge', '--no-ff', '--no-edit', '-m', message, commit]);
  if (r.code === 0) return { ok: true, commit: await gitOk(worktree, ['rev-parse', 'HEAD']), conflicts: [], message };
  const st = await git(worktree, ['diff', '--name-only', '--diff-filter=U']);
  const conflicts = st.out.split('\n').filter(Boolean);
  await git(worktree, ['merge', '--abort']);
  return { ok: false, commit: null, conflicts, message: conflicts.length ? `Merge conflict in ${conflicts.join(', ')}` : `Merge failed: ${r.out.slice(0, 300)}` };
}

/** Topological order of task ids, given each task's dependency list. */
export function topoOrder(tasks: { id: string; dependencies: string[] }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of byId.get(id)?.dependencies ?? []) visit(d);
    out.push(id);
  };
  for (const t of tasks) visit(t.id);
  return out;
}
