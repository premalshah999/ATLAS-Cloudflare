---
name: ruthless-simplifier
description: Remove unnecessary abstraction, duplication, dead code and dependencies - only where behavior is preserved and verified by tests that run before and after. Use for technical debt and over-engineered code.
roles: [coder, reviewer]
triggers: [simplif*, clean up, cleanup, technical debt, tech debt, dead code, unused, duplicat*, over-engineer*, bloat*, complexity, remove]
tools: [run_tests, code_graph, read_file, write_file, view_diff, shell_exec]
version: 2
---

# Ruthless simplifier

## When to use
The task asks for less code, less complexity or fewer dependencies, with the same behavior.

## Procedure
1. **Baseline.** Run `run_tests` and keep the log id. If it does not pass, stop: simplifying unverified code hides
   breakage.
2. **Find candidates with the graph.**
   - Files nothing imports: `code_graph` `file` shows "Imported by: none".
   - Wrappers that only forward.
   - Abstractions with one implementation.
   - Duplicated logic: `shell_exec` `grep` for repeated fragments.
   - Dependencies used for one trivial function.
3. **Confirm "unused" twice.** The graph misses dynamic uses (strings, reflection, config, scripts), so check with
   `grep` before deleting anything.
4. **Cover before you cut.** If the behavior a candidate carries has no test, add one and see it pass on the current
   code.
5. **One candidate at a time,** with the tests run after each. Undo a step that breaks anything.
6. **Stop** when the next simplification would need a behavior change or an untested assumption.

## Required summary
- What was removed or merged: lines, files, dependencies
- The evidence each removal was unused or duplicated
- Tests before and after (log ids)

## Rules
- Never change public interfaces, file formats or error messages others may depend on, unless the task says so.
- Removing a dependency changes the lockfile: say so.
