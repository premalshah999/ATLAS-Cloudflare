# ADR 0033 — macOS launch and operator terminal

2026-10-14. The original Linux implementation built on macOS but had not been exercised there. This change verifies the source app and an unsigned Intel Mac bundle using the existing Electron mission tests.

- Clear `ELECTRON_RUN_AS_NODE` in launch scripts and Electron tests. IDE hosts can export it; inheriting it prevents the desktop window from starting.
- Include standard user Node/Git installation directories in the daemon PATH for Finder launches.
- Permit filesystem metadata lookups under the home directory in the Seatbelt profile so Node can resolve npm symlinks. Continue blocking home file contents. A canary test checks content access and write denial. Explicitly deny writes to the root of read-only worktrees, including worktrees inside the temporary directory.
- BSD `script` cannot accept Electron's piped stdin. On macOS, use a small Python 3 standard-library PTY bridge to allocate a terminal, then execute the existing sandbox-wrapped shell in the child. The bridge is trusted infrastructure, not repository code; no third-party native Node module or Electron ABI rebuild is required. The child receives the scrubbed environment. Terminal shutdown signals the child process group.
- Linux retains the existing `script` implementation. macOS needs `/usr/bin/python3` (Apple Command Line Tools) for the optional Terminal panel.

The macOS profile is not equivalent to Linux namespaces. In particular, the OS temporary directory is available and process visibility is not isolated. The UI and setup docs describe this limitation. Xvfb desktop control remains Linux-only.
