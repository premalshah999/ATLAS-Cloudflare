// ADR 0019 through the real app, in a temporary home directory: author a skill, sync skills to Claude Code and an MCP
// server to Codex, see "in sync" afterwards, bring another tool's skill and MCP server into ATLAS without credentials.
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers';
import { launch } from './app';

test('skills and MCP servers sync to Claude Code and Codex; other tools\' items come in as untrusted', async () => {
  const home = tmpDir('atlas-home-');
  // Another tool's skill and MCP server, made by the user outside ATLAS.
  mkdirSync(path.join(home, '.config/opencode/skills/team-style'), { recursive: true });
  writeFileSync(path.join(home, '.config/opencode/skills/team-style/SKILL.md'), '---\nname: team-style\ndescription: Our team conventions.\n---\nPrefer small functions.\n');
  writeFileSync(path.join(home, '.config/opencode/opencode.json'), JSON.stringify({ mcp: { tracker: { type: 'remote', url: 'https://tracker.example.com/mcp', headers: { Authorization: 'Bearer real-secret-value' } } } }));
  // HOME on Linux and macOS; USERPROFILE is what Windows (and os.homedir()) use.
  const { app, page } = await launch({ env: { HOME: home, USERPROFILE: home } });
  try {
    await page.keyboard.press('Control+,');

    // Author a skill.
    await page.getByTestId('skill-new').click();
    await page.getByTestId('skill-form-name').fill('release-notes');
    await page.getByTestId('skill-form-description').fill('Write user-facing release notes from a diff.');
    await page.getByTestId('skill-form-body').fill('# Steps\n1. Read the diff.\n2. Group by user impact.');
    await page.getByTestId('skill-form-save').click();
    const skills = page.getByTestId('skills');
    await expect(skills.locator('[data-testid="skill-row"][data-source="operator"]')).toContainText('release-notes');

    // The other tool's skill is listed as untrusted and can be imported at the reviewed version.
    const ext = skills.locator('[data-testid="skill-row"][data-source="external"]');
    await expect(ext).toContainText('team-style');
    await expect(ext).toContainText('OpenCode · not trusted');
    await ext.getByRole('button', { name: 'Read' }).click();
    await ext.getByTestId('skill-import').click();
    await expect(skills.locator('[data-testid="skill-row"][data-source="operator"][data-name="team-style"]')).toHaveCount(1);

    // Turn one bundled skill off: it is not synced.
    await skills.locator('[data-testid="skill-row"][data-name="ruthless-simplifier"]').getByRole('switch').click();
    await expect(skills.locator('[data-testid="skill-row"][data-name="ruthless-simplifier"]')).toContainText('off');

    // Sync skills to Claude Code (user scope). MCP for Claude Code is per repository: a note says so.
    const claude = page.getByTestId('sync-claude-code');
    await claude.scrollIntoViewIfNeeded();
    await page.getByTestId('sync-claude-code-preview').click();
    const changes = page.getByTestId('sync-claude-code-changes');
    await expect(changes).toContainText('~/.claude.json');
    // 18 bundled skills, one turned off, plus the two operator skills (release-notes, team-style).
    await expect(changes.locator('[data-action="create"]')).toHaveCount(18 - 1 + 2);
    await page.getByTestId('sync-claude-code-apply').click();
    await expect(page.getByTestId('sync-claude-code-apply')).toHaveText('In sync');
    expect(readFileSync(path.join(home, '.claude/skills/release-notes/SKILL.md'), 'utf8')).toContain('Group by user impact.');
    expect(existsSync(path.join(home, '.claude/skills/ruthless-simplifier'))).toBe(false);

    // Bring OpenCode's MCP server in: the header value is not copied, only its name.
    await page.getByTestId('sync-opencode-foreign').click();
    const list = page.getByTestId('sync-opencode-foreign-list');
    await expect(list).toContainText('tracker');
    await expect(list).toContainText('secrets to enter: Authorization');
    await list.getByRole('button', { name: 'Add to ATLAS' }).click();
    await expect(page.getByTestId('mcp-tracker')).toContainText('tracker.example.com');
    const listed = await page.evaluate(async () => JSON.stringify(await (window as any).atlas.invoke('mcp.list', {})));
    expect(listed).not.toContain('real-secret-value');

    // Sync MCP servers to Codex: a managed block in config.toml that references a variable, never the value.
    await page.getByTestId('sync-codex-preview').click();
    await expect(page.getByTestId('sync-codex-changes').locator('[data-action="create"]')).not.toHaveCount(0);
    await page.getByTestId('sync-codex-apply').click();
    await expect(page.getByTestId('sync-codex-apply')).toHaveText('In sync');
    const toml = readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.tracker]');
    expect(toml).toContain('env_http_headers = { Authorization = "ATLAS_MCP_SECRET_TRACKER_AUTHORIZATION" }');
    expect(toml).not.toContain('real-secret-value');
    expect(existsSync(path.join(home, '.codex/skills/release-notes/SKILL.md'))).toBe(true);
  } finally { await app.close(); }
});
