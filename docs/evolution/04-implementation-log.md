# 04 — Implementation log

Each slice follows the same steps:
1. Probe or test that reproduces the defect.
2. The change.
3. Tests, including a negative test.
4. An independent adversarial review by a separate agent with no write access.
5. Fixes for the confirmed findings.

"Evidence" names a test or a CI run, never an agent's claim. The commits are on `claude/gifted-volta-j4hvy4`.

The execution order followed the backlog: P0-1/2 → P0-3 → P1-1 → P0-4 → P1-3 → P1-2 → P1-6 → P1-4 → P1-5, with P0-5/P0-6 (macOS, Windows) worked in parallel against CI.

---

## P0-1 Truncated event history · P0-2 Unverified shown as Completed — `0ba91ff`

**Defects**
- `useMission` read one page of 2000 events, so long missions lost their tail, including the gate result.
- The gate verdict was not stored, so an unverified mission rendered as "Completed".

**Change**
- `fetchAllSince` pages until it gets a short page.
- Migration v5 adds `missions.verdict`, backfilled from the latest `gate.result`.
- `missionStatus()` drives the status dot and the verdict label everywhere in the UI.

**Evidence**
- `apps/desktop/renderer/src/live/eventSync.test.ts`: a 4321-event log, and a log that is an exact multiple of the page size.
- Storage backfill test.
- Integration test: `verdict === 'unverified'`.
- e2e: `data-verdict`.

## P0-3 The agent could redefine its own verification — `5afe983`, revised in `0f1dba3`

**Probe (baseline).** Rewriting `scripts.test` to `node -e "process.exit(0)"` produced "Verified: tests passed; review passed" with zero approvals.

**First change (`5afe983`)**
- A `verification-definition` gate check compares the approved base with the integrated commit. It covers scripts, runner config and `atlas.config.json`.
- Deleted tests are listed.
- A test run that executed zero tests is inconclusive.

**Independent review of v1** (subagent, read-only on the repo). It found **six bypasses**:

| ID | Bypass |
|---|---|
| A | Gut a test body |
| B | `test.skip` |
| C | Rename tests out of the runner's reach and add a trivial test |
| F | Commit `node_modules/.bin/node` |
| D | Switch package manager via lockfiles |
| J | Fan-out scripts (`run-s`, `-r`) |

It also found **three false positives** (G, H, K: legitimate new scripts or tests flagged), a crash on a `null` package.json, an approval that was not bound to content or state, and `noTestsRan` misfiring on output that merely mentions "0 tests".

**Revision (`0f1dba3`)**
- **Definition coverage** (`packages/orchestrator/src/definition.ts`):
  - every package.json outside node_modules;
  - `pre`/`post` hooks of `test`/`typecheck`/`lint`, plus scripts reached through `npm run x`;
  - all scripts when a fan-out runner is used;
  - runner keys (`workspaces`, `packageManager`, `type`, `imports`, `exports`, …);
  - lockfiles as a `package-manager` item;
  - config files in any directory (jest/vitest/tsconfig/eslint/.npmrc/.yarnrc/pnpm files/babel/swc/pytest/tox/conftest).
- **Large and unusual files:** blobs over 1 MB are hashed. Paths are read NUL-separated, so unusual names cannot break parsing.
- **New items:**
  - A new script or a first test script is reported as *added*, which is informational (fixes G/H/K).
  - A new config file, lockfile or runner key counts as *changed*.
- **Modified or renamed tests:** the gate runs the **base commit's original suite** against the integrated code, inside the sandbox. It restores the base tests, configs, lockfiles and the base package.json verification keys, removes added tests, and resets in `finally` (fixes A/B/C).
- **Tracked `node_modules`** blocks the gate (fixes F).
- **Operator approval** is bound to a SHA-256 over the integrated *tree*, the base, the definition hash and the weakening list. It is refused unless the mission failed and is undecided. It is recorded as an `operator.action`, never as evidence.
- **`noTestsRan`** reads only the runner summary lines (node, jest, vitest, mocha, cargo, pytest, go). Any count above zero means tests ran; all-skipped runs are detected.

**Evidence**
- `tests/integration/mission.test.ts` › "verification cannot be redefined…": a rewritten script; A, B, C, D, E (`null` package.json), F; a legitimate fix with a new test and lint script stays verified; a legitimate test edit passes the original suite; the approval is hash-bound and is not evidence; the approval is refused when not failed.
- `packages/orchestrator/test/definition.test.ts`: fan-out, nested config, conftest, non-ASCII deletion, hash follows the tree, a git failure throws.
- `core.test.ts`: `noTestsRan` misfire cases.

**Residual risk**
- A test rewritten to be weaker *and* still passing on correct code is caught only by the original suite. A brand-new weak test on new code is not distinguishable from a good one; the eval keeps a deliberate `weak-tests` case at 1/7 false passes.
- Coverage is limited to the Node, Python and Go ecosystems listed above.

## P1-1 Approval bypass through argument forms — `5afe983`

**Probe.** All 8 forms were classified `shell.safe`: `git -c…`, `git grep -O`, `--open-files-in-pager`, `--ext-diff`, `--output`, `find -exec`, `sort --compress-program`, `rg --pre`.

**Change** (`packages/policy`). Per-program argument deny patterns (`EXEC_ARGS`). The following are now privileged:
- git global options before the subcommand;
- `git branch` writes;
- `npm/pnpm exec`;
- config overrides (`--script-shell`, `--userconfig`, …);
- `node --require/--import/--loader`.

**Evidence.** Policy unit table: 22 bypass forms are privileged, and the plain forms are still safe.

## P0-4 Orphaned processes after a daemon crash — `0f1dba3`, hardened in `d20546b`

**Probe (baseline).** After a hard daemon kill, an unsandboxed command was reparented to PID 1 and kept running. Under bwrap it was clean (`--die-with-parent`).

**Change**
- `packages/terminal/src/journal.ts` records every spawned process (`run`, `startProcess`, PTYs) in SQLite `process_journal` with an OS identity: start time plus boot id on Linux, `ps lstart` on macOS.
- On start, the daemon kills journaled process groups whose identity still matches. It does this before `recover()`.

**Independent review** (subagent). Findings and fixes:
- **Major: survivors were missed when the leader died first.** If `npm` exits but its server keeps running, the leader's identity no longer matches, so nothing was reaped. *Fixed:* when the leader's pid is free, members of the group it led are found by pgid and start time ≥ the leader's. When the pid is alive under another identity, it was reused, and POSIX never reuses a pid while a group with that id exists, so nothing is searched.
- **Major: `startProcess` did not kill its group on exit.** *Fixed:* it now does, like `run()`.
- **Major: Xvfb was never journaled.** *Fixed.* The Playwright Chromium is not journaled; it exits when its pipe closes.
- **Major: no single-instance protection.** A second app launch would reap the first instance's live work. *Fixed:* a daemon lock file per data directory (identity-checked; stale locks are taken over), plus Electron `requestSingleInstanceLock`.
- **Minor: no boot id.** A row from a previous boot could match. *Fixed:* the boot id is part of the Linux identity.
- **Minor: EPERM kills were counted as killed.** *Fixed.*
- **Open: Windows.** The helper holds a kill-on-close Job Object but does not watch its parent, so after a daemon crash a sandboxed child lives until it exits. Unsandboxed Windows commands get no job. Recorded in [06-security-review.md](06-security-review.md).
- **Open, minor:**
  - `journalStart` is synchronous per spawn; on macOS it calls `ps`.
  - PTY shells started with `nohup`/`setsid` escape the group.

**Evidence** (`tests/integration/orphans.test.ts`, run in a child process that is SIGKILLed mid-command):
- the survivor is reaped;
- a pid-reuse (identity mismatch) row is not killed;
- a dead leader's surviving group member is reaped while a bystander group is untouched;
- a finished command leaves the journal empty.

`apps/daemon/test/reap.test.ts`:
- the daemon kills a journaled orphan on start;
- a second daemon on the same data directory refuses to start and kills nothing, then takes over a stale lock.

## P1-3 Uncommitted work destroyed by `worktree remove --force` — `0f1dba3`, hardened in `d20546b`

**Change**
- `preserveWorktree` snapshots dirty and untracked state through a temporary `GIT_INDEX_FILE` into `refs/atlas/preserved/<mission>/<worktree>/uncommitted`, and keeps the branch tip at `…/branch`.
- The user's index and checkout are never touched.
- Deleting a mission deletes its refs.

**Independent review.** Findings and fixes:
- **Blocker: a failed snapshot still destroyed the work.** A path git refuses (e.g. `GIT~1/` under `core.protectNTFS`), an unreadable file, or a status error meant nothing was preserved, and the worktree was still force-removed. *Fixed:* `retireWorktree` keeps the directory and branch and returns a `retained` reason, which is recorded as a `workspace.worktree {action:'retained'}` event.
- **Major: nested repositories became bare gitlinks.** If an agent ran `git init` or a scaffolder, the nested repo was recorded only as a gitlink, so its files and history were lost. *Fixed:* new gitlinks in the snapshot tree mean the worktree is retained.
- **Major: `git worktree prune` ran on the user's repository.** It deleted the metadata of the user's own temporarily missing worktrees. *Fixed:* only the ATLAS worktree's admin directory is removed.
- **Minor: automatic retention purged cancelled, undecided missions.** *Fixed:* automatic purge is limited to decided or archived missions.
- **Minor: refs were recorded only at the end of `decide`.** *Fixed:* they are recorded per worktree.
- **Open, minor:**
  - Ignored files (e.g. `.env`) are not captured. This is documented.
  - Preserved refs accumulate until the mission is deleted.

**Evidence**
- `packages/workspace/test/workspace.test.ts` › "retireWorktree keeps what it cannot preserve":
  - a refused path, and a nested repository: both retained;
  - a normal dirty worktree is preserved and removed, and the user's moved worktree is still listed.
- Integration: a reject preserves the dirty file and the branch ref; delete removes the refs; a cancelled mission is never auto-purged.

## P1-2 Unsandboxed mode ran project code without approval — `e2084e8`

**Change**
- `evaluate()` takes a required `sandboxed` flag.
- Without a sandbox, safe-listed commands that run project code (npm/pnpm/yarn test and run, npx dev tools, `node <file>`, `tsc`, `run_tests`) return `ask` with a "No OS sandbox" reason.
- Read-only commands stay allowed.
- The Settings copy now states this.

**Evidence**
- Policy unit tests for both modes, including a tester's `run_tests`.
- Integration (`tests/integration/sandbox.test.ts`): with approval the mission is verified; with denial no agent process starts.

## P1-6 Stalled attempts looked healthy — `2c2afb4`

**Change**
- A watchdog emits `attempt.stalled` once per silence when a running attempt has produced no event for `stallAfterMs` (default 120 s).
- A pending approval does not count as a stall.
- The attempt is not stopped.
- The task row shows "No signal" until the attempt produces an event.

**Evidence**
- Integration: the stall is flagged once and not repeated while an approval is pending, and the attempt still succeeds.
- Unit: `stalledTasks()`.

**Note.** This slice introduced a hook-order bug (a `useMemo` after an early return) that blanked the mission view. The full Electron e2e suite caught it, not lint: the ESLint config has no react-hooks rule. It was fixed in `d20546b` before CI ran that code.

## P1-4 Resource guards — `6645eb5`

**Change.** A task or integration worktree is refused below `worktrees.minFreeMiB` (default 1024) or at `worktrees.maxPerMission` (default 40), with a typed `resource_limit` reason.

**Evidence.** Integration with an injected `diskFree`; a cap of 1.

## P1-5 Operator terminal died with its tab — `fdf2dce`

**Change**
- Sessions live in the daemon. The view attaches and detaches; Close, the mission decision, delete or daemon stop ends a session.
- `terminal.list`, `terminal.attach` (snapshot + seq) and `terminal.resize`.
- The view subscribes before taking the snapshot, and each push carries `seq` (`attachGate`).
- Output is coalesced at 8 ms or 16 KB.
- Resize applies `TIOCSWINSZ` via `stty` on the shell's terminal. On Linux the terminal is reached through `/proc/<pid>/fd/0`, which crosses bwrap's private devpts. Resize is unsupported on Windows.

**Evidence**
- `pty.test.ts`: resize from outside the sandbox (`stty size` → `43 132`).
- `termSync.test.ts`.
- e2e `capabilities.spec.ts`: type, switch tab, return; history and shell variables are intact; Close works.

**Measurement.** Echo latency medians were 92 ms and 160 ms in two runs, against a 182 ms single-run baseline. That is within run-to-run variance. **No latency improvement is claimed.**

## P0-5 macOS — `64cffcd`, `b8ec01c`

**Evidence from CI.**
- Run 38101667968: `sandbox-exec` allowed reads *and writes* anywhere in `$TMPDIR` (the sandbox test read and wrote a sibling temp directory).
- Denying reads under `/Users` also denied `lstat` on the ancestors of granted paths, so Node's `realpath` failed, and with it every mission check.

**Change**
- `seatbeltProfile()` is a pure function, unit-tested on every platform. It denies reads under home, `/Users`, `/Volumes`, the per-user temp directory and `/private/tmp`, except granted paths. Parents of granted paths get `file-read-metadata` only.
- Each command gets a private scratch `HOME`/`TMPDIR`, which is removed when the command exits.

**Result.** In CI run 38102776208 macOS **unit, integration and eval passed**.

**Remaining failure: the e2e terminal.** BSD `script` exits with `tcgetattr: Operation not supported on socket`, because Node's stdio pipes are socketpairs on macOS. Fixed in `b8ec01c` by giving `script` a real pipe (`cat |`). The next run failed with `openpty: Operation not permitted`. `6317668` allows the PTY devices only for operator terminal sessions (agent commands still cannot open `/dev/ttys*`). **Result: macOS CI fully green (run 38107974496).**

## P0-6 Windows — `fd796ff`, `b8ec01c` (in progress)

**Evidence from CI and fixes so far**
1. The C# helper compile raced between parallel workers (`CS0016`). Fixed with an atomic compile-and-rename.
2. Inside the AppContainer, Node fails with `EPERM lstat 'C:\'` (its JS realpath walks ancestors). Sandboxed Node now runs with `--preserve-symlinks --preserve-symlinks-main`, rather than ATLAS changing the ACL of the drive root.
3. `npm test` reports "Access is denied." from `cmd.exe`. The CI bisection (run 38109076836) isolated the cause:
   - The toolchain capability ACE is present on the Node directory.
   - Node inside the container can list and read that directory.
   - `cmd.exe` cannot: it resolves paths with `FindFirstFile` on every ancestor (`C:\`, the tool cache), which the container may not list.

   **Fix (`a351f34`):** npm's and cmd-shim's `.cmd` shims are resolved to the script they wrap and run as `node <script>`. cmd.exe no longer starts inside the sandbox for package managers, and no system ACL is changed.
4. The helper now terminates its Job Object when the daemon exits (`--parent`).

**Status.** Windows is **not** green. The status is maintained in [05-test-evidence.md](05-test-evidence.md).

## P2-1 Daemon idle memory

**Measurement.** Importing `@earendil-works/pi-coding-agent` costs about 89 MB of RSS; `playwright-core` costs about 36 MB. Both were loaded at daemon start, even when no Pi mission or browser check ever ran.

**Change.**
- The Pi adapter imports the SDK on first use; types stay static.
- `playwright-core` is required when a browser is looked up or launched.

**Evidence.**
- Daemon utility-process RSS from `pnpm metrics` went from 180–181 MB to 134 MB and 135 MB (two runs).
- Runtime-pi contract tests pass (9).
- Browser integration tests pass (4).

## Final audit (Phase 9)

An independent agent re-ran every suite and matched the documented counts exactly. It then tried to break the highest-stakes fixes.

**Findings.**
1. **High: long-option abbreviations bypassed P1-1.** `sort --compress-p=`, `sort --out=` and `git grep --open-files=` were reproduced with the real tools. Fixed: any long option that is a prefix of a dangerous name is privileged. A table test covers the abbreviations and confirms safe options stay safe.
2. **Medium: export integrity was overclaimed.** Hashes are unkeyed, so a forger who recomputes them is not detected. The docs are corrected to "tamper-evidence, not authenticity", and signing is recorded as an open risk.

The auditor also confirmed several fixes against new scenarios (could not break them):
- P0-3, including an additive-check laundering attempt;
- P1-3;
- the early-kill fix;
- the P1-2 denial path.

## Not done
- **P2-2 (live preview browser):** not attempted.
- **P3:** not attempted.
## Linux CI timeouts — root-caused and fixed (`29b9a42`)

**Symptom.** Intermittent 60 s timeouts in tests that cancel a sandboxed command.

**Root cause.** bwrap's child runs in its own session. When bwrap was killed during namespace setup, before the child had armed `--die-with-parent`, the child survived holding our pipes, so `run()` never resolved. This reproduced under load: 118 of 150 early cancels hung.

**Fix.**
- The sandboxed child's pid is read from `--json-status-fd`, and both process groups are killed.
- After the leader exits, the pipes are given a bounded wait.

**Evidence.**
- 0 of 150 hung under the same load.
- A regression test asserts no hang and no survivor.
- Linux CI has been green on every run since.

---

# Round 2 (operator priorities)

## Independent acceptance verification — `1d8a345`
- **Problem.** The eval's `weak-tests` case is an overfit fix: a lookup table that passes every visible test. It was a false pass, and nothing in the gate could catch it, because the agent can read and satisfy every test in the repository.
- **Change.** Holdout acceptance suites.
  - Operators keep acceptance tests in ATLAS's data directory, never in the repository.
  - Agents cannot read them: their sandbox sees only their worktree. The integration test proves an agent that knows the storage path reads nothing.
  - At the gate the suite is written to `.atlas-acceptance/` in the integration worktree, run in the sandbox as the required check `acceptance (holdout)` (named by content hash), and removed. A planted `.atlas-acceptance` symlink cannot redirect writes.
  - UI: Projects → "Holdout acceptance tests".
- **Evidence.**
  - `tests/integration/acceptance.test.ts`: 12 tests.
  - eval: the new `weak-tests-holdout` case is correctly `failed`. The original `weak-tests` (no holdout) still counts as a false pass, so the limitation stays visible.
  - e2e `acceptance.spec.ts`.

## Skills — `7fa8278` (ADR 0013)
- **Library.** Bundled and operator skills are trusted. Repository skills (`.agents/skills`, `.pi/skills`) are listed as untrusted and offered only after an import pinned to the reviewed hash.
- **Loading.** Agents see an index of skills and load them through the governed tools `load_skill` / `read_skill_file`. Each load is recorded with its hash.
- **Bundled skills (7):**
  - `reproduce-before-fix`
  - `skeptical-review`
  - `architecture-tournament`
  - `ruthless-simplifier`
  - `deployment-detective`
  - `experimental-scientist`
  - `evidence-report`
- **Skill Laboratory.** `pnpm lab:skills` compares the corpus with and without skills on the same runtime and model. On the scripted runtime both arms are identical by construction (the report says so). **No skill benefit has been measured**: that needs a live model.
- **Evidence.** Unit (10), integration (3), and e2e `skills.spec.ts`, which shows the built app finds the bundled library.

## Signed evidence exports — `e4b334b`
- Each installation has an Ed25519 key, and the export trailer is signed.
- Import refuses an invalid signature and records provenance: unsigned, this installation, a trusted key, or an untrusted key.
- This closes the final audit's forgery finding:
  - keeping the old signature after recomputing hashes → refused;
  - re-signing with another key → shown as "untrusted key", never as the original signer.
- **Found while testing:** an imported read-only archive offered Accept and Reject. Fixed in the UI and in the orchestrator.

## Live Pi integration test — `47a9936`
- `pnpm test:live` runs a real Pi mission, with and without the bundled skills. It passes only if:
  - the gate verifies the result;
  - a hidden oracle agrees;
  - privileged requests are denied;
  - no provider key appears in the export.
- **Not run here: no provider key in this environment.**

## Toolchain upgrades — `a9c7e71`
- vitest 4, vite 7, esbuild 0.25, electron-builder 26.17, eslint 9.39 and typescript-eslint 8.71, with a full regression run.
- Audit advisories went from 30 to 1. The remaining one is build-time and has no upstream fix.

## Windows — `a351f34`, `dcab0bc` (in progress)
- **Shim fix confirmed.** `npm.cmd` is now run as `node npm-cli.js`. CI run 38118446488 shows npm working inside the AppContainer: the bisection test passed.
- **Next blocker.** `npm test` hangs inside the container, and a probe that spawns children never writes its pid file.
- **Hypothesis:** libuv's piped child stdio needs a named pipe the AppContainer may not create. Diagnostics are on CI now.

## Durable Pi sessions — ADR 0014
- **What changed.** A daemon restart no longer throws away a running attempt's work. Pi sessions are now saved per attempt. On recovery:
  - the lost worktree is committed, uncommitted edits included;
  - the next attempt starts from that commit;
  - the next attempt continues the lost conversation, using Pi's `forkFrom` into a new attempt and worktree.
- **Found while testing:**
  - **Unanswered tool calls.** A crash mid-command leaves a tool call with no result. The faux model received exactly that, and real providers would replace it with a generic "No result provided". The adapter now closes such calls itself, with a message saying the command was interrupted.
  - **Cleanup leak.** Saved conversations for lost attempts whose task was no longer running were not deleted at recovery. Fixed.
- **Tests:**
  - 3 unit tests: crash mid-command, fresh fallback, path-like ids refused;
  - 2 integration tests: a full mission across a daemon restart, verified, plus the case where the worktree is gone.

## GitHub PR/CI feedback loop — ADR 0015
- **What it does.** After an accepted, verified mission:
  - *Open pull request* pushes the branch, never force-pushing, and opens or reuses a pull request;
  - CI checks are read on demand and polled while unfinished;
  - *Fix CI failures* creates a follow-up mission. It starts from the pull request head as it is on GitHub now, carries the CI output as quoted data, needs plan approval, and fast-forwards the same pull request when published.
- **Token.** The GitHub token is stored like model keys and passed to the daemon only. Git receives it through environment config, never arguments, and it is redacted everywhere.
- **Found while testing:** the e2e launcher stripped `ATLAS_GITHUB_TOKEN` after merging the test's own environment, so the app reported "no token". Fixed. The daemon now logs whether a GitHub token is configured; it logs presence only, never the value.
- **Tests:**
  - 7 unit tests;
  - 4 integration tests: the full loop, refusing to overwrite a moved branch, a follow-up from someone else's commit, and the refusals;
  - 1 Electron e2e.
- **Limits:** github.com only. API calls ignore `HTTPS_PROXY`.

## Windows — child processes in the AppContainer (CI run 38127174519)
- **Bisection inside the AppContainer**, one bounded step at a time:

  | Step | Result |
  |---|---|
  | cmd.exe, node by path, `npm --version` | ✓ |
  | child with inherited stdio | ✓ |
  | child with piped stdio | hangs (8 s limit) |
  | child with `stdio: 'ignore'` | `EPERM` in 4 ms |

- **What this means.** Every test runner that collects worker output through pipes, including `node --test` behind `npm test`, hangs inside the container. That is why missions on Windows cannot verify.
- **Hypothesis.** libuv backs piped stdio with a named pipe (`\\.\pipe\uv\…`), and an AppContainer may create pipes only under `LOCAL\`.
- **A probe of ours was wrong.** It printed "named pipe: EACCES", but that probe listened on a mis-escaped path, not a pipe. It is rebuilt now, and a `LOCAL\` variant is added, so the next run tests the hypothesis directly.
- **If confirmed, the options are:**
  1. A restricted-token sandbox: a deny-only user SID plus a low-integrity job, as Chromium's legacy sandbox does. It keeps file isolation through ACLs, but its pipe rules have to be tested.
  2. A helper that pre-creates the stdio pipes in the container's namespace and hands them over. That works for the first process only; its children still use libuv.
  3. Documenting Windows as unsupported for running project code.

  This choice needs an ADR and evidence from the next run.
- **Hypothesis confirmed (CI run 38130392107).** A pipe in the global namespace is refused inside the container, and the same pipe under `LOCAL\` is created. libuv offers no way to change its pipe names, so piped children cannot work in an AppContainer. The options and a recommendation are in ADR 0016 (proposed; the operator decides).

## Windows restricted-token experiment (ADR 0016, operator-approved), rounds 1–5
- **Design.** The helper gained `run - --restricted SIDLIST [--low]`: the operator's token, with the user and all groups except a basic allowlist made deny-only, no privileges, and restricting SIDs. It also gained `grant` (ACEs for SIDs that are not accounts) and `pipetest`, a diagnostic. Nothing in ATLAS uses this mode yet.
- **Shown so far** (CI runs 38156630914 through 38162335938), for variant **H** (everyone, users, authenticated users and a per-root SID; low integrity; the own SID granted on the window station and desktop):
  - home and outside canaries are unreadable;
  - **another task's root is unreadable**;
  - writes land only in the root (outside it and in `C:\Users\Public` they are denied);
  - global named pipes can be created.
- **Not working yet:**
  - **Piped child processes.** `pipetest` shows the pipe server is created, but opening its client end is denied (error 5). The next run prints the pipe's actual DACL and integrity label.
  - **Network** is not blocked by any variant. The operator accepted this, with a proxy guard and a "network not enforced" label.
- **Ruled out:**
  - capability SIDs as restricting SIDs (error 87);
  - restricting lists without Everyone, where Node cannot start;
  - the logon SID in the restricting list, which lets one task read another's root.
- **Paused (2026-10-11).** Round 6 (CI run 38163323568) recorded the security descriptor the pipe receives under the restricted token. The client end of the pipe is still denied (error 5). The experiment stops here and nothing in ATLAS uses this mode. Windows stays fail-closed: no pass is ever reported, and verification runs on Linux, macOS or WSL2. The helper's experimental subcommands stay in the source, used only by the diagnostic test.
