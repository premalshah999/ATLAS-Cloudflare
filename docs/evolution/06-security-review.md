# 06 — Security review

Scope: the changes made during this evolution, and the trust boundaries they touch. Method: threat-driven probes, then an independent adversarial review per slice. Three reviewer subagents ran with no write access; their findings and our responses are in [04](04-implementation-log.md). Everything marked "verified" names a test.

## Trust boundaries

| Boundary | Control | Verified by |
|---|---|---|
| Agent → host | Every command goes through ToolGate → policy → executor, inside an OS sandbox (bwrap / Seatbelt / AppContainer) | `sandbox.test.ts` (unit + integration): canary credential, writes outside root, network off |
| Agent → verdict | The verification definition comes from the approved base. Modified tests run the base suite. Approval is hash-bound and is never evidence | `mission.test.ts` › verification cannot be redefined (incl. 6 review bypasses) |
| Agent → approvals | Argument-level classification. Path-qualified programs are never safe. Unsandboxed project code always asks | policy unit tables; `sandbox.test.ts` (integration) approve/deny |
| Renderer → daemon | Frozen 6-key bridge; zod-validated IPC; sender check | `security.spec.ts` (e2e) |
| Evidence at rest → another installation | SHA-256 per artifact, trailer hash over the export; artifacts that fail their checksum are refused on import. The final audit reproduced that unkeyed hashes alone can be recomputed by a forger. **Since then, exports are signed** with a per-installation Ed25519 key (trailer signature over the hash of every record). An import shows the signer: this installation, a key the operator trusts, or an untrusted key. A changed file with the old signature is refused | `archive.test.ts` › signed exports, `faults.test.ts`, e2e provenance badge |
| Daemon restart → leftover processes | Process journal with OS identity; reaper runs only when the identity matches; single daemon per data directory | `orphans.test.ts`, `reap.test.ts` |
| Daemon → GitHub (ADR 0015) | Operator actions only: publishing requires an accepted, verified mission and a confirmation. Push is a plain refspec (never forced). The token goes to the daemon only, never to a runtime; git gets it through `GIT_CONFIG_*` environment variables, with credential helpers off and hooks off. CI output enters a follow-up mission as quoted data, and that mission needs plan approval | `forge.test.ts` (unit + integration), `github.spec.ts` |
| Saved agent conversations (ADR 0014) | Pi sessions persist under the ATLAS data directory only between an attempt's start and end, or until a lost attempt is resumed or recovery decides not to resume it. Attempt ids are validated before use as paths | `runtime-pi/test/resume.test.ts`, `resume.test.ts` |
| Mission cleanup → user's data | Preserve before remove; retain what cannot be preserved; never prune the user's worktrees | `workspace.test.ts`, `mission.test.ts` |

## Findings fixed in this evolution (security-relevant)

| # | Severity | Finding | Fix |
|---|---|---|---|
| S1 | High | **The agent could redefine its own verification**: rewrite a test script or config, gut or skip tests, track `node_modules/.bin/node`, or swap the package manager. The result was "Verified" with no approval | P0-3 |
| S2 | High | **Safe-listed programs ran other programs.** Examples: `git -c`, `find -exec`, `rg --pre`, `sort --compress-program`, `npm exec`, `node --require`. The final audit also reproduced unambiguous **abbreviations** of these options (`sort --compress-p=`, `git grep --open-files=`) | P1-1; any long option that is a prefix of a dangerous name is privileged |
| S3 | High | **Unsandboxed mode ran project code with no consent**, through agent commands, release checks, the original-suite run, and browser app starts | P1-2 and its review fix (`unsandboxed_run` consent per context) |
| S4 | High | **Path-qualified programs were classified by basename.** `tools\ls.cmd` and `script/test` ran agent-written code as "safe" | Paths are never safe-listed |
| S5 | Medium | Package-manager "read-only" subcommands load project code (yarnPath, plugins, `.pnpmfile.cjs`) | All package-manager subcommands count as project code |
| S6 | High | **Integrity laundering.** Evidence tampered on disk was re-hashed on export and imported elsewhere as intact | Import refuses records whose checksum failed before export (Phase 8) |
| S7 | Medium | macOS Seatbelt allowed reads and writes anywhere in `$TMPDIR` (other missions, canaries) | Deny-by-location profile; private scratch per command |
| S8 | Medium | A second app instance would reap the first instance's live processes | Data-directory lock and Electron single-instance lock |
| S9 | Medium | `git worktree prune` on the user's repository dropped the metadata of their own worktrees | Only ATLAS's own admin entry is removed |

## Open risks (not fixed; stated plainly)

| Risk | Severity | Why it is open | Mitigation today |
|---|---|---|---|
| **Windows sandbox not working end to end.** The npm shim is denied inside the AppContainer, so missions on Windows cannot verify | High (functional) | Diagnosis in progress on CI | Fails closed: checks report a failure, never a pass |
| Windows: a sandboxed child outlives a daemon crash (the helper does not watch its parent); unsandboxed Windows commands have no Job Object | Medium | Not yet implemented | Kill-on-close job while the helper lives |
| macOS operator terminal can open `/dev/ttys*` (needed for the PTY) | Low | Seatbelt cannot express "only the pty I allocated" | Only for operator-driven terminal sessions; agent commands cannot |
| Desktop app launch checks only that a command is classifiable, not the per-command ask (review P1 finding 10) | Low | Covered by a session-level approval that states "unsandboxed" | Session approval |
| Export key distribution is manual: the operator copies a 32-hex key id between installations; no revocation | Low | No PKI in a local-first app | A re-signed forgery is always shown as "untrusted key", never as the original signer |
| Ignored files (e.g. `.env`) are not in preserve snapshots | Low | Snapshotting ignored files would capture `node_modules` and secrets | Documented |
| Redaction runs per output chunk; a secret split across chunks can pass | Low | Pre-existing | Env allowlist keeps credentials out of the sandbox in the first place |
| The daemon's GitHub API calls ignore `HTTPS_PROXY` (Node `fetch`) | Low (functional) | Not implemented | Publishing fails with a network error; nothing is sent elsewhere |
| A user's global git config (for example an `insteadOf` to SSH) applies to ATLAS's push | Low | It is the user's own configuration | Push only on an operator click; never forced |
| A brand-new weak test on new code cannot be told apart from a good one | Inherent | The eval keeps a deliberate `weak-tests` case: false passes 1/7 | Review stage; shown as a limitation in the eval report |

## Dependency audit

**Before the upgrade (2026-10-11):**
- `pnpm audit --prod` (what ships in the app): no known vulnerabilities.
- `pnpm audit` (including dev and build tools): 30 advisories (1 low, 11 moderate, 13 high, 5 critical), all in development and packaging tools.

**Upgrade (this change), with a full regression run on the new toolchain:**

| Package | From | To | Note |
|---|---|---|---|
| vitest | 2.1.8 | 4.1.11 | The workspace file moved into `vitest.config.ts` projects |
| vite-node | (transitive) | 5.3.0 | Now explicit: the orphan test and `pnpm lab:skills` use it |
| vite | 5.4.21 | 7.3.7 | |
| @vitejs/plugin-react | 4.3.4 | 5.2.0 | |
| esbuild | 0.24.2 | 0.25.12 | |
| electron-builder (+ squirrel peer) | 25.1.8 | 26.17.0 | |
| eslint | 9.17.0 | 9.39.5 | Majors avoided where not needed for a fix |
| typescript-eslint | 8.18.1 | 8.71.1 | |
| tar (override) | — | ≥ 7.5.21 | |

**Regression results:**
- typecheck and lint clean;
- unit 191 passed, 3 skipped; integration 93 passed;
- eval 12/12 as expected (false passes 1/7, unchanged);
- Electron e2e 11 passed;
- AppImage packaged.

**After the upgrade:**
- `pnpm audit --prod`: no known vulnerabilities.
- `pnpm audit`: **1 moderate** remains: `sprintf-js` ≤ 1.1.3, via electron-builder → @electron/get → global-agent → roarr. It is build-time only, and there is no patched version upstream (`patched: <0.0.0`). Accepted and recorded.

## Reference-repository handling

The three competitor repositories were read as source only, at pinned commits, in subagents:
- no install;
- no execution of their scripts;
- no credentials passed.

No code was copied. The concepts adopted (journal with identity, preserve before remove, attach after subscribe, hash-bound acknowledgment) were implemented independently, and attribution is in [01](01-competitor-matrix.md) and in code comments where a concept is used.
