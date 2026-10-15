// Where each harness keeps skills and MCP servers (ADR 0019). Only locations confirmed from each tool's own
// documentation or source are written; anything else is reported as unsupported, never guessed.
import os from 'node:os';
import path from 'node:path';

export type Harness = 'claude-code' | 'codex' | 'opencode';
export type Scope = 'user' | 'project';
export const HARNESSES: { id: Harness; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
];

export interface Target {
  harness: Harness;
  scope: Scope;
  /** The operator's home directory (tests pass a temporary one). */
  home?: string;
  /** Repository root, for project scope. */
  projectRoot?: string;
  /** $CODEX_HOME when set; default ~/.codex. */
  codexHome?: string;
}

export type McpFormat = 'claude-json' | 'opencode-json' | 'codex-toml';
export interface Locations {
  skills: string | null;
  skillsWhyNot?: string;
  mcp: { format: McpFormat; file: string } | null;
  mcpWhyNot?: string;
}

export function locations(t: Target): Locations {
  const home = t.home ?? os.homedir();
  if (t.scope === 'project' && !t.projectRoot) throw new Error('project scope needs a repository');
  const root = t.projectRoot!;
  switch (t.harness) {
    case 'claude-code':
      return t.scope === 'user'
        ? { skills: path.join(home, '.claude', 'skills'), mcp: null, mcpWhyNot: 'Claude Code keeps user-level MCP servers in ~/.claude.json, a file it manages itself. Sync MCP servers per repository (.mcp.json) instead.' }
        : { skills: path.join(root, '.claude', 'skills'), mcp: { format: 'claude-json', file: path.join(root, '.mcp.json') } };
    case 'codex': {
      const ch = t.codexHome ?? path.join(home, '.codex');
      return t.scope === 'user'
        ? { skills: path.join(ch, 'skills'), mcp: { format: 'codex-toml', file: path.join(ch, 'config.toml') } }
        : { skills: null, skillsWhyNot: 'Codex reads user skills from ~/.codex/skills; ATLAS does not write repository skills for Codex.', mcp: null, mcpWhyNot: 'Codex reads MCP servers from ~/.codex/config.toml; use the user scope.' };
    }
    case 'opencode':
      return t.scope === 'user'
        ? { skills: path.join(home, '.config', 'opencode', 'skills'), mcp: { format: 'opencode-json', file: path.join(home, '.config', 'opencode', 'opencode.json') } }
        : { skills: path.join(root, '.opencode', 'skills'), mcp: { format: 'opencode-json', file: path.join(root, 'opencode.json') } };
  }
}
