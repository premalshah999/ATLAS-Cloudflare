# ADR 0018 — MCP connections

Status: accepted · 2026-10-12

## Context
The operator asked for MCP connection options. Model Context Protocol servers give agents tools from outside ATLAS, such as issue trackers, documentation, databases and internal services. Each such tool is new privileged reach, so it must go through the same chain as everything else: ToolGate, then policy, then the executor, under the operator's control.

## Alternatives
1. **Hand MCP servers to Pi directly.** Rejected. Pi's tool calls would bypass ToolGate: no approval, no evidence, no role limits. AGENTS.md says privileged execution happens only through the gate.
2. **The official MCP TypeScript SDK.** Rejected for now. ATLAS needs three methods (`initialize`, `tools/list`, `tools/call`) over two transports. The SDK brings a large dependency tree into the daemon that runs untrusted code. A small client (`packages/mcp/src/client.ts`, about 200 lines) is easier to audit, and its limits are ours to set. Revisit if ATLAS needs resources, prompts or OAuth.
3. **One governed `mcp_call` tool, a small client, and servers configured by the operator.** Chosen.

## Decision
- **Configuration is operator data.** Servers live in Settings, never in a repository. Two transports:
  - **Remote:** streamable HTTP. https only; plain http only for loopback; no credentials in the URL.
  - **Local:** a stdio command that runs inside the OS sandbox. Its home folder is private (`<data>/mcp/<name>`). It can read only the folders the operator lists, and has no network unless the operator enables it. Without an OS sandbox it does not start, unless the operator allowed unsandboxed execution.
- **Secrets.** Header and environment values are stored in the OS credential store, in their own file (`mcp-secrets.json`), so no deploy target can be named to receive them.
  - Without a credential store, an operator can export `ATLAS_MCP_SECRET_<SERVER>_<NAME>`. Stored values win.
  - Values are registered for redaction. Only their names reach the renderer.
- **Agents.**
  - A role gets `mcp_call` when a server is enabled for that role and has listed tools.
  - Its context lists the tools it may call, with argument summaries, at most 8 000 characters.
  - The operator can narrow each server to chosen tools.
  - Results are wrapped in `<mcp-result>` as data and truncated at 20 000 characters. Non-text content is omitted.
- **Gate.** For each call:
  1. The daemon checks that the server exists, is enabled, allows the role, and offers the tool. Otherwise the call is denied with a reason.
  2. Policy then decides on `mcp.call`, held by coder, reviewer and tester:
     - **ask** (the default): every call waits for approval. The approval card names the server, the tool and its arguments.
     - **allow** (a trusted server): the call runs without asking.
     - **plan-only missions:** always ask.
  3. Each call is stored as a log artifact (request and response, redacted) and recorded as `mcp.called`.
- **Protocol surface.**
  - The client advertises no capabilities, so servers cannot sample through ATLAS's models, read roots or ask questions. Their requests get "method not found".
  - Messages are capped at 4 MB, tool lists at 500 tools, and calls time out after 120 s.
  - Cancelling an attempt sends `notifications/cancelled`.
- **Idle.** Nothing connects at startup: a server starts on *Test connection* or on the first agent call, and closes after ten idle minutes or a configuration change. The idle network audit (manual §43) is unaffected.

## Consequences
- An operator can trust a server with side effects. The UI says what *Trusted* means, and the default is to ask.
- A local server that needs npx downloads needs network access. The operator decides, and the card shows "network on".
- Not yet: OAuth sign-in for remote servers (use a token header), MCP resources and prompts, and per-mission server choice.
