// ADR 0019: syncing ATLAS skills and MCP servers to Claude Code, Codex and OpenCode. Every test runs against a
// temporary home and repository; nothing outside them is read or written.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpServerConfig } from '@atlas/contracts';
import { apply, BLOCK_BEGIN, dirHash, foreignServers, plan, type SkillSource, type SyncState, type Target } from '../src';
import { tmpDir } from '../../../tests/helpers';

function skill(name: string, body = 'Do the thing.'): SkillSource {
  const dir = path.join(tmpDir('atlas-skill-'), name);
  mkdirSync(path.join(dir, 'references'), { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} procedure\n---\n${body}\n`);
  writeFileSync(path.join(dir, 'references', 'notes.md'), 'notes');
  return { name, dir, files: ['SKILL.md', 'references/notes.md'], hash: dirHash(dir)! };
}
const remote = McpServerConfig.parse({ name: 'docs', transport: 'http', url: 'https://mcp.example.com/mcp', secrets: ['Authorization'] });
const local = McpServerConfig.parse({ name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'some-server'], env: { LOG_LEVEL: 'info' }, secrets: ['API_TOKEN'] });
const sync = (t: Target, input: Parameters<typeof plan>[1], state: SyncState) => apply(t, input, state, plan(t, input, state).id);
const counts = (cs: { action: string }[]) => cs.reduce<Record<string, number>>((a, c) => ({ ...a, [c.action]: (a[c.action] ?? 0) + 1 }), {});

describe('harness sync (ADR 0019)', () => {
  it('Claude Code, project: writes skills and .mcp.json with variable references, keeps the user\'s entries, is idempotent', () => {
    const root = tmpDir('atlas-repo-');
    writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { type: 'stdio', command: 'my-server' } } }, null, 2));
    const t: Target = { harness: 'claude-code', scope: 'project', projectRoot: root, home: tmpDir() };
    const input = { skills: [skill('evidence-report')], mcp: [remote, local] };
    const first = sync(t, input, {});
    expect(counts(first.changes)).toEqual({ create: 3 });
    expect(readFileSync(path.join(root, '.claude/skills/evidence-report/references/notes.md'), 'utf8')).toBe('notes');
    const mcp = JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.mine).toEqual({ type: 'stdio', command: 'my-server' });
    expect(mcp.mcpServers.docs).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: '${ATLAS_MCP_SECRET_DOCS_AUTHORIZATION}' } });
    expect(mcp.mcpServers.files.env).toEqual({ LOG_LEVEL: 'info', API_TOKEN: '${ATLAS_MCP_SECRET_FILES_API_TOKEN}' });
    const again = plan(t, input, first.state);
    expect(counts(again.changes)).toEqual({ unchanged: 3 });
  });

  it('updates only what it wrote; edits and same-named items made outside ATLAS are conflicts and stay untouched', () => {
    const home = tmpDir();
    const t: Target = { harness: 'claude-code', scope: 'user', home };
    const a = skill('alpha');
    const { state } = sync(t, { skills: [a], mcp: [] }, {});
    // Someone else's skill with a name ATLAS wants to use.
    mkdirSync(path.join(home, '.claude/skills/beta'), { recursive: true });
    writeFileSync(path.join(home, '.claude/skills/beta/SKILL.md'), 'mine');
    const p1 = plan(t, { skills: [skill('alpha', 'Improved procedure.'), skill('beta')], mcp: [] }, state);
    expect(p1.changes.map((c) => [c.name, c.action])).toEqual([['alpha', 'update'], ['beta', 'conflict']]);
    // The operator edits ATLAS's copy by hand: now it is theirs too.
    writeFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'hand edited');
    const p2 = plan(t, { skills: [skill('alpha', 'Improved procedure.')], mcp: [] }, state);
    expect(p2.changes[0]).toMatchObject({ action: 'conflict', reason: expect.stringMatching(/changed outside ATLAS/) });
    apply(t, { skills: [skill('alpha', 'Improved procedure.')], mcp: [] }, state, p2.id);
    expect(readFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'utf8')).toBe('hand edited');
    expect(readFileSync(path.join(home, '.claude/skills/beta/SKILL.md'), 'utf8')).toBe('mine');
    expect(p2.notes[0]).toMatch(/~\/\.claude\.json/);
  });

  it('removes a skill ATLAS no longer has, unless it was changed outside ATLAS', () => {
    const home = tmpDir();
    const t: Target = { harness: 'opencode', scope: 'user', home };
    const { state } = sync(t, { skills: [skill('one'), skill('two')], mcp: [] }, {});
    writeFileSync(path.join(home, '.config/opencode/skills/two/SKILL.md'), 'kept by hand');
    const r = sync(t, { skills: [], mcp: [] }, state);
    expect(r.changes.map((c) => [c.name, c.action])).toEqual([['one', 'delete'], ['two', 'conflict']]);
    expect(existsSync(path.join(home, '.config/opencode/skills/one'))).toBe(false);
    expect(existsSync(path.join(home, '.config/opencode/skills/two'))).toBe(true);
  });

  it('Codex: a managed block in config.toml; the rest of the file is never changed', () => {
    const home = tmpDir();
    const file = path.join(home, '.codex/config.toml');
    mkdirSync(path.dirname(file), { recursive: true });
    const user = 'model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "my-server"\n';
    writeFileSync(file, user);
    const t: Target = { harness: 'codex', scope: 'user', home };
    const clash = McpServerConfig.parse({ name: 'mine', transport: 'http', url: 'https://x.example.com/mcp' });
    const r = sync(t, { skills: [], mcp: [remote, local, clash] }, {});
    expect(r.changes.map((c) => [c.name, c.action])).toEqual([['mine', 'conflict'], ['docs', 'create'], ['files', 'create']]);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith(user)).toBe(true);
    expect(text).toContain(BLOCK_BEGIN);
    expect(text).toContain('[mcp_servers.docs]\nurl = "https://mcp.example.com/mcp"\nenv_http_headers = { Authorization = "ATLAS_MCP_SECRET_DOCS_AUTHORIZATION" }');
    expect(text).toContain('[mcp_servers.files]\ncommand = "npx"\nargs = ["-y", "some-server"]\nenv = { LOG_LEVEL = "info" }\nenv_vars = ["API_TOKEN"]');
    expect(counts(plan(t, { skills: [], mcp: [remote, local] }, r.state).changes)).toEqual({ unchanged: 2 });
    // Hand edits inside the block make it a conflict.
    writeFileSync(file, text.replace('some-server', 'other-server'));
    expect(counts(plan(t, { skills: [], mcp: [remote, local] }, r.state).changes)).toEqual({ conflict: 2 });
    writeFileSync(file, text);
    // Removing every server removes the block and leaves the user's file as it was.
    sync(t, { skills: [], mcp: [] }, r.state);
    expect(readFileSync(file, 'utf8').trim()).toBe(user.trim());
  });

  it('OpenCode: a config with comments is never rewritten; a disabled server is not synced', () => {
    const root = tmpDir('atlas-repo-');
    const jsonc = '{\n  // my settings\n  "theme": "dark"\n}\n';
    writeFileSync(path.join(root, 'opencode.json'), jsonc);
    const t: Target = { harness: 'opencode', scope: 'project', projectRoot: root, home: tmpDir() };
    const r = sync(t, { skills: [], mcp: [remote, { ...local, enabled: false }] }, {});
    expect(r.changes).toEqual([expect.objectContaining({ name: 'docs', action: 'conflict', reason: expect.stringMatching(/not plain JSON/) })]);
    expect(readFileSync(path.join(root, 'opencode.json'), 'utf8')).toBe(jsonc);
    const root2 = tmpDir('atlas-repo-');
    sync({ ...t, projectRoot: root2 }, { skills: [], mcp: [remote, local] }, {});
    const cfg = JSON.parse(readFileSync(path.join(root2, 'opencode.json'), 'utf8'));
    expect(cfg.mcp.docs).toEqual({ type: 'remote', url: 'https://mcp.example.com/mcp', enabled: true, oauth: false, headers: { Authorization: '{env:ATLAS_MCP_SECRET_DOCS_AUTHORIZATION}' } });
    expect(cfg.mcp.files).toEqual({ type: 'local', command: ['npx', '-y', 'some-server'], enabled: true, environment: { LOG_LEVEL: 'info', API_TOKEN: '{env:ATLAS_MCP_SECRET_FILES_API_TOKEN}' } });
  });

  it('refuses to apply a stale preview, writes through no symbolic link, and names unsupported locations', () => {
    const home = tmpDir();
    const t: Target = { harness: 'claude-code', scope: 'user', home };
    const input = { skills: [skill('alpha')], mcp: [] };
    const p = plan(t, input, {});
    mkdirSync(path.join(home, '.claude/skills/alpha'), { recursive: true });
    writeFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'appeared meanwhile');
    expect(() => apply(t, input, {}, p.id)).toThrow(/changed since the preview/);
    expect(readFileSync(path.join(home, '.claude/skills/alpha/SKILL.md'), 'utf8')).toBe('appeared meanwhile');
    const outside = tmpDir();
    symlinkSync(outside, path.join(home, '.claude/skills/linked'));
    expect(plan(t, { skills: [skill('linked')], mcp: [] }, {}).changes[0]).toMatchObject({ action: 'conflict', reason: expect.stringMatching(/symbolic link/) });
    const codexProject = plan({ harness: 'codex', scope: 'project', projectRoot: tmpDir(), home }, { skills: [skill('x')], mcp: [remote] }, {});
    expect(codexProject.changes).toEqual([]);
    expect(codexProject.notes).toHaveLength(2);
  });

  it('reads other tools\' servers for import without copying credentials', () => {
    const root = tmpDir('atlas-repo-');
    writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
      search: { type: 'http', url: 'https://search.example.com/mcp', headers: { Authorization: 'Bearer sk-live-real-token' } },
      db: { command: 'db-mcp', args: ['--ro'], env: { DB_PASSWORD: 'hunter2', REGION: 'eu' } },
    } }));
    const found = foreignServers({ harness: 'claude-code', scope: 'project', projectRoot: root }, {});
    expect(JSON.stringify(found)).not.toMatch(/sk-live-real-token|hunter2/);
    expect(found.find((f) => f.name === 'search')).toMatchObject({ secretNames: ['Authorization'], config: { transport: 'http', url: 'https://search.example.com/mcp' } });
    expect(found.find((f) => f.name === 'db')).toMatchObject({ secretNames: ['DB_PASSWORD'], config: { command: 'db-mcp', args: ['--ro'], env: { REGION: 'eu' } } });
    for (const f of found) expect(McpServerConfig.safeParse(f.config).success).toBe(true);

    const home = tmpDir();
    mkdirSync(path.join(home, '.codex'));
    writeFileSync(path.join(home, '.codex/config.toml'), '[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"\nbearer_token_env_var = "FIGMA_TOKEN"\n\n[mcp_servers.local-tool]\ncommand = "tool"\nargs = ["serve", "--stdio"]\nenv = { MODE = "fast", SECRET_KEY = "abc" }\n');
    const codex = foreignServers({ harness: 'codex', scope: 'user', home }, {});
    expect(codex.map((c) => c.config)).toEqual([
      { name: 'figma', transport: 'http', url: 'https://mcp.figma.com/mcp', secrets: ['Authorization'] },
      { name: 'local-tool', transport: 'stdio', command: 'tool', args: ['serve', '--stdio'], env: { MODE: 'fast' }, secrets: ['SECRET_KEY'] },
    ]);
  });
});
