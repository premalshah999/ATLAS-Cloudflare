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

Cloudflare deployment returned error 10403: Artifacts requires Workers Paid. Worker type checking and mocked protocol tests pass, but no live repository creation, push or remote hash readback has succeeded. Wrangler's local mode also requires remote Artifacts access. This is an unresolved challenge requirement.

The Mac bundle is unsigned and not notarized. External Node, Git and Python 3 are needed for agent commands and the terminal. Mac Seatbelt is not Linux process-namespace isolation. This prototype does not demonstrate massive agent scale.
