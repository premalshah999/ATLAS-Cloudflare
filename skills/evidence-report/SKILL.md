---
name: evidence-report
description: Write the final report of an attempt so every claim points to evidence (a log id, a file, a test) and what was not verified is stated plainly. Use before finishing any task.
triggers: [report, summary, summari*, document, explain, findings, results]
tools: [mission_memory, view_diff]
version: 2
---

# Evidence-backed completion report

## When to use
Before you finish any task, whatever your role.

## Procedure
1. **Collect the record.** `mission_memory` lists the files you wrote, the commands you ran with their exit codes,
   your findings, and the approvals that were denied. Build the report from it, not from memory.
2. **Check the change** (`view_diff`) so "what changed" matches what is actually in the worktree.
3. **Write the four parts below,** and nothing else.

## Structure
1. **What changed:** the files, and the behavior each change affects.
2. **Evidence:** for each claim, the run that supports it (the command and its log id). No log id, no claim.
3. **Not verified:** what you could not run or check, and why.
4. **Risks:** what could still be wrong, and how someone would notice.

## Rules
- Words like "works", "fixed" or "all tests pass" need a log id next to them.
- If a run failed, say so, even if a later run passed, and say what changed in between.
- ATLAS verifies your result independently. Your report helps the operator understand it; it does not replace that.
