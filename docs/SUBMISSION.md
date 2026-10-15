# Cloudflare challenge submission draft

**Status: local application ready; Workers + Artifacts deployed and verified live.** **Live status (verified October 15, 2026, 01:31 UTC):** deployed on Workers Paid. `pnpm test:cloud-live` ran a real concurrent mission, pushed five refs (base, two parallel writers, review, integration) to `atlas-msn_ASLu9BwdSNdC` in the `atlas` namespace, and the Worker independently read every hash back as matching.

## Project name

ATLAS — evidence-first mission control for concurrent software agents

## Project vision

Agent collaboration needs a unit of work richer than a branch and a final chat message. ATLAS makes that unit a mission: a validated task graph, isolated workspaces, explicit permissions, checkpointed changes, structured review, independently executed checks, and an operator's decision.

Independent agents work concurrently in separate Git worktrees. Dependencies start from their predecessors' checkpoints, declared file overlaps are serialized, and merge conflicts stop integration. Tests and browser/API checks run on the integrated revision. ATLAS records process output, approvals and evidence in an append-only timeline; an agent's success claim is never enough to mark a release verified.

The Cloudflare extension is designed to make mission checkpoints shareable through per-mission Artifacts repositories. It preserves local execution and adds Worker-controlled repository access and independent remote hash verification. The prototype supports a small configurable agent budget, not hundred-thousand-agent scale.

## How Cloudflare is used — current, truthful draft

We implemented a Cloudflare Worker with an Artifacts binding. The Worker creates per-mission repositories, issues ten-minute repository-scoped Git write tokens, and reads published branch tips back through the Artifacts API. ATLAS's daemon publishes immutable base, task and integration commit IDs, and requires every remote hash to match before recording success. Connection secrets are encrypted in the desktop's OS credential store; model keys never reach Cloudflare.

The Worker is type-checked against Wrangler-generated Artifacts types. Tests cover authorization failure, invalid refs, remote hash mismatch, credential redaction and invalid destinations. This was verified live: a concurrent mission's five branches were pushed to a per-mission Artifacts repository and every commit ID was independently read back as matching (`pnpm test:cloud-live`).

## Source URL

https://github.com/premalshah999/ATLAS-Cloudflare

## Instructions to run

Clone the repository, install Node.js 22.19+ and pnpm 10.28, run `pnpm install --frozen-lockfile`, `node node_modules/electron/install.js`, `pnpm exec playwright install chromium`, `pnpm build`, and `pnpm seed:sample ~/ATLAS-Demo`. Start with `pnpm start`.

Open the sample repository in ATLAS. Create a scripted mission with objective `[parallel sample] Fix slugify and add regression coverage in parallel, then review and verify the integrated result.` Approve the plan and inspect Tasks, Changes, Review, Evidence and Browser. Scripted decisions require no API keys; worktrees, concurrent scheduling, edits, merges and checks are real. Add provider keys in Settings and select Pi for live model missions.

For Cloudflare, use an account with Workers Paid, run `pnpm cloud:login`, `pnpm cloud:deploy`, and `pnpm cloud:secret`. Save the deployed Worker URL and matching connection token in ATLAS Settings. Publish a completed mission from its Cloudflare tab and verify that every remote hash matches. Detailed instructions: `docs/MAC-SETUP.md` and `docs/CLOUDFLARE.md`.

## Video

The narrated walkthrough uses screenshots captured from a real Electron mission and locally synthesized narration. The raw interaction video is retained alongside it. It explicitly discloses the scripted runtime and the absence of live provider calls. Its Cloudflare segment was recorded while deployment was blocked; replace it with a recording of a live **Publish to Cloudflare** (green matching hashes) before upload.

## Manual entry

The official rules prohibit automated entry. The account owner must submit manually at https://www.cloudflare.com/git-competition/submit/ and review the eligibility and terms declarations.

Required personal/team fields: team name, contact name/email, team location, first attendee name/email; second attendee is optional. Do not invent these fields.

The stated deadline is **October 14, 2026, 11:59 p.m. Pacific** (October 15, 2:59 a.m. Eastern). The form needs a 5–10 minute MP4, WebM or MOV under 2 GiB, the public source URL, run instructions, and the Workers + Artifacts confirmation. Source is MIT licensed in `LICENSE`.

## Sources

- [Challenge](https://www.cloudflare.com/git-competition/)
- [Official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf)
- [Submission form](https://www.cloudflare.com/git-competition/submit/)
- [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)
