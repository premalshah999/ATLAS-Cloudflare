# ADR 0032 — Cloudflare mission publication

2026-10-14. Keep ATLAS's local DAG, isolated worktrees, review and verification. Add an explicit operator action to publish a completed mission's base and agent/integration branches to a dedicated Cloudflare Artifacts repository.

A Cloudflare Worker brokers repository creation, ten-minute repository-scoped write tokens, and independent commit readback via the Artifacts binding. Each published ref must match the local checkpoint SHA before the desktop reports publication verified. This verifies storage, not the quality of the change; the existing release gate remains separate. A failed push or readback never becomes a success record.

This is trusted Git plumbing under the existing ADR 0007 exception, not a new agent tool. The daemon owns it; hooks and fsmonitor are disabled. No agent can request publication or obtain its token. The operator explicitly confirms upload of committed source and its history. The Worker connection secret uses the existing OS-encrypted deploy-secret store, under target `cloudflare`, name `ATLAS_CLOUD_TOKEN`. Git credentials are supplied through per-process configuration environment, scoped to the exact validated Artifacts HTTPS URL. They are registered for redaction and never persisted in Git config.

Alternatives: rewriting the scheduler to execute agents in Workers would abandon the established sandbox and harness in the demo time window. A plain source-code mirror would not connect mission collaboration to Artifacts. This design preserves the product and makes actual agent checkpoints remotely inspectable. It does not claim cloud agent execution or hundred-thousand-agent scale.

Cloud publication is optional. Local missions continue without Cloudflare credentials. The challenge demo must show a live publication separately from local tests; mocked binding tests are not deployment evidence.
