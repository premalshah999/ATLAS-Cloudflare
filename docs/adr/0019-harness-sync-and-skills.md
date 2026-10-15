# ADR 0019 — Skills authoring, and syncing with Claude Code, Codex and OpenCode

Status: accepted · 2026-10-12

## Context
The operator asked for Codex, Claude Code and OpenCode to be supported "not as the main agent as Pi, just a place that is synced", and for more from skills. Pi remains ATLAS's runtime. The other tools are where the operator also works; they should find the same procedures (skills) and the same tools (MCP servers) there.

## Alternatives
1. **Run those tools as ATLAS runtimes.** Rejected: explicitly not wanted, and their own permission systems would sit outside ToolGate.
2. **Symlink ATLAS's skill folder into each tool.** Rejected. Links reach outside what each tool expects, a tool or the operator could edit ATLAS's library through them, and MCP configuration cannot be linked.
3. **Copy on request, with ownership records, a preview, and conflicts left alone.** Chosen.

## Decision
- **Where (verified, nothing guessed).** Each location was checked against the tool's own documentation or source in October 2026:

  | Tool | Skills | MCP servers |
  |---|---|---|
  | Claude Code | `~/.claude/skills`; `<repo>/.claude/skills` | `<repo>/.mcp.json` (`${VAR}` references) |
  | Codex | `$CODEX_HOME/skills`, default `~/.codex/skills` (Codex source: `codex_home.join("skills")`) | `~/.codex/config.toml`, inside a marked block: `[mcp_servers.<name>]` with `url` and `env_http_headers`, or `command`/`args`/`env`/`env_vars` |
  | OpenCode | `~/.config/opencode/skills`; `<repo>/.opencode/skills` | `opencode.json` `mcp` entries (`{env:VAR}` references) |

  Not written:
  - **Claude Code user-level MCP** (`~/.claude.json`, a file Claude Code manages itself).
  - **Codex repository skills and project config.** The location was not confirmed.

  Each unsupported location is shown as a note in the preview.
- **What is synced.** Enabled trusted skills (bundled and the operator's own) and enabled MCP servers.
- **Secrets.** Secret values are never written. Configs reference variables instead:
  - remote servers use `ATLAS_MCP_SECRET_<SERVER>_<NAME>`;
  - a local server synced to Codex uses `env_vars`, which forwards the variable under its own name.
- **Ownership.** ATLAS stores the hash of everything it writes (`sync.state`). It updates or deletes only what it wrote and what is unchanged since. Everything else is a conflict and is left alone:
  - an edit made outside ATLAS;
  - a same-named item ATLAS did not write;
  - a config file that is not plain JSON (comments);
  - a Codex table for the same server outside ATLAS's block;
  - a symbolic link.
- **Preview, then apply.** Apply recomputes the plan and refuses if it differs from the preview. Writes are atomic: a temporary file or folder, then a rename.
- **Coming in.** Skills found in those tools' folders are listed as untrusted, exactly like repository skills, until the operator imports the reviewed version (hash-pinned). Copies ATLAS synced there are not listed again. MCP servers found in their configs can be added to ATLAS:
  - header values, environment references and secret-looking environment values become secret names the operator fills in;
  - credentials are never copied;
  - the server starts with "ask" approval and no network.
- **Skills authoring.**
  - The operator writes skills in ATLAS (name, description, roles, Markdown procedure). Editing keeps reference files.
  - *Customize* copies a bundled skill into an operator skill of the same name, which then overrides it.
  - A skill can be turned off (`skills.disabled`): it is neither offered nor loadable, and not synced.

## Consequences
- Approvals do not travel: Claude Code, Codex and OpenCode apply their own permission models to the synced MCP servers. The Settings text says so.
- Sync runs only on the operator's request. There is no background watcher, so a tool's files can drift until the next preview, which then shows the difference.
