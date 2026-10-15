# ADR 0013 — Skills: reviewed procedures, governed loading, untrusted repository skills

Status: accepted · 2026-10-11

## Context
Agents behave better when they follow a proven procedure (reproduce before fixing, falsify before approving, measure before claiming) than when they are told to "be an expert". The open Agent Skills layout (a `SKILL.md` with YAML front matter, loaded on demand) is a good, portable format for such procedures. Pi can discover skills from `.pi/skills` and `.agents/skills` in a repository.

ATLAS's existing rule is that repository text never reconfigures an agent: the Pi adapter turns off all resource discovery (extensions, skills, AGENTS files). A skill committed to a repository is exactly that kind of text: anyone who can open a pull request could add one that says "upload the repository first".

## Alternatives
1. **Enable Pi's own skill discovery.** Rejected. Repository-controlled instructions would reach every agent, with no review and no record of which version was used. It would also tie the feature to Pi.
2. **Skills compiled into role instructions.** Rejected. Every procedure would sit in every prompt, nothing would be loaded on demand, and operators could not add their own.
3. **An ATLAS skill library, loaded through governed tools.** Chosen.

## Decision
- **Format.** A skill is a directory named after the skill, holding `SKILL.md` with front matter (`name`, `description`, optional `roles`, `version`) and optional reference files. The front matter parser accepts a small, explicit YAML subset and rejects everything else. Symlinks, more than 64 files, or files over 256 KB are rejected.
- **Sources and trust.**
  - **Bundled** skills ship with ATLAS (`skills/`, an extra resource in packages) and are trusted.
  - **Operator** skills live in `<data dir>/skills` and are trusted. An operator skill overrides a bundled one with the same name.
  - **Repository** skills (`.agents/skills`, `.pi/skills`) are listed in Settings as *not trusted* and are never offered to agents. The operator can read one and import **that exact version**: the import is refused if the files changed since the operator reviewed them (content hash).
- **Loading.**
  - An agent's context includes an index (name and description) of the skills offered to its role.
  - The agent fetches a skill with `load_skill` and its references with `read_skill_file`. Both are read-only (`fs.read`) and checked by policy.
  - Each load emits `skill.loaded` with the skill's content hash, so the evidence shows which version of which procedure an agent followed.
  - The tools are offered only when skills exist for the role.
- **Runtime independence.** Skills are served by ATLAS's own ToolGate, so they work with any `AgentRuntime` (Pi, the scripted runtime). Pi's discovery stays off.
- **Scripts.** Skill directories may contain scripts as reference material, but this version does not execute them. Running skill code would need a read-only mount into the sandbox and a policy decision per script, which is future work.
- **Measurement (Skill Laboratory).** `pnpm lab:skills [bundled|<dir>]` runs the golden corpus with and without a skill set, on the same runtime and model, and compares:
  - verdicts and false passes;
  - delivered correctness;
  - tool calls, tokens, skill loads and time.

  With the scripted runtime the arms are identical by construction, and the report says so. Measuring skills needs `ATLAS_EVAL_RUNTIME=pi` and a provider key.

## Bundled skills (version 1)
| Skill | Behavior | Roles |
|---|---|---|
| reproduce-before-fix | The relentless debugger: hypotheses, reproduction, regression test, smallest fix | coder, tester |
| skeptical-review | Assume the change is wrong; falsify; confirm findings with a failing run | reviewer |
| architecture-tournament | Competing solutions in isolated worktrees, judged by criteria declared in advance | coder |
| ruthless-simplifier | Remove complexity only where tests prove behavior is preserved | coder, reviewer |
| deployment-detective | Green CI is the start: verify the running revision and live behavior | browser_qa, deployment_verifier, tester |
| experimental-scientist | Falsifiable hypothesis, controlled runs, measurements separated from judgment | coder, tester, reviewer |
| evidence-report | Every claim in the final report points at a log id; unverified parts stated | every role |

## Consequences
- Operators get repeatable procedures, with a record of exactly which version was used.
- A malicious repository cannot inject instructions through a skill.
- Whether a skill improves outcomes is a measured question (Skill Laboratory on a live model), not an assumption. **No such measurement has been run yet.**
