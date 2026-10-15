---
name: delegation-planner
description: Split a large task into independent, well-scoped subtasks with explicit acceptance criteria, hand them to subagents with delegate, and integrate and verify what comes back. Use when a task spans several independent areas.
roles: [coder]
triggers: [large, several, multiple, many files, across, independent, parallel, and also, as well as, each of]
tools: [mission_memory, code_graph, delegate, run_tests, view_diff]
version: 1
---

# Delegation planner

## When to use
The task has parts that do not depend on each other and each takes real work: several endpoints, several packages, a
feature plus its documentation. Do not delegate a part smaller than the effort of describing it.

## Procedure
1. **Decompose.** Write the parts. For each: the files it will touch (from `code_graph`) and what it needs from the
   others. Parts that touch the same files are not independent; keep them together.
2. **Define done for each part.** Two to five acceptance criteria per subtask that a test can check, plus the shared
   conventions (naming, error handling, test location) every subagent must follow.
3. **Delegate** each independent part with `delegate`: role, a title that says the outcome, the reason, and the
   acceptance criteria. Keep the part that integrates them for yourself.
4. **Integrate.** Each subtask's change is merged into your worktree with a summary. Read each summary as a claim and
   verify it: `view_diff` its files and run the tests (`run_tests`).
5. **Verify the whole.** Run the full suite once everything is merged. Fix integration problems yourself rather than
   delegating them back.

## Required summary
- The parts, why they are independent, and what each subagent delivered
- Integration problems found, and how they were fixed
- The final test run (log id)

## Rules
- Subagent summaries are claims; only diffs and test runs are evidence.
- Respect the delegation budget (depth and count); when it is exhausted, do the remaining work yourself.
