---
name: flaky-test-hunter
description: Find why a test passes sometimes and fails other times, prove the cause with repeated runs, and fix the nondeterminism itself - never with retries or longer sleeps. Use for intermittent failures and timeouts.
roles: [tester, coder]
triggers: [flak*, intermittent*, sometimes, random*, nondetermin*, unstable, timeout*, race, order-dependent, occasionally, sporadic*]
tools: [mission_memory, code_graph, read_file, run_tests, shell_exec, write_file, view_diff]
version: 1
---

# Flaky test hunter

## When to use
A test fails some of the time without a code change. If it fails every time, use reproduce-before-fix.

## Procedure
1. **Measure the flake rate.** Run the single test at least 20 times (`shell_exec` with the project's runner and a
   filter, or `run_tests` repeatedly). Record passes and failures with the log ids of one pass and one failure.
   Under 1 in 20, run 100 times before concluding anything.
2. **Collect failure signatures.** Compare the failing outputs: same assertion? same line? a timeout? Different
   signatures usually mean different causes.
3. **Classify the cause** using references/causes.md: time, ordering, shared state, concurrency, randomness, network,
   resource limits, or environment. Read the test and the code under test (`code_graph` `file` and `related`) for the
   matching smell.
4. **Prove it by forcing it.** Make the flake deterministic: freeze or skew the clock, fix the seed, run the test
   after the one that pollutes state, add an artificial delay at the suspected race. A cause you can trigger at will
   is proven; one you cannot is a guess.
5. **Fix the nondeterminism.**
   - Wait for a condition, not a duration.
   - Isolate state per test.
   - Inject the clock and the random source.
   - Await every promise.
   - Remove dependence on order and on wall-clock time.
6. **Prove the fix.** The forced reproduction now passes, and the same 20 or 100 repeated runs all pass. Report the
   counts.

## Required summary
- Flake rate before (n runs, failures, log ids)
- Failure signature(s)
- The cause, and the forced reproduction that proves it
- The fix
- Flake rate after (n runs, log id)

## Rules
- Never add retries, longer timeouts or sleeps as the fix. They hide the cause and slow every run.
- Never skip or quarantine the test to get green.
- If the flake is in the product code (a real race), fix the product and keep the test strict.
