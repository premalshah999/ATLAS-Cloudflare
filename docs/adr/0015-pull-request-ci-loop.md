# ADR 0015 — Pull request and CI feedback loop

Status: accepted · 2026-10-11

## Context
Before this ADR, a mission ended with an accepted branch in the operator's local repository. Real development continues past that point: the change goes up as a pull request, the project's CI runs on it, and a failure sends someone back to fix it. Doing that by hand meant copying CI output into a new mission and re-explaining the context.

The loop touches things outside the machine: a push, a pull request, a token. The evolution non-negotiables apply. Never force-push. Never expose credentials to agents. Only the operator authorizes outward actions.

## Alternatives
1. **Agents push and open pull requests through a tool.** Rejected. It gives agents network access and a credential, and it makes an outward action depend on model output.
2. **Shell out to `gh`.** Rejected. It adds a dependency on a separately installed and authenticated tool, uses the user's ambient credentials, and gives no typed errors to test against.
3. **Operator actions in the daemon, using the GitHub REST API and plain `git push`.** Chosen.

## Decision
- **Publish** (button: *Open pull request*, with a confirmation).
  - Allowed only for a mission that is accepted, verified and not an imported archive.
  - The daemon pushes the integration commit to `atlas/<mission>/integration` on the workspace's `origin`. Only a github.com remote is supported.
  - It then opens a pull request, or reuses the open one for that branch. The body gives the verdict and the checks table.
  - The push is a plain refspec with no `+`, so a branch that someone else moved is refused, never overwritten.
  - It is recorded as `forge.published`.
- **CI.**
  - The daemon reads check runs and legacy commit statuses for the published commit.
  - Any failure fails, anything unfinished is pending, and success requires every check to be finished cleanly.
  - A change is recorded as `forge.ci`.
  - For failed checks, the output, annotations and the last 150 log lines are stored as an artifact.
  - The daemon polls every 60 s while CI is unfinished, for up to a day after publishing, and only when a token is configured. *Refresh CI* reads it on demand.
- **Fix CI** (button). It creates a follow-up mission:
  - The follow-up starts from the pull request branch as it is on GitHub now. The branch is fetched, so commits others pushed are included.
  - Its goal names the failing checks and includes the CI output as quoted data inside `<ci-output>`.
  - It goes through planning and plan approval like any mission.
  - Once accepted and verified, publishing it fast-forwards the same branch, and the pull request is reused.
- **Credential.**
  - A GitHub token is stored like provider keys: encrypted with safeStorage, or read from `ATLAS_GITHUB_TOKEN`.
  - It is passed to the daemon only. It is kept apart from model keys, so it never reaches a runtime or an agent, and it is registered for redaction.
  - `git` gets it through `GIT_CONFIG_*` environment variables (an `http.extraheader`), never in arguments.
  - The user's credential helpers are switched off for these calls, and git never prompts.
  - Repository hooks, fsmonitor and external diff programs are disabled for ATLAS's git calls, as for every other ATLAS git call.
- **ATLAS never merges a pull request.**

## Consequences
- **Remote support.**
  - github.com only, for now. `ATLAS_GITHUB_API` changes the API base (tests use it), but remote parsing and the push URL are github.com.
  - The user's global git config still applies. An `insteadOf` that maps github.com to SSH, for example, makes the push use the user's SSH key.
- **Proxies.** Node's `fetch` in the daemon does not use `HTTPS_PROXY`. API calls fail behind a proxy that is required for outbound traffic.
- **CI output is repository-controlled text.** It goes into the follow-up's goal as quoted data, and the operator approves the follow-up's plan before anything runs.
- **Tests:**
  - `packages/orchestrator/test/forge.test.ts`: remote parsing including look-alike hosts and traversal, CI state, the token kept out of arguments, typed API errors.
  - `tests/integration/forge.test.ts`, against a fake GitHub API and a bare repository reached through the repository's own `insteadOf`:
    - publish, then failing CI, then a follow-up that verifies and fast-forwards the same pull request;
    - refusal to overwrite a moved branch;
    - a follow-up starting from someone else's commit;
    - refusals without a token, without a github.com origin, for unverified results, and before CI failed;
    - the token absent from every event and artifact.
  - `tests/e2e-electron/github.spec.ts`: the same loop through the UI.
