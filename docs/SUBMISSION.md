# Cloudflare challenge submission draft

**Status: application ready; Workers + Artifacts deployed and verified live (again on October 15, 02:39 UTC, during the demo recording).** **Live status (verified October 15, 2026, 01:31 UTC):** deployed on Workers Paid. `pnpm test:cloud-live` ran a real concurrent mission, pushed five refs (base, two parallel writers, review, integration) to `atlas-msn_ASLu9BwdSNdC` in the `atlas` namespace, and the Worker independently read every hash back as matching.

## Project name

ATLAS — evidence-first mission control for concurrent software agents

## Project vision

Agent collaboration needs a unit of work richer than a branch and a final chat message. ATLAS makes that unit a mission: a validated task graph, isolated workspaces, explicit permissions, checkpointed changes, structured review, independently executed checks, and an operator's decision.

Independent agents work concurrently in separate Git worktrees. Dependencies start from their predecessors' checkpoints, declared file overlaps are serialized, and merge conflicts stop integration. Tests and browser/API checks run on the integrated revision. ATLAS records process output, approvals and evidence in an append-only timeline; an agent's success claim is never enough to mark a release verified.

Cloudflare Artifacts makes every mission's checkpoints shareable as a per-mission Git repository: the base, each agent's branch and the integrated result, published through a Worker and independently read back before ATLAS records the publication. Execution stays local and governed.

A dashboard makes many concurrent agents supervisable: Home shows what needs a decision, what is running and what is ready for review; Activity collects events across missions; Agents shows each role's tools, permissions, model tier and limits; each mission has a one-page Report. ATLAS reaches every key-based model provider of the Pi runtime and checks keys live at each provider's own API (DeepSeek only via api.deepseek.com). The prototype supports a small configurable agent budget per mission, not hundred-thousand-agent scale.

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
