// Git metadata is daemon-owned (ADR 0031). The workspace package refuses every git call on a worktree whose metadata
// no longer matches what ATLAS created; this module turns that refusal into mission state: a `workspace.tampered`
// event, the attempt stopped and failed as non-retryable, and the tree snapshotted under refs/atlas/preserved for
// audit (without using any of its metadata). The worktree itself stays on disk.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { NewEvent } from '@atlas/contracts';
import type { Repo } from '@atlas/storage';
import { manageWorktrees, onWorktreeTampered, preserveTampered, type WorktreeTampered } from '@atlas/workspace';

type Emit = (e: Omit<NewEvent, 'artifactIds' | 'taskId' | 'attemptId'> & Partial<Pick<NewEvent, 'artifactIds' | 'taskId' | 'attemptId'>>) => void;

const real = (p: string) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };

export class TamperWatch {
  /** Tampered worktrees, by the path the orchestrator uses for them (`<worktreeDir>/<mission>/<name>`). */
  private readonly seen = new Map<string, WorktreeTampered>();
  private readonly stops: (() => void)[] = [];

  constructor(private readonly worktreeDir: string, private readonly repo: Repo, private readonly emit: Emit, private readonly stopTask: (taskId: string) => void) {
    // git never runs under worktreeDir without a pin; after a restart a worktree is pinned through its mission.
    this.stops.push(manageWorktrees(worktreeDir, (wt) => {
      const m = this.repo.mission(path.basename(path.dirname(wt)));
      return m ? this.repo.workspace(m.workspaceId)?.root ?? null : null;
    }));
    this.stops.push(onWorktreeTampered((e) => this.report(e)));
  }

  dispose() { for (const s of this.stops.splice(0)) s(); }

  /** The tamper report for a worktree, if its metadata was found tampered. */
  get(dir: string): WorktreeTampered | undefined { return this.seen.get(dir); }

  private report(e: WorktreeTampered) {
    const rel = path.relative(real(this.worktreeDir), e.worktree);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return; // another orchestrator's worktree
    const [missionId, name] = rel.split(path.sep);
    if (!missionId || !name) return;
    const dir = path.join(this.worktreeDir, missionId, name);
    if (this.seen.has(dir) || !this.repo.mission(missionId)) return;
    this.seen.set(dir, e);
    const task = this.repo.tasks(missionId).find((t) => t.worktree === dir);
    const attempt = task ? this.repo.attempts(missionId).filter((a) => a.taskId === task.id).at(-1) : undefined;
    this.emit({
      missionId, taskId: task?.id ?? null, attemptId: attempt && !attempt.endedAt ? attempt.id : null, type: 'workspace.tampered', actor: { kind: 'system', component: 'workspace' },
      payload: { worktree: dir, field: e.field, detail: e.detail },
    });
    if (task) this.stopTask(task.id);
  }

  /** Snapshot a tampered worktree for audit. Returns the preserved ref, or null when nothing differed from its branch. */
  async preserve(repoRoot: string, missionId: string, dir: string, branch: string | null): Promise<{ ref: string; sha: string } | null> {
    const ref = `refs/atlas/preserved/${missionId}/${path.basename(dir)}-tampered`;
    const sha = await preserveTampered(repoRoot, dir, branch, ref);
    return sha ? { ref, sha } : null;
  }
}
