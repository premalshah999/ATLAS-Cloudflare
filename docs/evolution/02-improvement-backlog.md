# 02 — Improvement backlog

Ranked by severity, user impact, technical risk, dependency order and evidence. "Confirmed" means reproduced by a probe or test, or read in code, with the evidence named. The status column is updated as slices land; details are in [04-implementation-log.md](04-implementation-log.md).

## P0 — broken flows, insecure execution, process leaks, false success

| ID | Problem and user impact | Evidence | Reference | Proposed change | Risk / rollback | Verification | Status |
|---|---|---|---|---|---|---|---|
| P0-1 | **The UI shows a truncated history.** The mission view loads only the first 2000 events, so long missions lose their timeline tail and can show "verification has not run" after it ran | `useMission.catchUp` read one page (`events.since` LIMIT 2000) | AO SSE replay in batches until head | Page until a short page | Low; revert one file | Unit `eventSync.test.ts` (4321-event log; exact multiple of the page size) | **done** (0ba91ff) |
| P0-2 | **"Unverified" displayed as "Completed".** The verdict was not persisted | Code: `setMission(..., 'completed')` for verified and unverified alike | AO derives status from stored facts | Migration v5 `missions.verdict` (backfilled from `gate.result`); UI uses `missionStatus()` | Additive column | Storage backfill test; integration `verdict === 'unverified'`; e2e `data-verdict` | **done** (0ba91ff) |
| P0-3 | **False pass.** An agent can rewrite the project's test script (or `atlas.config.json` checks) so the gate runs `exit 0` and reports "Verified" | Probe: `scripts.test = node -e "process.exit(0)"` gave "Verified: tests passed; review passed", 0 approvals | LB hash-bound acknowledgment of repo-authored commands | Verification recipes come from the **base** commit's definitions (what the operator approved at plan time). If the agent changed a verification definition (scripts used by checks, the `checks` section, test runner config), the gate marks the change `failed: verification definition changed by agent` until the operator re-approves. Deleted test files are flagged in the gate summary | Medium (gate logic). Rollback: one revert | Integration: rewritten script gives failed with reason; legitimate source change still verified; operator re-approval path | **done** (5afe983, revised after review in 0f1dba3) |
| P0-4 | **Orphaned processes after a daemon crash.** Unsandboxed runs (and presumably macOS Seatbelt) leave commands, app servers and PTYs running forever | Probe `/tmp/claude-0/probe/run.sh`: survivor reparented to PID 1 (unsandboxed); bwrap clean | SM orphan sweep by command line; AO reaper | Journal every spawned process (pid + start-time identity) in SQLite (`process_journal`, migration v5). On daemon start, kill the journaled process groups whose identity still matches, before recovery. On Windows, every command runs under a Job Object (kill-on-close) via the helper | Low; identity check prevents killing reused PIDs | Integration: SIGKILL the orchestrator mid-command in unsandboxed mode, restart, and assert the survivor is gone; a reused-PID guard test | **done** (0f1dba3, review fixes d20546b); Windows parent-death open |
| P0-5 | **macOS: every mission check fails under `sandbox-exec`** | CI run 38086199749 (integration and eval red; e2e missions end "failed") | — | Diagnose with the new portable sandbox suite (it prints sandboxed output on failure), fix the Seatbelt profile | Platform-specific | CI macOS: sandbox suite, integration, e2e green | **done**: macOS CI fully green (run 38107974496, 6317668) |
| P0-6 | **Windows: lint, storage and missions broken** | CI run 38086199749 (`check-deps` path, `fsync` EPERM, path test) | — | Fixes in `eb3bd1c` plus the AppContainer launcher; iterate on CI | Platform-specific | CI Windows green | in progress: see 04 log |

## P1 — reliability, orchestration, recovery, verification, security hardening

| ID | Problem | Evidence | Reference | Proposed change | Verification | Status |
|---|---|---|---|---|---|---|
| P1-1 | **Safe-listed commands run programs without approval** through argument forms (`git -c…`, `git grep -O`, `--open-files-in-pager`, `--ext-diff`, `--output`, `find -exec`, `sort --compress-program`, `rg --pre`) | Probe: all 8 forms classified `shell.safe` | LB `readOnlyCommands.ts` deny-by-default arguments | Argument-level checks: options that execute or write make the command privileged; `git` global options before the subcommand make it privileged | Unit table of bypass forms (privileged) and plain forms (still safe) | **done** (5afe983) |
| P1-2 | **Unsandboxed mode runs project code without approval.** `npm test`, `node file` and `run_tests` are safe-listed; without a sandbox that is arbitrary code as the user | Policy code + the Settings text promising "approved commands" | — | When isolation is `unsandboxed`, every command that runs project code asks for approval | Policy unit + integration in unsandboxed mode | **done** (e2084e8) |
| P1-3 | **Uncommitted work is destroyed** when worktrees are force-removed (decide, delete; lost attempts' worktrees) | `removeWorktree` uses `--force` (`workspace/src/index.ts:52`) | AO `StashUncommitted` / LB `snapshotTree` | Before removal, snapshot dirty state with a temp index into `refs/atlas/preserved/<mission>/<task-attempt>` and record it as an event; delete removes the refs | Integration: dirty worktree, then reject; the ref holds the file; the checkout is untouched | **done** (0f1dba3, review fixes d20546b) |
| P1-4 | **Pre-create resource guards** — unbounded worktrees and disk use under retries | No check before `git worktree add` | SM `assertUnderCap`, `assertAboveDiskFloor` | Refuse to create a worktree under a free-disk floor (1 GiB) or above a per-mission cap, with a typed error surfaced as a task failure reason | Unit with an injected statfs | **done** (6645eb5) |
| P1-5 | **The operator terminal dies when the tab unmounts**, with no reattach, no resize, and IPC per chunk | `TerminalPanel` closes the session on unmount; 182 ms median echo | SM coalescer, ring buffer, snapshot attach, resize | Daemon-side session registry with a ring buffer; `terminal.attach` returns the snapshot + seq; renderer subscribes first; output coalesced (≤ 12 ms); `terminal.resize` | e2e: open, type, switch tab, return, history intact; echo latency re-measured | **done** (fdf2dce); no latency gain claimed |
| P1-6 | **Stalled attempts look healthy.** A runtime that stops emitting events looks "running" until the wall-clock budget (minutes) | Scheduler code | AO `no_signal` | Daemon watchdog: no attempt event for N s (default 120 s) emits `attempt.stalled` and the UI shows "No signal"; the attempt is not killed automatically | Unit with fake clock; e2e stall flag | **done** (2c2afb4) |

## P2 — UX, observability, performance

| ID | Item | Evidence | Status |
|---|---|---|---|
| P2-1 | **Daemon idle memory 181 MB.** Pi SDK and playwright-core load eagerly | Baseline metrics | **done**: daemon idle RSS 180 → 134/135 MB (two runs each, `pnpm metrics`) |
| P2-2 | **No live preview browser.** Only verification QA | Matrix #12 | candidate |
| P2-3 | **PTY resize** (part of P1-5) | — | **done** with P1-5 (Linux, macOS) |
| P2-4 | **Idle CPU metric is not meaningful** | Baseline | measure with two samples |

## P3 — speculative

| ID | Item | Notes |
|---|---|---|
| P3-1 | GitHub PR/CI feedback loop (AO concept) with **author gating** | Needs credentials: an untested boundary in this environment |
| P3-2 | Repo-drift delta for the next attempt (LB) | Cheap; low measured value so far |
| P3-3 | Agent session resume with pre-assigned ids (SM/AO) | Pi SDK support not verified |

## Order of execution
P0-3 → P1-1 → P0-4 → P1-3 → P1-2 → P1-5 → P1-6 → P1-4.

P0-5 and P0-6 run continuously through CI between slices. Each slice gets an independent review pass before it is called done.
