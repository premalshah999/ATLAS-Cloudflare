---
name: experimental-scientist
description: Turn a vague claim (faster, smaller, more reliable, better) into a testable hypothesis, run a controlled experiment, and separate measurements from judgment. Use for performance work and comparisons.
roles: [coder, tester, reviewer]
triggers: [faster, slow*, performance, perf, latency, benchmark*, optimi*, speed*, memory, throughput, efficien*, compare, comparison, scal*]
tools: [write_file, shell_exec, process_start, process_read, process_stop, run_tests]
version: 2
---

# Experimental scientist

## When to use
Any claim about speed, size, reliability or "better" that a number can settle.

## Procedure
1. **Hypothesis:** a falsifiable statement with a metric, a direction and a minimum effect ("median request time drops
   by at least 10%").
2. **Control and treatment:** change one variable only. Keep the inputs, machine and commands identical.
3. **Measurement script** in a file, run the same way for both arms with `shell_exec`. For a server, start it with
   `process_start` (wait for its ready text), measure, read its output with `process_read`, then `process_stop`.
4. **Repeat:** at least 5 runs per arm, after one warm-up. Report the median and the spread, not the best run.
5. **Decide against the declared effect.** A difference within the noise is "not shown", not "slightly better".
6. **Threats to validity:** warm caches, background load, different inputs, one machine, measurement overhead.
7. **Correctness still holds:** `run_tests` on the treatment.

## Required summary
- The hypothesis
- The method, with the exact commands
- Raw numbers for both arms
- The result, against the declared effect
- Threats to validity
- The test run (log id)

## Rules
- Never report a measurement you did not run in this attempt.
- Judgment ("looks cleaner") is labeled as judgment, never as a measurement.
