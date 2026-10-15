// ADR 0025 through the real app: Settings shows what ATLAS keeps on disk and clears derived data on request,
// keeping the evidence.
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch } from './app';
import { tmpDir } from '../helpers';

test('storage and cleanup: rotated logs and orphaned caches are cleared, evidence is kept', async () => {
  const userData = tmpDir('atlas-e2e-');
  const data = path.join(userData, 'data');
  const { app, page } = await launch({ userData });
  try {
    // Leftovers a long-running installation accumulates (made after start, so the start-up cleanup does not see them).
    mkdirSync(path.join(data, 'logs'), { recursive: true });
    writeFileSync(path.join(data, 'logs', 'daemon.log.1'), 'x'.repeat(50_000));
    mkdirSync(path.join(data, 'graphs'), { recursive: true });
    writeFileSync(path.join(data, 'graphs', 'f'.repeat(40) + '.json'), '{}');
    mkdirSync(path.join(data, 'worktrees', 'msn_deleted0001', 'implement-1'), { recursive: true });
    await page.keyboard.press('Control+,');
    const table = page.getByTestId('storage-table');
    await expect(table.locator('[data-category="evidence"]')).toContainText('Evidence');
    await expect(table.locator('[data-category="logs"]')).toContainText('can be cleared');
    await page.getByTestId('cleanup-now').click();
    await expect(page.getByTestId('cleanup-last')).toContainText('freed');
    expect(existsSync(path.join(data, 'logs', 'daemon.log.1'))).toBe(false);
    expect(existsSync(path.join(data, 'worktrees', 'msn_deleted0001'))).toBe(false);
    expect(existsSync(path.join(data, 'atlas.db'))).toBe(true);
    await expect(table.locator('[data-category="logs"]')).not.toContainText('can be cleared');
  } finally { await app.close(); }
});
