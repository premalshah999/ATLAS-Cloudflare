# ADR 0025 — Session hygiene: logs and caches, never evidence

Status: accepted · 2026-10-12

## Context
The operator asked for a section that clears caches and logs once a session gets overwhelmed. In the agent's
conversation, that is compaction (ADR 0024). On disk, a long-running installation accumulates several things:
- daemon logs, which grew without bound;
- code-graph caches;
- saved Pi conversations of attempts that can no longer be continued;
- worktree folders left by missions deleted while something held them;
- the SQLite write-ahead log.
None of these is evidence, but all of them grow.

## Decision
- **Rotation.** The daemon log rotates by size: 10 MB, keeping daemon.log.1 to .3.
- **Cleanup categories.** Each category only ever removes derived or temporary data:
  - `logs`: rotated logs (the current log is kept);
  - `graphs`: graph caches of commits that no undecided mission uses (rebuilt on demand);
  - `sessions`: saved conversations, except those of running attempts, and of lost attempts in missions that will
    resume;
  - `worktrees`: only folders of missions that no longer exist (an undecided mission's worktrees hold its work),
    followed by `git worktree prune` in each repository;
  - `database`: `wal_checkpoint(TRUNCATE)`.
- **Never cleared here:** the database, events and artifacts, which are evidence (the retention setting decides
  those), and staging releases (rollback needs them).
- **When.** Cleanup runs automatically at start and every 30 minutes when more than 64 MB can be reclaimed or
  rotated logs exist (Settings can turn this off). It also runs on demand from Settings → Storage and cleanup, which
  shows each category's size and what can be cleared. Every run is logged and its result shown.

## Consequences
Disk use is bounded for derived data, and unchanged for evidence by design.

**Tests.**
- `apps/daemon/test/hygiene.test.ts` covers:
  - sizes and reclaimable amounts;
  - exactly which paths are removed and which are kept (evidence, the current log, a live mission's graph,
    conversation and worktree, releases);
  - worktrees of existing missions never selected;
  - log rotation bounded.
- `tests/e2e-electron/maintenance.spec.ts` clears leftovers from the app and keeps the database.
