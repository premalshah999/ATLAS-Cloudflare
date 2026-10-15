# ATLAS bundled skills

Reviewed, versioned procedures that ship with ATLAS ([ADR 0013](../docs/adr/0013-skills.md)). Agents see an index of the skills offered to their role and load one with `load_skill`; every load is recorded with the skill's content hash.

A skill is a directory with a `SKILL.md` and optional reference files. Its front matter has:
- `name`, `description`;
- optional `roles` and `version`;
- `triggers`: words that make it relevant;
- `tools`: what it uses.

ATLAS recommends the skills whose triggers match a task, first in the agent's index, with the matched words
([ADR 0029](../docs/adr/0029-skill-routing-and-library.md)).

Operators can add their own skills in Settings. Skills found in a repository are offered to agents only after the
operator imports that exact version.

| Skill | For | Use it to |
| --- | --- | --- |
| reproduce-before-fix | coder, tester | Fix a bug: reproduce it, prove the cause, add a regression test |
| test-first-feature | coder | Build new behavior from its acceptance criteria, tests first |
| safe-refactor | coder | Restructure code without changing behavior, step by step |
| codebase-orientation | coder, reviewer, tester, security engineer | Map unfamiliar code from the code graph before reading |
| flaky-test-hunter | tester, coder | Find and remove the nondeterminism behind an intermittent test |
| dependency-upgrade | coder | Upgrade a package after reading what changed |
| data-migration-safety | coder, reviewer | Change schemas and data with expand and contract, reversibly |
| api-compatibility | reviewer, coder | Classify changes to public surfaces as patch, minor or major |
| delegation-planner | coder | Split work into independent subtasks and verify what comes back |
| architecture-tournament | coder | Choose between real alternatives by the same tests and measurements |
| experimental-scientist | coder, tester, reviewer | Settle "faster" or "better" with a controlled experiment |
| ruthless-simplifier | coder, reviewer | Remove dead code, duplication and needless layers, verified |
| skeptical-review | reviewer | Review a change by hunting counterexamples and proving findings |
| threat-model | security engineer | Review entry points against attack classes, with demonstrations |
| frontend-verification | browser QA, deployment verifier | Exercise a UI: states, keyboard, small screens, console, network |
| deployment-detective | browser QA, deployment verifier, tester | Verify what is really running after a deployment |
| evidence-report | every role | Finish with a report where every claim has evidence |
| web-research | coder, reviewer, tester, security engineer | Answer a question from the web with version-matched, cited sources ([ADR 0030](../docs/adr/0030-web-access-for-agents.md)) |

Every bundled skill passes a consistency gate (`packages/orchestrator/test/skills.test.ts`):
- its tools exist, and its roles hold them;
- its references exist;
- its sections are present;
- realistic tasks route to the right skill.

Skills describe *how* to work. They are not evidence: ATLAS's gate still verifies every result independently.
