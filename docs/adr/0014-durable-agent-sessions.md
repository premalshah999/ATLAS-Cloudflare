# ADR 0014 — Durable agent sessions: continue a lost attempt's conversation on its files

Status: accepted · 2026-10-11

## Context
Before this ADR, a daemon restart (crash, update or app quit) marked every running attempt `lost`. The next attempt started from scratch in a fresh worktree. On a long mission this throws away everything the agent learned and every uncommitted edit it made. The `AgentRuntime.resume` hook existed but Pi threw "not resumable", because sessions were in memory only.

Pi 0.87.1's `SessionManager` can write sessions to a directory we choose (`create`). It can also copy a session to a new working directory under a new id (`forkFrom`).

## Alternatives
1. **Keep restarting fresh.** Simple, but long missions lose all progress on every restart.
2. **Fresh attempt with a summary of the lost one.** It works with any runtime, but a summary drops the detail that matters: which files were read, which hypotheses were ruled out, what the tests said.
3. **Reopen the lost session in the lost worktree.** That reuses a worktree whose lease and state belong to a dead attempt, and it gives one attempt id two runs.
4. **Fork the lost conversation into a new attempt that starts from a snapshot of the lost files.** Chosen.

## Decision
- **Contract.** The `AgentRuntime` contract gains three optional members: `canResume(attemptId)`, `discard(attemptId)` and `AgentInput.resume { attemptId, prompt }`. A runtime without them (the scripted runtime) keeps the old behaviour. The handle reports `resumed`, so the record states what actually happened.
- **Pi.** Sessions are files under `<data dir>/pi/sessions/<attemptId>/`; attempt ids are validated, so no other path is reachable. A resumed attempt forks the lost session into its own directory with the new worktree as `cwd`. Before the model runs, tool calls that the interruption left without a result are closed with an explicit error ("Interrupted: ATLAS restarted before this call finished…"). The adapter does not rely on each provider's generic placeholder.
- **Recovery.** For a lost attempt whose runtime saved a conversation and whose worktree still exists:
  1. Commit the worktree's current files, uncommitted edits included, on the lost attempt's branch (`… attempt N (interrupted)`). Nothing is destroyed.
  2. Start the next attempt from that commit, and measure its patch from where the lost attempt started.
  3. Give the model a resume prompt that says commands were stopped and approvals expired.
  
  The model's memory of its edits then matches the files it finds.
- **Retention.** A saved conversation exists for crash recovery only. It is deleted when its attempt ends (except on daemon shutdown), when a resumed attempt has taken its own copy, or at recovery when it will not be resumed.
- **Not resumed:**
  - subtasks (the parent re-delegates);
  - attempts with no retries left;
  - attempts whose worktree is gone;
  - attempts that never reached a model answer (Pi writes the file only then).

  These start fresh, as before.

## Consequences
- Conversations, including tool output, are on disk between an attempt's start and its end. They sit in the same data directory as the event log, which already holds that output.
- Approvals never carry over a restart. They expire, and the model is told so.
- Any runtime can implement the three members. The orchestrator does not know about Pi.
- Tests:
  - `packages/runtime-pi/test/resume.test.ts`: a crash mid-command, a restarted runtime, the earlier conversation seen by the model, the interrupted call closed, a fresh start when nothing was saved, and refused path-like ids;
  - `tests/integration/resume.test.ts`: a full mission with the Pi adapter and a scripted model across a daemon restart, which verifies with the restored fix, plus the negative case where the worktree is gone.
