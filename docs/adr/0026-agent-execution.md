# ADR 0026 — Agent execution: background processes and a richer shell_exec

Status: accepted · 2026-10-12

## Context
The operator asked for terminal use and execution that agents can rely on for real work. Before this ADR, an agent
had one way to run a program: `shell_exec`, which waited for the program to exit.
- A dev server or a watcher (`npm run dev`, `tsc --watch`) could not run alongside the agent's other work. It
  blocked until its timeout and was then killed.
- Commands always ran at the worktree root, with an empty standard input.
- Long output was cut to its last 12,000 characters. Many tools print what they are doing at the start and the
  result at the end, so the start was lost.

## Alternatives
1. **A persistent shell per agent** (a PTY session the agent types into). Rejected:
   - every line would be a shell string, which the policy cannot classify; ATLAS classifies argument arrays only
     (manual §22);
   - output boundaries and exit codes would have to be guessed from a prompt.
2. **Let shell_exec run a shell with `&`.** Rejected: a shell is a privileged command, and a backgrounded child
   is killed with its parent when shell_exec returns.
3. **Background processes as first-class tools, started like shell_exec and owned by the attempt.** Chosen.

## Decision
- **`process_start {command, args, cwd?, name?, serve?, waitFor?, waitSec?}`.**
  - Policy classifies it exactly like `shell_exec`: the same safe list, denials, approvals and sandbox.
  - It returns once the output contains `waitFor`, the process prints a port, the process exits, or `waitSec`
    passes (default 5 s, at most 120 s).
  - `waitFor` is plain text, never a regular expression, so an agent cannot make the daemon backtrack.
- **`serve: true`** runs the process with network access in the sandbox, so loopback can reach it. Network access
  is egress too, so a safe command becomes privileged: a person approves it, and roles without privileged
  commands (tester, reviewer, security engineer) cannot serve. Without `serve`, a process's network is private to
  its sandbox. ATLAS says so when such a process prints a port, instead of implying the port is reachable.
- **`process_read {id, tail?, waitFor?, waitSec?}`** returns:
  - the status;
  - the ports the process printed; when it serves, each is probed with one HTTP GET to 127.0.0.1;
  - the output since the last read, as its last `tail` lines.

  `process_list` shows them all. `process_stop` stops the process tree.
- **Ownership.**
  - At most 4 run at once per attempt.
  - When the attempt ends, by success, failure, cancellation or shutdown, ATLAS stops whatever is still running.
  - Every process is recorded as `process.started`, `process.output` and `process.exited` (with `background`,
    `stopped`), and its full output is kept as a log artifact (newest 2 MB).
  - A process that exits non-zero by itself counts as a failing run for `reproducedBy`, like `shell_exec`.
- **Who gets the tools.** Any task that may use `shell_exec` gets the four process tools, the way every task gets
  `mission_memory`. Planners may also list them explicitly. Roles that run commands have them in their tool lists
  and instructions (coder@4, reviewer@3, tester@4, security_reviewer@2).
- **`shell_exec`**:
  - `cwd`: a directory inside the worktree, resolved like any path, so escapes are refused. The sandbox root stays
    the worktree.
  - `stdin`: text written to standard input, at most 1 MB.
  - Output over 12,000 characters keeps the first 3,000 and last 9,000 characters, and names the log artifact
    that holds all of it.
- **Windows:** sandbox ACL grants now run asynchronously before the command (`prepareSandbox`), so the daemon
  keeps answering the UI while a worktree is being granted.

## Consequences
- Port detection reads what the process prints (`localhost:5173`, `listening on port 8080`, `PORT=4000`). A server
  that prints nothing is still running and reachable when it serves; it is just not listed.
- The probe is a single GET to the loopback port the process printed, from the daemon. It is never sent elsewhere.
- **Tests.**
  - `packages/orchestrator/test/processes.test.ts`: port detection, waiting, reading only new output and the last
    lines, the limit, failed starts, unknown ids, and stopping everything once at the end.
  - `packages/policy/test`:
    - classification is the same as `shell_exec`;
    - `serve` needs an approval;
    - roles without privileged commands cannot serve;
    - plan-only missions deny it.
  - `tests/integration/execution.test.ts`, a real mission in the OS sandbox:
    - `stdin` and `cwd`;
    - a `cwd` escape refused;
    - 20,000 lines of output with its start, end and full log;
    - a served HTTP server answering the probe, after an approval;
    - a watcher read until its third tick, then stopped by ATLAS when the task ended (its pid gone);
    - refused commands never reaching an executor;
    - a review task without a shell having no process tools.
