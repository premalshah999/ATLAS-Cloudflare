# 07 — Final assessment

ATLAS was evolved, not rewritten. Its identity is preserved: the Electron + React + TypeScript app, the daemon architecture, and Pi as the core runtime behind `AgentRuntime` (pinned 0.87.1; now loaded on first use). Every change is an incremental, revertible commit on `claude/gifted-volta-j4hvy4`. Each was verified by tests, and the larger slices were reviewed by an independent agent that had no write access. Detail: [04 implementation log](04-implementation-log.md), [05 test evidence](05-test-evidence.md), [06 security review](06-security-review.md).

## What changed, in one table

| Area | Before (baseline, probed) | After (tested) |
|---|---|---|
| Can the agent fake "Verified"? | Yes. Rewriting the test script gave "Verified" | No for the 7 tested vectors. The definition comes from the base; changed tests run the base suite; any override is hash-bound and never counts as evidence |
| Approval bypass via safe programs | 8 argument forms ran programs without approval | Privileged, including option abbreviations (found by the final audit) and path-qualified programs |
| Unsandboxed mode | Project code ran as the user without consent | Agent commands, release checks and app starts each ask; a denial means nothing runs |
| Processes after a daemon crash | Unsandboxed commands orphaned forever | Journal + identity-checked reaper; group survivors found; one daemon per data directory; Windows helper now watches the daemon (test added; result pending on the Windows CI job) |
| Cancel during sandbox setup | Hung under load (118 of 150) | 0 of 150; Linux CI green since the fix |
| Uncommitted work at cleanup | Destroyed by `worktree remove --force` | Preserved in refs, or the worktree is kept with a recorded reason; the user's own worktrees are untouched |
| Daemon restart mid-attempt | The attempt's work and conversation were lost; a fresh attempt started over | Pi attempts continue the lost conversation on a snapshot of the lost files (ADR 0014); other runtimes restart fresh as before |
| Stalled agents | Looked healthy until the wall-clock budget | "No signal" after 120 s (not raised for approvals, running commands or working subtasks) |
| Disk and worktree growth | Unbounded | Free-space floor and per-mission cap, with typed reasons |
| Operator terminal | Died with its tab | Lives in the daemon; reattach with full history; resize (Linux, macOS) |
| UI truth | Long missions lost their tail; "Unverified" shown as "Completed" | Full history; verdict persisted and shown |
| Evidence export | Tampered artifacts re-hashed and imported as intact | Refused on import (tamper-evidence; not authenticity, see open risks) |
| Daemon idle memory | 180–181 MB | 134–135 MB (two runs each) |
| macOS | Every mission failed under Seatbelt | **CI fully green**, including Electron e2e, packaging, and real desktop control (XQuartz) |
| Windows | Broken | **Still not working end to end.** Sandboxed Node and npm run; child processes with piped stdio hang inside the AppContainer (test runners), see [04](04-implementation-log.md) |

## Scorecard against the backlog

| ID | Status | Evidence |
|---|---|---|
| P0-1, P0-2 | done | unit + integration + e2e |
| P0-3 | done, reviewed, audited (auditor could not break it) | 11 integration cases incl. 6 bypasses |
| P0-4 | done, reviewed (Linux, macOS) | orphans + reap tests; Windows parent watch: test added, CI result pending |
| P0-5 macOS | done | CI run 38107974496, all steps |
| P0-6 Windows | **open** | see [05](05-test-evidence.md) |
| P1-1 … P1-6 | done, reviewed, findings fixed | [04](04-implementation-log.md) |
| P2-1 | done | metrics, two runs |
| Independent acceptance verification | done | holdout suites; eval case `weak-tests-holdout` |
| Skills + Skill Laboratory | done (benefit unmeasured) | ADR 0013; unit, integration, e2e |
| Signed exports | done | archive tests incl. both forgery forms |
| Durable Pi session resumption | done (scripted model) | ADR 0014; unit + integration across a daemon restart |
| Live Pi test | written, **not run** (no key) | `pnpm test:live` |
| Toolchain upgrades | done | full regression; audit 30 → 1 |
| GitHub PR/CI feedback loop | done (fake GitHub API; not run against github.com) | ADR 0015; unit, integration, e2e |
| P2-2, P2-4, P3-* | not attempted | — |

## What this does not prove

- **No comparison with the reference products is claimed.** We did not run a fair, reproducible benchmark of ATLAS against agent-orchestrator, limboo or Claude-Multiplex. [01](01-competitor-matrix.md) compares designs from source reading only.
- **The scripted runtime drove every mission in these tests.** The Pi adapter is covered by its contract suite, but no live-model mission was run in this evolution, because no credentials were used.
- **The 1/7 false-pass case in the eval is real:** weak new tests on new code pass. The gate cannot judge test quality.
- **Export trust is per key id, set by hand.** Signed exports now name their signer; there is no revocation or key distribution beyond copying a key id.
- **Windows users get a fail-closed product today, not a working one.**
- **The pull request loop was tested against a fake GitHub API and a local bare repository**, not github.com.
- **Session resumption was tested with Pi's scripted model.** Whether a real model makes good use of a restored conversation is unmeasured until the live run.

## Recommended next steps, in order

1. **Windows: decide ADR 0016.** Root cause found: an AppContainer cannot create the named pipes Node uses for piped child stdio. Options are a restricted-token sandbox, consent-gated unsandboxed runs, or documenting the limit. Previously: **Windows AppContainer toolchain access.** Finish the diagnosis the CI bisection has started (the toolchain capability ACL is not in effect). Then grant only the directories of the programs actually used, not every `PATH` entry.
2. ~~Signed exports~~: done. Per-installation Ed25519 key; imports show signer and trust.
3. ~~Dev-tool upgrades~~: done, with a full regression run. One build-time advisory remains, with no upstream fix (see [06](06-security-review.md)).
4. ~~ESLint `react-hooks` rule~~: done. `rules-of-hooks` is an error in the renderer, and a conditional hook fails lint. `exhaustive-deps` is a warning (13 existing, mostly intentional).
5. **Live-model reality run.** A Pi mission against a real provider in a disposable environment, with credentials the operator supplies.
