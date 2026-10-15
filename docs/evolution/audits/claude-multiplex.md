# Source audit: Tetrahedroned/Claude-Multiplex ("SigmaLink")

- Repository: `/tmp/claude-0/refs/Claude-Multiplex`, commit `66efd4da333365738fe246a8f246c0b664a70b71`, MIT (`LICENSE`: "Copyright (c) 2026 s1gmamale1 and SigmaLink contributors").
- App package: `app/package.json` -> `sigmalink-agent-orchestrator` v2.5.1, Electron `^30`, `node-pty ^1.0.0`, `@xterm/xterm ^6`, `@xterm/headless ^6`, `@xterm/addon-webgl 0.19.0`, `better-sqlite3`, `drizzle-orm`, `zod ^4`.
- Method: read-only static reading of the source. I did not install, build or run anything. README, BRIEF.md, RUNNING.md and the code comments were treated as claims to check, not as evidence. Code comments in this repo are long and tell a narrative ("v1.6.0 Phase 7", "H-6 Wave-2 hardening"). Where a comment says what code does, I checked the code where that was practical.
- Confidence legend: **H** = read the implementing code directly; **M** = read the main path but not every caller, or the conclusion depends on how an external CLI behaves; **L** = inferred, not verified.
- ATLAS comparisons rely on the caller's description of ATLAS (daemon utilityProcess, Pi SDK in-process agents, bubblewrap argv executor, one `script`-based PTY per worktree, event-log status, fresh restart after a crash, DAG scheduler). I did not re-read ATLAS source for this audit.

---

## 1. Parallel CLI agent execution

**What it is.** Each "pane" is a real third-party agent CLI running inside a node-pty PTY in the **Electron main process**. There is no separate daemon or utility process.

- Provider table: `app/src/shared/providers.ts` `AGENT_PROVIDERS` (H):
  - `claude` (`command:'claude'`, `oneshotArgs:['-p','{prompt}']`, `resumeArgs:['--resume']`, `autoApproveFlag:'--dangerously-skip-permissions'`, `xtermOnlyArgs:['--settings','{"tui":"fullscreen"}']`)
  - `codex` (`-q {prompt}`, `--dangerously-bypass-approvals-and-sandbox`)
  - `gemini` (`initialPromptFlag:'-i'`, `--yolo`)
  - `kimi`, `opencode` (no prompt flag; the prompt is typed into stdin after spawn)
  - `cursor` (`cursor-agent --trust`, `--force`)
  - internal `shell` (`command:''` -> the user's default shell)
- Spawn chokepoint: `app/src/main/core/providers/launcher.ts` `resolveAndSpawn()` (H).
  - Resolves the provider and applies the comingSoon fallback.
  - Applies a legacy gate.
  - Pre-assigns `--session-id <uuid>` for claude only (`PRE_ASSIGN_PROVIDERS = new Set(['claude'])`).
  - Builds argv in `buildArgs()`: `[--session-id] + provider.args + xtermOnlyArgs + autoApproveFlag? + extraArgs`.
  - Walks `[command, ...altCommands]` on ENOENT.
- Pane launch: `app/src/main/core/workspaces/launcher.ts` `executeLaunchPlan()` loops over `plan.panes` **sequentially** (`for (const pane of plan.panes)`, awaiting worktree creation per pane). The PTYs then run concurrently. (H)
- Swarm launch: `app/src/main/core/swarms/factory.ts` (`MAX_SWARM_AGENTS = 20`) -> `factory-spawn.ts` `materializeRosterAgent()` / `spawnAgentSession()`. (H)
- Admission control: `app/src/main/core/ram-brake/admission.ts` `DEFAULT_CAPS` = 12 live agents in total, 8 per workspace, 2 "MCP-heavy" in total, 1 MCP-heavy per workspace. A launch over the caps is **rejected** (`RamBrakeAdmissionError`). It is not queued. (H)
- How the initial prompt is delivered (`workspaces/launcher.ts` `buildExtraArgs()`, lines ~121-146 and ~630-640) (H):
  - Path A: if the provider has `oneshotArgs`, the prompt becomes argv. For claude that is **`claude -p "<prompt>"`, which is print/non-interactive mode**. A claude pane launched with an initial prompt therefore runs one-shot and exits; in the default shell-first mode it then drops back to the shell. This follows from the argv; I did not observe the CLI's behaviour. (M)
  - Path B (kimi, opencode): `setTimeout(() => pty.write(id, prompt + '\n'), 600)`. This is a blind timed stdin write with no readiness check. (H)
- Environment: agent spawns pass `env: undefined`, and `spawnLocalPty` uses `input.env ?? process.env` plus `TERM`/`COLORTERM`/`FORCE_COLOR`. **The whole Electron main-process environment is inherited by every agent**, with no allowlist. (H for `local-pty.ts` lines 488-533; M that no caller passes a filtered env. I grepped for env scrubbing and found none.)
- Renderer-driven spawn: `pty.create` in `app/src/main/rpc-router.ts` (~987-1037) accepts renderer-supplied `args` (up to 256) and `env` (`schemas.ts` `'pty.create'`). It contains `cwd` via `assertAllowedPath` but takes args and env as given. (H)

**Assumptions.** CLIs are installed on a PATH resolved from the login shell (`whenShellPathReady`). The providers' flags are stable. Agent authorization is whatever the CLI provides, and the operator can turn it off with the per-pane `autoApprove` flag.

**Failure handling.**
- Synchronous ENOENT pre-flight: `resolvePosixCommand`/`resolveWindowsCommand` in `local-pty.ts` let the altCommand walk work on POSIX, where node-pty otherwise reports ENOENT as an asynchronous exit 127.
- If spawn throws synchronously, the error becomes a "fake handle" that emits a red error line and exit -1.
- Early death is classified by `pty/crash.ts` `isPtyCrash(earlyDeath<1500ms || exitCode!==0 || signal)`.
- If spawn fails after the worktree was created, the worktree is rolled back (`worktreePool.removeAndPrune`).

**Tests.**
- `app/src/main/core/providers/launcher.test.ts` and `__tests__/launcher.spec.ts` exist.
- `local-pty.test.ts` deliberately does **not** mock node-pty for the ENOENT pre-flight, and mocks it elsewhere with `vi.doMock`.
- `registry.test.ts` mocks `./local-pty` and `process-tree` entirely.
- These are unit tests against fakes. Real-CLI behaviour (`-p`, `--session-id`, `--resume`) is not tested anywhere I found. (M)

**Security.**
- No sandbox of any kind: agents run with the user's full privileges and the app's full environment.
- `autoApprove` maps directly to `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` / `--yolo` / `--force`. It is persisted in `agent_sessions.auto_approve` and **re-applied on every resume** (`pty/resume-launcher.ts` ~748: `autoApprove: row.autoApprove === 1`). (H)

**ATLAS equivalent.** None by design. ATLAS runs agents in-process through the Pi SDK with governed tools, so its scheduler and concurrency budget are stronger than a reject-only RAM brake. The SigmaLink model only matters if ATLAS ever hosts external CLIs.

---

## 2. PTY lifecycle

- **Library:** `node-pty` (`app/src/main/core/pty/local-pty.ts` `import * as nodePty from 'node-pty'`). It runs in the Electron main process. (H)
- **Spawn (`spawnLocalPty`)** (H):
  - `direct` mode: `nodePty.spawn(command, args, {name:'xterm-256color', cwd, cols>=20, rows>=5, env})`. A missing cwd falls back to `os.homedir()`.
  - **`shell-first` mode, which is the default** (`parseSpawnMode`: anything except `'direct'` gives `'shell-first'`): spawns `$SHELL -l` (bash/zsh), then **types the command line into the PTY master** on the first data chunk or after 250 ms (`SHELL_FIRST_PROMPT_TIMEOUT_MS`). The line is `command 'arg1' 'arg2' ; printf '\n%s%d%s\n' '__SIGMALINK_CLI_EXIT_' "$?" '__'`. Args are POSIX single-quoted (`posixQuoteArg`); the command name is not quoted, but it comes from the provider registry.
  - Windows always degrades to `direct` (`resolveEffectiveSpawnMode`).
- **Resize** (H):
  - `PtyHandle.resize` clamps the size and swallows EBADF.
  - `PtyRegistry.resize` skips dead sessions.
  - The router's `pty.resize` first **flushes the output coalescer** so bytes rendered at the old width reach the renderer before the SIGWINCH (`rpc-router.ts` ~1042-1050).
  - Renderer refit logic is in `app/src/renderer/features/command-room/refit-controller.ts`: a 60 ms trailing debounce, and during a drag xterm re-wraps without notifying the PTY. Only one SIGWINCH is sent, at drag end, because the code notes that Claude Code's Ink renderer duplicates its frame on each SIGWINCH.
- **Exit** (H):
  - `PtyRegistry.create` sets `alive=false` in `onExit`, broadcasts, persists scrollback (optional), and forgets the record after `gracefulExitDelayMs = 200` so late subscribers can still pull the buffer.
  - A guard (`recAtExit`) stops a stale timer from forgetting a re-created record.
  - Creating a duplicate live id throws.
- **CLI-exit vs PTY-exit:** in shell-first mode the PTY outlives the CLI. CLI exit is detected by the `printf` sentinel in the output stream (`pty/sentinel.ts` `extractSentinel`, `sliceSentinelCarry` handles a sentinel split across chunks), which fires `onCliExited`. (H)
  - **Gap:** the router's `onCliExited` (`rpc-router.ts` ~628) only pushes a notification. The swarm and launcher status writes hang off `rec.pty.onExit` (`swarms/factory-spawn.ts` ~561), which is the **shell's** exit. In the default mode an agent that finished therefore stays `idle`/`running` in the DB until the shell dies, and the swarm auto-teardown policy will not fire. (M-H; I did not find another writer.)
- **Kill of process trees** (`app/src/main/core/process/process-tree.ts`) (H):
  - `stopProcessTrees` reads `ps -axo pid=,ppid=,rss=,comm=,args=` (darwin), sends SIGTERM leaves-first, then SIGKILLs survivors after 5 s (`PTY_KILL_FALLBACK_MS`).
  - win32 uses `taskkill /T /F` after a CIM listing.
  - **Linux is explicitly unsupported**: `platformSupported()` returns true only for darwin/win32, and `process-tree.test.ts` asserts "linux: unsupported, never execs". On Linux, `stop()` falls back to `rec.pty.kill()` (node-pty sends SIGHUP to the child) plus a pid-only SIGKILL after 5 s (`registry.ts` `forget()`/`killAll()`). Grandchildren that set up their own session or ignore SIGHUP (MCP servers, dev servers) can survive. (H for the code; L for what happens on Linux, which I did not run.)
  - Liveness is checked with `process.kill(pid,0)`, which has a PID-reuse window that the comments acknowledge.
- **Cleanup on app quit** (`app/electron/main.ts` ~1010-1044) (H):
  - `before-quit` calls `preventDefault()`, then `async shutdownRouter()`, then re-quits.
  - `shutdownRouter` (`rpc-router.ts` 2611+) persists scrollback (if enabled), records root pids, calls `pty.killAll()`, tears down browser views, memory supervisors and the MCP host, waits a bounded time for pids to exit (win32 db-lock issue), then closes the DB.
  - Win32 boot-time orphan sweep: `process/orphan-sweep.ts` `sweepWin32DbOrphans` matches leftover `mcp-memory-server.cjs` processes by **command line** (so reparenting does not hide them) and runs `taskkill` on them.
  - A SIGKILL of the app skips all of this. A boot "janitor" (`app/src/main/core/db/janitor.ts`) reconciles stale `running` rows instead.

**Tests.** `registry-lifecycle.test.ts` covers the stale-timer guard, duplicate-live-id throw, clean replace over an exited record, and a sentinel split across two chunks. `process-tree.test.ts` injects `exec`. `sentinel.test.ts` and `pty-data-coalescer.test.ts` are pure. All are fake-driven. There is no real-PTY tree-kill test on Linux. CI e2e (`.github/workflows/e2e-matrix.yml`) runs **only `windows-latest` and `macos-14`**. (H)

**Security.**
- The default shell-first mode runs a **login shell** with the user's rc files before the agent starts. Behaviour therefore depends on the user's dotfiles, and anything in them runs inside the agent's cwd/worktree.
- The sentinel can be **spoofed**: any process that prints `\n__SIGMALINK_CLI_EXIT_0__\n` (an agent, a test, a `cat` of a file) fires `onCliExited`. Today that only produces a notification.

**ATLAS equivalent.** ATLAS's operator terminal uses `script` without resize and with fewer moving parts. ATLAS has no CLI-exit-vs-shell-exit split because agents are not shell children. ATLAS's terminal package already has process-tree kill (per the AGENTS.md map: "process-tree kill, timeouts"). SigmaLink's Linux path is weaker than that.

---

## 3. Multi-pane terminals

- **Layout:** `app/src/renderer/features/command-room/PaneGrid.tsx` (H).
  - Rows ≈ √n. Each row is an independent CSS grid. Track sizes are held in CSS custom properties (`--pg-rows`, `--pg-cols`) written imperatively once per rAF while dragging, so React reconciliation cannot overwrite a size mid-drag.
  - Panes are keyed by sessionId.
  - `react-resizable-panels` is a dependency, but the grid uses its own `PaneDivider`.
- **Rendering:** two presenters (H):
  1. Attached xterm.js (`@xterm/xterm`) with Fit, WebLinks and **WebGL** addons. Code: `app/src/renderer/lib/terminal-cache.ts`; `loadWebglAddon` disposes the WebGL addon on `onContextLoss`.
  2. A "DOM presenter" built on `@xterm/headless` (`app/src/renderer/lib/terminal-engine.ts`). It parses VT into logical lines and styled runs, renders them in React (`DomTerminalView.tsx`, `GridView.tsx`/`FlowView.tsx`), and records OSC-133 prompt marks (`registerOscHandler(133, …)`).
- **Terminal instance cache:** `terminal-cache.ts` keeps xterm instances in a module singleton keyed by sessionId, **LRU-capped at `TERMINAL_CACHE_LIMIT = 32`**, with `scrollback: 8000`. A detached terminal is parked in an off-screen "parking lot" div and keeps receiving data, so switching rooms or workspaces does not lose output or force a re-render.
- **Device Attributes filter:** `terminal-cache.ts` strips xterm's Device Attributes responses (`\x1b[?1;2c`) from the keystroke→`pty.write` pipe. This fixes "`1;2c` typed into the prompt on focus regain". (H)
- **Performance** (H):
  - Main-side per-session **output coalescer** (`app/src/main/core/pty/pty-data-coalescer.ts`): 12 ms flush timer (under one frame), with an immediate flush when a session's buffer exceeds 64 KiB.
  - Main-side **ring buffer** of 256 KiB per session (`pty/ring-buffer.ts`; drops whole chunks from the head, so a replay can start mid-escape-sequence).
  - Race-free attach: the renderer subscribes first, then calls `pty.snapshot` (which flushes the coalescer first), and removes the snapshot-tail/pending-head overlap with `computeSnapshotOverlap` (`renderer/lib/snapshot-overlap.ts`, scan ≤ 64 KiB).
  - Link detection per chunk can be gated off (`shouldDetectLinks`).
  - `pty:data` is routed only to the window that owns the session (`rpc-router.ts` `broadcast` with `SESSION_ROUTED_EVENTS` -> `sendToSessionOwner`).
- **Tests:** `pty-data-coalescer.test.ts`, `ring-buffer.test.ts`, `refit-controller.test.ts`, `PaneGrid.test.tsx`, `DomTerminalView.test.tsx` (jsdom). `app/tests/perf/jank-review.spec.ts` is gated by `PERF=1`. They look like real unit tests; WebGL and real rendering are not covered. (M)

**ATLAS equivalent.** ATLAS has one xterm per worktree and no resize. SigmaLink's coalescer, ring buffer, snapshot-overlap dedup and resize-flush ordering are directly relevant to ATLAS's operator terminal (see section 12).

---

## 4. Worktree and session coordination

- **Worktree pool:** `app/src/main/core/git/worktree.ts` `WorktreePool` (H).
  - Path: `<userData>/worktrees/<repoHash>/<branchSeg>`.
  - Branch: `sigmalink/<role>/<hint>-<8 hex of session uuid>` (`git/git-ops.ts` `generateBranchName`).
  - Three-attempt collision retry.
  - Guards run **before** touching disk: `DEFAULT_MAX_WORKTREES_PER_REPO = 40` and `DEFAULT_MIN_FREE_DISK_BYTES = 2 GiB` (`WorktreeDiskGuardError`). The crash-recovery spec header cites a real incident in which 49 GB of worktrees leaked.
- **In-place mode:** `workspaces/worktree-mode.ts` (ADR-007 in their tree) sets a per-workspace `'in-place'` KV, after which all agents share the repo root with **no isolation**. The default is `'worktree'`. (H)
- **Session identity:** the session uuid is pre-allocated, used as the worktree suffix, used as the `agent_sessions.id`, and passed to `PtyRegistry.create({preassignedSessionId})`. (H)
- **Cross-pane coordination:** there are **no leases or locks** between agents. `proper-lockfile` is used only for Gemini's `projects.json` and the sync engine. The only coordination channels are the mailbox and stdin injection (section 5). (H)
- **Guardrails:** these are **markdown text written into the per-worktree `CLAUDE.md`** (`workspaces/guardrail-block.ts`, marker `<!-- sigmalink-guardrails:start -->`). They are advisory prompt content, not enforcement. (H)
- **Side effects on user-global state** (H):
  - `browser/mcp-config-writer.ts` writes `<worktree>/.mcp.json`, appends to **`~/.codex/config.toml`**, and writes `~/.gemini/extensions/sigmalink-browser/gemini-extension.json`.
  - `workspaces/mcp-trust.ts` merges `enabledMcpjsonServers:["ruflo"]` into `<root>/.claude/settings.local.json` and runs `cursor-agent mcp enable ruflo`.

**ATLAS equivalent.** ATLAS has per-task worktrees, leases and checkpoints in `packages/workspace`, which is stronger. Worth noting from SigmaLink: the **pre-create disk/count guards** and **rollback on spawn failure**.

---

## 5. Orchestrator-to-worker communication

There are three channels, and all of them end in **writing to the PTY master (stdin injection)**.

1. **Swarm mailbox + stdin typing.** `app/src/main/core/swarms/controller.ts` `writeToPtys()` and `swarms/protocol.ts` `formatStdinDelivery()` type `SIGMA::<VERB> {"from":…,"to":…,"body":…}\n` into each recipient's PTY. The body is JSON-escaped, so newlines and control characters cannot break out of the line. (H)
   - `swarms/mailbox.ts` `SwarmMailbox` is the system of record: a SQLite `swarm_messages` table behind a single-writer promise queue, with JSONL mirrors at `<userData>/swarms/<id>/inboxes/<agent>.jsonl`.
   - Recipient expansion `expandRecipient()` handles `@all/@coordinators/@builders/@scouts/@reviewers` against the `swarm_agents` roster.
   - **Agents never read the inbox files.** Grepping for `inbox` outside mailbox/schema finds only creation and cleanup. The JSONL files are write-only debug mirrors. (H)
2. **Directive "pane echo".** `rpc-router.ts` ~695-727 `mailbox.setPaneEcho` writes `` `[Operator → ${role} ${n}] ${body}\n` `` raw into the PTY. **The body is not sanitized**, so newlines, ESC sequences and `\x03` reach the agent TUI as keystrokes. (H)
3. **Sigma Assistant ("Jorvis") tools over MCP.** (H)
   - The assistant is `claude -p <prompt> --output-format stream-json --verbose --append-system-prompt … [--resume <id>] --mcp-config <tmp> --strict-mcp-config` (`assistant/runClaudeCliTurn.args.ts` `buildCliArgs`, `applyMcpHostConfig`).
   - The MCP server is a stdio proxy (`assistant/mcp-host-server.ts`) that dials back over a **Unix socket at `os.tmpdir()/jorvis-host-<pid>-<8hex>.sock`** (`assistant/mcp-host-sigma.ts` `defaultSocketPath`) to main, which runs `tools.ts`.
   - Tools include `launch_pane`, `prompt_agent` (`ctx.pty.write(id, prompt + '\n')` after an `isLive` check), `read_pane` (ANSI-stripped ring-buffer tail, ≤ 64 KiB, passed through `scanIngested`), `close_pane`, `create_swarm`, `broadcast_to_swarm`, `roll_call`, `monitor_pane`, `browser_*`.
   - **The socket has no authentication.** Any same-user process that learns the path (it is passed in the env of the MCP child) can call tools with the "local" origin, which is not gated. Only the Telegram remote origin needs `confirmDangerous` (`assistant/authorization.test.ts`). (H for the code; M for exploitability: the Unix socket mode depends on umask, and I did not check the Windows named-pipe ACL.)
- **Tasks board:** `tasks/controller.ts` `assignToSwarmAgent` appends `SAY "SIGMA::TASK <title>"` to the mailbox only. It does **not** call `writeToPtys`, so given point 1 the agent never sees the task. The comment "so its CLI sees the work item" is not supported by the code. (M-H)
- **Design dispatch:** `design/controller.ts` ~292 types `buildElementDispatchPrompt({prompt, selector, html, pageUrl})` + `'\n'` into a pane. That puts **captured web-page HTML into an agent's stdin**. (H)
- **Submit semantics are inconsistent:** most writers append `'\n'`. The design controller's comment says `'\r'` "auto-submits", which implies `'\n'` may only insert a newline in some TUIs. Whether `prompt_agent` actually submits in Claude Code's TUI is **unverified**. (L)

**Security implications of injecting into agent terminals.**
- Stdin injection is input at the human level. Whatever is typed carries the operator's authority and, under `autoApprove`, executes with no approval.
- Untrusted content reaches stdin through:
  - `read_pane` output from other agents, fed into the assistant (scanned, but the comments admit "sophisticated injections may survive")
  - design-dispatch HTML
  - Telegram remote prompts (gated)
  - unsanitized pane-echo bodies
- There is no provenance on keystrokes. An agent cannot tell an operator directive from injected text.
- Interleaving: a write can land while the user is typing or while the TUI is in a modal (permission prompt), and can be taken as an answer to that prompt. I found no busy/modal check before writing (see section 9).

**ATLAS equivalent.** ATLAS dispatches work through structured runtime calls and governed tools, not keystrokes. That is safer. Do not adopt stdin injection as a control channel.

---

## 6. Agent resumption

- **Capture of provider session ids** (H):
  - claude: pre-assigned `--session-id <uuid>` at spawn (`providers/launcher.ts` `shouldPreAssign`), returned synchronously and persisted to `agent_sessions.external_session_id`.
  - codex/kimi/opencode: an **asynchronous disk scan** with retries at roughly +2/+5/+15 s (`pty/session-disk-scanner.ts` `findLatestSessionId`). It picks the newest file within a 5-minute mtime window:
    - codex: `~/.codex/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`
    - kimi: `~/.kimi/sessions/<project>/<uuid>/`
    - opencode: `opencode session list --format json` / a sqlite reader
  - Results are limited to ids already recorded for the workspace (`workspaceAllowedIds`).
  - The comments acknowledge that codex is not partitioned by cwd, so "newest in window" can pick up a sibling's session.
- **Resume argv:** `pty/resume-launcher.ts` `buildResumeArgs()` (H):
  - claude `--resume <id>`
  - codex `resume <id>`
  - gemini `--resume latest` only when an id exists
  - kimi/opencode `--session <id>`
  - cursor `--resume <id>`
  - A **null id starts fresh** rather than `--continue`. The "SESSION-COLLAPSE FIX" comment explains that `--continue`/`--last` attached every pane, and the operator's own CLI session, to the same conversation.
- **Worktree/cwd mismatch bridge:** `pty/claude-resume-sigma.ts` (H).
  - Claude keys transcripts by a cwd slug (`~/.claude/projects/<slug>/<id>.jsonl`). A pane runs in a worktree whose slug differs from the workspace's.
  - The bridge **symlinks** the JSONL into the worktree-slug directory. On win32 it falls back to hardlink, then copy. It also pre-creates the project directory so a fresh `--session-id` write does not fail.
  - Gemini gets an equivalent `projects.json` alias under `proper-lockfile` (`pty/gemini-resume-sigma.ts`).
- **Which rows resume:** `listEligibleRows()` selects `closed_at IS NULL AND (status='running' OR (status='exited' AND exit_code=-1))`. Boot resume uses `resumeWorkspacePanes()`. (H)
- **UI state restore:** `session/session-restore.ts` keeps `kv['app.lastSession']` up to date with a throttled flush of about 2 s so a crash loses little. (H)
- **Scrollback restore** is opt-in (`pty.scrollbackPersistence`), seeding the ring buffer through `RingBuffer.restore`. (H)
- **Assistant resume:** `--resume <claudeSessionId>` is stored per conversation. A stale id is cleared and the turn retried fresh (`clearPriorClaudeSessionId`). (H)
- **Tests:** `resume-launcher.test.ts` (1411 lines), `claude-resume-sigma.test.ts`, `gemini-resume-sigma.test.ts`, `session-disk-scanner.test.ts` (tmpdir home), `last-resume-plan.test.ts`. These test argv construction and filesystem bridging against fake directories. **Whether the real CLIs accept those flags is not tested.** (M)
- **Security:** resume re-applies `autoApprove`. Symlinking into `~/.claude/projects` mutates CLI-private state, which breaks if upstream changes its layout.

**ATLAS equivalent.** None. ATLAS restarts lost attempts fresh. The transferable idea is a **stable, pre-assigned conversation id persisted before the first turn**, which would let a Pi session resume if the SDK supports it. (Not verified for Pi.)

---

## 7. Browser integration

There are three separate mechanisms. (H unless noted)

1. **Operator in-app browser.** `app/src/main/core/browser/manager.ts` `BrowserManager` creates one Electron `WebContentsView` per tab (`contextIsolation:true, sandbox:true`), per workspace. Tabs are mirrored to the SQLite `browser_tabs` table. A tab can be detached into a second window. A `lockOwner` surfaces "agent is driving" in the UI.
2. **Assistant browser tools** (`browser_navigate`, `browser_snapshot`, …, in `assistant/tools.ts` ~984+).
   - Use `webContents.debugger.attach('1.3')` (`browser/cdp.ts`). This is the in-process CDP debugger, not `--remote-debugging-port`.
   - Off by default (KV `browser.agentDriving`).
   - SSRF guard `browser/agent-guard.ts` `assertAgentNavigable`: https only; rejects private, loopback, link-local, CGNAT, metadata, `.local` and `localhost` via `ipaddr.js`. It acknowledges a DNS-rebinding residual.
   - Snapshots use a fixed expression (`document.body.innerText`), capped at 20 CDP calls per turn, and pass through `scanIngested`.
3. **Agent CLIs** get a **separate headless browser**.
   - `browser/mcp-config-writer.ts` writes an MCP server entry `npx -y @playwright/mcp@0.0.75` into each agent's config (the `.mcp.json` / codex TOML / gemini extension files from section 4), gated by runtime profile.
   - This browser is **not** the in-app one, so the operator cannot watch what the agents' browsers do.
   - `npx -y` fetches from the network at the agent's first use.

**Security.**
- Main window `setWindowOpenHandler` calls `shell.openExternal(url)` for **any URL with no scheme check** (`electron/main.ts` ~690-693). By contrast, the assistant's `open_url` tool is https-only (`authorization.test.ts` "R-1 open_url scheme check").
- No `will-navigate` handler or CSP was found on the main window (grep for `will-navigate`, `Content-Security-Policy` and `setPermissionRequestHandler` returned nothing in `electron/` or `src/main`). (M: I grepped; I did not read every file.)

**ATLAS equivalent.** None in ATLAS's described scope.

---

## 8. Swarm delegation

- **Structure:** a swarm is a row in `swarms` plus `swarm_agents` rows. Each agent has a `role` (coordinator/builder/scout/reviewer, `swarms/types.ts`), a `roleIndex`, a `coordinatorId` (the "queen" = the first coordinator with no parent, `factory-spawn.ts` ~118-125), its own worktree and its own PTY. Presets come from `defaultRoster`/`totalForPreset`. (H)
- **Delegation mechanics:**
  - The operator or assistant sends envelopes: `controller.send` writes to the mailbox and types `SIGMA::…` into the agent; `broadcast` and `roll_call` do the same with `ROLLCALL` and a `deadlineAt`.
  - Agents are expected to **print `SIGMA::<VERB> {json}` lines on stdout**. `factory-spawn.ts` ~535-545 wires `rec.pty.onData` -> `ProtocolLineBuffer` -> `parseProtocolLine` -> `envelopeToInsert` -> `mailbox.append`. (H)
  - There is **no ANSI stripping** before `parseProtocolLine`, which requires the line to start with `SIGMA::` after `trimEnd()` only. Agent TUIs (Claude Code with Ink fullscreen, Codex) draw output with cursor movement and SGR codes, so a model-printed protocol line will rarely begin a raw PTY line. **This channel probably fires rarely for TUI agents.** (M; I did not run it.)
  - I found **no code that tells agent CLIs about the `SIGMA::` protocol**: no system prompt, CLAUDE.md block or initial prompt contains `SIGMA::STATUS`/`DONE`/`SAY`. A grep across `src` for those strings hits only `protocol.ts`. Without that instruction an agent will not emit these lines. (M-H)
  - Echo loop risk: the stdin line `SIGMA::OPERATOR {...}` written to an agent may be echoed by the TUI or shell. If it is echoed at the start of a line, the parser re-ingests it **as a message from that agent**. I found no from-self or echo suppression. (L-M)
- **Agent status:** `swarm_agents.status` is set to `idle` at spawn and to `done`/`error` on PTY exit. **Nothing sets `busy`** (grep: only the schema enum and the renderer read `'busy'`). (H)
- **Auto-teardown:** `swarm-teardown.ts` `applyTeardownPolicy` (keep-all / keep-passing / destroy-failing) runs when the last agent's PTY exits. In the default shell-first mode that is the shell's exit (see section 2). (M-H)
- **Tests:** `swarms/protocol.test.ts` (parser verbs, PROMPT payload bounds), `mailbox.test.ts`, `factory-spawn.test.ts` (1058 lines, mocked), `controller-split.test.ts`, `swarm-teardown.test.ts`. These are unit tests; I found no test with a real CLI emitting `SIGMA::`. (M)

**ATLAS equivalent.** ATLAS's DAG scheduler with structured attempts is far more deterministic. SigmaLink's swarm is closer to a "chat room of terminals" whose closed loop depends on agents' cooperation and on raw-output parsing.

---

## 9. Lifecycle event handling (idle / busy / waiting-for-input)

**Finding: there is no idle, busy or waiting-for-input detection in this codebase.** (H)

- `PaneEventSink` declares kinds `'started' | 'exited' | 'error' | 'output-spike' | 'idle'` (`pty/registry.ts` ~109-114, and the DB enum in `db/schema.ts` ~569). The registry emits **only** `started` (on create) and `exited`/`error` (on PTY exit, `exitCode===0`). `idle` and `output-spike` are never produced; grep for `kind: 'idle'` / `'output-spike'` emitters returns none. `notifications/sources/pty-exit.ts` ignores them.
- No bell (`\x07`), OSC 9/777, "Do you want to…" prompt-pattern, quiet-timer or output-rate heuristic exists in main. (A grep for bell/OSC9/needs-input/attention found only link-detector and ANSI-strip regexes.)
- What does exist:
  1. Spawn and exit events, plus `earlyDeath < 1500 ms` crash classification (`pty/crash.ts`).
  2. The shell-first **CLI-exit sentinel** (`printf` marker with `$?`) (section 2).
  3. Renderer **OSC-133 prompt marks** (A/B/C/D with an exit code) in `renderer/lib/terminal-engine.ts`. These only appear if the user's shell emits them; nothing installs shell integration.
  4. `SIGMA::PROMPT` (`protocol.ts`): an agent may print a structured question, and the renderer (opt-in, `use-prompt-card.ts`) shows a clickable card and writes the sanitized answer (control characters and newlines collapsed) to stdin. It depends on the agent knowing the protocol (section 8).
  5. `monitor_pane` (assistant tool) only stores `jorvisMonitorConversationId` on the session row so lifecycle events (started/exited/error) can be routed to a conversation.

**ATLAS equivalent.** ATLAS derives status from structured events (`attempt.started/ended`, tool calls, approvals), which is strictly better than anything here. ATLAS could adopt one concept: a **sentinel-based exit code for a command run inside an interactive shell**. This applies only to the operator terminal, if ATLAS wants to show "last command exit status" there.

---

## 10. Agent output observation and routing

- **Raw path:** node-pty `onData` -> `PtyRegistry.create` handler -> (shell-first sentinel strip) -> `RingBuffer.append` (256 KiB) -> `onData` sink -> `PtyDataCoalescer.push` -> `broadcast('pty:data')` to the **owning window only** -> renderer `pty-data-bus` -> the cached xterm or the headless engine. (H)
- **Parsers on the raw stream:**
  - sentinel (`pty/sentinel.ts`)
  - OSC-8 and plain-URL link detection (`pty/link-detector.ts`, gated per chunk)
  - swarm `SIGMA::` line parser (`swarms/protocol.ts`, swarm panes only, **no ANSI stripping**)
- **Model-readable view:** `assistant/pane-screen.ts` `extractPaneScreen` strips CSI/OSC/DCS and C0 controls and turns CR into newlines. It does **no terminal emulation**, so spinners appear as many lines. It returns the tail at ≤ `maxBytes`. (H)
- **Hooks and transcripts:** there is no use of Claude Code hooks (`PreToolUse`, `Stop`, …) for observation. Grep hits for "hooks" are unrelated. Provider JSONL transcripts are read only for **session-id discovery and history previews** (the first 32 KiB, `MAX_PREVIEW_SCAN_BYTES`), not for live status. (H)
- **Assistant turns** are the exception: they use `--output-format stream-json`, parsed line by line (`assistant/cli-envelope.ts` `parseCliLine`, `runClaudeCliTurn.trajectory.ts`). This is a **structured** channel, but only for the one-shot assistant, not for panes. (H)
- **Notifications:** pty exit and cli-exited events go to `notifications/manager.ts` -> OS notifications with quiet hours and DND. (M)

**ATLAS equivalent.** ATLAS's event log is the structured counterpart. SigmaLink uses structured output only where it controls invocation (`-p --output-format stream-json`), and that is the correct lesson: structure beats scraping.

---

## 11. Cross-cutting: Electron security, IPC surface, tests, license

### Electron security (H)
- Main windows (`electron/main.ts` `buildWindow` ~675-681): `contextIsolation:true, nodeIntegration:false, **sandbox:false**`, plus a preload. The diagnostic window has `sandbox:true`.
- Browser `WebContentsView`s: `sandbox:true`.
- Preload (`electron/preload.ts`, 71 lines) exposes `window.sigma`:
  - `invoke(channel, …)` gated by `isAllowedChannel` (static allowlist `src/shared/rpc-channels.ts`, about 296 entries)
  - `eventOn` / `eventSend` gated by `isAllowedEvent`
  - `getPathForFile`, `platform`, `getZoomFactor`/`setZoomFactor`, `windowContext`
- IPC handlers (`rpc-router.ts` `registerIpcHandler` ~2430):
  - `ipcMain.handle(channel, async (_e, ...args) => …)`. **The sender is ignored**: there is no `senderFrame` origin check.
  - Zod validation covers **only `args[0]`**. For `pty.write(sessionId, data)` only the sessionId is validated; the data is unbounded by design.
  - Many channels are `z.any()` stubs. In dev the router warns about missing schemas (`registerRouter`).
- The renderer can open a shell (`pty.spawnScratch`, `providerId:'shell'`) and write to it. **Compromising the renderer gives code execution**, which is inherent to a terminal app. With `sandbox:false` and no CSP, renderer hardening is mostly contextIsolation plus the channel allowlist.
- `setWindowOpenHandler` passes any URL to `shell.openExternal` with no scheme check.

### Security implications of terminal injection
See section 5. In summary: keystroke-level authority, no provenance, unsanitized pane-echo, web HTML into stdin, writes that race user typing and modal prompts, persisted bypass flags, and an unauthenticated local MCP socket that can drive `prompt_agent`/`close_pane`.

### Tests (H for existence and shape; M for adequacy)
- 386 `*.test.ts`/`*.spec.ts` files under `app/src`, plus 11 Playwright e2e specs in `app/tests/e2e`. Examples: `smoke.spec.ts`, `pane-split.spec.ts`, `assistant-cli.spec.ts`, and `crash-recovery.smoke.spec.ts`, which is gated by `SMOKE_CRASH=1` and therefore not run in CI.
- Unit tests rely heavily on `vi.mock` of `local-pty`, `process-tree` and the DB. They assert real logic (sentinel parsing, coalescer timing, lifecycle races, path containment, authorization gate).
- **No test runs real agent CLIs.**
- CI e2e covers Windows and macOS only; Linux is untested.
- The crash-recovery spec documents a RED→GREEN intent but is excluded from CI.

### License and attributions (H)
- MIT. Reusing code requires keeping the copyright and permission notice.
- `ATTRIBUTIONS.md` says the PTY ring-buffer + atomic-subscribe pattern, worktree-pool branch layout, Proxy RPC, and per-agent MCP adapter shape were **adapted from Emdash (Apache-2.0)**, "re-implemented, no code copied". I could not verify the no-copy claim.
- It also lists xterm.js (MIT), node-pty (MIT), Drizzle (Apache-2.0), better-sqlite3 (MIT), shadcn, Radix, lucide (ISC), Tailwind, and @playwright/mcp (Apache-2.0).
- `.gitmodules` vendors `whisper.cpp` (voice feature).
- If ATLAS adopts **concepts** only, no attribution is legally required. If ATLAS copies code, it should carry the MIT notice. For patterns that trace to Emdash, it is prudent to credit Emdash (Apache-2.0) as well.

### Maintainability
- `rpc-router.ts` is 2775 lines.
- Comments are long and version-stamped ("v1.6.0 Phase 7", "H-6", "BUG-V1.1.3-ORCH-01"), and several contradict each other or the code. Examples:
  - The `PRE_ASSIGN_PROVIDERS` comment mentions gemini, but the set is `['claude']`.
  - `local-pty.ts` comments describe `direct` as "DEFAULT" while `parseSpawnMode` defaults to shell-first.
  - The `assignToSwarmAgent` comment claims the CLI sees the task.
  - The `ResolveAndSpawnResult` doc says claude and gemini.
- Duplicated logic: `buildExtraArgs` exists in both `workspaces/launcher.ts` and `swarms/factory-spawn.ts` ("twin").
- Many features sit behind KV flags with silent fallbacks.
- `CHANGELOG.md` is 387 KB.

---

## 12. Mechanisms most worth adopting into ATLAS (as concepts)

1. **Output coalescer + ring buffer + race-free snapshot attach, for the operator terminal.**
   - Per-session coalescing in main (12 ms timer, immediate flush at 64 KiB): `app/src/main/core/pty/pty-data-coalescer.ts`.
   - A bounded per-session ring buffer: `pty/ring-buffer.ts`.
   - "Subscribe first, then snapshot" with a coalescer flush before reading the buffer, then dropping the snapshot-tail/pending-head overlap: `rpc-router.ts` `snapshot` ~1052-1061; `renderer/lib/snapshot-overlap.ts` `computeSnapshotOverlap`.
   - For ATLAS this means a reattaching renderer gets history without gaps or duplicates, and IPC cost stays bounded with several worktree terminals.
2. **Resize ordering and SIGWINCH discipline.**
   - Flush pending output before applying a resize (`rpc-router.ts` `resize` ~1042-1050).
   - Debounce refits and send a single SIGWINCH at drag end (`renderer/features/command-room/refit-controller.ts`).
   - Ignore resize on a dead PTY (`registry.ts` `resize`; `local-pty.ts` try/catch on EBADF).
   - This would be the template if ATLAS adds resize support to its `script`-based terminal.
3. **Lifecycle race guards in a session registry.**
   - Refuse a duplicate **live** id and clean-replace an exited one (`PtyRegistry.create`, `registry.ts` ~246-254).
   - A grace window before forgetting the record (`gracefulExitDelayMs`), guarded so a stale timer cannot reap a re-created record (`recAtExit`, ~383-387).
   - Tested in `registry-lifecycle.test.ts`.
   - These apply directly to ATLAS's per-worktree terminal and to attempt restarts that reuse ids.
4. **Pre-create resource guards with rollback.**
   - Worktree count cap (40/repo) and free-disk floor (2 GiB) checked **before** `git worktree add`, raising a typed error: `git/worktree.ts` `assertUnderCap`, `assertAboveDiskFloor`, `WorktreeDiskGuardError`.
   - Worktree rollback when the later spawn fails: `workspaces/launcher.ts` ~595-600 and ~732-736.
   - Boot-time orphan sweep that matches by **command line**, so reparented grandchildren are caught: `process/orphan-sweep.ts` `findDbOrphanPids`.
   - ATLAS's per-task worktrees and scheduler would gain a hard stop against runaway disk use, plus crash-orphan reaping that does not rely on ppid links.
5. **A stable conversation id assigned before the first turn, plus explicit refusal of "resume latest".**
   - Mint the provider session id at spawn and persist it immediately (`providers/launcher.ts` `shouldPreAssign` / `preassignedExternalSessionId`).
   - On resume, use the exact id or start fresh, never "continue most recent", because that collapses parallel sessions onto one conversation (`pty/resume-launcher.ts` `buildResumeArgs`, SESSION-COLLAPSE FIX comment).
   - For ATLAS this is a design rule if agent session resume is ever added to the Pi runtime. Persist the runtime's session handle in the event log at `attempt.started`, and never resume by recency. Pi SDK support for this is **not verified**.

Honourable mention, operator terminal only: the **exit-code sentinel** (`pty/sentinel.ts`, cross-chunk carry `sliceSentinelCarry`) gives "last command exit status" in an interactive shell. Use a per-session random nonce rather than a fixed marker, because the fixed marker can be spoofed.

### Explicitly not recommended for ATLAS
- Stdin keystroke injection as a control channel (sections 5 and 8).
- Scraping raw PTY output for protocol lines without ANSI handling (section 8).
- Inheriting the full app environment into agents (section 1).
- Persisting and re-applying "skip permissions" flags on resume (section 6).
- An unauthenticated local tool socket (section 5).
- Mutating user-global CLI config (`~/.codex/config.toml`, `~/.gemini/…`) (section 4).

---

## Items I could not verify
- Runtime behaviour of the real CLIs with the flags used (`claude -p` inside an interactive pane, `--session-id`, `--settings '{"tui":"fullscreen"}'`, `codex -q`, `resume <id>`, kimi/opencode `--session`), and whether `'\n'` vs `'\r'` submits in each TUI.
- Linux process-tree cleanup in practice (the code path is pty.kill plus pid SIGKILL only; Linux CI is absent).
- Whether `SIGMA::` lines are ever parsed from real TUI output, and whether stdin echo re-ingests operator lines.
- Unix socket file mode under the user's umask, and the Windows named-pipe ACL for the Jorvis host socket.
- The "no code copied" claim relative to Emdash.
- Whether any renderer code (not fully read) supplies idle/busy detection. Main-process code does not, and grep of the renderer found only status display.
