# ADR 0021 — Team spaces: people and agents working on one repository

Status: accepted · 2026-10-12

## Context
Until now, ATLAS had one operator per installation. The operator asked for teams: several people, with or without
their own agents, working on the same code and seeing each other's work. That covers several teams per repository,
not only agents.

The first-release exclusions in the manual (§3: "accounts, team administration, a hosted marketplace") and the
evolution non-negotiables still hold:
- no billing, subscriptions or commercial account system;
- no hosted multi-tenant service;
- credentials never reach agents or other repositories;
- incremental and reversible changes.

So collaboration has to work without an ATLAS server and without accounts.

## Alternatives
1. **A hosted ATLAS team service with accounts.** Rejected: it is an account system and a hosted multi-tenant
   service, both excluded.
2. **One member's daemon serving the others over the network.** Rejected:
   - it exposes the privileged control plane (the only process that executes anything) to other machines;
   - it adds authentication, network listeners and uptime;
   - when that member is offline, the team is offline.
3. **The forge's own objects (GitHub issues and comments) as the shared state.** Rejected as the foundation:
   - it is GitHub-only and rate-limited;
   - it mixes ATLAS records into the project's issue tracker;
   - a member cannot verify who wrote what beyond the forge's account.
   It remains possible later as a mirror.
4. **A signed, append-only record in the repository's own git remote.** Chosen.

## Decision
- **Record.** A team space is the ref `refs/atlas/team` in the repository.
  - Each entry is one file `entries/<id>.json`, where the id is the SHA-256 of its canonical content.
  - Each entry is signed with the installation's Ed25519 key, the same key that signs evidence exports (R2-3).
  - Files never change once written. Two histories therefore merge by taking the union of their files, so there is
    never a conflict to resolve.
- **Sharing is `git fetch` and `git push` of that ref to `origin`.**
  - The push is a plain fast-forward. When the origin moved, ATLAS fetches, merges (a merge commit) and pushes again,
    up to five rounds.
  - Nothing is ever force-pushed, and no branch is touched.
  - For a github.com origin, the GitHub token from Settings is used through the environment, as in ADR 0015.
    Otherwise, the operator's own git setup is used (SSH agent, credential helpers).
  - Hooks, fsmonitor, external diff programs, and transport programs from repository config are disabled, as for
    every ATLAS git call.
- **Reading is deterministic.**
  - Every installation folds the same entries in the same order (author timestamp, then id) with the same rules
    (`packages/team/src/fold.ts`). Everyone sees the same team without a server deciding.
  - An entry that breaks a rule stays in the record with no effect, and the view lists it with the reason. Rule
    breaks include: bad signature, content that does not match the id, an author who is not a member, or an action
    the author is not allowed.
  - ATLAS refuses to write an entry the rules would reject.
- **Membership.** A member is an installation key.
  - The creator is the first maintainer.
  - A maintainer can create an invitation. The code (120 random bits, shown once) derives an Ed25519 key, and only
    its public half is published in the record.
  - Whoever holds the code proves it by signing their own key id, bound to the space and the invitation. They are
    admitted as soon as both sides sync, with no approval step.
  - Invitations expire and have a use count.
  - Without a code, a person asks to join and a maintainer admits them.
  - Members can leave, and maintainers can remove members. A space always keeps one maintainer.
  - Each key's fingerprint is shown so people can compare it out of band.
- **Teams** group members. A team can:
  - own paths (CODEOWNERS-like patterns);
  - name the model its agents use.
- **Work items** form a board with Open, In progress, In review and Done.
  - An item can be assigned to a person, to nobody, or to the agents of a team.
  - Claiming an item is refused when someone else already has it. Two claims made offline resolve to the same
    winner everywhere.
  - Starting a mission for an item claims it and shares the mission. The item moves to review when the mission is
    verified, and to done when the pipeline reports ready to merge (ADR 0022).
- **Shared missions.** A member can share a mission, or turn on sharing every mission of the repository.
  - A shared mission is published as a snapshot and kept current as it runs.
  - The snapshot holds: state, verdict, decision, plan summary and hash, tasks, checks, changed files, pull request
    and CI, pipeline stage, and the change as a redacted diff of at most 200 kB.
  - Teammates can comment and review it: approve, or request changes, on a specific commit.
- **Owner approval gates publishing.** If the change touches paths a team owns, publishing (ADR 0015) is refused
  until that commit has an approving review from a member of that team other than the author.
  - If that team has no other member, a maintainer can approve.
  - A later review of the same commit replaces the reviewer's earlier one.
  - A new commit needs new approval.
- **Teammates approve plans.** A teammate can approve a shared plan. The approval binds to the plan's version and
  content hash.
  - The installation running the mission acts on it only if its operator turned on "Start plans teammates approve",
    or the mission was started by its runner.
  - It is recorded as `plan.approved` by a `teammate` actor.
  - Tool approvals (risky commands) are never answered through the team record. They stay with the person whose
    machine runs the command.
- **Runner.** An operator can let their machine run the work the team assigns to agents. The runner:
  - takes one item at a time, up to two in progress, for the teams it serves;
  - claims it first, plans it as a mission in its own sandbox with its own keys, and shares it;
  - waits for a teammate's plan approval;
  - cancels its mission if another runner's claim won.
- **Sync.** "Keep in sync" (on by default once a space exists) fetches and pushes every 30 seconds and right after
  each local change. Repositories without a team space are never contacted (§43). Sync on demand is always available.

## What this is and is not
- **Signatures prove who wrote an entry.** Access to the record is access to the repository. Anyone who can push to
  it could also push code.
- **Owner approval is enforced by ATLAS on ATLAS's publish path.** A determined member can bypass it with plain git.
  Protected branches on the forge are the enforcement point for that.
- **Order uses each author's clock.** A member could backdate an entry. Timestamps are ATLAS's claims, not proof.
  ATLAS stamps its own entries after everything it has seen, so its entries stay in causal order even with a slow
  clock.
- **Nothing in the record is secret from people with repository access.** That includes goals, plans and diffs,
  after redaction of registered secrets. Do not start a team space in a repository whose readers should not see
  ATLAS missions.

## Consequences
- **New pieces.**
  - Package `@atlas/team` (crypto, fold, git store, space).
  - Daemon `TeamHub`.
  - IPC methods `team.*`.
  - Event types `team.shared` and `team.review`.
  - Actor kind `teammate`.
  - Orchestrator option `publishGate`.
  - Team screen (Ctrl/Cmd+2).
- **Growth.** The record grows with activity: each mission update is one small file. Snapshots are written only when
  something a teammate would see changed, and diffs are capped. Compaction is future work.
- **Tests.**
  - `packages/team/test/team.test.ts` (real git, three installations), covering:
    - invite and join, including a single-use code, a wrong code and an expired code;
    - join requests;
    - forged, tampered and non-member entries;
    - concurrent writers converging;
    - contested claims;
    - owner approval rules;
    - removal and leaving;
    - pattern matching and order independence.
  - `tests/integration/team.test.ts` (two full orchestrators with `TeamHub`), covering:
    - the shared diff and the publish gate;
    - teammate plan approval, only when allowed and only for that plan version;
    - a runner taking an item assigned to agents.
  - `tests/e2e-electron/team.spec.ts` (two app instances): create, invite, join, board, mission for an item, owner
    review gating publish.
