# Cloudflare challenge submission draft

**Status: application ready; Workers + Artifacts deployed and verified live (again on October 15, 02:39 UTC, during the demo recording).** **Live status (verified October 15, 2026, 01:31 UTC):** deployed on Workers Paid. `pnpm test:cloud-live` ran a real concurrent mission, pushed five refs (base, two parallel writers, review, integration) to `atlas-msn_ASLu9BwdSNdC` in the `atlas` namespace, and the Worker independently read every hash back as matching.

## Project name

ATLAS — evidence-first mission control for concurrent software agents

## Project vision

Agent collaboration needs a unit of work richer than a branch and a final chat message. ATLAS makes that unit a **mission**: a model-proposed, validated task graph; agents working concurrently in isolated Git worktrees inside an OS sandbox; explicit permissions; checkpointed changes; structured review and a security engineer; independently executed checks (tests, API, browser, visual, staging); and a person's decision. An agent's success claim never marks work verified.

ATLAS is an automated software team with a mission-control interface. The dashboard is the full ATLAS design system running on live data: Mission Control (workforce graph of agents and dependencies, needs-you queue, timeline, live terminals, inspector), a task graph, each agent's thread and tool trace with a composer that **directs a running agent** in its live session, review with findings on the diff, browser QA with real screenshots, a deployment-cycle graph with a release report, Agent Studio (roles as enforced policy), and activity across missions. Verified missions are accepted, pushed and opened as GitHub pull requests, where CI runs; a failing CI can start a follow-up mission.

We used ATLAS on a real product, **Operon** (a complaint-operations platform: FastAPI + React), with DeepSeek models through the official API — real planning and real agent decisions, no scripted runtime. The orchestrator model planned each mission (for example 9 tasks across coder, reviewer and browser-QA roles with dependencies), coders wrote tests first, and the gate recorded honest failures as failures.

## How Cloudflare is used — current, truthful draft

We implemented a Cloudflare Worker with an Artifacts binding. The Worker creates per-mission repositories, issues ten-minute repository-scoped Git write tokens, and reads published branch tips back through the Artifacts API. ATLAS's daemon publishes immutable base, task and integration commit IDs, and requires every remote hash to match before recording success. Connection secrets are encrypted in the desktop's OS credential store; model keys never reach Cloudflare.

The Worker is type-checked against Wrangler-generated Artifacts types. Tests cover authorization failure, invalid refs, remote hash mismatch, credential redaction and invalid destinations. This was verified live: a concurrent mission's five branches were pushed to a per-mission Artifacts repository and every commit ID was independently read back as matching (`pnpm test:cloud-live`).

## Source URL

https://github.com/premalshah999/ATLAS-Cloudflare

## Instructions to run

Clone the repository, install Node.js 22.19+ and pnpm 10.28, run `pnpm install --frozen-lockfile`, `node node_modules/electron/install.js`, `pnpm exec playwright install chromium`, `pnpm build`, and `pnpm seed:sample ~/ATLAS-Demo`. Start with `pnpm start`.

Open the sample repository in ATLAS. Create a scripted mission with objective `[parallel sample] Fix slugify and add regression coverage in parallel, then review and verify the integrated result.` Approve the plan and inspect Tasks, Changes, Evidence, Report, Review and Browser, then Home, Activity and Agents. Scripted decisions require no API keys; worktrees, concurrent scheduling, edits, merges and checks are real. Add provider keys in Settings and select Pi for live model missions.

For Cloudflare, use an account with Workers Paid, run `pnpm cloud:login`, `pnpm cloud:deploy`, and `pnpm cloud:secret`. Save the deployed Worker URL and matching connection token in ATLAS Settings. Publish a completed mission from its Cloudflare tab and verify that every remote hash matches. Detailed instructions: `docs/MAC-SETUP.md` and `docs/CLOUDFLARE.md`.

## Video

`ATLAS-demo.mp4` (6 min 49 s) is a narrated walkthrough built from screenshots of a real Electron session (`scripts/record-demo.mjs`), with locally synthesized narration; the raw interaction recording is kept alongside it. It discloses that agent decisions come from the scripted runtime (no model calls). The worktrees, concurrent scheduling, edits, merge, tests, browser checks, review and the **live Cloudflare Artifacts publication** are real: the recorded mission was pushed to `atlas-msn_SWCCdqpWMGwV` and every commit ID was read back as matching.

## Manual entry

The official rules prohibit automated entry. The account owner must submit manually at https://www.cloudflare.com/git-competition/submit/ and review the eligibility and terms declarations.

Required personal/team fields: team name, contact name/email, team location, first attendee name/email; second attendee is optional. Do not invent these fields.

The stated deadline is **October 14, 2026, 11:59 p.m. Pacific** (October 15, 2:59 a.m. Eastern). The form needs a 5–10 minute MP4, WebM or MOV under 2 GiB, the public source URL, run instructions, and the Workers + Artifacts confirmation. Source is MIT licensed in `LICENSE`.

## Sources

- [Challenge](https://www.cloudflare.com/git-competition/)
- [Official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf)
- [Submission form](https://www.cloudflare.com/git-competition/submit/)
- [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)
