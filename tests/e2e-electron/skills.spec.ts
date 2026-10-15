// Skills through the real app (ADR 0013): the packaged-path resolution finds the bundled library, a skill found
// in the repository is shown as untrusted, and importing it pins that exact version.
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sampleRepo } from '../helpers';
import { launch } from './app';

test('bundled skills are listed; a repository skill is untrusted until imported', async () => {
  const repo = sampleRepo();
  mkdirSync(path.join(repo, '.agents/skills/house-style'), { recursive: true });
  writeFileSync(path.join(repo, '.agents/skills/house-style/SKILL.md'), '---\nname: house-style\ndescription: Our commit and naming conventions.\n---\nUse short names.\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=u', '-c', 'user.email=u@u', 'commit', '-qm', 'skill']);
  const { app, page } = await launch({ openDir: repo });
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('sample-app');
    await page.keyboard.press('Control+,');
    const skills = page.getByTestId('skills');
    await expect(skills.locator('[data-testid="skill-row"][data-source="bundled"]')).toHaveCount(18);
    // Each bundled skill says when ATLAS recommends it (ADR 0029).
    await expect(skills.locator('[data-testid="skill-row"][data-name="flaky-test-hunter"] [data-testid="skill-triggers"]')).toContainText('Recommended when a task mentions: flak*, intermittent*');
    await expect(skills).toContainText('reproduce-before-fix');
    const repoRow = skills.locator('[data-testid="skill-row"][data-source="repository"]');
    await expect(repoRow).toContainText('house-style');
    await expect(repoRow).toContainText('not trusted');
    await repoRow.getByRole('button', { name: 'Read' }).click();
    await expect(repoRow).toContainText('Use short names.');
    await repoRow.getByTestId('skill-import').click();
    await expect(skills.locator('[data-testid="skill-row"][data-source="operator"]')).toContainText('house-style');
  } finally { await app.close(); }
});
