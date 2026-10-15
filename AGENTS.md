# AGENTS.md — working on ATLAS

Read this before editing. The functional specification is `docs/spec/manual.md` (50 sheets + the Electron addendum). Decisions that deviate from or refine it are in `docs/adr/`. The current milestone and what is and is not done is in `docs/spec/status.md`.

## Ground rules

- An agent claim is not evidence. Pass conditions must cite a process exit, a test assertion or an operator decision.
- Never fabricate test results, screenshots or deployment status in code, docs or reports.
- Keep the runtime behind `AgentRuntime` (`packages/contracts/src/runtime.ts`). No Pi SDK type may appear outside `packages/runtime-pi`.
- Privileged execution happens only in the daemon, only through `ToolGate` → `@atlas/policy` → executor. The renderer and Electron main never run commands.
- Dependency direction points at `@atlas/contracts`. `pnpm lint` enforces an acyclic graph and that packages never import UI or Electron.
- Add a negative test with every capability. Make scoped changes; record an ADR when you choose between real alternatives.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install everything (Electron binary included) |
| `pnpm dev` | Vite + esbuild watch + Electron |
| `pnpm typecheck` | `tsc` for every workspace |
| `pnpm lint` | dependency-graph check + ESLint |
| `pnpm test` | unit tests (no network, no credentials) |
| `pnpm test:integration` | orchestrator missions against real git repos with the scripted runtime |
| `pnpm eval` | golden mission corpus; writes `docs/eval/latest.{md,json}` |
| `pnpm test:e2e` | builds, then drives the Electron app with Playwright (Linux needs `xvfb-run`) |
| `pnpm package` | electron-builder (Linux AppImage is the tested target) |
| `pnpm run doctor` | checks local requirements without printing secrets |
| `pnpm pi:version` | verifies installed Pi packages against the pin |
| `pnpm seed:sample [dir]` | creates the sample git repository used by the demo |
| `pnpm screenshots` | rebuilds and recaptures `docs/screenshots` from a live sample mission (Linux: `xvfb-run -a -s "-screen 0 1600x1000x24"`) |

## Map

```
apps/desktop/electron-main   window, OS dialogs, daemon supervision, IPC routing (validates sender + payload)
apps/desktop/preload         frozen window.atlas: invoke(method), onEvent, onStatus — nothing else
apps/desktop/renderer        React UI; src/live is the real app, the rest is the design-system prototype (preview only)
apps/daemon                  control plane process: storage + orchestrator + runtimes
packages/contracts           domain types, zod IPC schemas, events, runtime contract, redaction
packages/storage             SQLite (node:sqlite, WAL, migrations), event log, artifact store
packages/policy              capabilities, role grants, command classification, approvals
packages/workspace           canonical path checks, git worktrees, checkpoints, diffs, leases
packages/terminal            argument-array executor, env allowlist, process-tree kill, timeouts
packages/orchestrator        state machines, plan validation, scheduler, ToolGate, verification, release gate, recovery
packages/browser             Playwright browser sessions, app start in the sandbox, API checks, browser_action (snapshot + refs), visual proof stage
packages/deploy              staging providers (local, command), independent verification, rollback, reconcile
packages/desktop-control     Xvfb virtual displays, xdotool input, controller lease, desktop_action tool
packages/mcp                 MCP client (stdio in the sandbox, streamable HTTP) and server manager behind mcp_call
packages/sync                skills and MCP servers synced to Claude Code, Codex and OpenCode (preview, ownership, conflicts)
packages/team                team spaces: signed append-only record in refs/atlas/team, invitations, teams, board, reviews, owner gate
packages/security            deterministic security scan of a change: secrets, injection-prone code, dependency and CI risks
packages/graph               code graph of a repository (files, symbols, imports) that agents query instead of re-reading files
packages/web                 web access for agents: search accounts pooled per provider (Tavily, Brave, Google), web_fetch, read-only web_browse, public-address guard
packages/runtime-fake        deterministic scripted runtime (CI and the sample missions)
packages/runtime-pi          Pi SDK adapter (pinned 0.87.1)
fixtures/sample-app          sample project with a real bug and real tests
tests/integration            end-to-end orchestration against temp git repos
tests/e2e-electron           Playwright drives the built Electron app
evals                        golden mission corpus, hidden oracles, metrics (`pnpm eval` → docs/eval)
```
