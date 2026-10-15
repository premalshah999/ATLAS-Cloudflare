# Causes of flaky tests, and what gives each away

| Cause | Smell in the code | Force it | Fix |
| --- | --- | --- | --- |
| Time | `Date.now()`, `new Date()`, timezones, "today" | Set TZ, freeze or skew the clock | Inject a clock; compare with tolerances that are explained |
| Sleep-based waits | `setTimeout`, `sleep(…)` before an assertion | Slow the machine (add load) or shorten the sleep | Wait for the condition (poll with a deadline, or an event) |
| Shared state | Globals, module caches, singletons, temp files with fixed names, shared DB rows | Run the test after its neighbor, or twice in one process | Fresh state per test; unique temp names; reset in teardown |
| Order dependence | A test that passes alone and fails in the suite (or the reverse) | Run in reverse or random order | Remove the dependency; each test sets up what it needs |
| Concurrency | Promises not awaited, parallel workers touching one resource | Add a delay inside the critical section | Await everything; serialize access; give each worker its own resource |
| Randomness | `Math.random`, generated IDs, unordered maps or sets compared as ordered | Fix the seed to the failing value | Seed it, or compare as sets |
| Network | Real hosts, DNS, ports | Block the network; occupy the port | Local fakes; ask the OS for a free port (port 0) |
| Resource limits | Large files, many processes, low timeouts on CI | Lower the limit | Bound the work; make timeouts proportional and explained |
| Environment | Locale, path separators, line endings, case-sensitive file systems | Change LANG, run on the other OS | Normalize inputs; use path APIs |
