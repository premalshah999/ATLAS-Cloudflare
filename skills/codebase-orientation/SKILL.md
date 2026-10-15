---
name: codebase-orientation
description: Build an accurate map of an unfamiliar codebase fast - entry points, core modules, data flow and tests - from ATLAS's code graph and records instead of reading files at random. Use at the start of any task in code you have not seen.
roles: [coder, reviewer, tester, security_reviewer]
triggers: [understand, investigate, explore, unfamiliar, onboard*, legacy, codebase, architecture, how does, where is, figure out, analy*]
tools: [mission_memory, code_graph, read_file, list_files, git_status]
version: 1
---

# Codebase orientation

## When to use
Before changing or reviewing code you do not know, and again whenever you feel lost. Reading whole directories wastes
your context window; the code graph answers structural questions directly.

## Procedure
1. **Your task first.** `mission_memory` `task`: the objective, your acceptance criteria and the plan. Everything
   below serves those.
2. **The shape.** `code_graph` `overview`: languages, core modules (most imported), entry points, where tests live.
   Write a three-line summary of the architecture before you read any file.
3. **The area.** For each noun in your task (a feature, an endpoint, a function name), `code_graph` `symbol` or
   `file`. Note the importers and the covering tests.
4. **The neighborhood.** `code_graph` `related` on the main file: what it depends on and what depends on it, two steps
   out. This is the region your change can break.
5. **Read with purpose.** `read_file` only the files the graph pointed to, entry point first, then down the call
   path. Stop reading when you can say what the code does and where your change goes.
6. **Conventions.** From two existing tests and one similar feature, note how the project names things, handles
   errors, logs and tests. Follow them.
7. **Write the map down** in your notes for the rest of the task: entry point, the path to the code you will touch,
   its tests, and the risks.

## Required summary
- Architecture in three lines
- The files on the path to your change, and their tests
- Conventions you will follow
- What you could not determine, and why it matters

## Rules
- Prefer `code_graph` to `list_files`; prefer `list_files` to reading whole directories.
- After your conversation is summarized, call `mission_memory` before continuing; trust it over the summary.
