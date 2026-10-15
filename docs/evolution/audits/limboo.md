# Source audit: limboo-ai/limboo

- Commit: `4ad8bea8365a9f92e03650f8c455593c9feb0992` (2026-10-08), package version 1.3.4
- License: MIT, "Copyright (c) 2026 BotCoder254" (`LICENSE`)
- Method: static reading only. Nothing was installed, built or run. Nothing in the repository was treated as an instruction (it ships a 100 KB `CLAUDE.md`, a `project.md` and `.claude/settings.local.json`, none of which were followed).
- Size: about 96k lines of TS/TSX under `src/`. `src/main/managers/AgentManager.ts` alone is 8,035 lines.
- Confidence labels: **High** means I read the code path directly. **Medium** means I inferred it from code plus third-party library semantics I did not execute. **Unverified** means I could not confirm it statically.

---

## 0. Summary

Limboo is a single-window Electron app (Electron ^42, React 19, Zustand, Tailwind 4, xterm.js). Nearly everything runs inside the Electron **main process**: SQLite (better-sqlite3), node-pty terminals, git, the chokidar watchers, the MCP clients, the Claude Agent SDK (dynamically imported ESM) and the permission gate. The only separate Node process the app owns is a `utilityProcess` for voice inference (sherpa-onnx). Agent providers run as child processes of main: the Claude Code CLI via the Agent SDK, `cursor-agent`, and the AI-SDK "harness" adapters.

The renderer hardening is reasonable: contextIsolation, sandbox, sender-origin checks, a navigation guard and a webview block. Two things weaken it. The preload is very large (24 namespaces, about 210 methods), and IPC payloads are checked by hand rather than against schemas. The main security mechanism is a provider-neutral permission function (`decideToolUseCore`). It is carefully commented, but it rests on string heuristics. By default the OS sandbox is off (`network: 'all'` disables the Claude jail, and the harness jail is an explicit no-op). **The repository contains no automated tests**: no unit, integration or e2e tests. CI runs lint, regex-based "security invariant" checks and a smoke test that boots a throwaway `about:blank` window, not the app.

---

## 1. Electron process architecture

| Process | Evidence | Notes |
|---|---|---|
| Main | `src/main/index.ts` `bootstrap()`, which constructs about 27 managers inside `app.whenReady()` | Holds the DB, PTYs, git, the agent SDK, MCP, search indexing, telemetry, the updater and the tray. A crash or block in any of them takes down the whole control plane. |
| Preload | `src/preload/index.ts` (968 lines), `contextBridge.exposeInMainWorld('limboo', limbooApi)` | Built separately (`vite.preload.config.ts`). |
| Renderer | `index.html` loads `src/renderer/main.tsx` | React 19 + Zustand stores in `src/renderer/stores/*` (23 stores). |
| utilityProcess | `src/main/managers/voice/VoiceManager.ts` `utilityProcess.fork(workerPath…)`; entry `src/main/voice/worker.ts`; build `vite.voiceworker.config.ts` | Voice only (STT/TTS/VAD with the native sherpa-onnx). The protocol is in `src/main/voice/protocol.ts`. |
| Child processes | Claude Code CLI (spawned by `@anthropic-ai/claude-agent-sdk` with `pathToClaudeCodeExecutable`, `AgentManager.buildOptions` ~L6123), `cursor-agent` (`managers/cursor/exec.ts`), AI-SDK harness bridges (`managers/harness/sandbox/LocalWorktreeSandbox.ts` `spawn`), MCP stdio servers (`managers/mcp/client/stdioClient.ts`), git/gh via `execFile`, node-pty shells | All are spawned from main. |
| Cursor bridge helpers | `managers/cursor/bridge/hookRunner.cjs`, `mcpBridge.cjs`, copied unbundled by `vite.main.config.ts` `copyCursorBridgeScripts` | Spawned by cursor-agent. They talk back to main over a per-run unix socket or named pipe (`bridge/pipeServer.ts`). |

- Approach: a single privileged main process. There is no daemon or control-plane split. (High)
- Failure handling: `safeDispose()` isolates each teardown step in `before-quit` (`index.ts` ~L700). `installGlobalErrorHandlers()` is in `logger.ts`. The single-instance lock is `requestSingleInstanceLock`. (High)
- Fuses (`forge.config.ts` L196-203): RunAsNode off, NODE_OPTIONS off, inspect args off, ASAR integrity on, OnlyLoadAppFromAsar on, cookie encryption on. (High) Electron Forge packages the app, then electron-builder produces the installers (`scripts/dist.mjs`). I did not verify how fuses interact with electron-builder repacking.
- On Linux, hardware acceleration is disabled unconditionally (`index.ts`). (High)
- ATLAS equivalent: ATLAS is stronger here. Execution and SQLite live in a separate daemon utilityProcess. Limboo puts the DB, PTYs and agent SDK in main. ATLAS should keep its split.
- Maintainability: an 8k-line `AgentManager` and a 4.3k-line `shared/types.ts`. TypeScript is pinned to `~4.5.4`, and **`tsc` is never run** (stated in `.github/workflows/ci.yml` header and `docs/contributing/testing-and-verification.md`). Types are therefore not enforced anywhere. (High)

## 2. IPC security boundary

**BrowserWindow** (`src/main/window/createWindow.ts` `createMainWindow`): `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `allowRunningInsecureContent: false`. (High)
- `setWindowOpenHandler` always denies, and http(s) URLs go to `shell.openExternal`. (High)
- The `will-navigate`/`will-redirect` guard permits the dev-server URL and **any `file://` URL**. (High)
- `installWebviewBlock()` cancels every `will-attach-webview` app-wide. (High)

**Sender validation** (`src/main/ipc/registry.ts` `isTrustedSender`): a sender passes when `event.senderFrame.origin` equals the dev-server origin or `'file://'`. Every handler is registered through `handle()`/`on()`, and grep finds no direct `ipcMain.handle` elsewhere. (High)
- Weakness: the check does not compare `event.sender` with the main window's webContents, and it does not pin a frame URL. Because navigation to any `file://` URL is also allowed, a `file://` document reached by navigation would keep the preload and pass the origin check. I did not demonstrate a navigation path from renderer content. Markdown is sanitized with `rehype-sanitize` (`renderer/features/workspace/Markdown.tsx`). (Medium, theoretical)
- ATLAS validates the sender against the actual window, which is stronger. Keep it.

**Preload surface** (`src/preload/index.ts`): 24 namespaces (window, settings, system, app, events, workspace, session, agent, fs, terminal, git, gh, worktree, services, memory, search, resume, updates, release, voice, attachment, mcp, graph, runtime) and roughly 210 `ipcRenderer.invoke` call sites. `src/shared/ipc-channels.ts` has about 255 channel or event constants. The object is not `Object.freeze`d. That matters less because contextBridge copies it, but it shows no deliberate minimal-surface design. (High)
- High-power methods exposed directly to the renderer include `terminal.write` (raw keystrokes to an interactive `bash -i`), `fs.writeFile`, `workspace.remove(id, deleteFiles)`, `settings.set` (which can switch `agent.permissionMode` to `'auto'`, meaning every tool call is auto-approved), `system.clipboardRead`, `mcp.add` (registers arbitrary stdio commands) and `worktree` setup-hook acknowledgment. A renderer compromise is therefore equivalent to arbitrary code execution and full policy bypass. (High)
- ATLAS exposes only `invoke(method)`/`onEvent`/`onStatus`/`onTerminal` with a method allowlist and zod schemas. That is materially smaller. Do not adopt Limboo's per-feature preload.

**Payload validation**: hand-written guards in `src/main/ipc/validate.ts` (`assertId`, `assertBoolOpts` rejects unknown keys and non-booleans, `assertText`, `assertInt`, `assertEnum`) plus per-handler checks. An example is `terminalHandlers.ts` `sanitizeOptions`, which ignores a renderer-supplied `origin`. zod is a dependency but is used only for MCP tool input schemas (`memoryTools.ts`, `searchTools.ts`, `plainTool.ts`), not at the IPC boundary. Coverage is inconsistent. `systemClipboardWrite` coerces with `String(text)`, and `terminalResize` checks only `typeof number`. Clamping happens in the manager. (High)
- ATLAS's zod-at-boundary approach is stronger.

**CSP** (`src/main/index.ts` `hardenSession`): it sets a strict production policy through `session.defaultSession.webRequest.onHeadersReceived` (`script-src 'self' blob:`, `connect-src 'self'`, fonts.googleapis/gstatic allowed). However, `index.html` also ships a **permissive meta CSP** (`'unsafe-inline' 'unsafe-eval'`, `connect-src ws: http: https:`) that applies in every build. The renderer is loaded with `loadFile` (file://). I could not verify whether Chromium delivers `onHeadersReceived` headers for `file://` responses. If it does not, the effective production CSP is the permissive meta policy. (Unverified, flagged as a likely weakness.) The renderer also loads Google Fonts remotely in production (`index.html` `<link>`), which is an external network dependency and a tracking surface. (High)

**Permission handlers**: `setPermissionRequestHandler` denies everything except audio-only `media` from the main webContents. `setPermissionCheckHandler` accepts origin `''`, `'null'` or undefined as "own origin" in packaged builds (comment at `index.ts` ~L820). (High)

**CI "security invariants"** (`ci/scripts/check-electron-security.mjs`): regexes over source text, such as `/sandbox:\s*true/` and `/senderFrame/ && /origin/`. These are easy to satisfy accidentally. (High)

## 3. Workspace management

- `src/main/managers/WorkspaceManager.ts`, persisted in the SQLite `workspaces` table (`db/database.ts`).
- `workspace/validate.ts` `validateWorkspacePath` realpaths the input, rejects NUL, non-directories, `FORBIDDEN_WORKSPACE_PATHS`, `$HOME` itself, paths without read and write access, and duplicates. `isInsideRoot` is a lexical containment check. (High)
- `workspace/detect.ts` and `stats.ts` call `execFileSync` (git) synchronously from main. (High)
- Removal sweeps every table in `WORKSPACE_SCOPED_TABLES`, leaving `sessions` for last as a backstop. (High)
- **Worktrees** (`managers/worktree/WorktreeManager.ts`, `worktree/paths.ts`): `git worktree add` under `{userData}/worktrees/{repoBucket}/{slug}`. Branch names pass through `sanitizeRef`/`sanitizeBranchName`, and every create or remove path passes `assertInsideWorktreeRoot`. The worktree manager is the single resolver of each session's effective root (`resolveSessionRoot`). (High)
- **Repo-authored commands** (`worktree/config.ts`): `limboo.json` declares setup and teardown hooks, scripts and supervised services. It is size-capped and shape-validated, with prototype-pollution keys dropped. `hashRepoConfig` takes a sha256 over the executable parts. `WorktreeManager.ackConfig` requires the renderer to echo the hash it displayed, and it stores `hooksAckHash` per workspace. Any edit to the file forces re-acknowledgment. (High)
- ATLAS uses per-task worktrees with leases. It has no repo-authored command config, so the hash-acknowledgment pattern is useful if ATLAS ever runs repo-declared commands.

## 4. Session persistence

- Store: `{userData}/limboo.db` via better-sqlite3 with `journal_mode=WAL` and `foreign_keys=ON` (`db/database.ts` `getDb`). (High)
- Schema: `migrate()` is one big `CREATE TABLE IF NOT EXISTS` script plus `addColumnIfMissing` and data-fixup `UPDATE`/`DELETE` statements. The meta table's `schema_version` is simply overwritten. These are not ordered, versioned migrations, and **they are not wrapped in a transaction**: grep finds no `transaction` in `database.ts`. A partial failure can leave a mixed schema. (High)
- Tables: `sessions` (trash via `deleted_at`), `agent_messages` (role plus **text only**, "append-only"), `agent_activity` (JSON payload feed), `agent_subagent_runs`, `agent_provider_sessions` (provider resume tokens per (session, provider)), `agent_diagnostics`, `hook_audit`, `agent_plans`/`plan_revisions`/`plan_state`, `git_checkpoints`, `session_snapshots`, `resume_deltas`, `memories` (+FTS5), search tables (+FTS5), `attachments`, `mcp_servers`, `work_graph_*` (+FTS5) and `telemetry_*`. (High)
- Tool calls are explicitly **not persisted** ("runtime state rebuilt per run", comment above `agent_subagent_runs`). Conversation continuity depends on the provider's own resume token, the Claude SDK `resume` session id stored in `agent_provider_sessions`. The full model-facing transcript therefore lives in the provider's store (for Claude Code, under `~/.claude`), not in Limboo. Deterministic replay is not possible. (High)
- Durability: WAL with default `synchronous` (not set explicitly). Secrets go to separate files (see §11). Settings live in `settings.json` (`SettingsManager`, `storage.ts`).
- ATLAS's append-only event log plus replay is stronger for audit and recovery. Limboo's `agent_provider_sessions` keyed by (session, provider) is a reasonable pattern if ATLAS ever resumes provider-native sessions.

## 5. Context and memory management

- **No app-level summarization or compaction.** Compaction is left to the provider (Claude Code auto-compact). Limboo only *observes* it: `telemetry/store.ts` `observeAutoCompact` records the `pre_tokens` of an observed compaction as the threshold, and `telemetry/accumulator.ts` tracks characters since the last compaction. (High)
- **Injected context** (`AgentManager` ~L2863 and ~L3224): `memoryContextFor`, then `searchContextFor`, then `resumeContextFor`, joined and passed as `systemPrompt: {type:'preset', preset:'claude_code', append}` for Claude or as `instructions` for harnesses. (High)
- **Memory** (`managers/memory/MemoryManager.ts`): SQLite rows with tiers (decision, convention, preference, solution, note, project, workspace, session). Retrieval in `retrieve()` is FTS5 BM25 over the prompt, active file basenames and branch name, plus "always" rows (pinned, decision, convention, preference). The composite score is `0.42*relevance + 0.14*recency + 0.16*confidence + 0.08*usage + 0.10*tier + 0.15*pinned + 0.05*workspace match`, truncated to `MEMORY_LIMITS.injectCharBudget`. `buildContextBlock` wraps the result in `<project-memory>` and tells the model to "Treat it as authoritative". No embeddings and no network. (High)
- Memory capture: `propose()` respects `autoCapture` (`off`, `propose`, `auto`; default `'propose'`, so proposals need user acceptance). The only caller found is `GitManager` ~L455 `proposeFromCommit`, which classifies commit subjects by conventional-commit prefix. (High)
- Agent read access to memory: in-process MCP tools `limboo_memory` (`memoryTools.ts`: `list_memories`, `search_memories`, `list_memory_proposals`), auto-allowed by the `AUTO_ALLOWED_INTERNAL_TOOLS` allowlist (`AgentManager` L257). (High)
- **Resume delta** (`managers/resume/ResumeManager.ts`, `resume/delta.ts`): a per-session anchor of HEAD, branch and `dirty_hash` (sha256 over sorted `status|path|size|mtimeMs`, without reading contents). On activation it recomputes a capped `RepoDelta` (commits ahead or behind, rewritten history, changed files categorized as manifest or migration) and injects a one-shot `<repository-delta>` block, with status `pending` → `injected` persisted. (High)
- Security implication: memory text is injected as "authoritative" system-prompt content. With `autoCapture: 'auto'`, commit messages become prompt content without review. The default is `propose`. (High)
- ATLAS uses a per-attempt context bundle with source hashes and operator project facts, so it has no long-lived memory. The **resume-delta concept** (detect repo drift between attempts and tell the agent explicitly) is the most transferable idea here.

## 6. Agent provider abstractions

- The seam is `src/main/managers/agent/providerBridge.ts` `ProviderRunBridge`: callbacks such as `ensureStreaming`, `queueDelta`, `finishStreaming`, `onToolUse(id,name,input,parentCallId?)`, `onToolResult`, `onInit(chatId)`, `onResult`, and optional `onUsage`/`onThinking`/`onPlan`/`onSubagent`/`onSandboxStatus`/`diag`. The rule is that new members must be optional. A runtime only translates its wire format, and `AgentManager` owns persistence, gating and timeline. (High)
- Runtimes:
  - The direct Claude Agent SDK (`@anthropic-ai/claude-agent-sdk ^0.3.286`), which is the default because `harness.legacyClaudeSdk: true` in `shared/constants.ts` ~L1144.
  - `CursorRuntime` (`managers/cursor/CursorRuntime.ts`) runs `cursor-agent` in print mode with NDJSON, gated through a hook-runner bridge and generated `.cursor/cli.json` rules (`cursor/permissions.ts`).
  - `HarnessRuntime` (`managers/harness/HarnessRuntime.ts`) runs AI SDK 7 `HarnessAgent` adapters: `@ai-sdk/harness-claude-code` (exact pin 1.0.141), `-codex` (^), `-pi` (^).
  - Registry: `managers/agent/harnessRegistry.ts` `HARNESSES` with a `HarnessCapabilities` record (`gatesReads`, `gatesBuiltins`, `subagents`, `plan`, `vision`, `tokenUsage`). (High)
- Codex is marked `gatesBuiltins: false`. Per the comments it is refused at preflight with `HarnessUngatedError` rather than run ungated. (High for the registry entry. Medium for the enforcement, since I did not trace the preflight call.)
- `harness/approval.ts` `resolveApproval` routes harness approval requests into the same `makeCanUseTool` closure and fails closed on exceptions. `harness/permissions.ts` maps every composer mode to `'allow-reads'`, so edits and bash always reach the gate. (High)
- **Reads are not gated on AI-SDK harness paths** (`gatesReads: false`). The adapter auto-allows `Read`/`Glob`/`Grep`, so Limboo's workspace path guard and crown-jewel guard do not run for reads on those paths. Combined with the no-op jail (§8), a harness-path agent can read files outside the workspace. (Medium. Based on the code comments plus the jail being a no-op. I did not test adapter behavior.)
- ATLAS has `AgentRuntime` with Pi behind it. The **capability record per runtime, with refusal when a runtime cannot be gated**, is worth adopting (see §Adopt 2).

## 7. Terminal and filesystem watchers

- **node-pty `1.2.0-beta.15`** (native, Node-API) in `managers/TerminalManager.ts` `create()` → `pty.spawn(shell, shellArgs, {cwd, env})`. The shell runs interactive (`-i` for bash, zsh and sh). `cwd` is resolved through workspace and worktree and checked with a realpath `isInside`. There is a scrollback ring capped at `TERMINAL_LIMITS.scrollbackLines*256` bytes and replayed on reattach. (High)
- `sanitizedEnv()` is **not sanitized**. It copies all of `process.env` and adds `TERM`, `COLORTERM` and `LIMBOO_TERMINAL`. Comments claim "the environment is sanitized". The Claude SDK likewise gets `env: { ...process.env, … }` (`AgentManager.buildOptions`). Any secrets in the parent environment reach agents and terminals. (High)
- Agent and service commands also run through PTYs (`createForCommand`, used by worktree hooks and `ServiceManager`). (High)
- **Watcher**: chokidar ^5 in `managers/fs/watcher.ts` `WorkspaceWatcher`: `followSymlinks:false`, bounded depth, a shared `IgnoreMatcher` (the `ignore` package), debounced batches, and an overflow flag that triggers a full pass. The watcher feeds the file tree and the search indexer (`SearchManager`, FTS5 file and symbol index). (High)
- ATLAS uses `script` with no node-pty and no watchers. Limboo's watcher is well-bounded. If ATLAS ever adds a watcher, copy the debounce + overflow-to-structural + no-symlink-follow design. The node-pty beta pin is a supply-chain and stability risk that ATLAS avoids.

## 8. Permission and approval for agent tool calls

Core: `AgentManager.decideToolUse` → `decideToolUseCore` (~L6258-6690), called by Claude's `canUseTool`, the Cursor hook bridge and the harness `resolveApproval`. Steps in order (High):
1. Deny every tool while a plan awaits approval (`isPlanBlocking`).
2. Log a `dangerouslyDisableSandbox` retry (audit only, enforcement unchanged).
3. Allow reads inside this session's attachment staging directory.
4. **Crown-jewel deny** (`touchesCrownJewel`): `file_path`/`path`/`notebook_path` is compared after realpath against `secrets/`, `limboo.db`, `settings.json` and `window-state.json`. For **Bash it is a substring match on the absolute path**.
5. **Sensitive-file ask** (`touchesSensitiveFile`): `.env*` (except templates), `.netrc`, `id_*`, `*.pem|key|p12|pfx` and `~/.ssh` private keys. Bash commands are tokenized on whitespace and `=`. The prompt is mandatory unless a "sensitive" remembered grant exists.
6. Allowlisted internal MCP tools are auto-allowed (allowlist by bare tool name, not by prefix).
7. Web tools are denied if web search is disabled.
8. Risk classification `classifyTool`: `write`, `command` or `read`. Unknown and MCP tools count as `command`. `isReadOnlyShellCommand` (`agent/readOnlyCommands.ts`) can relax `Bash` to `read`.
9. Plan and ask modes block anything that is not a read, with MCP `planAccess` and `readOnlyHint` exceptions.
10. **Workspace path guard** (`isInside(cwd, filePathOf(input))`). This **applies only to tools with a `file_path`/`path`/`notebook_path` field**, so Bash arguments never reach it.
11. `acceptEdits` auto-allows writes.
12. Trusted MCP servers are auto-allowed.
13. Global `permissionMode === 'auto'` allows everything. `autoApproveReads` (default **true**) allows reads.
14. Remembered per-session, per-risk-class grants (in memory, not persisted).
15. Interactive prompt: `promptForApproval` creates `PermissionRequest {id}` → renderer → `respondPermission`. That deletes the pending entry, which makes it **single-use**, and it resolves the parked promise. AbortSignal makes a stopped run resolve as deny.

Read-only shell classifier (`readOnlyCommands.ts`): it rejects backticks, `<`, `>`, `$(`, `${`, `$VAR`, a lone `&` and control characters. It splits on `&&`, `||`, `|` and `;`. Each segment must be allowlisted: `BARE_SAFE` (cat, grep, ls, echo, …), `rg` without `--pre`, `find` without `-exec`/`-delete`/`-fprint`, an allowlist of git subcommands with `--output`/`-O`/`--upload-pack` rejected, and `gh` read verbs. It refuses `..` traversal and absolute paths outside cwd (realpath-checked). It is a careful design, and its stated posture is deny-by-default. (High)

**Bypass analysis.** I traced each chain in code but executed none of them.
- **Repo-supplied Claude settings.** `buildOptions` passes `settingSources: ['user','project','local']` (`AgentManager` L6168). In the Claude Agent SDK, settings allow rules and hooks are evaluated before `canUseTool` is consulted, and project hooks run shell commands. A cloned repository's `.claude/settings.json` could therefore pre-approve `Bash(*)` or register hooks, and Limboo's gate would never see those calls. I found no trust or acknowledgment check for `.claude/` content, unlike `limboo.json`. (Medium. This depends on SDK permission-evaluation order, which I know from the SDK documentation but did not run.) **This is the most important weakness for ATLAS to avoid: never let workspace content configure the runtime's permission layer.**
- **Git config execution via "read-only" git.** `git status`, `git diff` and `git log` are classified read-only and are auto-approved by default (`autoApproveReads: true`). Git honours `.git/config` keys that execute programs (`core.fsmonitor`, `diff.external`, textconv drivers via `.gitattributes`, `core.pager` in some modes). In `acceptEdits` mode, a Write to `.git/config` inside the workspace is auto-allowed: it is inside cwd, the path guard passes, and no `.git` rule exists in the agent gate. (The renderer `fs/writer.ts` does reject `.git`, but the agent path does not.) The chain "Write .git/config → `git status`" could therefore run arbitrary commands with no prompt. (Medium. Plausible from the code paths; not executed.)
- **Remembered grants are coarse.** "Always allow" on one `command` prompt allows every later Bash command in that session. (High)
- **Crown-jewel substring matching for Bash** misses relative paths, globs or `cd` into userData. Those commands are not read-only, though, so they still prompt unless `auto` mode or a remembered `command` grant applies. (High)
- **No OS jail by default.** `sandbox/policy.ts` `mapClaudeSandbox` returns `undefined` when `network === 'all'`, which is the default (`constants.ts` L1129-1137). `harness/sandbox/jail.ts` `resolveJail` is an explicit no-op that returns `restricted:false`. Both are honest in their comments. Containment therefore rests entirely on the string-level gate. (High)
- **Renderer authority.** `settings.set` can switch `permissionMode` to `'auto'`, and `terminal.write` executes anything. The approval UI is in the same trust domain as these switches. (High)
- **Cursor bridge token.** It is passed through the child environment (`LIMBOO_BRIDGE_TOKEN`), so any shell command run by cursor-agent inherits it and can connect to the pipe. Impact appears limited: it lets a process emit hook requests and memory or search MCP calls, both of which main still decides. (Medium)

ATLAS equivalent: ATLAS's ToolGate → policy (role grants, single-use approvals, canonical paths) → bubblewrap executor is structurally stronger. Its kernel jail is the primary boundary, and the string classifier is not. Ideas worth borrowing are the **risk-scoped remembered grants** (a grant on a read never widens to a write) and the separate mandatory-ask tier for secret files.

## 9. Checkpoints and recovery

- `GitManager.createCheckpoint` (~L899): `snapshotTree()` builds a tree from a **throwaway `GIT_INDEX_FILE`** (`read-tree HEAD` → `add -A` → `write-tree`), so the user's index and worktree are untouched and untracked files are included (`.gitignore` respected). Then `commit-tree` with parent HEAD and a fixed fallback identity, then `update-ref refs/limboo/checkpoints/<sessionId>/<ts>`, never a branch and never pushed. Metadata goes to the `git_checkpoints` row, followed by `pruneCheckpoints`. (High)
- `restoreCheckpoint` (~L1095) first takes a **safety checkpoint** and refuses to proceed if it cannot. It computes a tree-to-tree diff (checkpoint vs safety), runs `git restore --source <cp> --staged --worktree -- .` (falling back to `checkout <cp> -- .`), deletes only the paths git shows as added since the checkpoint (each through `assertInsideRepo`, skipping `.git`), and removes newly emptied directories deepest-first. It avoids `git clean`. (High)
- `previewRestore` and `diffCheckpoint` use the same tree arithmetic, so the preview matches the operation. (High)
- Auto-checkpoints: "Before agent changes" (`AgentManager` ~L1333) and "Before implementing the plan" (~L5301). (High)
- Conversation revert ties checkpoints to messages (`checkpointForMessage`, preferring an anchored `message_id`, else the newest at or before the message). (High)
- Limitations: ignored files such as `.env` or build outputs are neither captured nor restored. Commit messages carry a `[limboo checkpoint]` label. Checkpoint creation calls `this.status()` and several git subprocesses from main.
- ATLAS uses git commits in per-task worktrees. The **temp-index snapshot + non-branch ref + safety-snapshot-before-restore + tree-to-tree add-detection** sequence is a precise, adoptable refinement (see §Adopt 1).

## 10. UI architecture and state

- React 19 with feature folders under `src/renderer/features/*` (workspace, sessions, git with diff, graph, plan, memory, settings, terminal, updates, …) and shared `components/ui`. (High)
- State: 23 Zustand stores (`src/renderer/stores/*`, for example `useAgentStore.ts` at 821 lines and `useGitStore.ts` at 558). Stores call `window.limboo.*` and subscribe to push events. (High)
- Markdown: `react-markdown` + `remark-gfm` + `rehype-sanitize`. Code highlighting with shiki is inserted through `dangerouslySetInnerHTML` (`CodeBlock.tsx`, `ToolDiff.tsx`), relying on shiki's escaping. (High; shiki's escaping not independently verified.)
- Terminal: `@xterm/xterm` 6 + addon-fit. (High)
- ATLAS has its own React UI. Nothing here is obviously better beyond feature breadth.

## 11. Other observations

**Tests.** There are none. `find` finds no `*.test.*` or `*.spec.*` files. `docs/contributing/testing-and-verification.md` says "There is no automated test suite yet." CI (`.github/workflows/ci.yml`) runs ESLint, `check-licenses.mjs`, `check-electron-security.mjs` (regex), `check-manifest.mjs`, release-notes sync, `npm audit … || echo warning` (non-blocking), a renderer Vite build, `electron-forge package`, and `ci/scripts/smoke-test.mjs`. The smoke test **does not launch Limboo**. It writes a temporary `boot.cjs` that creates a bare sandboxed window on `about:blank`, spawns Electron with **`--no-sandbox`**, and checks that `require`/`process` are undefined. Its header says it "verifies the security boundary from inside the running app" and asserts "that the packaged security model actually holds at boot". The code checks neither. (High) The extensive defensive comments in the source are therefore unverified by any test.

**Secrets.** `src/main/secrets/SecretStore.ts` stores secrets as `safeStorage.encryptString` → base64 in `{userData}/secrets/<name>.bin.json`. Temp files are opened `wx` with 0600, then fsync and rename. It refuses when `isEncryptionAvailable()` is false. It does not check `safeStorage.getSelectedStorageBackend()`, so on Linux without a keyring the `basic_text` backend may be used silently (grep finds no such check). (Medium)

**Network fetches.** `src/main/net/ssrfGuard.ts` provides a `makeGuardedLookup` passed as `https.request({lookup})`, so the IP actually connected to is checked. That defeats DNS rebinding. 169.254.169.254 is always blocked. Voice model downloads are verified against pinned SHA-256 values (`shared/voice-models.ts`, `VoiceModelManager` ~L356) and use traversal-safe extraction. (High)

**Auto-update.** `managers/AutoUpdateManager.ts` uses electron-updater against GitHub Releases (`FEED = {provider:'github', owner:'limboo-ai', repo:'limboo'}`), polling hourly with an initial delay of 8 s. `autoDownload` follows a user setting. Beta is enabled through `allowPrerelease`. Linux deb/rpm installs bypass electron-updater and run through `updates/linuxInstall.ts` with `pkexec` and argv (no shell). **Windows: `verifyUpdateCodeSignature: false`** (`electron-builder.yml` L82) because the certificate is self-signed. Update integrity therefore rests on the sha512 in `latest.yml`, served from the same release. Compromising the GitHub release means code execution on update, and on Linux the user is asked to authorize a root install. CI generates build-provenance and SBOM attestations (`.github/workflows/_package.yml`), but the client does not verify them. (High)

**Dependencies of note.**
- Native: `better-sqlite3 ^13`, `node-pty 1.2.0-beta.15` (beta), `sherpa-onnx-node 1.13.8`.
- Others: `electron ^42.5.0`, `@anthropic-ai/claude-agent-sdk ^0.3.286` (proprietary license; listed as a named exception in `check-licenses.mjs`), `@ai-sdk/harness*` (described in comments as experimental; mixed exact and caret pins), `ai ^7`, `chokidar ^5`, `electron-updater`, `tar-fs 3.1.3`, `unbzip2-stream 1.4.3`, `ws`, `zod ^4`, `zustand ^5`, `shiki ^4`.
- Toolchain: TypeScript `~4.5.4` (very old; not typechecked in CI), `@typescript-eslint` 5, eslint 8.
- Many caret ranges; `package-lock.json` is committed. (High)

**License and attribution.** MIT. Copying code or substantial portions requires keeping the copyright notice "Copyright (c) 2026 BotCoder254" and the permission text. Adopting the *concepts* below as independent implementations needs no attribution. `CITATION.cff` requests citation but is not binding. If code is copied, record provenance in an ADR.

**Repository hygiene.** The repo ships `.claude/settings.local.json` (`Bash(git push *)` allowed) and a 100 KB `CLAUDE.md`. These are agent-workflow artifacts and not relevant to runtime behavior.

---

## Comparison matrix (ATLAS vs Limboo)

| Area | Limboo | ATLAS | Verdict |
|---|---|---|---|
| Process split | Everything in main; voice in a utilityProcess | Daemon utilityProcess owns execution and SQLite | ATLAS stronger |
| Preload | About 210 methods across 24 namespaces | Frozen invoke/onEvent/onStatus/onTerminal | ATLAS stronger |
| IPC validation | Hand-written asserts | zod schemas | ATLAS stronger |
| Sender check | Origin is `file://` or the dev origin | Sender plus schema | ATLAS likely stronger |
| CSP | Strict header (file:// delivery unverified) plus permissive meta | (ATLAS's own) | Avoid the Limboo meta pattern |
| Tool gate | String heuristics in main; no OS jail by default | Policy engine plus bubblewrap | ATLAS stronger |
| Workspace-configurable runtime permissions | Yes (`settingSources` includes project) | No | Avoid |
| Checkpoints | Temp index, `refs/limboo/...`, safety snapshot | Worktree commits | Adopt refinements |
| Persistence | Mutable tables, text-only transcript, non-transactional migrations | Append-only event log plus replay | ATLAS stronger |
| Repo drift on resume | `RepoDelta` one-shot injection | Source hashes in bundle | Adopt concept |
| Memory | FTS5-ranked memories injected as authoritative | Operator project facts | Optional; keep operator-gated |
| Tests | None | Unit, integration, e2e | ATLAS stronger |

---

## The 5 mechanisms most worth adopting into ATLAS (as concepts)

1. **Non-destructive snapshot via a throwaway index, plus a safety snapshot before restore.** Evidence: `GitManager.snapshotTree`, `createCheckpoint` and `restoreCheckpoint` (`src/main/managers/GitManager.ts` ~L844-1180). The snapshot uses `GIT_INDEX_FILE=<tmp>`, then `read-tree HEAD`, `add -A`, `write-tree`, `commit-tree` and `update-ref` under a private ref namespace. A restore first takes a snapshot of the current state and refuses if that fails. It then computes a tree-to-tree diff to find files added since the checkpoint, deletes only those (with a containment check, skipping `.git`), and runs the same arithmetic for preview. ATLAS checkpoints are commits on task branches; this adds restorable intermediate states without polluting branch history, captures untracked files, and makes every restore itself reversible.

2. **A capability record per runtime, with refusal at preflight when a runtime cannot be gated.** Evidence: `harnessRegistry.ts` `HarnessCapabilities {gatesReads, gatesBuiltins, …}` and `HarnessUngatedError` (`harness/errors.ts`). `harness/permissions.ts` uses an exhaustive switch, so a new mode becomes a compile error. In `harness/approval.ts`, a gate exception produces a deny (fail closed). For ATLAS's `AgentRuntime`: have each runtime declare which tool classes it routes through ToolGate, refuse to start one that cannot route a required class, and show the degraded capabilities in the UI.

3. **Hash-bound acknowledgment of repo-authored executable configuration.** Evidence: `worktree/config.ts` `hashRepoConfig` (sha256 over the canonicalized hooks, scripts and services) and `WorktreeManager.ackConfig`, which requires the displayed hash to equal the current hash and persists the ack per workspace, so any edit forces re-review. ATLAS could apply the same idea to any verification commands or project-declared commands that a repository or agent can modify. The approval should be bound to the content hash, not to the file name.

4. **A repository-drift delta at session or attempt resume.** Evidence: `resume/ResumeManager.ts` and `resume/delta.ts`. An anchor (HEAD, branch, a dirty hash over `status|path|size|mtime` with no content reads) is compared on activation. The result is a capped structured delta (commits ahead or behind, rewritten history, changed manifest or migration files) injected once with persisted `pending`/`injected` status. ATLAS already hashes context sources. A typed drift record attached to the next attempt's bundle, and written as an event, would make "the repo changed under you" explicit and auditable.

5. **Risk-scoped remembered grants with a separate mandatory tier for secret files, plus DNS-rebinding-safe fetches.** Evidence: `rememberKey(sessionId, scope)` together with `promptForApproval(..., scope)`, where a remembered grant only satisfies its own risk class (`AgentManager` ~L6680, L1618). `touchesSensitiveFile` forces an ask even under auto-approve modes. For network access, `net/ssrfGuard.ts` `makeGuardedLookup` validates the address actually connected to, combined with pinned SHA-256 artifacts (`VoiceModelManager`). For ATLAS, single-use approvals stay the default. If "remember" is ever added, scope it by capability class and never let it cover secret-path access. Use the guarded-lookup pattern for any daemon-side HTTP.

(Honourable mention: the read-only shell classifier in `agent/readOnlyCommands.ts` is a careful deny-by-default allowlist. ATLAS should treat such a classifier only as a prompt-reduction hint inside the bubblewrap jail, never as a boundary. See the git-config weakness below.)

## Security weaknesses ATLAS should avoid

1. **Letting workspace content configure the agent runtime's permission layer.** Limboo passes `settingSources: ['user','project','local']` (`AgentManager.ts` L6168), so a repo's `.claude/settings.json` can contribute allow rules and hooks that are evaluated ahead of Limboo's gate. (Medium confidence on the exact SDK ordering.) ATLAS must ensure Pi SDK runtime config, rules and hooks come only from operator-controlled locations.
2. **Treating "read-only" git as safe when the agent can write `.git/config` or `.gitattributes`.** Auto-approved `git status` and `git diff` can run fsmonitor, external diff or textconv programs. ATLAS's executor should run git with hardened config (for example `-c core.fsmonitor= -c diff.external= -c core.hooksPath=/dev/null`, `GIT_CONFIG_NOSYSTEM`) and deny agent writes under `.git`.
3. **String-level command analysis as the primary boundary,** including substring matching for protected paths in Bash and path guards that only inspect `file_path`-style fields. The kernel sandbox must be primary.
4. **An OS sandbox off by default** (`mapClaudeSandbox` returns undefined when `network === 'all'`; the harness `resolveJail` is a no-op). Graceful degradation (`failIfUnavailable: false`) silently drops containment.
5. **Passing the full `process.env` to agents and PTYs** while documenting it as "sanitized" (`TerminalManager.sanitizedEnv`, `buildOptions.env`). Keep ATLAS's env allowlist.
6. **A broad preload exposing policy switches** (`settings.set` → `permissionMode: 'auto'`) and raw terminal write. The renderer should not be able to downgrade policy without a daemon-side, operator-scoped confirmation path.
7. **Origin-only IPC sender checks combined with a navigation guard that allows any `file://`.**
8. **A permissive meta CSP shipped alongside a strict header CSP,** plus remote font loading in production.
9. **Non-transactional, unversioned schema migration** (`database.ts` `migrate`).
10. **Disabling update signature verification** (`verifyUpdateCodeSignature: false`) and relying on same-origin checksums.
11. **Security "tests" that are regexes over source, and a smoke test that does not load the app** while claiming to verify the packaged security model. This conflicts directly with ATLAS's rule that pass conditions must cite real assertions.

## Could not verify
- Whether `webRequest.onHeadersReceived` applies the strict CSP to the `file://`-loaded renderer.
- The exact Claude Agent SDK permission-evaluation order relative to `canUseTool` when project settings are loaded (based on SDK documentation knowledge, not executed).
- Whether the `.git/config` → read-only git chain works end to end (not executed).
- The `HarnessUngatedError` preflight call site for Codex (registry entry read; enforcement call not traced).
- AI-SDK harness adapter internals (`@ai-sdk/harness-*` are not vendored in the repo).
- Fuse application under the Forge-then-electron-builder pipeline.
