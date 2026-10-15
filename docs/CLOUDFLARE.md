# Cloudflare Workers + Artifacts

Artifacts is Git-compatible versioned repository storage, not a desktop app hosting service. ATLAS continues to run locally. A Worker creates per-mission Artifacts repositories, issues ten-minute Git write tokens, and reads commit IDs back independently after publication.

**Current account status:** deployment was rejected with error 10403 (Workers Paid required). Live push and readback are unverified. Local Wrangler development also uses remote Artifacts; no free local Artifacts emulator is provided by the installed SDK.

## Account and deploy

Cloudflare currently requires **Workers Paid** for Artifacts. Check [current pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) before enabling it. The account owner must complete any billing upgrade in the dashboard.

```sh
pnpm cloud:login
pnpm exec wrangler artifacts namespaces list --json
pnpm cloud:check
pnpm cloud:deploy
```

The Worker is `atlas-mission-control`, with an Artifacts binding in namespace `atlas`. Namespaces are created automatically when the first repository is created. If multiple accounts are available, set `CLOUDFLARE_ACCOUNT_ID` in the launching environment.

Copy the deployed HTTPS `workers.dev` URL. `/health` is public and reports service identity only; it does not prove a successful Artifacts operation.

## Connection secret

Generate a random secret of at least 32 characters (for example `openssl rand -hex 32` locally), and store it in your password manager. Set the same value in both places:

1. Run `pnpm cloud:secret` and paste the value at Wrangler's prompt.
2. ATLAS **Settings → Cloudflare Workers + Artifacts**: enter the Worker URL and this connection token, then save.

This secret is not your Cloudflare account API token. The desktop stores it encrypted with the OS credential store. The Worker uses it to authorize repository operations. Model provider keys never go to the Worker.

## Publish real checkpoints

Run the concurrent sample in [Mac setup](MAC-SETUP.md). On a completed mission, open **Cloudflare → Publish to Cloudflare** and confirm the source upload. Publish before rejecting or deleting task branches.

The daemon snapshots local commit IDs and pushes only the mission's base and `atlas/<mission>/…` branches to `atlas-<mission>`. It does not force-push, change the origin remote, or modify the original checkout. The Worker reads each exact ref through `ArtifactsRepo.log` and compares its hash. Only a complete match becomes a recorded, verified publication.

The first publication sends the Git history reachable from these commits. Use the bundled public sample for the competition demo. An audit event records the repository URL, branch hashes and verification time; credentials are redacted.

## API

All repository routes require `Authorization: Bearer <connection-secret>`.

- `POST /repos/atlas-<mission>/connect`: create/get repository, return remote and a short-lived write token.
- `POST /repos/atlas-<mission>/verify`: body `{ "refs": [{ "ref": "refs/heads/main", "sha": "<40-character-sha>" }] }`; independently read remote refs and compare.
- `GET /health`: public service metadata only.

This prototype uses one owner token, not multi-tenant user authentication. It publishes completed local collaboration; it does not run agents in Workers or claim large-scale concurrency. A complete competition demonstration needs a successful live publication, not only unit tests with a mocked Artifacts binding.

## Verification

`pnpm cloud:check` checks against Wrangler-generated binding types. `pnpm test` covers unauthorized access, invalid refs, remote mismatch, credential-bearing error redaction and destination validation. Local tests do not establish cloud deployment status.

References: [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), [getting started](https://developers.cloudflare.com/artifacts/get-started/workers/).
