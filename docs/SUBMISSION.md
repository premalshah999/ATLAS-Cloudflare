# Cloudflare challenge submission draft

**Status:** application complete; Cloudflare Worker with Artifacts binding deployed and verified live; real missions on Operon with DeepSeek, a verified mission pushed from the app as a GitHub pull request with CI green, and published to Cloudflare Artifacts with every ref matching.

## Project name

ATLAS — evidence-first mission control for concurrent software agents

## Project vision

Agent collaboration needs a unit of work richer than a branch and a final chat message. ATLAS makes that unit a **mission**: a model-proposed, validated task graph; agents working concurrently in isolated Git worktrees inside an OS sandbox; explicit permissions; checkpointed changes; structured review and a security engineer; independently executed checks (tests, API, browser, visual, staging); and a person's decision. An agent's success claim never marks work verified.

ATLAS is an automated software team with a mission-control interface. The dashboard is the full ATLAS design system running on live data: Mission Control (workforce graph of agents and dependencies, needs-you queue, timeline, live terminals, inspector), a task graph, each agent's thread and tool trace with a composer that **directs a running agent** in its live session, review with findings on the diff, browser QA with real screenshots, a deployment-cycle graph with a release report, Agent Studio (roles as enforced policy), and activity across missions. Verified missions are accepted, pushed and opened as GitHub pull requests, where CI runs; a failing CI can start a follow-up mission.

We used ATLAS on a real product, **Operon** (a complaint-operations platform: FastAPI + React), with DeepSeek models through the official API — real planning and real agent decisions. The orchestrator model planned each mission (for example 9 tasks across coder, reviewer and browser-QA roles with dependencies), coders wrote tests first, and the gate recorded honest failures as failures.

## How Cloudflare is used — current, truthful draft

We implemented a Cloudflare Worker with an Artifacts binding. The Worker creates per-mission repositories, issues ten-minute repository-scoped Git write tokens, and reads published branch tips back through the Artifacts API. ATLAS's daemon publishes immutable base, task and integration commit IDs, and requires every remote hash to match before recording success. Connection secrets are encrypted in the desktop's OS credential store; model keys never reach Cloudflare.

The Worker is type-checked against Wrangler-generated Artifacts types. Tests cover authorization failure, invalid refs, remote hash mismatch, credential redaction and invalid destinations. This was verified live: a concurrent mission's five branches were pushed to a per-mission Artifacts repository and every commit ID was independently read back as matching (`pnpm test:cloud-live`).

## Source URL

https://github.com/premalshah999/ATLAS-Cloudflare

## Instructions to run

Requirements: macOS or Linux, Node.js 22.19+, pnpm 10.28, git.

```sh
git clone https://github.com/premalshah999/ATLAS-Cloudflare && cd ATLAS-Cloudflare
pnpm install --frozen-lockfile && node node_modules/electron/install.js && pnpm exec playwright install chromium
pnpm build && pnpm start
```

ATLAS opens on the dashboard. Open a repository (any git project). In Settings add a model provider key (DeepSeek, Anthropic, OpenAI and every other Pi key-based provider; Settings → Test checks it at the provider's own API) and choose models per tier. Create a mission from Home or New mission: the orchestrator model proposes a plan, you approve it, agents work concurrently in sandboxed worktrees, and ATLAS verifies the result independently. Accept to keep the integration branch, or publish it as a GitHub pull request (uses your GitHub CLI sign-in).

Cloudflare: with Workers Paid, `pnpm cloud:login`, `pnpm cloud:deploy`, `pnpm cloud:secret`, then put the Worker URL and connection token in Settings and use **Publish to Cloudflare** on a completed mission. Live check: `ATLAS_CLOUD_URL=… ATLAS_CLOUD_TOKEN=… pnpm test:cloud-live`. Details: `docs/MAC-SETUP.md`, `docs/CLOUDFLARE.md`.

## Video

`ATLAS-demo.mp4`: a narrated, motion-designed walkthrough of the live app on real missions (Operon with DeepSeek models): planning, concurrent agents, review, verification, staging, the GitHub pull request with CI, and Cloudflare Artifacts publication.

## Manual entry

The official rules prohibit automated entry. The account owner must submit manually at https://www.cloudflare.com/git-competition/submit/ and review the eligibility and terms declarations.

Required personal/team fields: team name, contact name/email, team location, first attendee name/email; second attendee is optional. Do not invent these fields.

The stated deadline is **October 14, 2026, 11:59 p.m. Pacific** (October 15, 2:59 a.m. Eastern). The form needs a 5–10 minute MP4, WebM or MOV under 2 GiB, the public source URL, run instructions, and the Workers + Artifacts confirmation. Source is MIT licensed in `LICENSE`.

## Sources

- [Challenge](https://www.cloudflare.com/git-competition/)
- [Official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf)
- [Submission form](https://www.cloudflare.com/git-competition/submit/)
- [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)
