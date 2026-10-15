# 00 — Baseline (start of the evolution mission)

Recorded 2026-10-10 on commit `eb3bd1c`. That commit is the state when this mission began: the M0–M5 work, plus uncommitted cross-platform work that was committed first so nothing was lost (see "Repository safety"). Every number below comes from a command that ran on that date. Platform: Linux x64 container (Node 22.22, Electron 44.1.1, bubblewrap, Xvfb, Playwright Chromium). macOS and Windows numbers come only from GitHub Actions runs and are labeled as such.

## Repository safety
- At the start, the working tree held unverified edits to the terminal, policy, path and desktop code. They were committed to the working branch as `eb3bd1c` ("WIP cross-platform…") rather than discarded or overwritten, then validated: unit 83/83 (1 skipped), integration 44/44.
- One tool call that the user rejected mid-flight had already written its file edits (`packages/workspace/src/paths.ts` and its tests). They were kept, not silently reverted, and the full suite was re-run to verify them.
- No force-push, no history rewrite, nothing deployed.
- Reference repositories were cloned read-only to `/tmp/claude-0/refs`, outside the ATLAS tree. Nothing was installed or executed from them.

## Architecture map (as built)

```
Renderer (React 18, sandboxed, contextIsolation)
  │  window.atlas = frozen { invoke(method, params), onEvent, onStatus, onTerminal, platform, e2e? }
  ▼
Preload (CJS) ── ipcRenderer.invoke('atlas:invoke') ──▶ Electron main (apps/desktop/electron-main)
                                                        • validates sender frame + zod schema (packages/contracts/src/ipc.ts)
                                                        • OS dialogs, safeStorage credentials and deploy secrets
                                                        • supervises the daemon (restart with backoff), forwards events
                                                        ▼ MessagePort / utilityProcess
Daemon (apps/daemon, ESM utilityProcess) — re-validates every request
  ├─ storage: SQLite (node:sqlite, WAL, migrations v1–v4), append-only per-mission event log (seq), checksummed artifacts
  ├─ orchestrator: plan (model plan → validatePlan → 1 repair → deterministic fallback) → DAG scheduler
  │      (budget.maxConcurrentAgents, file-overlap serialization) → per-task worktrees from dependency checkpoints
  │      → ToolGate → policy → executors → checkpoint → integration branch merge → checks → release stages → gate
  ├─ policy: role capability grants, NEVER set, command classifier, single-use approvals with expiry
  ├─ terminal: argv-only executor, env allowlist, process-group kill, bubblewrap / Seatbelt / AppContainer (WIP) sandbox, PTY via `script`
  ├─ workspace: canonical path checks, git worktrees, checkpoints, leases
  ├─ browser: playwright-core sessions (origin-locked), app start in sandbox, API checks, browser_action tool
  ├─ deploy: local and command providers, independent staging verification, rollback, reconcile on start
  ├─ desktop-control: Xvfb display per attempt, xdotool input, controller lease (agent/operator/paused/stopped)
  └─ runtimes: Pi SDK 0.87.1 (packages/runtime-pi, behind AgentRuntime) · scripted FakeRuntime
```

Process count at idle: 5 (Browser, GPU, NetworkService, renderer Tab, daemon NodeService).

## What works, what is mocked, what is incomplete, what is broken

| Area | Status | Evidence |
| --- | --- | --- |
| Plan → approve → execute → verify → decide (scripted agent) | **works** (Linux) | e2e `mission.spec.ts`, integration `mission.test.ts` |
| Multi-task DAG, integration merge, conflict surfacing | **works** (Linux) | `m2.test.ts` |
| Review findings with failing-run evidence | **works** | `m2.test.ts` |
| Browser QA, API checks | **works** (Linux, bwrap) | `browser.test.ts`, e2e capabilities |
| Staging deploy (local provider), revision read-back, rollback | **works** (Linux) | `deploy.test.ts`, eval `wrong-deploy-revision` |
| Command deploy provider against a real hosting platform | **untested boundary** | no external credentials; only the local provider is exercised |
| Desktop control (Xvfb), takeover, pause | **works** (Linux) | `packages/desktop-control/test`, e2e |
| Operator terminal (PTY) | **works** (Linux), no resize | e2e terminal; resize not implemented |
| Pi runtime against a live model | **untested boundary** | contract-tested with Pi's faux provider only |
| Agent behaviour in demos, screenshots, eval | **scripted** (FakeRuntime) | labeled "scripted runtime" in the UI and docs |
| Design preview screens | **mocked by design** | labeled sample data |
| Agent session resume after crash | **not implemented** | lost attempts restart fresh |
| GitHub PR/CI/review feedback loop | **not implemented** | — |
| macOS: missions | **broken** (CI) | run 38086199749: every mission check under `sandbox-exec` failed; integration and eval red |
| macOS: packaging | **works** (CI) | arm64 `.dmg` and `.zip` built, unsigned |
| Windows: lint, storage, missions | **broken** (CI) | run 38086199749: `check-deps` path bug, `fsync` EPERM in the artifact store, path test |
| Windows sandbox | **WIP, unverified** | AppContainer launcher written in `eb3bd1c`; CI run 38086953805 in progress at baseline |

## Baseline command results (Linux, `eb3bd1c`)

| Command | Result |
| --- | --- |
| `pnpm lint` | pass (13 workspaces acyclic, ESLint clean) |
| `pnpm typecheck` | pass (workspaces + tests + evals) |
| `pnpm test` | 83 passed, 1 skipped (Windows-only) — 3/3 consecutive runs identical |
| `pnpm test:integration` | 44/44 — 3/3 consecutive runs identical (no flakes observed in 3 runs) |
| `pnpm eval` | 11/11 cases as expected; false pass rate 1/7 (deliberate `weak-tests` case) |
| `xvfb-run -a pnpm test:e2e` | 9/9 at the previous run (including the network audit and mid-mission restart specs) |

## Baseline metrics (Linux, built app, `pnpm metrics`, label `baseline`)

Collected by `tests/e2e-electron/metrics.ts` on the real Electron app; raw JSON in `evals/out/metrics-baseline.json` (local).

| Metric | Value |
| --- | --- |
| Cold launch → daemon ready (3 runs) | 1295 / 1275 / 1245 ms, median **1275 ms** |
| Idle memory, all processes | **677 MB** (Browser 159, GPU 141, Network 72, renderer 125, daemon 181) |
| Plan latency (scripted planner) | 387 ms |
| Approve → first agent attempt started | 624 ms |
| Approve → verified (sample mission, scripted agent with a 350 ms step delay) | **7.5 s** |
| Peak memory during the mission | 817 MB |
| Operator terminal keystroke → echo (5 samples) | 211 / 188 / 176 / 182 / 74 ms, median **182 ms** |
| Daemon hard crash → ready again | **1990 ms** |
| Idle CPU | not meaningful (first `getAppMetrics` sample) — re-measure with two samples |

## Probes run during the baseline (architecture challenge, first pass)

1. **Orphaned processes after a hard daemon crash.** Method: a mission runs `node -e setInterval(...)`, the orchestrator process is SIGKILLed, then survivors are listed (`/tmp/claude-0/probe/run.sh`).
   - Sandboxed (bubblewrap): no survivors, thanks to `--die-with-parent`.
   - Unsandboxed (operator opt-in): the command **survives**, reparented to PID 1, and recovery never reaps it. **Confirmed P0 process leak.** macOS `sandbox-exec` has no die-with-parent equivalent, so it is presumed to leak too (not yet observed).
2. **Truncated event history in the UI.** `useMission.catchUp` asks `events.since` for one page (the daemon caps it at 2000 events) and does not page further. A finished mission with more than 2000 events therefore shows a truncated timeline, and the gate verdict (taken from the events) can be missing: "Verification has not run yet" for a mission that ran it. **Confirmed by code inspection; regression test pending.**
3. **Unverified shown as "Completed".** The gate verdict is not persisted on the mission row. A mission whose verdict is *unverified* is listed as "Completed" with the same done status as a verified one (projects list, title bar, rail); only the outcome banner says "Unverified". **Confirmed by code inspection.**
4. **Approvals vs. project code.** In `ask_risky` mode, `node <file>` and `npm test` are on the safe list, so an agent can write a script and run it without an approval. Inside the sandbox this is the designed boundary. With **unsandboxed execution allowed** it means arbitrary code as the user without a prompt. **Credible risk.**
