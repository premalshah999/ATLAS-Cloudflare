// Session hygiene (ADR 0025): what ATLAS keeps on disk besides evidence, and clearing what nothing needs any more.
// Evidence (the database, events, artifacts) is never touched here: the retention setting decides that. What is
// cleared is derived or temporary: rotated logs, code-graph caches, saved conversations of finished attempts,
// worktrees left by deleted missions, and the database's write-ahead log once checkpointed.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export type Category = 'logs' | 'graphs' | 'sessions' | 'worktrees' | 'database';
export const CLEANABLE: Category[] = ['logs', 'graphs', 'sessions', 'worktrees', 'database'];

export interface StorageRow { category: Category | 'evidence' | 'releases'; label: string; bytes: number; items: number; reclaimable: number; note: string }
export interface CleanupResult { at: string; freed: number; removed: Record<string, number>; categories: Category[]; automatic: boolean }

export interface HygieneInput {
  dataDir: string;
  /** Missions that may still need their worktrees, conversations and graphs (not deleted, not decided). */
  liveMissions: { id: string; baseCommit: string | null }[];
  /** Attempts whose saved conversation can still be continued (running, or lost in a mission that will resume). */
  keepAttempts: Set<string>;
  /** Mission ids that exist at all. */
  knownMissions: Set<string>;
}

export function sizeOf(p: string): { bytes: number; items: number } {
  if (!existsSync(p)) return { bytes: 0, items: 0 };
  let bytes = 0, items = 0;
  const walk = (x: string) => {
    let st;
    try { st = statSync(x); } catch { return; }
    if (st.isDirectory()) { let names: string[] = []; try { names = readdirSync(x); } catch { /* unreadable */ } for (const n of names) walk(path.join(x, n)); }
    else { bytes += st.size; items++; }
  };
  walk(p);
  return { bytes, items };
}

const list = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };

/** What each cleanup would remove: the paths per category. */
export function candidates(i: HygieneInput): Record<Category, string[]> {
  const live = new Set(i.liveMissions.map((m) => m.id));
  const bases = new Set(i.liveMissions.map((m) => m.baseCommit).filter(Boolean) as string[]);
  const logs = path.join(i.dataDir, 'logs');
  return {
    logs: list(logs).filter((f) => /^daemon\.log\.\d+$/.test(f)).map((f) => path.join(logs, f)),
    graphs: list(path.join(i.dataDir, 'graphs')).filter((f) => f.endsWith('.json') && !bases.has(f.slice(0, -5))).map((f) => path.join(i.dataDir, 'graphs', f)),
    sessions: list(path.join(i.dataDir, 'pi', 'sessions')).filter((a) => !i.keepAttempts.has(a)).map((a) => path.join(i.dataDir, 'pi', 'sessions', a)),
    // Only worktrees of missions that no longer exist; an undecided mission's worktrees hold its work.
    worktrees: list(path.join(i.dataDir, 'worktrees')).filter((m) => /^msn_/.test(m) && !i.knownMissions.has(m) && !live.has(m)).map((m) => path.join(i.dataDir, 'worktrees', m)),
    database: [],
  };
}

export function report(i: HygieneInput): StorageRow[] {
  const c = candidates(i);
  const sum = (ps: string[]) => ps.reduce((a, p) => a + sizeOf(p).bytes, 0);
  const row = (category: StorageRow['category'], label: string, p: string, reclaimable: number, note: string): StorageRow => ({ category, label, ...sizeOf(p), reclaimable, note });
  const wal = sizeOf(path.join(i.dataDir, 'atlas.db-wal')).bytes;
  return [
    { category: 'evidence', label: 'Evidence (database and artifacts)', ...(() => { const a = sizeOf(path.join(i.dataDir, 'artifacts')); const d = sizeOf(path.join(i.dataDir, 'atlas.db')); return { bytes: a.bytes + d.bytes, items: a.items + d.items }; })(), reclaimable: 0, note: 'Never cleared here. The retention setting removes decided missions after the number of days you choose.' },
    { category: 'database', label: 'Database write-ahead log', bytes: wal, items: wal ? 1 : 0, reclaimable: wal, note: 'Folded into the database, then truncated.' },
    row('logs', 'Daemon logs', path.join(i.dataDir, 'logs'), sum(c.logs), 'The current log is kept; rotated logs are removed.'),
    row('graphs', 'Code graph caches', path.join(i.dataDir, 'graphs'), sum(c.graphs), 'Graphs of commits no active mission uses. Rebuilt on demand.'),
    row('sessions', 'Saved agent conversations', path.join(i.dataDir, 'pi', 'sessions'), sum(c.sessions), 'Conversations no attempt can continue any more.'),
    row('worktrees', 'Worktrees', path.join(i.dataDir, 'worktrees'), sum(c.worktrees), 'Only those of deleted missions. Undecided missions keep theirs.'),
    row('releases', 'Staging releases', path.join(i.dataDir, 'releases'), 0, 'Managed by the deploy history (rollback needs them).'),
  ];
}

/** Remove the candidates of the given categories. `checkpoint` folds the write-ahead log into the database. */
export function cleanup(i: HygieneInput, categories: Category[], checkpoint: () => void, automatic = false): CleanupResult {
  const c = candidates(i);
  const removed: Record<string, number> = {};
  let freed = 0;
  for (const cat of categories) {
    if (cat === 'database') {
      const before = sizeOf(path.join(i.dataDir, 'atlas.db-wal')).bytes;
      try { checkpoint(); } catch { /* busy: next time */ }
      const after = sizeOf(path.join(i.dataDir, 'atlas.db-wal')).bytes;
      freed += Math.max(0, before - after);
      removed.database = before > after ? 1 : 0;
      continue;
    }
    let n = 0;
    for (const p of c[cat]) {
      const b = sizeOf(p).bytes;
      try { rmSync(p, { recursive: true, force: true, maxRetries: 3 }); freed += b; n++; } catch { /* in use: next time */ }
    }
    removed[cat] = n;
  }
  return { at: new Date().toISOString(), freed, removed, categories, automatic };
}
