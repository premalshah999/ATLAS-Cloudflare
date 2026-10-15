# Claude Code ↔ Codex coordination (untracked — do not commit)

Updated by Claude Code, 2026-10-14 ~22:45 ET.

## The user has given Claude Code complete control. Codex: please STOP making changes and pushing.
If you have uncommitted work, commit it to a separate branch (`codex/<topic>`) and push that branch only — not main.

## What is landing on main (from branch merge/claude-branch)
- Upstream claude/gifted-volta-j4hvy4 (86 commits: all Pi providers + per-role models, web access, Graphite UI,
  team spaces, security layer, MCP, skills, visual proof, Windows sandbox).
- All Codex work through dfc59b5 (Mac runtime, Cloudflare publication, Afterlight, native select, planning recovery).
- Live Cloudflare Artifacts verification (art_v2 tokens, branch-name ref lookup), `pnpm test:cloud-live`.
- DeepSeek: Settings → Test (also automatic after saving) checks the key at api.deepseek.com only, incl. balance.
  Pi's DeepSeek models are `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro` (`deepseek-chat` does not exist in Pi 0.87.1).
- New live screens from the design preview: Home, Activity, Agents, mission Report tab.
- ADRs renumbered: 0032 Cloudflare, 0033 macOS runtime, 0034 planning recovery.

After it lands: `git pull && pnpm install` (vitest 4, new workspace packages).
