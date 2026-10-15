---
name: threat-model
description: Review a change as an attacker would - list its entry points and trust boundaries, check each against the classes of attack that apply, and confirm findings with a demonstration ATLAS can observe. Use for any change touching input, auth, data access, secrets or external calls.
roles: [security_reviewer]
triggers: [auth*, login, password, token, session, permission*, role*, admin, upload, input, sql, query, injection, api, endpoint, secret*, crypto*, webhook, redirect, url, file, path, cookie, cors, payment*]
tools: [security_scan, view_diff, code_graph, read_file, run_tests, shell_exec, report_finding]
version: 1
---

# Threat model

## When to use
Every security review. Start with ATLAS's deterministic scan, then look for what a scanner cannot see.

## Procedure
1. **Scan.** Run `security_scan` and read every result. Each is a lead, not a verdict.
2. **Entry points.** From `view_diff`, list every new or changed place where data enters: routes, handlers, CLI
   arguments, file reads, queue consumers, webhooks, environment. Use `code_graph` `related` to follow each input to
   where it is used.
3. **Trust boundaries.** For each entry point, write who can call it (anonymous, user, admin, internal service) and
   what it can reach (database, file system, shell, network, secrets).
4. **Attack classes.** For each entry point, walk references/checklist.md: authentication, authorization (including
   object-level: can user A reach user B's records?), injection (SQL, shell, path, template, HTML), SSRF and open
   redirects, deserialization, secrets in logs or errors, races on checks, and resource exhaustion.
5. **Demonstrate.** A finding is confirmed only when a run shows it. You cannot write files, so:
   - Prefer an existing test or command that already exercises the path with hostile input (`run_tests`, or
     `shell_exec` with the attack as an argument or as standard input to an existing script).
   - For new code, pass a short script on standard input (`shell_exec` `node` with `stdin`). It always asks the
     operator, who sees the full script before it runs. Keep it minimal and local.

   The run must exit non-zero because the attack succeeds: the injected query that returns another user's row, the
   path that escapes the upload directory, the request that skips the permission check. Pass that run's log id as
   `reproducedBy`.
6. **Report** each problem with `report_finding`: file, line, severity, the attack it enables, the evidence, and the
   fix. Unproven but plausible problems are "suspected"; general best practice is not a finding.

## Required summary
- Entry points and their trust boundaries
- For each: the attack classes checked, and the result
- Confirmed findings, with their demonstration runs
- Suspected findings, and what would confirm them
- Scan results you dismissed, and why

## Rules
- Severity follows impact and reach: who can exploit it, and what they get.
- Never send real attack traffic outside the sandbox; demonstrate against the code, locally.
- No secret, token or credential in a finding's text; describe where it is.
