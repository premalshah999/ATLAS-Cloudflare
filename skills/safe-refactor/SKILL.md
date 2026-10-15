---
name: safe-refactor
description: Change the structure of code without changing what it does - pin current behavior with tests, map every caller with the code graph, move in small verified steps. Use for renames, extractions, moves and splitting modules.
roles: [coder]
triggers: [refactor*, restructure, rename, extract, move, split, reorganiz*, modulari*, decouple, consolidate]
tools: [mission_memory, code_graph, read_file, write_file, run_tests, view_diff, shell_exec]
version: 1
---

# Safe refactor

## When to use
The task changes how code is organized, not what it does. If behavior must change too, do the refactor first, prove
it changed nothing, then change the behavior with test-first-feature.

## Procedure
1. **Map the blast radius.** For each symbol or file you will touch: `code_graph` `symbol` (where it is defined, who
   uses it), `file` (who imports it, which tests cover it) and `related` (two import steps out). List every caller.
   Search for dynamic uses the graph cannot see (strings, reflection, config) with `shell_exec` `grep`.
2. **Pin behavior.** Run `run_tests` and keep the log id: this is the baseline. If a touched path has no test, write a
   characterization test that records what it does today, even if that looks wrong. It must pass before you start.
3. **Plan small steps.** Each step must leave the code compiling and the tests green: add the new form, move callers
   one group at a time, then delete the old form. Write the steps down.
4. **One step at a time.** After each step, run the tests. If anything fails, undo that step rather than patching
   forward.
5. **Callers last checked.** Re-run `code_graph` `symbol` on the old names: there must be no users left before you
   delete them.
6. **Prove nothing changed.** Same test results as the baseline, with no test edited except for import paths and
   names. Read the whole diff (`view_diff`): renames and moves only, no logic.

## Required summary
- The callers found, including dynamic uses
- The baseline run and the final run (log ids), with the same results
- Characterization tests added, and why
- Every test change, and why it is a rename or move only

## Rules
- No behavior change in a refactor. If you find a bug, report it or fix it in a separate, tested change.
- Never edit a test's assertions to make a refactor pass.
- Prefer many small diffs to one large one.
