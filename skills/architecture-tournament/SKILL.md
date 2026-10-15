---
name: architecture-tournament
description: Build two or three competing solutions in separate subtasks and choose by the same tests and measurements. Use for high-impact design choices where the better option is not obvious.
roles: [coder]
triggers: [design, architecture, approach, alternative*, trade-off*, tradeoff*, choose between, which approach, best way, evaluate options]
tools: [delegate, run_tests, shell_exec, view_diff, code_graph]
version: 2
---

# Architecture tournament

## When to use
The choice matters, is hard to reverse, and reasonable engineers would disagree. Not for choices the codebase's
existing conventions already decide.

## Procedure
1. **The decision and two or three genuinely different candidates,** not variations of one idea. For each, write
   the expected strength and the expected risk. Use `code_graph` to see how each would fit the existing structure.
2. **Judging criteria first:** the acceptance tests every candidate must pass, plus measurable criteria (latency,
   memory, lines changed, new dependencies, reversibility). Write them down; do not change them later.
3. **Delegate each candidate** to its own subtask (`delegate`), each in its own worktree with the same acceptance
   criteria. Ask each to report its measurements with the commands used.
4. **Measure each result yourself** with the same commands (`run_tests`, `shell_exec`). Repeat timing runs at least
   three times; record numbers and log ids in references/rubric.md's table.
5. **Pick by the declared criteria.** If none is clearly better, prefer the simplest.
6. **Keep only the winner** in your worktree (`view_diff` to confirm), and summarize why the others lost.

## Required summary
- The completed rubric table
- The decision, its reason, and what would change it

## Rules
- A candidate that fails an acceptance test is out, however fast it is.
- Never compare candidates measured with different commands or inputs.
