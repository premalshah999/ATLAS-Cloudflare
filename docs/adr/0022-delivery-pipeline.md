# ADR 0022 — Automated delivery pipeline

Status: accepted · 2026-10-12

## Context
After ADR 0015, getting an accepted change merged still meant several clicks spread over time:
1. Open pull request.
2. Wait.
3. Refresh CI.
4. Fix CI.
5. Approve the follow-up's plan.
6. Wait.
7. Accept.
8. Publish again.

The operator asked for an automated CI/CD pipeline. These non-negotiables stay:
- never deploy to production or merge without explicit authorization;
- never force-push;
- risky execution only inside the sandbox, with the ToolGate unchanged;
- a passing build is not proof of correctness, so the release gate's verdict stays the condition for acceptance.

## Alternatives
1. **Generate CI configuration for the user's project and stop there.** Too little. It does not close the loop the
   operator described, and a model-written workflow file is a change like any other: it already goes through a
   mission.
2. **A separate pipeline engine with its own state and stages.** Rejected. It would duplicate the mission state
   machine, the release gate and the forge loop, and could disagree with them.
3. **A thin policy layer over what exists.** Chosen. Stages are derived from each mission's own events. Automation is
   a per-repository policy that calls the same orchestrator actions a person would, with its own actor recorded.

## Decision
- **Stages.** Every mission shows Plan → Build → Verify → Accept → Pull request → CI → Ready to merge, in the
  mission header.
  - `pipelineOf` in `@atlas/contracts` derives each stage's state from the mission and its events only. The pipeline
    stores no state of its own.
- **Policy per repository.** It is off by default, set under Team → Automation, and stored as setting
  `pipeline.<workspace>`:
  - `autoPublish`: push and open or update the pull request when a verified mission is accepted.
  - `fixCi`:
    - `off`: nothing happens.
    - `propose`: a fix mission is created and planned, then waits for a person.
    - `auto`: the fix mission is planned and its plan approved automatically, unless a task is high-risk. It then
      runs, verifies, and, with `autoAcceptFixes`, is accepted and pushed to the same pull request.
  - `maxFixRounds` (1–5, default 2): the number of automatic fixes per pull request. After that the pipeline records
    "A person needs to look" and stops.
- **Recording.** Every automatic step is recorded as `pipeline.step`, with actor `system/pipeline` and a sentence
  saying what happened or why it did not. The actions it takes are the orchestrator's own (`publish`, `fixCi`,
  `plan`, `approvePlan`, `decide`), now attributed to the actor that took them.
- **What the pipeline never does:**
  - merge a pull request;
  - deploy to production (staging stays a release stage, ADR 0010);
  - answer a tool approval;
  - approve a plan other than a CI fix it started itself, or a plan with a high-risk task;
  - accept a change that is not verified or has a blocking finding;
  - publish past a blocker, including owner approval (ADR 0021).
  A held-back publish is recorded with its reason.
- **CI polling.** Unchanged from ADR 0015: every 60 s while CI is unfinished, for a day, only with a token.
- **"Ready to merge".** It is recorded on the mission and on the mission it fixed. With a team space it moves the
  linked item to Done, which tells a person to merge.

## Consequences
- **Attribution.** The orchestrator's `approvePlan`, `decide`, `publish`, `fixCi` and `createMission` take an
  optional actor (default: operator). Timelines say "Pipeline", "Team runner" or a teammate's name where they used
  to say "You".
- **No new trust in the scope.** A fix in auto mode is planned, run and verified like any mission.
- **Test weakening.** It is guarded by the same release gate. A test-definition change blocks acceptance (ADR 0009's
  definition-change rule), so the pipeline cannot accept a weakened test suite.
- **Tests.** `tests/integration/pipeline.test.ts`, against the fake GitHub API and a bare repository, covers:
  - acceptance leading to an automatic pull request;
  - failing CI leading to a fix mission that is auto-planned, auto-approved, verified, auto-accepted and pushed to the
    same pull request, then ready to merge, with no merge request ever sent;
  - stopping after `maxFixRounds`;
  - no auto-approval of a high-risk plan;
  - tool approvals left pending for a person;
  - no auto-acceptance when it is off;
  - nothing when the policy is off;
  - propose mode;
  - a publish held back by the owner gate, with its reason.
