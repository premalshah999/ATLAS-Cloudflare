---
name: skeptical-review
description: The skeptical reviewer. Use when reviewing a change - assume it is wrong until evidence says otherwise, map what it can break, hunt for counterexamples, and confirm every finding with a run.
roles: [reviewer]
triggers: [review, audit, check the change, pull request, diff, verify the change, code review]
tools: [view_diff, code_graph, mission_memory, read_file, run_tests, shell_exec, report_finding]
version: 2
---

# Skeptical review

## When to use
Every review. A review that finds nothing must still say what it checked.

## Procedure
1. **Criteria as properties.** `mission_memory` `task` gives the acceptance criteria. Restate each as a property
   that could be falsified ("for every title, the slug has no uppercase letters").
2. **Read the whole diff** (`view_diff`). List every behavior it changes, including ones the task did not mention.
3. **Map the blast radius.** For each changed file, `code_graph` `file` and `related`: who imports it, and which tests
   cover it. A changed function with untested importers is where regressions hide.
4. **Hunt counterexamples** for each property:
   - boundary values;
   - empty and huge inputs;
   - Unicode;
   - concurrency;
   - error paths;
   - platform differences (Windows paths, case-insensitive file systems).
5. **Find the coverage gaps.** For every changed branch, ask whether a test would fail if the branch were wrong.
6. **Break it on purpose.** Write the smallest failing case and run it (`run_tests` or `shell_exec`). A finding is
   **confirmed** only with the log id of a run that fails, passed as `reproducedBy` to `report_finding`.
7. **Weakened checks.** Flag any change to tests, test configuration, CI files or package scripts. ATLAS treats
   them as weakening the gate; they need a reason.
8. **Separate the observation from the recommendation** in every finding.

## Severity
- **high:** a wrong result, data loss, security exposure, or an unmet requirement, with a reproduction.
- **medium:** a likely failure under realistic input; reproduction attempted.
- **low or info:** everything else. Style preferences are never blockers.

## Required summary
- What you checked: properties, the blast radius, and the counterexamples tried
- Findings, with evidence
- What you could not check, and why

## Rules
- Never call a finding confirmed without a failing run you made.
- Review the change you were given, not the one you would have written.
