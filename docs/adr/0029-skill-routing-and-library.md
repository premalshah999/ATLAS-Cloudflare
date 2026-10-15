# ADR 0029 — Skills that find their task: routing, a consistency gate, outcomes, and a deeper library

Status: accepted · 2026-10-14

## Context
Skills (ADR 0013) gave agents reviewed procedures, but:
- **Choosing was left to the agent.** Each agent saw a flat index of names and descriptions and had to decide which,
  if any, applied to its task.
- **Nothing checked a skill against the harness.** A skill could tell an agent to use a tool its role does not hold.
  The new consistency test found one: the threat-model draft told the read-only security engineer to write a test
  file.
- **Nobody could tell whether a skill helped.** No record linked skills to mission outcomes.
- **The library was thin.** Seven procedures of about 25 lines, with no coverage of feature work, refactoring,
  orientation, frontend checks, threat modeling, flaky tests, upgrades, API compatibility, migrations or delegation.

## Alternatives
- **Model-chosen skills** (an LLM picks from the index): not deterministic and not explainable, and it costs a model
  call per task. The agent can still load any skill; routing only orders the index.
- **Embedding similarity:** needs a model or a vector index, which is a new dependency, and is hard to explain to an
  operator.
- **Chosen: declared triggers.** Each skill lists words and phrases; ATLAS matches them against the task.
  Deterministic, testable, and explainable ("matches 'bug', 'fix'"), and authors can tune them.

## Decision
- **Front matter:**
  - `triggers`: words or phrases, case-insensitive whole-word matches; a trailing `*` matches word forms.
  - `tools`: the tools the procedure relies on.

  Operator-authored skills get triggers in the skill editor.
- **Routing:**
  - For each attempt, ATLAS matches triggers against the mission objective, constraints, task title and acceptance
    criteria.
  - The top three skills offered to the role come first in the agent's skill index, each with the matched words.
  - They are recorded on `context.built` as `skillsRecommended`.
- **Consistency gate** (`packages/orchestrator/test/skills.test.ts`). Every bundled skill must:
  - use only existing roles;
  - declare its tools, each of which exists and is held by at least one of its roles (counting the tools ATLAS offers
    every task);
  - declare every tool its text mentions;
  - link only reference files that exist;
  - have "When to use", "Procedure" (or "Structure") and "Rules" sections, and at least three triggers.

  Ten realistic tasks must route to the expected skill.
- **Outcomes:** `Repo.skillUsage()` counts, per skill, the missions that loaded it and how many ended verified or
  failed. The Skills settings show it next to each skill.
- **Library** (17 skills, every one stating when to use it, a procedure naming ATLAS's tools, a required evidence
  summary, and rules):
  - **New:**
    - test-first-feature, safe-refactor, codebase-orientation (code graph first);
    - frontend-verification (snapshot, refs, states, keyboard, small screens, console and network);
    - threat-model (entry points, trust boundaries, attack classes with demonstrations);
    - flaky-test-hunter, dependency-upgrade, api-compatibility, data-migration-safety, delegation-planner.
  - **Upgraded to version 2:** reproduce-before-fix, skeptical-review, evidence-report, experimental-scientist,
    ruthless-simplifier, architecture-tournament, deployment-detective.
  - **References:** checklists for hypotheses, flaky causes, UI states, attack classes, breaking changes and
    migration patterns.
- **Policy found while writing them** (ADR 0026 review):
  - A program passed on standard input to an interpreter (`node`, `python`…) is inline code, like `node -e`. It now
    needs approval.
  - Approval cards for `shell_exec` show the standard input, so the operator sees the code they approve.

## Consequences
- Triggers are lexical: a task phrased without any trigger gets no recommendation, only the full index, as before.
  The routing tests guard the common phrasings.
- Usage counts are correlation, not causation: missions that load a skill differ in other ways. They tell the
  operator which skills are used and how those missions ended, not that a skill caused the outcome.
- The skill lab (ADR 0013) remains the way to compare a procedure's effect on the same task.
