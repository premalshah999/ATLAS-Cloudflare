# Real product verification: Afterlight

[Afterlight source](https://github.com/premalshah999/Afterlight) · [Private hosted workspace](https://afterlight-launch.premalshah1305.workers.dev)

Afterlight is a launch room for small software teams: release templates, owners, deadlines, proof attached to checks, blocker enforcement, a go/no-go decision, and an immutable shipment snapshot. It includes persistent storage, an evidence library, an activity trail, search, JSON export, responsive layouts and workspace authentication. Node runs the local application; Workers assets and a Durable Object run the hosted version.

ATLAS mission `msn_kphn7jMTbPNz` verified the real product at commit `fcdcc48b5248a62e24c3fc6632de81d4d546da73`. All required checks passed: tests, syntax, HTTP health/workspace/cross-origin boundaries, the full browser launch lifecycle, staging approval and revision readback, traffic checks, and HTTP/browser checks on staging.

The baseline mission uses the explicitly labeled scripted survey runtime. The product was implemented in the development session; this baseline does not claim model-authored changes. The agent survey and review are separate from independently executed verification.

The first run correctly failed when the browser driver could not reliably operate a dropdown through keystrokes. A native `select` action and a real-browser regression test fixed that gap. A subsequent run passed and was accepted. ATLAS published its four Git refs to Artifacts and independently confirmed every remote hash.

For a fresh run on this Mac:

```sh
cd ~/Desktop/ATLAS-Cloudflare
pnpm build
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --projectDir apps/desktop
ATLAS_DEMO_REPO=~/Desktop/Afterlight node scripts/afterlight-mission.mjs
```

The script uses a separate ATLAS profile, requests explicit local staging approval, captures screenshots and a raw UI recording, and exports a checksummed audit log. `ATLAS_DEMO_PROFILE`, `ATLAS_DEMO_OUT` and `ATLAS_TEST_EXECUTABLE` can override its paths. Optional `ATLAS_CLOUD_PUBLISH=1` uses the connection token in the ignored `cloudflare/.dev.vars` and publishes source/history to the configured Worker. Model credentials are not included in source or audit exports.
