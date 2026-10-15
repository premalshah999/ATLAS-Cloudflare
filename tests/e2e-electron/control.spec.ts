// Mission Control (the design's Control view): workforce with dependencies, inspector, thread and composer.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath as __f } from 'node:url';
import { sampleRepo } from '../helpers';
import { launch } from './app';
const shot = (name: string) => path.resolve(path.dirname(__f(import.meta.url)), `../../test-results/e2e-electron/${name}.png`);

test('mission control shows the workforce, inspects an agent and refuses to direct one that is not running', async () => {
  const { app, page } = await launch({ openDir: sampleRepo() });
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Parallel work');
    await page.getByTestId('mission-goal').fill('[parallel sample] Fix slugify and add regression coverage in parallel, then review and verify the integrated result.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('plan-mission').click();
    await page.getByTestId('approve-plan').click();
    await expect(page.getByTestId('control')).toBeVisible();
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
    await page.getByRole('tab', { name: /Control/ }).click();
    const cards = page.getByTestId('agent-card');
    expect(await cards.count()).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId('workforce')).toContainText('after');
    await cards.nth(1).click();
    await expect(page.getByTestId('agent-inspector')).toContainText('Execution permission');
    await expect(page.getByTestId('agent-inspector')).toContainText('Branch');
    await expect(page.getByTestId('agent-thread')).not.toContainText('No activity for this agent yet');
    await expect(page.getByTestId('composer-input')).toBeDisabled();
    await page.screenshot({ path: shot('live-control') });
    // The daemon refuses direction to an agent that is not running, whatever the UI allows.
    const err = await page.evaluate(async () => {
      const a = (window as any).atlas;
      const [m] = await a.invoke('mission.list', {});
      const s = await a.invoke('mission.get', { missionId: m.id });
      try { await a.invoke('task.direct', { taskId: s.tasks[0].id, text: 'keep going' }); return ''; } catch (e) { return (e as Error).message; }
    });
    expect(err).toContain('no running agent');
  } finally { await app.close(); }
});
