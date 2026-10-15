# ADR 0031 — Git metadata is daemon-owned

Status: accepted · 2026-10-15

## Context
An agent can write its worktree. ATLAS's daemon then runs git over that tree, outside any sandbox, to checkpoint,
diff, preserve and merge it. Until now it ran git the way a user would:

- `isolationFor` bound the worktree's admin dir (`<repo>/.git/worktrees/<id>`) read-write and the worktree root
  writable, so a `shell_exec` could rewrite the `<worktree>/.git` pointer file or the admin dir's files.
- git found the repository through that pointer file and read the configuration and attributes it found there.
- `git.ts` neutralized only `core.hooksPath`, `core.fsmonitor` and `diff.external`.

So an agent could point `.git` at a git dir it planted, whose config defines `filter.x.clean`, add `* filter=x` to
`.gitattributes`, and the daemon's next `git add -A` (in `checkpoint()` or `preserveWorktree()`) ran the agent's
program as the operator. A `diff.<d>.textconv` worked the same way through any daemon diff. The feasibility panel
reproduced it (`PWNED_CLEAN`). The first test of this change reproduces it on the unfixed code (red, the mark exists),
then passes on the fix.

Implementing the fix found four more problems:

- **Nested repositories.** An agent's `git init` (create-vite, cargo new) inside the tree has its own config and
  `.git/info/attributes`. Once a checkpoint records it as a gitlink, `git status`, a worktree `git diff` and even
  `git add -A` start `git status` inside it, under its configuration. A filter planted there ran from ATLAS's
  status and checkpoint even with every other fix in place. A `.gitmodules` with `ignore = none` overrides a
  configured `diff.ignoreSubmodules`.
- **`removeWorktree`** read the admin dir to delete from the pointer file. A rewritten pointer could make the daemon
  delete another worktree's metadata.
- **HEAD** lives in the writable admin dir. Pointing it at `refs/heads/main` made the next checkpoint commit onto the
  user's branch.
- **`-c include.path=`**, which the design listed, makes git refuse to start ("relative config includes must come
  from files"). It is not used.

Every later backlog item (repair loops, best-of-N, scratch base worktrees, mutation testing) runs git over
agent-written trees more often, so this goes first.

## Alternatives
- **Keep discovery and add more `-c` overrides.** The list of configuration that can name a program is long and
  grows with git. A redirected pointer brings an entire planted repository, so no list is complete.
- **Only make the metadata read-only in the sandbox.** It is needed, but it is not enough on its own:
  - there is no deny-write ACL on Windows yet;
  - the operator's unsandboxed mode has no sandbox at all;
  - the guarantee depends on every bind being right on every platform.
- **Read the tree in the daemon without git** (copy files, hash them, build trees). This reimplements `add`, `diff`
  and `merge`.
- **Read attributes from the mission's base commit** (`GIT_ATTR_SOURCE=<base tree>`) instead of the empty tree, so
  LFS and line-ending rules keep applying. Base content can come from earlier merged agent work, and drivers that the
  repository's config defines may run scripts inside the tree. The empty tree is simpler to reason about: no
  attribute selects anything.
- **Chosen:** the daemon names every location explicitly, verifies the metadata it owns before each call, reads no
  global or system configuration, lets no attribute select a driver and never starts git inside a nested repository.
  The sandbox makes the metadata read-only as defense in depth.

Prior art:
- Claude Code disables filter drivers when it creates a worktree and refuses `core.worktree` redirects.
- Codex's `workspace-write` mode makes `.git` and the resolved git dir read-only.

## Decision
- **Pins** (`packages/workspace/src/pinned.ts`):
  - `addWorktree` pins the worktree right after `git worktree add`, before any agent runs.
  - The admin dir is found from the repository side, never from the pointer: the entry of
    `<common>/worktrees/*` whose `gitdir` points back at `<worktree>/.git`. Exactly one must match.
  - What git just wrote is recorded: the admin dir, the common dir, `HEAD` (`ref: refs/heads/<branch>`) and the
    sha-256 of `config.worktree` (git copies the main worktree's when `extensions.worktreeConfig` is on, as
    `git sparse-checkout` sets it). The record is also written to `<admin dir>/atlas-pin.json`, which the sandbox
    cannot write.
  - After a restart, the orchestrator's `TamperWatch` declares `<data>/worktrees` a managed root. A worktree there is
    pinned again through its mission's repository and the record. A worktree from before this ADR has no record: it
    must be on an `atlas/` branch and have no `config.worktree`. A path under the root that no mission owns is
    refused, never discovered.
- **Every daemon git call on a worktree is pinned.** `git()` routes any call whose directory is inside a pinned or
  managed worktree through `gitPinned(worktree, adminDir, args, opts)`; the user's own checkout runs as before. This
  covers, without changing their call sites, ToolGate's `git_status`, `view_diff` and `mission_memory`, the context
  diff, the code graph, the security scan, visual proof's `checkout-index`, integration merges and the release-gate
  restores. `checkpoint`, `diffSince` and `preserveWorktree` require a pin.
- **A pinned call:**
  - `--git-dir=<admin dir> --work-tree=<worktree>` and `GIT_COMMON_DIR=<common dir>`, so neither the pointer nor the
    admin dir's `commondir` file is read for locations;
  - `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, and `GIT_ATTR_SOURCE=<empty tree>` in the normal mode;
  - the existing flags plus `-c core.attributesFile=/dev/null -c core.pager=cat -c core.sshCommand=false
    -c diff.ignoreSubmodules=dirty -c status.submoduleSummary=false -c submodule.recurse=false`;
  - `diff` always gets `--no-ext-diff --no-textconv --ignore-submodules=dirty`, and a caller's `--ext-diff`,
    `--textconv` or `--ignore-submodules` is dropped; `status` gets `--ignore-submodules=dirty`;
  - `add` excludes populated gitlinks by pathspec, because `git add` ignores every submodule setting;
  - no caller-supplied `GIT_*` variable except `GIT_INDEX_FILE`.
- **`verifyWorktreeMetadata(worktree, adminDir)`** runs before each pinned call. It requires:
  - the admin dir is a real directory in `<common>/worktrees/`;
  - `<worktree>/.git` is a regular file, not a symlink, that says exactly `gitdir: <admin dir>`;
  - `<admin dir>/gitdir` points back to it;
  - `<admin dir>/commondir` resolves to the common dir;
  - `config.worktree` exists only as recorded;
  - `HEAD` is the branch ATLAS created.

  A mismatch throws `WorktreeTampered` (kind `workspace_conflict`).
- **Tampering in a mission** (`packages/orchestrator/src/tamper.ts`):
  - The refusal is recorded as a new `workspace.tampered {worktree, field, detail}` event, and the attempt is
    stopped.
  - The attempt fails as non-retryable (`workspace_conflict`), with no checkpoint.
  - The tree is snapshotted under `refs/atlas/preserved/<mission>/<task>-<n>-tampered`. The snapshot uses the
    repository's own git dir and a throwaway index started from the task branch, so none of the tampered metadata is
    used and nothing in the tree runs. Planted files are part of the snapshot.
  - The worktree stays on disk. Retiring it keeps it, with the reason recorded. A tampered worktree is never resumed
    after a restart.
- **Before git 2.40**, or when a probe shows that `GIT_ATTR_SOURCE` is not honoured, every driver name is disabled
  with `-c filter.<d>.clean= -c filter.<d>.smudge= -c filter.<d>.process= -c filter.<d>.required=false
  -c diff.<d>.textconv= -c diff.<d>.command=`. The names come from two places:
  - every `.gitattributes`, read as text by the daemon: in each directory that holds a tracked or non-ignored file,
    plus tracked ones that exist only in the index;
  - every filter and diff driver defined in the configuration the call reads, since a driver runs only if it is
    defined. This also covers macros and quoting that a text parse could miss.

  A name containing `=` or a newline cannot be passed with `-c`, so the call fails closed. `pnpm doctor`, `app.info`
  and Settings › About report the git version and the mode in use.
- **Sandbox** (`packages/terminal/src/sandbox.ts`):
  - `SandboxSpec.protect` lists paths that stay read-only inside the writable root.
  - bubblewrap binds them `--ro-bind` after the root and its writable paths. A read-only path inside the root was
    otherwise overlaid by the root's writable bind. A missing protected path fails the command.
  - Seatbelt denies `file-write*` on them as its last rule.
  - Windows: TODO, no deny-write ACE yet, so `<worktree>/.git` stays writable inside the granted root. The pinned
    calls never follow it (a rewritten pointer only makes ATLAS refuse the worktree), and the admin dir is now granted
    read-only to the sandbox account instead of read-write. Not tested on Windows in this change.
  - `isolationFor` takes its paths from the pin: the common dir and the admin dir are read-only, nothing is
    read-write, and `<worktree>/.git` and the admin dir are protected.

## Consequences
- **Inside the sandbox**, agents and operator terminals can run `git status`, `git diff` and `git log`; the index
  refresh cannot write and is skipped. They cannot commit, stash, check out or switch branches. ATLAS checkpoints
  (ADR 0008).
- **ATLAS's own `add`, `diff` and `merge` ignore in-tree attributes and global configuration:**
  - An LFS-tracked file an agent changes is committed as its bytes, not as a pointer.
  - Line-ending normalization and merge or diff drivers named in `.gitattributes` do not apply to checkpoints,
    patches and integration merges.
  - Worktree creation still checks out with the repository's configuration, so agents see LFS content. On
    repositories that convert line endings at checkout, a file git must re-read can show as changed.
- **Nested repositories:** a gitlink's later commits are not recorded by later checkpoints. Their files never were
  (`preserveWorktree` already keeps such worktrees).
- **Residual risks:**
  - Worktree creation checks out a commit with the repository's own configuration. For integration and delegation
    worktrees that commit is an agent's checkpoint, so its `.gitattributes` can select (not define) a driver the
    operator configured, such as the git-lfs smudge filter. A follow-up could create worktrees with `--no-checkout`
    and check out through a pinned call.
  - `config.worktree` and `HEAD` are verified and then git runs. That window matters only if something can still
    write the admin dir: the sandbox cannot on Linux and macOS, and Windows grants it read-only. Admin dirs of
    worktrees created before this change keep the read-write grant they were given on Windows.
  - Seatbelt's deny rule is checked as profile text on every platform. Its behavioural test expects `EPERM` on
    macOS, but in this change it ran only under bubblewrap (Linux).
- **Cost:** a pinned call adds a few small file reads. In fallback mode it adds two git listings per call.
- **Tests:**
  - `packages/workspace/test/git-hardening.test.ts`. Negative tests plant a program that leaves a mark, assert the
    mark never appears, and run a control showing the same tree runs it under ATLAS's previous git invocation:
    - the planted git dir pointer, red before the fix: checkpoint fails closed with `workspace.tampered`, the
      planted filter never runs and no branch moves;
    - `status`, `diff` and `rev-parse` refused on the same tree;
    - a planted `config.worktree`, a redirected `commondir`, a symlinked `.git`, and `HEAD` pointed at `main`;
    - a filter defined in the repository's config and selected by the agent's `.gitattributes`;
    - `diff.x.textconv` and `diff.x.command` never run by `diffSince` or worktree diffs, even when asked for
      `--ext-diff --textconv`;
    - a nested repository's filter never run by checkpoint, status or diff;
    - `removeWorktree` never deleting another worktree's admin dir;
    - retire keeping a tampered tree, and the audit snapshot;
    - re-pinning after a restart from the record, with tampering still refused and unowned paths refused;
    - the fallback with git mocked at 2.39: filters, textconv, macros and nested `.gitattributes` neutralized, and a
      name that cannot be neutralized failing closed;
    - positive: a normal checkpoint records exactly the agent's bytes, and an LFS repository with a required filter
      checkpoints the worktree bytes.
  - `packages/terminal/test/sandbox.test.ts`: under bubblewrap, writes to `.git`, unlink and rename of `.git`, and
    writes to the admin dir's `config.worktree` and `HEAD` fail with `EROFS` or `EBUSY`, while the root stays
    writable. `seatbelt.test.ts` checks the profile's last rule.
  - `tests/integration/sandbox.test.ts`:
    - In a sandboxed mission, an agent's writes to its git metadata fail with `EROFS`, `git status` from
      `shell_exec` exits 0 and lists its change, and the checkpoint is as before.
    - In an unsandboxed mission, a rewritten pointer fails the attempt once and non-retryably with
      `workspace.tampered`, never runs the planted filter, and keeps the tree under `refs/atlas/preserved`.
