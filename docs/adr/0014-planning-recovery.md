# ADR 0014 — Provider-independent planning recovery

The Afterlight live-model run encountered a valid DeepSeek key with an unavailable provider (HTTP 503). The renderer's two-minute daemon request timeout expired before the planner's five-minute budget. Restart then synchronously repeated the provider call during recovery, preventing the daemon from becoming ready.

Recover interrupted planning with a deterministic proposal and require operator approval. Do not repeat an external, potentially billable planning request during startup. The proposal remains labeled `default`; it never claims model authorship. Explicit replanning may use the model once access returns. A negative integration test proves that startup does not invoke the unavailable provider, no agent attempt starts and replay matches the recovered state.

Set the desktop planning request timeout above the planner's five-minute budget, and allow cloud publication enough time for its bounded connection, Git push and readback operations. Ordinary requests retain the existing timeout.

The current model catalog advertises a 384,000-token response ceiling for DeepSeek Flash. The SDK otherwise uses that ceiling as its default request maximum. Bound planning responses to 4,096 tokens and coding turns to 16,384 (or the model's lower maximum). This limits individual requests independently of the cumulative mission budget. A faux-provider test verifies that a very large advertised ceiling is reduced before requesting a response; this does not claim that a cap can resolve a provider outage.
