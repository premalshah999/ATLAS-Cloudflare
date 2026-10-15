# ADR 0020 — Windows: run untrusted commands as dedicated sandbox accounts

Status: accepted (operator-approved 2026-10-12: "Approved: visible ATLAS sandbox accounts on Windows") · decides ADR 0016

## Context
ADR 0016 showed that an AppContainer cannot host Node's piped child processes. As a result no test runner works inside it, and Windows missions can never verify. The restricted-token experiment (option 1 there) was stopped: the client end of Node's pipes stayed denied.

The operator asked for Windows to work, chose the account approach below, and asked that the accounts stay visible.

## Alternatives
1. **AppContainer only.** Rejected: fails closed on every test run (ADR 0016).
2. **Restricted token.** Stopped at round 6 (ADR 0016).
3. **WSL2 with the Linux sandbox.** Rejected for now: it needs WSL2 and a distribution on every machine, Windows-native toolchains do not run there, and GitHub's Windows runners cannot test it.
4. **Two standard local accounts, created with the operator's administrator consent.** Chosen. Windows' own user isolation is the boundary, and a Windows Firewall rule blocks the network.

## Decision
- **Setup.** Settings → Execution isolation → *Set up sandbox accounts* runs the helper's `account-setup` through the Windows consent prompt (`Start-Process -Verb RunAs`), or directly when ATLAS is already elevated, as on CI. It creates:
  - `atlas-sbx`: a standard user, member of Users only;
  - `atlas-sbx-net`: the same, used only for network commands the operator approved;
  - a Windows Firewall rule *ATLAS sandbox (no network)* that blocks outbound traffic for `atlas-sbx`'s SID.

  Both accounts are visible like any other account, and their description names ATLAS. Passwords are random, protected with DPAPI for the operator's own Windows user, and kept in `%LOCALAPPDATA%\ATLAS\sandbox\accounts.txt` with the SIDs. They never leave the helper. Running setup again rotates them. *Remove* deletes both accounts and the rule.
- **Running a command.** `atlas-sandbox run - --account offline|network` starts the command with `CreateProcessWithLogonW`, suspended, inside the existing Job Object (kill on close, tied to the daemon's lifetime), and without a console window. The token is an ordinary one, so Node's piped children work.
- **Access.** The account gets, by ACL on its SID:
  - read-write on the task root and the worktree's git admin directory;
  - read on the read-only paths and the toolchain directories outside the system folders;
  - read-attributes only on the ancestors of each, so paths resolve;
  - a private home with its own temp and npm cache.

  Everything else in the operator's profile is protected by ACLs that name only the operator.
- **Network.** `atlas-sbx` is blocked by the firewall rule. If the rule could not be created, Settings shows *network not enforced*, and commands get proxy variables that point at a closed port as a partial guard. This is the guard-and-label choice the operator made for Windows networking earlier.
- **Operator terminals.** CreateProcessWithLogonW takes no attribute list, so the ConPTY is hosted by a copy of the helper running as the account. The helper executable is granted read and execute for both accounts.
- **Detection.** When the store exists and a probe command runs as `atlas-sbx`, the sandbox kind is `windows-account`. Otherwise the AppContainer mode remains, and its detail says that test runs cannot work in it.

## Consequences
- All tasks share the same account identity: one task's grants are readable by another task of the same operator. Linux bubblewrap isolates tasks from each other; this mode isolates them from the operator's own data.
- Setup changes the machine (two accounts and a firewall rule). It happens only on the operator's click with Windows consent, and is reversible with *Remove*.
- CI creates the accounts on the hosted runner (`scripts/win-sandbox.ts setup`), and `ATLAS_EXPECT_WINDOWS_ACCOUNTS` makes the sandbox suite fail if Windows silently falls back to the AppContainer.
