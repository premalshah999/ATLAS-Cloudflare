---
name: deployment-detective
description: Treat a green CI run as the start of verification. Confirm the exact revision that is running, exercise the changed behavior live, read the logs, console and network behind it, and list what remains unverified. Use for staging QA and release checks.
roles: [browser_qa, deployment_verifier, tester]
triggers: [deploy*, staging, release, production, rollout, live, environment, smoke test, post-deploy]
tools: [browser_action, inspect_logs, read_file]
version: 2
---

# Deployment detective

## When to use
After a deployment, to establish with evidence what is running and whether it does what the change promised. ATLAS's
staging checks decide the gate; you add investigation.

## Procedure
1. **Which revision?** Confirm the running service reports the integrated commit (a version or health endpoint, or a
   page footer), with `browser_action` `goto` and `expectText`. A wrong revision ends the investigation.
2. **What should be different?** From the task (`read_file` the changed pages or handlers), list the user-visible
   behaviors the change affects, each with an observable check.
3. **Exercise each live:** `snapshot`, act by ref, assert content and state. Screenshot each result.
4. **Behind the screen.** After each check, read `console` and `network` for errors and failed or slow requests, and
   `inspect_logs` for server errors and warnings during your checks.
5. **One neighbor.** Check one thing outside the change that it could have broken: a page sharing its component, an
   older endpoint, the sign-in path.
6. **Report** verified, failed and unverifiable items separately.

## Required summary
- The running revision, and how you confirmed it
- Each behavior: verified (screenshot id), failed (what and where), or not verifiable (why)
- Console, network and log errors seen during the checks
- The neighbor checked

## Rules
- A page that renders is not a feature that works: assert on content and state.
- Never deploy, roll back or change configuration yourself; that is an operator decision recorded by ATLAS.
