# Source audit: OrchestratorInc/agent-orchestrator

- Commit: `2874fcf43c23e45c1090d229ccb31966a93d3e1e` (checked with `git log -1`)
- Clone: `/tmp/claude-0/refs/agent-orchestrator`
- Method: read-only static reading (cat/grep/sed/find). I did not build, install, run or test anything. Any statement about runtime behavior is inferred from source, not observed.
- Scope note: the repository has about 4,500 files, 852 Go `_test.go` files and 411 frontend `*.test.ts(x)` files. I read the core paths named below. I did not read the rest, including `cloud/`, `private/`, `packages/mobile`, most of the 50 or so agent adapters, and most of the renderer.
- Confidence labels: **H** means I read the code path directly. **M** means I read part of the path or inferred it from names, comments and wiring. **L** means it is plausible but I did not verify it.

All paths below are relative to the repo root unless stated otherwise. `bi/` stands for `backend/internal/`.

---

## 0. Process architecture

| Component | Evidence | Conf. |
|---|---|---|
| Go backend daemon plus CLI in one binary `ao`, built with cobra. Module `github.com/aoagents/agent-orchestrator/backend`, `go 1.27.1`. | `backend/go.mod`, `backend/cmd/ao`, `bi/cli/*.go` | H |
| The daemon serves REST over chi on **loopback 127.0.0.1 only** (`config.LoopbackHost`). If the configured port is taken, it falls back to an ephemeral port and publishes the actual port in `running.json`. | `bi/config/config.go` (`LoopbackHost`), `bi/httpd/server.go` `NewWithDeps`, `run` → `runfile.Write` | H |
| The frontend is Electron 33 with React, TanStack Router and TanStack Query, built with electron-forge and Vite. The renderer calls the daemon's HTTP API and SSE directly (`api-client.ts`, `event-transport.ts`). Electron IPC is not the data path. | `frontend/package.json`, `frontend/src/renderer/lib/event-transport.ts` | H (deps), M (direct HTTP) |
| Lifetime coupling: Electron holds a socket open to the daemon's supervisor listener. When the last client disconnects, the daemon stops itself after a grace period. tmux and PTY-host sessions survive so the next boot can adopt them. | `frontend/src/main/supervisor-link.ts`, `bi/daemon/supervisor/supervisor.go` | H |
| Agent terminal runtime on Linux: tmux (a bundled build script `build:tmux`). On macOS and Windows: a detached "pty-host" child process (`Setsid`) per session that serves the PTY over **loopback TCP** with a binary framing protocol and replays scrollback. A hybrid router sends legacy handles to tmux. | `bi/adapters/runtime/runtimeselect/{runtimeselect,hybrid}.go`, `bi/adapters/runtime/conpty/{host.go,host_main.go,proto.go,spawn_unix.go}`, `bi/adapters/runtime/tmux/` | H |
| Chat mode: agents are driven over ACP (Agent Client Protocol) through `bi/adapters/chatdriver/*acp`, with a persistent host process (ADR 0003). | `bi/adapters/chatdriver/`, `docs/adr/0003-persistent-chat-provider-host.md` | M |
| Optional remote access: a LAN listener with a password and lockout (ADR 0001), a Cloudflare tunnel (ADR 0004), a mobile app (`packages/mobile`) and a cloud control plane (`cloud/`). | `bi/httpd/lan_listener.go`, `bi/httpd/auth.go`, `bi/mobilebridge/` | M |
| Telemetry: PostHog plus Sentry, and a local SQLite telemetry adapter. | `bi/adapters/telemetry/`, `bi/observe/sentryobs`, `bi/config/config.go` `DefaultTelemetryPostHogHost` | H (exists) |

**Compared with ATLAS:** both use a separate privileged backend process that the UI talks to. AO's backend is a Go HTTP daemon that any local process can reach. ATLAS's daemon is an Electron utilityProcess reached through validated IPC. AO's daemon outlives the UI by design and adopts sessions that are still running. ATLAS (per the description) restarts lost attempts fresh.

---

## 1. Project-aware orchestration (projects and repos)

**Implementation**
- `projects` table (`bi/storage/sqlite/migrations/0001_init.sql`): a slug `id`, `path`, `repo_origin_url`, `display_name`, and soft delete through `archived_at` so a session's FK always resolves. (H)
- `domain.ProjectRecord` and `ProjectKind` (`bi/domain/project.go`) take one of three values: `single_repo`, `workspace` (a root repo plus child repos stored in `workspace_repos`) and `scratch` (a plain directory). (H)
- `SessionWorktreeRecord` (`bi/domain/project.go`) holds one row per repo worktree in a session. A workspace project has one root row (`RootWorkspaceRepoName = "__root__"`) plus one row per child repo. (H)
- Per-project typed config is `domain.ProjectConfig` (`bi/domain/projectconfig.go`). It covers agent/harness per role (`RoleOverride`), permissions, env, reviewer config, tracker intake and container reap. (H for the fields' existence)
- Multi-repo workspace creation is in `gitworktree.Workspace.CreateWorkspaceProject` and `rollbackWorkspaceProjectPreparation` (`bi/adapters/workspace/gitworktree/workspace.go`). (H for the functions' existence, M for the full semantics)
- Session ids are `"{project_id}-{num}"` with a per-project counter (`UNIQUE(project_id, num)`). (H)

**Operational assumptions:** a project is a local git checkout the user already has. The "origin" remote is used to identify the SCM repo (`resolveGitOriginURL` in `bi/observe/scm/observer.go`).

**Maintainability:** there is drift between comments and code. The `SessionWorktreeRecord.State` comment says the field "is never set by any live code path", but `session_manager.Manager.saveAndTeardownOne` sets `State: "removed"` (`bi/session_manager/manager.go`). (H)

**ATLAS equivalent:** partial. ATLAS plans per mission against a repo. AO adds a durable project registry and multi-repo "workspace" projects. ATLAS has no multi-repo project concept (based on the description).

---

## 2. Worker and agent lifecycle

**Spawn:** `session_manager.Manager.Spawn` (`bi/session_manager/manager.go:916`). The file is 6,525 lines.
- Idempotency comes from `ClientRequestID` and a request hash, using `GetSessionByClientRequestID` and `replayClientRequest`. (H)
- Validation runs before any durable state is written: harness known, model valid, mode resolvable. (H)
- The sequence is: insert a seed row (which assigns the id), create the workspace, provision, stage attachments, set up the browser, run PreLaunch, build the launch command, start the supervisor, create the runtime, commit, then deliver the prompt. Each failure is wrapped with a stage sentinel (`ErrSpawnCreate`, `ErrWorkspaceCreate`, `ErrRuntimeCreate`, `ErrSpawnDeliverPrompt` and others) through `wrapSpawnStage`. (H)
- Rollback: if workspace creation fails, the seed row is deleted. Later failures leave the row marked terminated and roll back what was built (`rollbackSpawn`, `destroySpawnWorkspace`, `preserveFailedSpawnWorkspace`, `markSpawnFailedTerminated*`). (H for the function list, M for each branch)
- Launch argv per harness, for example Claude Code `GetLaunchCommand` (`bi/adapters/agent/claudecode/claudecode.go`): `claude [--session-id <uuid>] [--permission-mode <mode>] [--append-system-prompt…] -- <prompt>`. (H)
- Hooks: the adapter writes `.claude/settings.local.json` hook entries (PreToolUse, PostToolUse, PermissionRequest, Stop, Notification, SessionEnd, SubagentStop) into the worktree. Each runs `ao hooks …`, which POSTs to `POST /api/v1/sessions/{id}/activity` on the loopback daemon (`bi/adapters/agent/claudecode/hooks.go`, `bi/cli/hooks.go`). (H)

**Monitor:**
- The activity signal is push-based, from agent CLI hooks. The persisted states are `active | idle | waiting_input | blocked | exited` (`bi/domain/activity.go`). `waiting_input` and `blocked` are "sticky", meaning time never demotes them. (H)
- Liveness is pull-based: `observe/reaper.Reaper.Tick` runs every 5 s (`bi/observe/reaper/reaper.go`). It probes `runtime.IsAlive(handle)` and, where supported, `IsSupervisedProcessAlive` (the agent process inside a still-living pane). It reports one of three facts: `ProbeAlive`, `ProbeDead` or `ProbeFailed`. A probe error is never collapsed to alive or dead. (H)
- Mass-death circuit breaker: if at least 5 sessions are dead and they are more than 50% of those probed in one pass, every dead result in that pass is downgraded to `ProbeFailed` and logged at error level (`massDeadMinSessions`, `massDeadFraction`). (H)
- A lifecycle reducer decides what happens. In `lifecycle.Manager.ApplyRuntimeObservation` (`bi/lifecycle/manager.go:462`), observations are fenced by `RuntimeLaunchID`, so a result from an older launch is ignored. If the pane is alive but the workload is dead, the session becomes `exited`. If the runtime is dead and there was no recent activity (`runtimeClearlyDead`, `bi/lifecycle/runtime.go`), the session is terminated in two steps with a revision re-check. Containers labelled `ao.session=<id>` are then reaped (`bi/adapters/container/dockerreap/reap.go`). (H)

**Stop:**
- `Manager.Kill`, `RequestKill` and `kill` (`manager.go:2410+`) terminate the native agent session, close scoped shell terminals, destroy the runtime and tear down the workspace. Tests cover ordering and failure preservation: `TestKill_NativeTerminationFailurePreservesRuntimeAndWorkspace`, `TestKill_RefusesWorkspaceTeardownWhenShellTerminalsWontClose`, `TestKillCleanupScriptFailurePreservesWorkspaceForRetry` (`bi/session_manager/manager_test.go`). (H for the test names, M for the bodies)
- `ExitAgent` stops only the agent and keeps the session (`manager.go:2868`). (M)

**Crash and restart handling (daemon):**
- `Reconcile` = `ReconcileStartupSafety` + `ReconcileBackground` (`manager.go:3774`). Startup closes durable non-terminal agent switches, recovers interrupted interface transitions, and marks in-flight async spawns as failed (`failInterruptedProvisioningRecords`). Background adopts surviving runtimes. Per its comment it "never launches missing agents or restores shutdown-saved workspaces" automatically. (H for the comments and structure, M for every branch)
- On orderly shutdown, `SaveAndTeardownAll` and `saveAndTeardownOne` (`manager.go:3474`) capture uncommitted work into a git ref, write a DB marker, mark the session terminated, destroy the runtime and force-remove the worktree. `RestoreAll` and `restoreSessionWorkspace` rebuild it later. See section 5. (H)

**Session resume:** the agent's native conversation is resumed, not restarted. `GetRestoreCommand` builds `claude --resume <agentSessionId>`, with the id captured from hooks or derived deterministically from the AO session id (`claudecode.go`). `ResumeAgentWithMode` and `relaunchSessionWithPolicyAndGeneration` live in `manager.go:3040+`. (H)

**Tests:** `bi/observe/reaper/reaper_test.go` covers the circuit breaker (`TestTick_MassDeathPassIsReportedAsInconclusive`, `TestTick_MinorityDeadPassesThroughBreaker`, `TestTick_SmallBoardMassDeathStillConcludes`), workload probes and probe errors becoming failed. `bi/integration/lifecycle_sqlite_test.go` covers spawn, PR and kill round trips, restore round trips and `TestReconcile_PreservesFailedLiveSessionAndReapsLeakedTmux`, using a `stubRuntime` against real SQLite. The tests are real Go tests, but the runtime in integration tests is a stub. tmux has its own `tmux_integration_test.go`. (H)

**Security implications:** agent processes inherit the daemon's full environment. tmux uses `cmd.Env = append(os.Environ(), env...)` (`bi/adapters/runtime/tmux/tmux.go:229`) and the pty-host uses `interactiveTerminalEnv(os.Environ(), …)` (`conpty/spawn_unix.go:32`). So any `GITHUB_TOKEN` or other secret in the daemon env reaches every agent. (H) Configured project env values are redacted from error messages (`agentlaunch.RedactValues` and `RedactError`). (H)

**Maintainability:** `session_manager/manager.go` is 6,525 lines and `lifecycle/manager.go` is 2,013 lines. Comments are dense with issue references (#2879, #3475, #4528 and so on), which suggests evolution by patching. There are many optional capability interfaces chosen by type assertion. That makes behavior hard to reason about without reading every adapter. (H for the sizes, M for the judgement)

**ATLAS equivalent:** ATLAS has attempt lifecycle, crash recovery that marks attempts lost and restarts them fresh, and a PTY via `script` in a sandbox. ATLAS has no native session resume, no tri-state liveness probe of the kind described, no mass-death breaker and no container reap.

---

## 3. Task-to-agent ownership

- **One task is one worker session.** There is no separate task table in the core schema. `sessions.issue_id` links a session to a tracker issue, and `sessions.kind ∈ {worker, orchestrator}` (`0001_init.sql`). (H)
- Task delegation: `service/session/delegation.go` `DelegateTaskInput` takes a project, a brief, an agent and a mode, then spawns a worker. `PrepareTask` is a reversible step that only creates the worktree. (H for the type, M for the flow)
- The orchestrator is itself an agent (kind `orchestrator`, chat mode by default per `Spawn`). It spawns workers through the `ao spawn` CLI, which POSTs to `/api/v1/sessions` with `ParentSessionID` (`bi/cli/spawn.go` `spawnRequest`). Workers inherit the parent's permission mode (`inheritedSpawnPermissions`). (H for the request shape, M for the orchestrator prompt flow in `session_manager/prompt.go`)
- Tracker intake (opt-in): `observe/trackerintake` polls once a minute and starts one worker per eligible issue, filtered by assignee (`""`, `*`, `none` or a name). Dedup is only against **non-terminated** sessions with the same canonical issue id (`seenIssueIDs`). After the session terminates, a still-eligible issue could plausibly be spawned again. I did not verify whether closed or ineligible state prevents that. (H for the code, L for the consequence)
- PR ownership: `pr.session_id` FK. The comment says "a PR belongs to one session (enforced at runtime)". Discovery attributes a PR to a session by **branch-name matching** (`matchSession` in `bi/observe/scm/observer.go`): exact branch, a `…/root` namespace prefix, or the generated `ao/<session>-N` hyphen form. Ambiguous matches are rejected. Explicit claiming goes through `service/session/claim_pr.go` (`ClaimPROptions.AllowTakeover`, `ErrPROwnedElsewhere`). (H)

**Limitations:** there is no DAG, dependency graph or concurrency budget between tasks. Coordination is left to the orchestrator agent's prompt. (M, based on not finding a scheduler; I did not search exhaustively.)

**ATLAS equivalent:** ATLAS is stronger here. It has a validated plan, a DAG scheduler, a concurrency budget and per-task worktrees from dependency checkpoints. AO is a session manager plus an LLM orchestrator, not a deterministic planner.

---

## 4. Persistent state storage

- SQLite via `modernc.org/sqlite`, which is pure Go with no CGO. The file is `<dataDir>/ao.db` (`bi/storage/sqlite/db.go`). (H)
- Pragmas: `journal_mode(WAL)`, `busy_timeout(5000)`, `foreign_keys(ON)`, `synchronous(NORMAL)`. (H) With `synchronous=NORMAL` in WAL mode, the last transactions can be lost on power failure, though not on a process crash. This is standard SQLite behavior and not specific to AO.
- **There are two pools.** The writer pool has `MaxOpenConns=1`, so all writes are serialized on one connection. The reader pool has up to 8 connections. The comment explains why: the CDC triggers do subqueries that need read-your-writes. (H)
- Migrations: goose, embedded SQL, **175 files** going up to `0194_…`. There are many "renumber" migration tests (`migrate_*_renumber_test.go`) and a guard against a legacy path (`checkLegacyDatabasePath` refuses to create an empty DB when legacy data exists). (H)
- Queries are generated by sqlc (`bi/storage/sqlite/gen/*.sql.go`) and wrapped by `store/`. (H)
- Core tables in `0001`: `projects`, `sessions` (only `activity_state` and `is_terminated` are status-like; display status is derived), `pr`, `pr_checks` (one row per PR, check and commit), `pr_comment` and `change_log`. Later tables include conversations, reviews, review threads, notifications, session_worktrees, automations, agent switching and others. (H for 0001, M for the later tables, which I read by filename)
- Concurrency fencing: `UpdateSessionFromActivitySignal(rec, expectedRevision)`, a revision column, launch-id fencing and owner generation (`bi/lifecycle/manager.go` interfaces). (H)
- Reaction dedup survives restarts through `pr.last_nudge_signature` (a JSON `{seen, attempts}`) (`bi/lifecycle/reactions.go` `reactionPayload`). (H)

**Recovery after restart:** see section 2. The durable rows plus `session_worktrees.preserved_ref` drive restore, and `change_log` lets SSE clients resume from their cursor. (H)

**ATLAS equivalent:** largely equivalent (SQLite WAL with an append-only log). The difference is that ATLAS's log is a per-mission domain event log with replay, while AO's `change_log` is a UI change-notification feed with bounded retention (7 days or 100k rows, `bi/cdc/retention.go`). It is not a source of truth.

---

## 5. Git worktree isolation

All in `bi/adapters/workspace/gitworktree/{commands.go,workspace.go}`. Git is called with argv arrays through `aoprocess.CommandContext`, never through a shell. (H)

- Path layout: `<managedRoot>/<projectID>/<sessionID>` for workers and `<managedRoot>/<projectID>/orchestrator/<prefix>-orchestrator` for orchestrators. Paths are validated with `validateManagedPath` and `pathWithin` (`ErrUnsafePath`). (H)
- Branches: the default is `ao/<sessionID>` (`defaultSessionBranchName`), or `ao/<id>-N` when a name is taken. (H)
- Creation: `git -C repo worktree add [-f] -b <branch> <path> <baseRef>`. The base is `origin/<default>` first, then `refs/heads/<default>` (`configuredBaseRefCandidates`). `--force` is used once, only to re-register a missing-but-registered path. The comment notes that git still refuses non-empty paths and locked registrations. (H)
- The default branch is refreshed on spawn with `fetch remote +refs/heads/B:refs/remotes/remote/B`, on a 5 s budget. (H)
- `extensions.worktreeConfig` is enabled (`enableWorktreeConfig`), and AO's own files go into `info/exclude` under `--git-common-dir` (`AddExclude`). (H)
- **Cleanup:** `Destroy` uses `git worktree remove` **without** `--force`. A dirty worktree fails with `ports.ErrWorkspaceDirty`, and the session is routed to "Skipped" rather than having its work deleted. `ForceDestroy` (`--force`) is called only after `StashUncommitted`. Teardown is serialized per repository (`repoTeardownLock`). (H)
- **Uncommitted-work capture:** `StashUncommitted` stages into a temporary `GIT_INDEX_FILE` with `add -A`, then runs `write-tree` and `commit-tree -p HEAD`, then `update-ref refs/ao/preserved/<sessionID>`. The real index and working tree are never touched. If the tree equals HEAD's tree, it is a no-op. (H)
- **Restore and conflicts:** `ApplyPreserved` runs `git cherry-pick --no-commit <sha>` (a three-way merge). On a non-zero exit, conflict markers are left in place, the ref is **kept**, and `ErrPreservedConflict` is returned. On success, the ref is deleted. (H)
- Merge or integration conflicts between workers: AO does **not** merge workers together. Integration happens through PRs on the SCM. Merge conflicts are detected from the provider's `mergeability` (`conflicting`) and turned into a rebase nudge to the agent (section 7). (H)

**Tests:** `workspace_integration_test.go` runs against **real git** (`requireGit(t)`, temp origin and clone). Examples: `TestWorkspaceIntegrationDestroyDirtyWorktree` asserts `ErrWorkspaceDirty` and that the file is preserved, then a successful destroy once only ignored files remain. `TestWorkspaceIntegrationRestoreRecreatesSiblingsIndependently` is a regression test showing that `git worktree prune` wiped a sibling's registration. Other tests cover locked worktrees, stale registration recovery and multi-repo rollback. These look substantive. (H)

**ATLAS equivalent:** ATLAS has per-task worktrees from dependency checkpoints and its own integration-branch merge with conflict detection, which AO lacks. ATLAS lacks AO's non-destructive capture of uncommitted work into a hidden ref with a three-way reapply. It is unknown whether ATLAS refuses to force-remove a dirty worktree.

---

## 6. Event-driven state sync (backend to UI)

The pipeline is: DB triggers → `change_log`, then a poller, then an in-process broadcaster, then SSE, then the renderer invalidating its query cache. (H)

1. **Capture:** SQLite `AFTER INSERT/UPDATE` triggers on `sessions`, `pr` and `pr_checks` write to `change_log` **in the same transaction** as the change. They are guarded so a no-op update emits nothing (for example `WHEN OLD.activity_state <> NEW.activity_state …`). The application never emits events itself (`0001_init.sql`). Later migrations add more event types (`pr_session_changed`, review threads, review runs and others). (H)
2. **Poll:** `cdc.Poller` runs every **100 ms** in batches of 512 (`bi/cdc/poller.go`). It keeps an in-memory cursor only and calls `SeekToHead` on boot. Because the writer is a single connection, seq order equals commit order, so cursor reads do not skip rows. (H for the code, M for the reasoning)
3. **Fan-out:** `cdc.Broadcaster` (`bi/cdc/broadcast.go`) uses synchronous callbacks with panic recovery for each subscriber. (H)
4. **Transport:** `GET /api/v1/events` serves SSE (`bi/httpd/events.go`). It **subscribes to live events before replaying**, replays from `?after=` or `Last-Event-ID` in batches of 512, and dedups by seq (`writeSSEEvent` skips `seq <= sent`). If the 1024-event live buffer overflows, it **closes the stream rather than dropping events**, and the client replays on reconnect. A cursor ahead of head is clamped to head, which avoids a reconnect stampede. A named heartbeat is sent every 10 s for proxies. (H)
5. **Client:** `frontend/src/renderer/lib/event-transport.ts` subscribes to named CDC events and **invalidates TanStack Query keys**, batched over a 150 ms window. The UI refetches snapshots rather than applying deltas. Backoff is in `sse-backoff.ts`. (H)
6. Terminal I/O is a separate path: a `/mux` terminal surface (`bi/httpd/terminal_mux.go`, `coder/websocket` dependency). (M)

**Tests:** `bi/httpd/events_test.go` includes `TestEventsStreamSubscribesBeforeReplayAndDrainsBufferedLive`, `TestEventsStreamDeduplicatesLiveEventOverlappingReplay`, `TestEventsStreamClampsCursorAheadOfCurrentDatabaseToHead` and `TestEventsStreamHeartbeatsWhileIdle`. `bi/cdc/cdc_test.go` includes `TestE2E_StoreWriteToBroadcast` and `TestBroadcasterRecoversPanickingSubscriber`. `bi/integration/lifecycle_sqlite_test.go:TestCDCPollerReceivesSessionAndPREvents` is weak: it only asserts `len(got) >= 2`. (H)

**Limitations:** polling adds up to 100 ms of latency and constant small read load. Payloads are thin (ids and states), so every event causes a REST refetch.

**ATLAS equivalent:** ATLAS has an append-only per-mission event log with replay. It is unknown whether ATLAS captures events atomically through triggers, and whether its UI stream supports cursor resume and overflow-closes. The concepts are close and AO's transport details are more refined.

---

## 7. PR, CI and review feedback loops

**Observation:** `bi/observe/scm/observer.go` (2,229 lines) is a provider-neutral polling loop. PRs and CI are polled every **30 s**, and review threads every 2 minutes at most. It uses ETag guards (`RepoPRListGuard`, `CommitChecksGuard`), a forced re-fetch after 5 minutes, a rate-limit cooldown and batches of 25. Providers are GitHub and GitLab (`bi/adapters/scm/{github,gitlab,multi}`). For failed checks it fetches the log tail (`FetchFailedCheckLogTail`, `enrichFailureLogs`). Results are persisted transactionally, after which `lifecycle.ApplySCMObservation` and `ApplyPRObservation` are called. (H)

**GitHub auth:** a token from `AO_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then other fallback sources (`bi/adapters/scm/github/auth.go`). (H for the env order, M for the remaining sources)

**Routing back to agents:** `lifecycle.Manager.ApplyPRObservation` (`bi/lifecycle/reactions.go:70`) queues independent nudges, so no condition suppresses another:
- **CI failing**, if `pr.AutoInjectCI`: a message that lists failed checks, the URL and the **log tail inside a fence that grows to fit the content**, all with control characters stripped (`formatCIFailureMessage`). There is no attempt cap (`maxAttempts: 0`), and dedup is by a check signature.
- **Unresolved review comments**, if `AutoInjectReview`: one nudge per comment, keyed per comment id, capped at `reviewMaxNudge = 3`. The message includes file:line, author, body and thread id, and tells the agent to resolve threads after pushing.
- **changes_requested reviews:** one nudge per review.
- **Merge conflict:** only at the bottom of a PR stack (`prBlockedByOpenParent`). It is "urgent", so it can reach a session idle at a needs-input prompt, but never one blocked on a permission dialog.
- Delivery goes through `sendOnce`, which loads persisted dedup lazily, then calls the session guard (section 8), then updates in-memory dedup, then persists. The order is send first, then persist. A crash between the two causes at most one duplicate nudge, never a lost one. A nudge suppressed by the guard is **not** marked delivered and fires again on the next poll. (H)
- **Completion:** when PRs are merged or closed, the session terminates only if no open PR remains, at least one merged, `TerminateOnPRMerge` is set, and the agent is not `active` (#2879). (H)
- **Auto review:** `bi/autoreview/coordinator.go` starts reviewer agents on PR heads after the worker has been idle for at least 1 minute, with 3 retries per head. The reviewer gateway (`bi/reviewgateway`, ADR 0002) gives reviewers manifest-pinned, structured git access. The ADR itself says it "is not by itself a process sandbox". (H)

**Security implications:**
- Review comment bodies and CI logs are attacker-influenced (the code comment says "anyone who can comment on the PR") and are pasted into the agent's live pane. Sanitization covers terminal control characters only. There is **no author trust filter**: injection is a per-session toggle (`sessions.auto_inject_review` / `auto_inject_ci`), not a per-author allowlist. I found `IsBot` tagging but no filter on collaborator or association. That makes this a prompt-injection channel from any PR commenter. (H for the code, M for "no filter anywhere", since I grepped only the observer and the GitHub adapter)

**Tests:** `bi/lifecycle/manager_test.go` includes `TestPRObservation_CIFailingNudgesAgentWithLogs`, `TestPRObservation_CancelledChecksDoNotNudge`, `TestPRObservation_CIFailureNotInjectedWhenPRPolicyDisabled`, `TestPRObservation_ReviewCommentsNudgeAgent`, `TestPRObservation_HumanReplyInBotThreadStillNudgesAgent` and `TestFormatCIFailureMessageUsesNonMutatingFence`. `bi/integration/scm_observer_test.go` includes `TestSCMObserverEndToEnd` and `TestSCMObserverMultiPREndToEnd`, using a fake provider (M). `frontend/e2e/ci-auto-inject.spec.ts` and `multi-pr.spec.ts` exist (I did not read them).

**ATLAS equivalent:** **none.** ATLAS has no GitHub PR or CI loop.

---

## 8. Live status derivation

- **Status is never stored.** `contract.DeriveStatus` (`backend/pkg/contract/status.go:107`) is called at read time from `service/session/status.go:deriveStatus`. Precedence:
  1. Terminated: `merged` if there are no open PRs and any PR merged, otherwise `terminated`.
  2. Activity `active` gives `working`, `exited` gives `exited`, and `waiting_input` or `blocked` give `needs_input`.
  3. Otherwise the **SCM status** of open PRs, taking the worst by severity: `ci_failed` < `changes_requested` < `commented` < `draft` < `review_pending` < `pr_open` < `approved` < `mergeable`. PRs stacked on an open parent PR are ignored unless the child has an actionable signal (`BuildStacks`, `isActionableChildSignal`).
  4. `no_signal` applies if the harness is expected to send hooks but **no hook has ever arrived** (`FirstSignalAt` zero) and the session has been silent for more than **90 s** (`noSignalGrace`). This avoids showing a confident "idle" when the hook pipeline is broken.
  5. Otherwise `idle`. (H)
- Inputs: hook-reported activity (push), reaper runtime and workload probes (pull, 5 s), and SCM facts (pull, 30 s). There is also a separate Kanban projection (`domain/kanban.go`, `pkg/contract/kanban.go`: building / validating / needs_review / ready / archive). (H)
- A terminal-scrape fallback exists for when a Stop hook never fires (`claudecode/terminal_activity.go`, whose comment mentions auth expiry, CLI crash and network loss). (M)
- **Session input guard:** `bi/sessionguard/guard.go`. Every write into a pane re-reads the session immediately beforehand and refuses with a typed `Outcome`: `SuppressedTerminated`, `SuppressedExited` (the pane may now be a shell), `SuppressedAwaitingUser` (blocked on a permission dialog, where a pasted Enter would answer it), `SuppressedStartupPending` (no first hook yet, since a startup dialog could eat the input), `SuppressedInputGated` (a mutation is in progress, checked via an `InputLease` acquired before the write and held until it returns), or `SuppressedUnknown` (fails closed on a store error). (H)

**Tests:** `pkg/contract/status_test.go` (`TestDeriveStatusPrecedence`, `TestDeriveStatusNoSignalRules`, `TestDeriveSCMStatusPipelineAndWorstWins`, `TestStackRules`) and `bi/sessionguard/guard_test.go` (`TestGuard_OutcomeByState`, `TestGuard_StoreErrorFailsClosed`, `TestGuard_InputLeaseCoversActualPaneWrite` and others). (H for the names)

**Limitations:** activity depends on each agent CLI's hook vocabulary. About 50 adapters exist in `bi/adapters/agent/`, and quality likely varies (L). A hook POST carries `AO_SESSION_ID`, checked only by a character regex, to an unauthenticated loopback endpoint (`bi/cli/hooks.go` `sessionIDPattern`). Any local process can forge activity for any session. (H)

**ATLAS equivalent:** ATLAS derives task state from orchestrator state machines and verification, not from agent self-reports. It has no equivalent of `no_signal`, sticky needs-input states, or a just-in-time input guard. That matters only if ATLAS injects input into live PTYs.

---

## 9. Browser previews

- Managed dev servers: `bi/previewserver/manager.go`. Config is read from `<worktree>/.ao/launch.json`. AO reserves a port, interpolates it into the command and env, probes readiness (150 ms interval, 30 s default and 55 s maximum timeout), and keeps a 200-line log buffer. Process records are persisted to `preview-processes.json` so they can be reaped after a restart (`reapPersistedProcesses`). Target URLs must be loopback (`isLoopbackHost`; test `TestManagerRejectsMissingConfigAndNonLoopbackURL`). (H)
- `bi/preview/poller.go` (250 ms) refreshes only previews that were explicitly selected. It never guesses ports (comment). (H)
- An embedded browser: Electron `WebContentsView` per session (`frontend/src/main/browser-view-host.ts`, `agent-browser-runtime.ts`). Agents drive it through the daemon's `browserruntime` broker. Electron authenticates to the broker with an HMAC/token handshake, and the token is passed over stdin (`bi/browserruntime/broker.go` `RuntimeTokenStdinEnv`). (H for the token handoff, M for the agent-facing API)
- Static preview files are served at `/api/v1/sessions/{id}/preview/files/*` with a path-scoped `HttpOnly` cookie on the LAN listener (`bi/httpd/auth.go`). (H)

**Security implication:** the `.ao/launch.json` command comes from the worktree, which the agent can edit, and the daemon executes it unsandboxed when a preview starts. Workers already have shell access, so this is not an escalation for the worker itself. It does mean the content of a branch decides what runs on the host. (M)

**ATLAS equivalent:** ATLAS runs browser QA through Playwright as part of verification. It does not have an interactive per-session preview browser. The approaches differ (verification vs live preview).

---

## 10. Recovery from blocked or failed work

- **Blocked on permission:** surfaced as `needs_input` and a notification (`lifecycle.emitNotification`, `bi/notify`). Automated nudges are suppressed while a session is blocked. The human answers in the terminal. (H)
- **Failed spawn:** the seed row is deleted or the session is marked terminated. If the runtime died, the workspace is preserved (`preserveFailedSpawnWorkspace`). (H for the names)
- **Agent crashed (pane alive):** the session becomes `exited`. The user can run `ResumeAgentWithMode` to resume the native conversation (`--resume`), or start fresh if no native id exists. (H)
- **Runtime died:** after the reaper confirms death, the session is terminated and its containers reaped. `RestoreWithMode` re-creates the worktree from the same branch, reapplies the preserved ref and relaunches (`manager.go:2795`). (M)
- **Daemon restart:** reconcile as in section 2. Interrupted async spawns are marked failed instead of spinning forever. (H)
- **CI failure or review feedback:** the agent is nudged automatically (section 7). There is no automatic re-run of a failed agent turn. Agent switching lets a session move to a different harness with a handoff artifact (`session_manager/agent_switching*.go`, `observe/agentswitch/policy.go`). (M)
- **Merge conflict on PR:** a rebase nudge, bottom of stack only. (H)

**ATLAS equivalent:** ATLAS restarts lost attempts fresh from checkpoints, which is deterministic. AO prefers resuming the agent's conversation and asking a human. ATLAS has no agent switching or handoff.

---

## 11. Security posture summary

| Area | Finding | Conf. |
|---|---|---|
| OS sandbox for workers | **None found.** No bwrap, seccomp, landlock or sandbox-exec references in `backend/` (grep). Agents run as the user in the worktree. ADR 0002 says the reviewer gateway "is not by itself a process sandbox". | H (grep) |
| Permission prompts | Delegated to each agent CLI. The Claude modes are `default`, `accept-edits`, `auto` and `bypass-permissions` (`bi/domain/agentconfig.go`). The Unreal harness defaults to `bypass-permissions` (`Spawn`). Workers inherit the parent's mode. | H |
| Global config mutation | `claudecode.PreLaunch` writes workspace trust into the user's `~/.claude.json` to skip the trust dialog. | H |
| Env/secrets | Agents inherit the full daemon `os.Environ()`, including tokens such as `GITHUB_TOKEN`. Configured values are redacted in errors and logs. CI runs `gitleaks`. | H |
| Daemon API auth | The loopback HTTP API is **unauthenticated**. The code comment says "The daemon is a no-auth loopback service". The CORS middleware rejects foreign `Origin`s with 403 but **accepts any loopback origin, including `*.localhost` and 127.x on any port** (`isLoopbackOrigin`, `bi/httpd/cors.go`), and passes requests with no Origin. Any local process, and any page served from localhost (including agent-run dev servers), can call kill, send and spawn. | H |
| PTY host | The pty-host listens on `127.0.0.1:0` TCP with no handshake or token in `handleConn` (`conpty/host.go`, `host_main.go`). Any local process that finds the port can read scrollback and inject keystrokes. | H (code read), M (exploitability) |
| LAN mode | Password hash, per-source lockout (5 failures per minute), cookie scoped to preview-files paths, plaintext HTTP by design (ADR 0001), and an unauthenticated identity probe (ADR 0003). | H |
| Prompt injection | PR comments, CI logs and tracker issue bodies are injected into agent prompts or panes, with control characters stripped but no author trust gating. | H |

**Compared with ATLAS:** ATLAS has a much stronger isolation and authorization model (bubblewrap sandbox, ToolGate, a policy engine with role grants and single-use approvals, and an IPC sender check). AO's model is "trust the agent CLI's own permission system plus loopback". Adopting AO's PR loop would bring its injection surface into ATLAS unless authors are filtered.

---

## 12. Coupling and maintainability

- Hexagonal-style layering: `domain`, then `ports` (interfaces), then `adapters`, then `observe/*` (pollers that only report facts), then `lifecycle` (a reducer that is the only writer of lifecycle facts), then `service/*` and `httpd`. The reaper comment says "only reports facts — it never writes session rows". This separation is a good pattern. (H)
- Size and complexity hotspots: `session_manager/manager.go` (6,525 LOC), `observe/scm/observer.go` (2,229), `lifecycle/manager.go` (2,013), `gitworktree/workspace.go` (2,343). There are 175 migrations including "renumber" fixes, about 50 agent adapters and about 20 ACP chat drivers. The surface is broad, and much of the behavior depends on harness-specific predicates (`WithActiveSteering`, `WithUrgentNudgeGate`, `WithStartupSignalGate`). (H)
- An OpenAPI spec is generated from Go (`bi/httpd/apispec`, `cmd/genspec`), and TS types come from `openapi-typescript`. There is a DTO drift test (`bi/cli/dto_drift_e2e_test.go`). (M)
- Tests are extensive and many use real git and SQLite. Some integration tests use runtime stubs, and some assertions are weak (CDC count ≥ 2). I did not run any tests.

---

## 13. License and NOTICE

- The root `LICENSE` is the Apache License 2.0, and its appendix reads "Copyright 2026 Untrivial". The README states Apache-2.0. (H)
- **There is no `NOTICE` file** anywhere in the repo (`find -iname 'NOTICE*'`). (H)
- Inconsistent metadata: `frontend/package.json`, `packages/ao*/package.json` and `packages/product-ui/package.json` declare `"license": "MIT"`. `packages/cloud-client` declares Apache-2.0. Third-party brand assets ship with their own MIT licenses (`frontend/src/renderer/assets/agents/LICENSE-{codewhale,mimo-code}.txt`). (H)
- Obligations if code is copied: under Apache-2.0 §4, include a copy of the license, keep copyright and attribution notices, and mark modified files. With no NOTICE file, there is no NOTICE text to carry forward. Adopting **concepts** only, as recommended below, creates no license obligation. Because the frontend package metadata conflicts with the root license, confirm intent before copying frontend code. (H for the facts, M for the interpretation; this is not legal advice)

---

## 14. Unverified or not examined

- I did not read `cloud/`, `private/ao-cloud` (possibly a submodule), `packages/mobile`, most agent adapters, most renderer code, or the frontend e2e spec bodies.
- I did not confirm whether any agent CLI is launched inside Docker (only container *reaping* by label exists).
- I did not confirm the full `RestoreAll` branch behavior or the agent-switch saga.
- I did not confirm whether tracker intake can re-spawn an issue after its session terminates.
- I made no runtime observations. Everything here comes from reading source.

---

## 15. Five mechanisms most worth adopting into ATLAS (as concepts)

1. **A just-in-time input guard with typed suppression outcomes and an input lease.** Before any automated write into a live agent PTY, re-read durable state and refuse if the session is blocked on a decision, exited (the pane may now be a shell), still starting (no first signal yet), mid-mutation (lease closed) or unreadable (fail closed). A suppressed write is never recorded as delivered.
   Evidence: `bi/sessionguard/guard.go` (`Outcome`, `InputLease`), `bi/lifecycle/reactions.go` `sendOnce`, `guard_test.go`. Relevance: ATLAS drives a PTY via `script`. Any future nudge or steering path needs this invariant. (H)

2. **A tri-state liveness probe with launch-id fencing and a mass-death circuit breaker.** Probes report alive, dead or failed, never collapsing an error into either. Observations carry the launch id so results from a previous attempt are ignored. A pass where most attempts appear dead is treated as an infrastructure fault rather than N failures. Pane liveness and workload liveness are distinct facts.
   Evidence: `bi/observe/reaper/reaper.go` (`massDeadMinSessions=5`, `massDeadFraction=0.5`, `ProbeFailed`), `bi/lifecycle/manager.go` `ApplyRuntimeObservation` (`matchesLaunch`, two-step revision-checked termination), `reaper_test.go`. Relevance: ATLAS's "mark lost attempts and restart fresh" could restart a whole mission's attempts after a transient sandbox or daemon fault. (H)

3. **A non-destructive capture of uncommitted work before worktree removal, with a three-way reapply.** Never `--force` a dirty worktree. To tear one down, first snapshot it into a hidden ref (temporary index, `write-tree`, `commit-tree`, `update-ref refs/<app>/preserved/<id>`) and commit a DB marker, then force-remove. On restore, cherry-pick with `--no-commit`. On conflict, keep the ref and the markers and surface a typed error.
   Evidence: `bi/adapters/workspace/gitworktree/workspace.go` `StashUncommitted`, `ApplyPreserved`; `commands.go` `worktreeRemoveArgs` (no force); `session_manager/manager.go` `saveAndTeardownOne` (capture, then the DB marker, then ForceDestroy); real-git tests in `workspace_integration_test.go`. Relevance: ATLAS restarts lost attempts fresh. Preserving the lost attempt's partial diff as evidence or for salvage costs little and loses nothing. (H)

4. **Trigger-captured change feed with cursor-resumable SSE semantics.** Change events are written by DB triggers in the same transaction as the state change, guarded so no-op updates emit nothing. A single writer connection makes seq a safe cursor. The stream subscribes before replaying, dedups by seq, closes rather than dropping on overflow, clamps a future cursor to head, sends heartbeats, and has bounded retention.
   Evidence: `migrations/0001_init.sql` triggers; `bi/storage/sqlite/db.go` single-writer comment; `bi/cdc/{poller,broadcast,retention}.go`; `bi/httpd/events.go`; `events_test.go`. Relevance: ATLAS already has an append-only event log. The transferable parts are atomic capture (no event lost when a write commits but the emit fails) and the subscribe-before-replay plus overflow-closes discipline for the renderer stream. (H)

5. **Display status derived from facts and never stored, with a "no signal" downgrade and sticky needs-input states.** Persist only minimal facts and compute status at read time with explicit precedence and a "worst signal wins" aggregation. If an expected heartbeat or hook never arrived within a grace period, show "no signal" rather than "idle". Do not demote "awaiting human" states over time.
   Evidence: `backend/pkg/contract/status.go` `DeriveStatus`, `silentPastGrace`, `aggregatePRStatus`, `statusSeverity`; `bi/domain/activity.go` `IsSticky`; `bi/service/session/status.go` (`noSignalGrace = 90s`); `status_test.go`. Relevance: this prevents ATLAS's UI from showing a stuck runtime as healthy-idle. (H)

Runner-up: if ATLAS ever adds a PR/CI loop, copy AO's reducer shape. It queues independent nudges so one condition cannot suppress another, persists dedup signatures and attempt budgets, sends before persisting so a crash duplicates at most one nudge rather than losing it, and includes the CI log tail in a fence that grows to fit. Add what AO lacks: author trust gating before injecting PR text. Evidence: `bi/lifecycle/reactions.go` `ApplyPRObservation`, `sendOnce`, `reactionPayload`, `formatCIFailureMessage`. (H)
