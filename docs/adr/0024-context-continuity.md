# ADR 0024 — Context continuity: compaction, mission memory and the code graph

Status: accepted · 2026-10-12

## Context
The operator asked that agents "never really lose context". Long tasks fill a model's window. Before this ADR, the
Pi adapter ran with compaction off, so a long attempt either hit the window or the budget. The repository map in the
context bundle is a flat list of files, which says nothing about how the code fits together.

## Alternatives
1. **Bigger budgets and windows only.** This fails with any model whose window is smaller than the task.
2. **graphify, or a similar tool that builds a knowledge graph with a language model.** Rejected for now:
   - it is a Python program with its own dependency tree to audit (non-negotiables: audit before reuse, do not
     install just to inspect);
   - it sends repository text to a model to extract the graph;
   - its graph is model output, not something ATLAS can treat as fact.
   ATLAS's graph is deterministic, so what it reports is reproducible.
3. **Three layers: runtime compaction, ATLAS's exact records, and a deterministic code graph.** Chosen.

## Decision
- **Compaction.** Pi's automatic compaction is on for agent sessions.
  - When the conversation nears the window, Pi summarizes the older part and keeps recent turns. The thresholds are
    Pi's defaults, configurable in the adapter.
  - Planning sessions keep compaction off.
  - The adapter reports each compaction as a runtime `context` event. ATLAS records it as `context.compacted`, with
    Pi's token estimates (shown in the mission timeline).
- **`mission_memory` tool**, read-only, offered to every role. It returns ATLAS's own records for the task, not a
  summary:
  - the objective and constraints;
  - the task's acceptance criteria;
  - the plan and task states, and earlier attempts;
  - every file the task wrote;
  - the commands it ran, with exit codes and durations;
  - policy denials and refused approvals;
  - the mission's findings;
  - `git diff --stat` and untracked files against the base.

  Every role's standing instructions tell the agent to call it, and to trust it over the summary, after a
  compaction. Standing instructions survive compaction; a message injected mid-turn might not.
- **Code graph** (`@atlas/graph`). It holds, per file: the symbols it defines (functions, classes, types, constants,
  with line numbers and visibility), its imports resolved to repository files, the files that import it, and the
  test files.
  - Extraction is line-oriented and deterministic, and has no dependencies. It covers TypeScript/JavaScript,
    Python, Go, Rust, Java, Kotlin and Ruby.
  - The graph of a mission's base commit is built in the background when its plan is approved, while agents work.
    It reads blobs from git (the commit as committed, whatever the checkout holds), yields between batches, and is
    cached in the data directory by commit.
  - The `code_graph` tool, offered to every role and read-only, answers `overview`, `file`, `symbol` and `related`.
    It applies the worktree's committed and uncommitted edits first, re-extracting only changed files.
  - When the graph is ready at attempt start, the context bundle carries its overview. The agent is never kept
    waiting for it.

## Consequences
- Role definitions changed, so their versions moved: coder@3, reviewer@2, tester@3, browser_qa@2,
  desktop_operator@2, deployment_verifier@2.
- **Graph limits.**
  - The graph is a map, not a compiler. It misses dynamic imports, re-exports through aliases, and unusual syntax.
  - It only resolves JavaScript/TypeScript, Python and Ruby imports to files.
  - It caps at 6000 files and 512 kB per file, and says when it truncated.
- **Compaction loses detail**, which is why exact records exist. Their accuracy is limited to what ATLAS observes:
  it records what the agent did through tools, not what it was thinking.
- **Tests.**
  - `packages/graph/test/graph.test.ts` covers extraction per language, resolution, queries, incremental edits, and
    indexing the sample app.
  - `packages/runtime-pi/test/compaction.test.ts` drives real Pi with a faux model and a small window: Pi compacts,
    the adapter reports it, and the task completes.
  - `tests/integration/context.test.ts` covers:
    - a compaction recorded;
    - `mission_memory` returning the exact writes, the test run with its exit code, and the change;
    - `code_graph` including a file the agent created;
    - the background graph built and cached;
    - a malformed query refused;
    - memory scoped to its own mission, with refusals listed.
