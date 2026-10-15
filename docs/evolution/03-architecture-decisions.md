# 03 — Architecture challenge and decisions

## Answers to the challenge questions (evidence-based)

| Question | Answer | Evidence |
|---|---|---|
| Is orchestration durable across restarts? | Yes for state; partly for processes | Event log + `recover()`, integration crash test, e2e mid-mission restart. The process leak is P0-4 |
| Can a worker crash without corrupting a mission? | Yes | Lost attempts are recorded and restarted in fresh worktrees; replay equals the stored state (eval `crash-recovery`) |
| Can parallel agents safely modify the same project? | Yes, by isolation and serialization | Per-task worktrees, writers with overlapping declared files serialized, conflicts stop integration (`m2.test.ts`) |
| Is every terminal process supervised and cleanly terminated? | Not after a hard daemon crash without bwrap | Baseline probe → P0-4 |
| Can approvals be bypassed through alternate tools? | **Yes, within the sandbox**, through argument forms of safe-listed programs; unsandboxed, project code runs without approval | Probe → P1-1, P1-2 |
| Does the renderer receive unjustified privileges? | No | `security.spec.ts`: 6-key frozen bridge, undeclared IPC denied |
| Can automation race human input? | Desktop: no (lease, serialized actions, pause checked mid-action). Terminal: no automated writes exist | `desktop.test.ts` |
| Are planned/running/failed/verified/completed distinguished accurately? | **Not before P0-2**; now verdict-aware everywhere | P0-2 |
| Can interrupted work resume idempotently? | Tasks restart fresh; deploys are never repeated after a crash | `deploy.test.ts` "crash mid-deploy" |
| Are deployments linked to exact SHAs? | Yes, with read-back | `deploy.test.ts` |
| Is verification independent of the implementing agent? | **Not fully.** The agent could rewrite the verification definition | P0-3 |
| Are agent reports backed by evidence? | Yes. Claims are labeled; the gate uses exits | eval `false-claim` |
| Is the app testable without live models? | Yes | FakeRuntime; every suite runs offline |
| Does Pi create lock-in? | Low | `AgentRuntime` interface, contract suite shared by fake and Pi |

## Decisions

### D1 — Verification definitions come from the approved base, not from the agent's change (P0-3)
- **Context.** Verification ran the integrated commit's own `package.json` scripts and `atlas.config.json` checks. The agent writes that commit, so it chooses its own test.
- **Alternatives.**
  - (a) Keep the current behaviour and rely on review. Rejected: review is gate-only by design.
  - (b) Run the base commit's recipes against the integrated tree, and fail the gate if any verification definition changed (LB-style content-hash acknowledgment).
  - (c) Freeze the definitions in a separate operator file outside the repo. Rejected: it duplicates project config.
- **Decision: (b).** The gate derives recipes from the mission's base commit and compares a hash of the verification-relevant definitions between base and integrated commit. On any difference the gate fails with a named reason and lists the changed definitions. The operator can still accept, and that is recorded as a decision, not as verification.
- **Trade-off.** A legitimate change to the test command (rare in a mission) needs operator review.

### D2 — Process journal with identity, reaped on start (P0-4)
- **Alternatives.**
  - (a) Rely on `--die-with-parent`. Linux bwrap only.
  - (b) Scan by command line (SM). Fragile and can match unrelated user processes.
  - (c) Journal pid + start-time identity per spawn and reap the matching process groups on start (AO's "facts first" style).
- **Decision: (c).** On Windows, Job Objects with kill-on-close are used for every helper-launched process, so the OS reaps them.
- **Identity source:** `/proc/<pid>/stat` starttime (Linux), `ps -o lstart=` (macOS). Rows without a verifiable identity are dropped, never killed.

### D3 — Argument-level command classification (P1-1)
- **Decision.** Keep the kernel sandbox as the boundary. The classifier gates approvals, so it must not label program-executing or file-writing forms as safe. Per-program deny lists for executing/writing options, plus "git global options ⇒ privileged".
- **Alternative rejected.** A full read-only allowlist parser like LB's. It is more code than ATLAS needs, because ATLAS's sandbox is the boundary.

### D4 — Preserve before remove (P1-3)
- **Decision.** A temp-index snapshot into `refs/atlas/preserved/<mission>/<worktree>` before any forced removal, recorded as an event. No change to the user's index or checkout. Deleting a mission deletes its refs. Concept from AO/LB; implemented independently.

### D5 — Terminal sessions live in the daemon (P1-5)
- **Decision.** The renderer attaches and detaches; closing a tab no longer kills the PTY. Ring buffer + seq + subscribe-then-snapshot (SM concept). The session ends only on explicit close, mission decision or daemon stop.

### D6 — Rejected adoptions
See [01-competitor-matrix.md](01-competitor-matrix.md): stdin injection, unauthenticated local sockets, full environment inheritance, repo-configurable permissions, persisted bypass flags, unsigned updates.
