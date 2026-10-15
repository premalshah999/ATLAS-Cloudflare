---
name: test-first-feature
description: Build new behavior from its acceptance criteria - turn each criterion into a failing test, make it pass with the simplest code, then harden edges and errors. Use for features, endpoints and new options.
roles: [coder]
triggers: [add, implement, feature, support, new, endpoint, option, introduce, allow, enable, build, create]
tools: [mission_memory, code_graph, read_file, list_files, write_file, run_tests, view_diff, shell_exec, process_start]
version: 1
---

# Test-first feature

## When to use
The task asks for behavior that does not exist yet. For broken existing behavior use reproduce-before-fix.

## Procedure
1. **Criteria to examples.** Rewrite each acceptance criterion as two or three concrete examples: an input and the
   exact expected output or effect. Add the error case each criterion implies (invalid input, missing data,
   permission). If a criterion is ambiguous, choose the reading the existing code and tests support and say so.
2. **Find the seam.** `code_graph` `overview`, then `symbol` and `related` for the area. Find where similar behavior
   already lives and how it is tested (the "Tests that import it" line). Follow the existing pattern; do not invent a
   new layer.
3. **Write the tests first,** next to the existing tests, in their style. Run `run_tests`: the new tests must fail
   because the behavior is missing (not because of a typo or import error). Keep that log id.
4. **Simplest passing code.** Implement only what the examples require. Run `run_tests` after each meaningful step.
5. **Harden.** Add tests for the edges the examples skipped: empty, very large, duplicate, concurrent use if
   relevant, and each error message a user could see. Make them pass.
6. **Integrate.** Wire the feature where users reach it (route, CLI flag, UI control, config) and test that path
   too, not only the inner function. For a server, start it with `process_start` and check one real request if your
   task permits it.
7. **Clean up.** Remove duplication you introduced, name things after what they mean, and keep public surfaces
   small. Run the full suite.
8. **Review your diff** (`view_diff`): every changed line serves a criterion; no stray files, logs or commented-out
   code.

## Required summary
- Each acceptance criterion and the test(s) that prove it
- The failing run before (log id) and the passing run after (log id)
- Where the feature is reachable from
- Edge and error cases covered; any criterion you interpreted, and how

## Rules
- No production code before a failing test that needs it.
- Tests assert behavior users rely on, not private implementation details.
- Do not change existing tests to fit new behavior unless a criterion requires it; say so when you do.
