# ADR 0017 — Every model provider Pi supports, chosen per role and per mission

Status: accepted · 2026-10-12

## Context
Until now ATLAS accepted keys for three providers (Anthropic, OpenAI, Google), and one model for the whole installation through `ATLAS_MODEL`. The pinned Pi runtime (0.87.1) already reaches 43 providers. The operator asked for every provider, and for real model choice.

Pi stays the runtime. This ADR changes only which provider and model ATLAS asks Pi to use. No new dependency is added.

## Alternatives
1. **Offer every provider Pi lists, including the ones that sign in or read cloud credentials** (Amazon Bedrock, Google Vertex, Azure OpenAI, Cloudflare, GitHub Copilot, OpenAI Codex). Rejected for now:
   - Each needs more than a key (a region, a resource name, an account id, an OAuth sign-in or ambient cloud credentials).
   - Ambient cloud credentials are exactly what the sandbox keeps away from agents.
   - Each one is a separate piece of work with its own UI and tests.
2. **Model per mission only.** Rejected: planners and reviewers benefit from a stronger model than the coder, and the roles already declare `modelPreference` (`default`, `fast`, `strong`).
3. **Key-based providers; a model per role tier in Settings; an optional model per mission.** Chosen.

## Decision
- **Providers.** `@atlas/contracts` lists the 34 key-based providers (`PROVIDERS`), with the variable each one reads. `credentials.set` accepts exactly those ids plus `github`. Keys stay in the OS credential store, as before.
- **Shared variables.** Some providers share a variable, for example `MOONSHOT_API_KEY` for Moonshot and Moonshot China. The shell therefore hands the daemon one JSON map of keys (`ATLAS_PROVIDER_KEYS`) instead of one variable per provider. The daemon removes every provider variable from its environment at start.
- **Model choice.** Precedence:
  - The mission's own model wins (`missions.model`, schema v7).
  - Otherwise the Settings model for the role's tier (`models.fast`, `models.strong`).
  - Otherwise `models.default`.
  - Otherwise the runtime picks the first model with a key, as before.

  The planner uses the orchestrator role's tier (`strong`). A CI follow-up mission inherits its parent's model.
- **Evidence.** `attempt.started` records the model used, and `mission.created` records the mission's model. The timeline shows the model next to the role version.
- **Refusals.** A model whose provider has no key fails the attempt with "No API key for …" (`model_auth`), and an unknown model with "Model not found". Neither ever falls back silently to a different model. A malformed model reference is rejected at the IPC boundary (`provider/model`).
- **Drift guard.** `packages/runtime-pi/test/providers.test.ts`, run offline, checks on every Pi upgrade that:
  - each listed provider exists in Pi and has models;
  - it is not configured without a key;
  - its declared variable configures it.

## Consequences
- A model list can grow large: OpenRouter alone lists 386 models. The pickers group models by provider and show only providers with a key.
- No request is made to a provider until an agent runs. Listing models uses Pi's bundled catalog, with no catalog fetch.
- Not yet: providers that need more than a key, custom OpenAI-compatible endpoints (local models such as Ollama or LM Studio), and per-model cost reporting in the budget.
