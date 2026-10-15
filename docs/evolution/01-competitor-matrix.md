# 01 — Competitor matrix

## Sources
- **ATLAS** at `eb3bd1c` (baseline, this repository).
- **AO** = OrchestratorInc/agent-orchestrator @ `2874fcf`, Apache-2.0.
- **LB** = limboo-ai/limboo @ `4ad8bea`, MIT.
- **SM** = Tetrahedroned/Claude-Multiplex ("SigmaLink") @ `66efd4d`, MIT.

## How the evidence was gathered
- Full per-repository audits with file/symbol citations are in [`audits/`](audits).
- The audits were static reads by three independent reviewers working in fresh contexts. Nothing from the references was built or run.
- I re-checked a sample of their claims against the source myself (4/4 confirmed):
  - LB `settingSources: ['user','project','local']` at `AgentManager.ts:6168`;
  - AO `refs/ao/preserved/` in the worktree code and tests;
  - SM `sandbox: false` at `electron/main.ts:679`;
  - SM's Linux process-tree kill marked unsupported in `process-tree.test.ts:24`.
- ATLAS entries cite ATLAS tests that ran on 2026-10-10.

## How to read the table
- **Confidence:** **H** = code or test read directly (for ATLAS: a test ran); **M** = partial path or inference; **L** = plausible, unverified.
- **"Better"** means better on evidence for that dimension only. It is not a product-level claim.
- No reference project was executed, so their runtime behaviour, performance and reliability are **untested here**.

| # | Dimension | ATLAS | AO | LB | SM | Who is ahead (evidence) |
|---|---|---|---|---|---|---|
| 1 | Agent execution correctness | Pi SDK in the daemon, governed tools only; the adapter refuses unexpected tools (`runtime-pi/src/index.ts:147`). Contract-tested with Pi's faux provider, so live models are untested (H) | Agent CLIs in tmux/pty-host, driven by hooks (H) | Claude Agent SDK, cursor-agent and AI-SDK harnesses in main (H) | Agent CLIs typed into login shells; claude launched with `-p` exits in a pane (M) | ATLAS on governance. All are unverified against live models in this study |
| 2 | Multi-agent delegation and dependencies | Validated plan, DAG, concurrency budget, delegation depth/count budgets (`m2.test.ts`) (H) | LLM orchestrator spawns workers through the CLI; no DAG (M) | Subagents through the SDK; no scheduler found (M) | Swarm roster; protocol rarely closes the loop, task board never reaches agents (M-H) | ATLAS (H) |
| 3 | Worktree and repository isolation | Per-task worktrees from dependency checkpoints, integration merge, leases (`workspace.test.ts`, `m2.test.ts`) (H) | Worktrees; never force-removes dirty ones; `refs/ao/preserved` capture + 3-way reapply (H) | Worktrees + temp-index checkpoints under a private ref (H) | Worktree pool with count/disk guards; optional in-place mode with no isolation (H) | ATLAS on integration; **AO/LB on preserving uncommitted work** |
| 4 | Session persistence and resume | No agent-session resume; lost attempts restart fresh (H) | Native `--resume` with derived session id (H) | Provider resume tokens per (session, provider) (H) | Pre-assigned claude session id; exact-id resume, never "latest" (H) | AO/SM ahead on resume; ATLAS's fresh restart is deterministic but discards conversation |
| 5 | Terminal/PTY robustness | `script`-based PTY in the sandbox, no resize, no reattach; 182 ms median echo (baseline) (H) | tmux / pty-host; the pty-host TCP socket has no auth (H) | node-pty beta, scrollback ring (H) | node-pty + 12 ms coalescer + 256 KiB ring + race-free snapshot attach + resize discipline (H, unit-tested with fakes) | **SM** on terminal engineering; ATLAS on isolation |
| 6 | Electron process separation | Daemon utilityProcess; frozen 6-key preload; sender + zod checks (`security.spec.ts`) (H) | Go daemon over HTTP (no Electron data path) (H) | Everything in main; ~210 preload methods (H) | Everything in main; `sandbox:false`; sender ignored (H) | ATLAS (H) |
| 7 | Durable mission state | SQLite WAL, versioned transactional migrations, per-mission event log (`storage.test.ts`) (H) | SQLite, 175 goose migrations, single-writer pool (H) | SQLite, non-transactional unversioned migrate (H) | SQLite + drizzle (M) | ATLAS ≈ AO > SM > LB |
| 8 | Event sourcing / reconstruction | Append-only log + `replay()` checked after crash (H) | Trigger-captured change feed, not a source of truth; SSE resume, subscribe-before-replay (H) | Activity rows; tool calls not persisted (H) | Mailbox table; PTY events (H) | ATLAS on replay; **AO on stream transport discipline** |
| 9 | Crash/restart recovery | Lost attempts recorded and restarted; unanswered approvals expired. **Defect found:** unsandboxed commands survive a daemon SIGKILL as orphans (baseline probe) (H) | Startup reconcile; tri-state liveness; mass-death breaker; adopts survivors (H) | Not examined in depth (L) | Boot janitor; win32 orphan sweep by command line (H) | AO on liveness modelling; ATLAS on deterministic state; **orphan reaping is an ATLAS gap** |
| 10 | Tool permissions and approvals | Policy engine, role grants, single-use approvals. **Defects found:** safe-listed argument forms run programs (§backlog P1-1) (H) | Delegated to each agent CLI's modes; bypass modes exist (H) | String-heuristic gate; repo `.claude/settings.json` may pre-approve (M) | `--dangerously-skip-permissions` per pane, re-applied on resume (H) | ATLAS, with fixes needed |
| 11 | Filesystem and network sandboxing | bubblewrap (Linux, tested); Seatbelt (macOS, failing in CI); AppContainer (Windows, WIP) (H) | None (H) | Off by default (H) | None (H) | ATLAS (H) |
| 12 | Browser and desktop interaction | Playwright QA, origin-locked; Xvfb desktop with lease, pause and takeover (H) | Embedded WebContentsView previews; tokenized broker (H) | — | In-app WebContentsView browser, CDP tools, SSRF guard (H) | ATLAS for verification; AO/SM for a live preview browser |
| 13 | Human takeover | Desktop takeover/pause/stop with tests; operator terminal (H) | Human types in the pane; input guard blocks automated writes during prompts (H) | Approval prompts (H) | Shared terminal (H) | ATLAS on enforced lease; **AO's input guard** is a good pattern |
| 14 | Context management | Per-attempt context bundle with source hashes + operator facts (H) | Persistent orchestrator context (M) | FTS5 memories injected as "authoritative"; repo-drift delta on resume (H) | — | LB's **repo-drift delta** is a cheap, auditable idea |
| 15 | Model/provider adaptability | `AgentRuntime` interface; Pi (multi-provider) + fake (H) | ~50 agent adapters (H) | Claude SDK, Cursor, AI-SDK harnesses with a capability record (H) | 6 CLIs (H) | AO/LB on breadth; ATLAS on a narrow, tested seam |
| 16 | Git/PR/CI feedback | None (H) | 30 s SCM poller, CI log tails and review comments routed to agents; no author gating (H) | gh read verbs (M) | — | **AO** (with its security caveats) |
| 17 | Build/test/QA verification | Independent gate on real exits; review is gate-only; eval corpus. **Defect found:** an agent can rewrite the test script and get "verified" (H) | Reviewer agents; CI is the signal (H) | None found (M) | None found (M) | ATLAS, after the fix |
| 18 | Staging deployment validation | Revision read-back, synthetic traffic, rollback with confirmation (`deploy.test.ts`) (H) | Not found (M) | Not found (M) | Not found (M) | ATLAS (H) |
| 19 | Observability and debugging | Event timeline, artifacts, JSONL export, daemon logs, eval report (H) | PostHog/Sentry telemetry, structured status (H) | Telemetry tables, diagnostics (H) | Notifications (M) | Different goals; ATLAS has no telemetry by design (§43 audit test) |
| 20 | UI/UX and keyboard efficiency | Command palette, shortcuts, "needs you" surfaces; no multi-pane terminal (H) | Kanban + session views (M) | Feature-rich renderer (M) | Pane grid, LRU terminal cache (H) | SM on terminal UX; otherwise unmeasured |
| 21 | Packaging and updates | electron-builder AppImage/dmg/nsis, unsigned, no auto-update (H) | electron-forge (M) | Forge + builder, electron-updater, Windows signature verification **off** (H) | electron-builder (M) | No one is clearly ahead; LB's updater pattern is unsafe |
| 22 | Automated test depth | Unit 87, integration 44, e2e 9, eval 11 — all executed here (H) | 852 Go test files + 411 frontend; many use real git and SQLite (H, not run) | **None** (H) | 386 unit + 11 e2e, mostly mocked; no real CLI (H, not run) | ATLAS and AO (AO's suite was not run here) |
| 23 | Resource consumption | Idle 677 MB, 5 processes, daemon 181 MB; launch 1.28 s (measured) | Not measured | Not measured | Admission caps 12/8 agents (H) | **Untested for references.** No claim |
| 24 | Security and supply chain | Env allowlist; no node-pty; pinned Pi; redaction; netlog audit (H) | Full env to agents; unauthenticated loopback API (H) | Full env; repo-configurable permissions; updater unsigned on Windows (H) | Full env; unauth MCP socket; `openExternal` any URL (H) | ATLAS (H) |
| 25 | Extensibility and maintainability | 13 small packages, acyclic graph enforced; largest file 1026 lines (H) | Hexagonal layering; 6.5k-line managers (H) | 8k-line `AgentManager`; TS 4.5 not typechecked (H) | 2.8k-line router; contradictory comments (H) | ATLAS on structure (H) |

## Mechanisms selected for adoption (concepts only; no code copied)

| Concept | Source evidence | Why it is worth adopting in ATLAS |
| --- | --- | --- |
| Preserve uncommitted worktree state in a hidden ref (temp index → `commit-tree` → `update-ref`) before removing it | AO `gitworktree/workspace.go` `StashUncommitted`; LB `GitManager.snapshotTree` | On decide or delete, ATLAS runs `git worktree remove --force` on every task worktree (`workspace/src/index.ts:52`). That includes lost attempts' worktrees and operator-terminal edits, so uncommitted work is destroyed without a trace |
| Orphan reaping that does not trust ppid | SM `process/orphan-sweep.ts` (by command line); AO reaper | Confirmed ATLAS leak (unsandboxed, macOS) |
| Hash-bound approval of repo-authored executable config | LB `worktree/config.ts` `hashRepoConfig` + `ackConfig` | Basis for the fix to the confirmed test-script false pass |
| Deny-by-default argument checks for "read-only" commands | LB `agent/readOnlyCommands.ts` (rejects `rg --pre`, `find -exec`, `git --output`/`-O`) | Fixes the confirmed classifier gaps |
| Terminal output coalescer + ring buffer + subscribe-then-snapshot reattach + resize ordering | SM `pty-data-coalescer.ts`, `ring-buffer.ts`, `snapshot-overlap.ts`, `refit-controller.ts` | ATLAS's terminal loses its session when the tab unmounts and has no resize |
| Pre-create resource guards (worktree count, disk floor) | SM `git/worktree.ts` `assertUnderCap`, `assertAboveDiskFloor` | Bounded disk use under many tasks and retries |
| "No signal" status for silent attempts | AO `pkg/contract/status.go` `noSignalGrace` | A stalled runtime currently looks like a working one until the wall-clock budget |
| Repo-drift delta for the next attempt | LB `resume/delta.ts` | Cheap, auditable context improvement (P3) |

## Mechanisms explicitly rejected
- Stdin keystroke injection as a control channel (SM).
- An unauthenticated loopback API or socket (AO, SM).
- Inheriting the full environment (AO, LB, SM).
- Repo-configurable runtime permissions (LB).
- Persisted permission-bypass flags (SM).
- Unsigned auto-updates (LB).
- A PR/CI loop without author gating (AO). It is deferred, since it needs credentials that are an untested boundary here.
