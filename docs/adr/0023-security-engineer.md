# ADR 0023 — The security engineer layer

Status: accepted · 2026-10-12

## Context
The operator asked for an AI security engineer layer. Before this ADR, ATLAS's protections were:
- the OS sandbox, the ToolGate and policy;
- redaction of known credential formats;
- a review gate where confirmed findings block release.

Nothing looked at the change itself for security problems unless the reviewer happened to. Agents write code at
volume, and a leaked secret, an injectable shell call or a hostile CI workflow costs far more after merge than
before.

## Alternatives
1. **An external SAST or secret scanner** (Semgrep, gitleaks, Trivy).
   - These are strong tools. They are separate installs with their own licenses and rule supply chains, and
     some fetch rules or vulnerability data from the network.
   - The non-negotiables say: audit before reuse, and do not install things merely to inspect. They remain options an
     operator can run as a project check. ATLAS does not bundle or require them.
2. **A model-only security review.** Rejected as the only layer. A model's claim is not evidence (AGENTS.md), and
   it can miss the obvious. It is kept as the second layer.
3. **A small deterministic scanner in ATLAS, plus a security engineer agent role.** Chosen.

## Decision
- **`@atlas/security`, a deterministic scanner with no dependencies.** It reads only what a change adds: added
  lines of the diff, and the before and after of `package.json`, `requirements*.txt` and `.github/workflows/*`. It
  runs nothing and fetches nothing. It reports:
  - **Secrets:**
    - AWS, GitHub, Slack, Stripe, Google, Anthropic and OpenAI keys;
    - private keys, and passwords in URLs;
    - random-looking literals assigned to password, secret, key or token names;
    - committed `.env` and key files.
  - **Code** (per language):
    - shell commands built from strings, and `shell=True`;
    - SQL built by interpolation;
    - `eval` and `new Function`;
    - disabled TLS verification;
    - HTML injection sinks;
    - unsafe deserialization;
    - file paths taken from requests;
    - `curl | sh`, and world-writable permissions;
    - weak hashes, insecure randomness and wildcard CORS (low severity).
  - **Dependencies:**
    - added dependencies (info);
    - install-time scripts;
    - names one edit away from popular packages (typosquats);
    - sources outside the registry;
    - changed package indexes.
  - **CI:**
    - `pull_request_target` checking out the pull request;
    - untrusted event text interpolated into `run:`;
    - `permissions: write-all`.
  - Each result has a file, line, severity, explanation and fix. Matched secrets are masked in the evidence.
- **Security gate.** After the review gate, every integrated change is scanned (check `security`, required). The
  report is an evidence artifact.
  - High and medium results become **confirmed** findings with `source: security`: ATLAS observed them, and the
    report is the reproduction. They block like any confirmed finding until fixed, or until the operator dismisses
    them, after which re-verification passes.
  - Fingerprints keep a dismissal across re-scans.
  - Low results are informational.
  - **Advisory mode** (Settings) records high and medium results as suspected and blocks nothing.
- **Security engineer role** (`security_reviewer`). It is added to every default plan, in parallel with the
  reviewer (Settings can turn it off). It is read-only, uses the strong model, and has a `security_scan` tool. Its
  instructions:
  - threat-model the change: trust boundaries, authentication and authorization, injection, SSRF, deserialization,
    secrets in logs, races, unbounded input;
  - report through `report_finding`, under the existing rule that "confirmed" needs a demonstration ATLAS observed.
- **Separate checks.** The `review` check now covers agent findings only, from the reviewer and the security
  engineer. The scan has its own `security` check. A failure therefore says which one blocked.

## Consequences
- The scanner is pattern-based. It misses what does not look like a known risk, and can flag safe code that does.
  Hence the agent layer, and dismissal with a record.
- Rules target JavaScript and TypeScript, Python, shell, and GitHub workflows. Other languages get the secret and
  file rules only.
- Known key formats are already masked by ATLAS's redaction in agent output and tool arguments, so an agent cannot
  write those into files. The scan catches formats outside that list, and anything a person commits through a
  mission.
- Storage migration v8 adds `findings.source`.
- **Tests.**
  - `packages/security/test/scan.test.ts` covers each rule family and its false-positive guards: placeholders,
    environment lookups, comments, argument arrays, parameterized SQL, other languages, lockfiles, example env files,
    and unchanged workflows.
  - `tests/integration/security.test.ts` covers:
    - a clean change passing, with the security engineer running the scan;
    - a leaked Stripe key and an injectable `exec` blocking release, masked evidence, and dismiss then re-verify;
    - advisory mode, and the AI review turned off;
    - a plan that gives the scan to the coder being rejected.
