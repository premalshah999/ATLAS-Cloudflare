# Discriminating experiments

Pick the cheapest experiment whose outcome differs between your hypotheses.

| Suspected cause | Experiment that tells it apart |
| --- | --- |
| Wrong input reaches the function | Log or assert the input at the boundary; compare with a known-good input |
| Logic error in one branch | A unit test that drives each branch with the minimal input |
| State left over from earlier code (cache, global, singleton) | Run the failing case alone, then after the case before it |
| Ordering or timing | Run it 10 times (`run_tests` repeatedly); vary the order; add a deterministic clock |
| Environment (path, locale, timezone, platform) | Run with the variable changed (TZ=UTC, LANG=C) in a script |
| Dependency behavior changed | Read the installed version's source or changelog in the worktree |
| Off-by-one or boundary | Tests at 0, 1, n-1, n, n+1 and empty |
| Encoding or normalization | Inputs with Unicode, combining marks, CRLF, a BOM |

Bisecting history: when the task says "this used to work", read `git log` for the touched files (`shell_exec git log
--oneline -- <file>`) and check out nothing; compare the old code with `git show <commit>:<file>` instead.
