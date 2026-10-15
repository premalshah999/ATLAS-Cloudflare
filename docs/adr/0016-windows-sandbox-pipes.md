# ADR 0016 — Windows: AppContainers cannot host Node's piped child processes

Status: decided by [ADR 0020](0020-windows-sandbox-accounts.md) (sandbox accounts) · 2026-10-12

## Evidence (CI runs 38127174519 and 38130392107, bisection inside the AppContainer)

| Step | Result |
|---|---|
| cmd.exe, node by path, `npm --version` | ✓ |
| child process with inherited stdio | ✓ |
| child process with piped stdio | hangs (8 s limit) |
| child process with `stdio: 'ignore'` | `EPERM` |
| named pipe `\\.\pipe\atlas-probe-…` | refused (libuv reports `EADDRINUSE` for access denied on pipe creation) |
| named pipe `\\.\pipe\LOCAL\atlas-probe-…` | ✓ |

An AppContainer may create named pipes only in its own namespace (`LOCAL\`). libuv, which is Node's I/O layer, backs piped child stdio with pipes in the global namespace and offers no option to change that.

As a result, any tool that collects a child's output inside the container hangs. That includes `node --test`, Jest and Vitest workers, and npm lifecycle scripts that pipe. This is why Windows missions cannot verify. ATLAS fails closed: no pass is ever reported, but nothing works either.

## Options
1. **Restricted-token sandbox instead of an AppContainer**, in the style of Chromium's legacy sandbox.
   - The token has the user SID as deny-only, so files the user's ACLs protect, such as the profile and other projects, are not readable.
   - The process runs at low integrity, so it cannot write above low integrity except in a worktree we label low.
   - A job object provides kill-on-close and limits.
   - *Unknowns to test first:* whether pipe creation works under this token; that files readable by Everyone or Users remain readable, which is weaker than an AppContainer; and network isolation, which needs the Windows Firewall per-SID rules an AppContainer gets for free.
   - Estimated effort: a new helper mode, plus the existing sandbox test suite run against it.
2. **Keep the AppContainer, and stop using it for commands that run project code.**
   - Those commands run unsandboxed, behind the existing per-context consent (`unsandboxed_run`).
   - Honest and quick, but on Windows it turns every test run into an approval prompt with no isolation.
3. **Document Windows as unsupported for running project code.**
   - The app, review, planning and evidence work on Windows; verification needs WSL2 (Linux sandbox) or a Linux or macOS machine.
   - The smallest change, and the most truthful about today.
4. A patched Node or libuv that uses `LOCAL\` pipe names. Rejected: we would ship and maintain a fork of the runtime that runs untrusted code.

## Recommendation
Option 3 now: state it in the app and docs, and keep failing closed. Then option 1 as a time-boxed experiment, adopted only if the existing sandbox tests (canary secrets, writes outside the root, network off, child processes, cancellation) pass under it. Option 2 stays available to an operator who explicitly allows unsandboxed execution, as today.
