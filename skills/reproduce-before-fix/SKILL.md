---
name: reproduce-before-fix
description: The relentless debugger. Use for bugs, failing tests, crashes and regressions - reproduce the failure, prove the cause, then make the smallest fix with a regression test.
roles: [coder, tester]
triggers: [bug, fix, fixes, failing, fails, failure, broken, regression, crash*, error, exception, incorrect, wrong, not working, doesn't work, issue, defect]
tools: [mission_memory, code_graph, read_file, git_status, view_diff, run_tests, shell_exec, write_file]
version: 2
---

# Reproduce before fix

## When to use
A behavior is wrong and you are asked to make it right. Not for new features (use test-first-feature) or for tests
that only fail sometimes (use flaky-test-hunter).

## Procedure
1. **Pin the symptom.** From the task and its acceptance criteria, write down: what happens, what should happen, and
   where (input, environment). Do not add details the task does not give.
2. **Locate before reading.** Ask `code_graph` for the symbol or file named in the symptom (`symbol`, then `file`
   and `related`). Read only the files it points to with `read_file`. Note who imports them and which tests cover
   them.
3. **Form up to three hypotheses.** For each, write what you would observe if it were true and what would rule it
   out. See references/hypotheses.md for discriminating experiments.
4. **Reproduce.** Run the failing test with `run_tests`, or write the smallest script that shows the failure
   (a file plus `shell_exec`, never inline `-e` code). Keep the log id of the failing run: it is your evidence.
5. **No reproduction, no change.** If you cannot reproduce it after two honest attempts, stop editing. Report what
   you ran, what you saw, and what is missing.
6. **Discriminate.** Run one targeted experiment per hypothesis. Discard each one the evidence contradicts. Stop
   when one remains and you can point at the line that causes it.
7. **Write the regression test first.** Make it fail on the current code *for the identified cause* (read its
   failure message). A test that fails for another reason proves nothing.
8. **Fix the cause, not the symptom.** Make the smallest change at the cause. No defensive special cases around the
   failing input.
9. **Prove it.** The regression test and the whole suite must pass (`run_tests`). Search for the same mistake
   elsewhere (`code_graph` `related`, or `shell_exec` with `grep`) and fix every copy you find, each with a test.
10. **Read your diff** (`view_diff`) for debug output, unrelated edits and widened scope. Call `mission_memory` if
    you are unsure what you already changed.

## Required summary
- Symptom: observed vs expected
- Reproduction: the command and its log id
- Root cause, and the experiment that confirmed it
- The fix: files and the reason it addresses the cause
- Tests: the regression test, and the suite result with its log id
- Other places checked for the same mistake
- What remains unexplained

## Rules
- Never claim a reproduction that a run you made does not show.
- Never weaken, skip or delete a test to get green; the gate detects it and the mission fails.
- One cause per fix. If you found two bugs, fix both with separate tests, or report the second.
- A passing test proves only what it asserts.
