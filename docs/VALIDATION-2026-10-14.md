# Mac validation — October 14, 2026

Environment: macOS 15.8.1, Intel x64, Node 24.21.0, pnpm 10.28.0, Electron 44.1.1.

## Observed passing checks

- `pnpm typecheck`: all workspace, test and Worker types pass.
- `pnpm lint`: ESLint and the acyclic workspace dependency check pass.
- `pnpm test`: **68 passed, 19 skipped**. Skips cover Linux-specific sandbox/desktop capabilities. Includes Mac PTY interaction, readonly terminal behavior, home-file isolation, Worker authorization failures, invalid publication destinations, remote hash mismatch and secret redaction.
- `pnpm test:integration`: **29 passed, 14 skipped**. The parallel sample test proves both writers overlap, both contributions reach the integration branch, and the original checkout remains clean. Linux-gated browser, staging, desktop and sandbox cases are skipped on Mac.
- Electron mission/security tests: five passed. The sample completes real tests, API checks and browser checks, records evidence, survives a daemon crash and app restart, and preserves the original checkout.
- Electron capabilities flow: passed on this Mac after fixing the PTY bridge. Exercises staging approval/verification, interactive terminal, and audit export/import.
- Packaged Intel `.app`: mission workflow including crash/restart recovery passed.
- Production renderer/daemon build and unsigned Mac directory packaging complete.
- `pnpm run doctor`: Node, SQLite, Git, pnpm, Electron, Seatbelt and browser available. Virtual Linux desktop automation is unavailable on Mac.

## Limits

No model API key was supplied and no live provider request was tested. The demo uses the explicitly labeled scripted runtime with real Git operations and checks.

Cloudflare: after upgrading to Workers Paid, the Worker deployed and `pnpm test:cloud-live` passed on October 15, 01:31 UTC — live repository creation, scoped-token push of five mission refs and independent remote hash readback all succeeded. Two defects found only against the live service were fixed: tokens are `art_v2_`-prefixed, and `ArtifactsRepo.log` resolves branch names, not full `refs/heads/` refs.

The Mac bundle is unsigned and not notarized. External Node, Git and Python 3 are needed for agent commands and the terminal. Mac Seatbelt is not Linux process-namespace isolation. This prototype does not demonstrate massive agent scale.

## Update — merged edition, October 15, 2026 (~02:45 UTC)

After merging the upstream `claude/gifted-volta-j4hvy4` branch (all Pi providers, web access, team spaces, security layer, MCP, skills, Graphite UI) with this edition, and adding the live Home, Activity, Agents and Report screens and provider key checks:

- `pnpm typecheck` passes; `pnpm lint` has 0 errors.
- `pnpm test`: 353 passed, 21 skipped. `pnpm test:integration`: 116 passed, 21 skipped.
- Electron e2e: all 21 specs passed on this Mac (15 in one full run; the other 5 failed there and passed when rerun alone with the same build — environmental contention, recorded here rather than hidden), including the new `dashboard.spec.ts`.
- Packaged Intel `.app`: `dashboard.spec.ts` and the crash/restart mission spec pass against it; installed at `~/Applications/ATLAS.app`.
- `pnpm test:cloud-live` passes against the deployed `atlas-mission-control` Worker; the demo recording published a mission live as well.
- DeepSeek: `credentials.test` (unit-tested against a mocked api.deepseek.com) checks keys and balance at the official API only. A live check of the operator's own key was not run from this session; use Settings → Test.

## Real missions on Operon with DeepSeek — October 15, 2026 (03:00–05:20 UTC)

Repository: `premalshah999/OPERON-ATLAS` (private; Operon complaint-operations platform, FastAPI + React), with GitHub Actions CI (backend pytest, frontend tests/types/lint/build, smoke). Models: DeepSeek via api.deepseek.com only (`deepseek-flash` for all tiers in the final runs). No scripted runtime.

What the runs showed, recorded as it happened:
- **Model planning works and staffs a team.** After fixing the planner (its own working directory; no long-held renderer call), the orchestrator model planned every mission itself, e.g. CSV export: 8 tasks — coder ×3, tester ×2, reviewer, security engineer, deployment verifier — with dependencies; writers ran concurrently in separate worktrees.
- **Coders delivered** every implementation and test task in the final export and SLA runs; testers and the security engineer completed their tasks. The security engineer's findings on export: export memory not bounded with off-filter parameters (medium), no role/scope check for bulk extract (low), and verified formula-injection and header-injection protections.
- **Honest failures, fixed one by one:** the 5-minute planner budget fell back to the default plan (fixed); coder 60-call and reviewer 40/120-call budgets were too small for a real codebase (raised: coder 160, reviewer 400, other read-only roles 100–120); macOS `git` xcrun shim could not write its cache inside the sandbox (now the Command Line Tools binaries are used); Vite needed a writable `node_modules` (Operon's toolchain script fixed); `mktemp -d` ignored the sandbox `TMPDIR` on macOS (fixed). Missions whose reviewer ran out of budget were recorded as **failed**, never as verified.
- The operator policy used by the driver approved low/elevated requests and the project's own check scripts, and denied other high-risk shells (for example `rm` of files) — every decision is in the mission log.
- Cost: under $1.50 of the DeepSeek balance for all runs (balance read through Settings → Test).
