// Manual §41, the UI half: six missions run at once (scripted runtime, real worktrees, real sandboxed checks) while
// the test measures the renderer's event-loop delay and how long the command palette takes to open from the keyboard.
// The worker-cap half (12 parallel writers never exceed maxConcurrentAgents) is tests/integration/m2.test.ts.
import { expect, test } from '@playwright/test';
import { sampleRepo } from '../helpers';
import { launch } from './app';

const MISSIONS = 6;

test('six concurrent missions: UI stays responsive and every mission verifies', async () => {
  // Windows: every sandboxed command is an account logon (ADR 0020), so six missions take longer.
  const budget = process.platform === 'win32' ? 420_000 : 180_000;
  test.setTimeout(budget + 60_000);
  const repo = sampleRepo();
  const { app, page } = await launch({ openDir: repo });
  try {
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await expect(page.getByTestId('workspace-card')).toContainText('sample-app');

    // The probe must see a frozen renderer: a 400 ms busy loop shows up as at least 300 ms of timer delay.
    const probe = () => new Promise<number>((r) => { const t = performance.now(); setTimeout(() => r(performance.now() - t - 50), 50); });
    const blocked = await page.evaluate(() => {
      const p = new Promise<number>((r) => { const t = performance.now(); setTimeout(() => r(performance.now() - t - 50), 50); });
      const end = performance.now() + 400; while (performance.now() < end) { /* block */ }
      return p;
    });
    expect(blocked).toBeGreaterThan(300);

    // Start every mission through the same IPC bridge the UI uses.
    const ids: string[] = await page.evaluate(async ({ n }) => {
      const a = (window as any).atlas;
      const [ws] = await a.invoke('workspace.list', {});
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const m = await a.invoke('mission.create', { workspaceId: ws.id, title: `Stress ${i + 1}`, goal: 'Make slugify produce valid URL slugs.', approvalMode: 'ask_risky', runtime: 'fake' });
        out.push(m.id);
      }
      await Promise.all(out.map(async (id) => { await a.invoke('mission.plan', { missionId: id }); }));
      await Promise.all(out.map(async (id) => { await a.invoke('mission.approvePlan', { missionId: id }); }));
      return out;
    }, { n: MISSIONS });
    expect(ids).toHaveLength(MISSIONS);

    // While they run: event-loop delay (a 50 ms timer, how late it fires) and palette open latency.
    const lag: number[] = [];
    const palette: number[] = [];
    const states = async () => page.evaluate(async (list) => {
      const a = (window as any).atlas;
      return Promise.all(list.map(async (id: string) => { try { return (await a.invoke('mission.get', { missionId: id })).mission.state; } catch { return 'error'; } }));
    }, ids);
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      lag.push(await page.evaluate(probe));
      const t0 = Date.now();
      await page.keyboard.press('Control+k');
      await expect(page.getByTestId('palette')).toBeVisible();
      palette.push(Date.now() - t0);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('palette')).toBeHidden();
      const s = await states();
      if (s.every((x) => ['completed', 'failed', 'cancelled', 'error'].includes(x))) break;
    }
    const final = await states();
    const p95 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];
    console.log(`[stress] missions=${MISSIONS} samples=${lag.length} event-loop delay p95=${p95(lag).toFixed(0)}ms max=${Math.max(...lag).toFixed(0)}ms; palette open p95=${p95(palette)}ms max=${Math.max(...palette)}ms; states=${final.join(',')}`);

    // Every mission finished and verified.
    const outcomes = await page.evaluate(async (list) => {
      const a = (window as any).atlas;
      return Promise.all(list.map(async (id: string) => { const m = (await a.invoke('mission.get', { missionId: id })).mission; return `${m.state}: ${m.outcome ?? ''}`; }));
    }, ids);
    expect(final.every((x) => x === 'completed'), outcomes.join('\n')).toBe(true);
    const verdicts: string[] = await page.evaluate(async (list) => {
      const a = (window as any).atlas;
      return Promise.all(list.map(async (id: string) => (await a.invoke('mission.get', { missionId: id })).mission.verdict));
    }, ids);
    expect(verdicts.every((v) => v === 'verified'), verdicts.join(',')).toBe(true);

    // Responsiveness bounds: generous for loaded CI runners, far below "frozen".
    expect(p95(lag), lag.join(',')).toBeLessThan(250);
    expect(p95(palette), palette.join(',')).toBeLessThan(1500);
  } finally { await app.close(); }
});
