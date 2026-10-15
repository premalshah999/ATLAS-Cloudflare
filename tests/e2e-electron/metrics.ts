// Baseline/regression metrics from the real built app (docs/evolution/05-test-evidence.md). Not a pass/fail test:
// it records numbers to evals/out/metrics-<label>.json. Run: pnpm metrics [label] (Linux: under xvfb-run).
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleRepo } from '../helpers';
import { launch } from './app';

const here = path.dirname(fileURLToPath(import.meta.url));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
type AppMetric = { pid: number; type: string; name?: string; serviceName?: string; memory: { workingSetSize: number; privateBytes?: number }; cpu: { percentCPUUsage: number } };

test('collect metrics', async () => {
  test.setTimeout(600_000);
  const out: Record<string, unknown> = { label: process.env.ATLAS_METRICS_LABEL ?? 'run', at: new Date().toISOString(), platform: `${process.platform}-${process.arch}` };

  // Cold launch to daemon ready, 3 runs (fresh data dir each time).
  const launches: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const { app } = await launch();
    launches.push(Date.now() - t0);
    await app.close();
  }
  out.coldLaunchToDaemonReadyMs = { runs: launches, median: median(launches) };

  const repo = sampleRepo();
  const { app, page } = await launch({ openDir: repo });
  try {
    await page.waitForTimeout(3000);
    const idle = (await app.evaluate(({ app: a }) => a.getAppMetrics())) as AppMetric[];
    out.idleMemoryMB = Math.round(idle.reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024);
    out.idleCpuPercent = Number(idle.reduce((n, m) => n + m.cpu.percentCPUUsage, 0).toFixed(1));
    out.idleProcesses = idle.map((m) => ({ type: m.type, name: m.serviceName ?? m.name ?? '', MB: Math.round(m.memory.workingSetSize / 1024) }));

    // Sample mission: plan → approve → verified.
    await page.getByRole('button', { name: 'Open repository' }).first().click();
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Metrics mission');
    await page.getByTestId('mission-goal').fill('Fix slugify.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
    let t0 = Date.now();
    await page.getByTestId('plan-mission').click();
    await expect(page.getByTestId('plan')).toBeVisible();
    out.planLatencyMs = Date.now() - t0;
    t0 = Date.now();
    await page.getByTestId('approve-plan').click();
    await expect(page.getByTestId('timeline')).toContainText('started attempt 1', { timeout: 30_000 });
    out.approveToFirstAgentStartMs = Date.now() - t0;
    let peak = 0;
    const poll = setInterval(async () => { try { const ms = (await app.evaluate(({ app: a }) => a.getAppMetrics())) as AppMetric[]; peak = Math.max(peak, ms.reduce((n, m) => n + m.memory.workingSetSize, 0)); } catch { /* closing */ } }, 500);
    await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 120_000 });
    clearInterval(poll);
    out.approveToVerifiedMs = Date.now() - t0;
    out.peakMemoryDuringMissionMB = Math.round(peak / 1024);

    // Terminal: keystroke-to-echo latency, 5 samples.
    await page.getByRole('tab', { name: /Terminal/ }).click();
    await page.getByTestId('open-terminal').click();
    await expect(page.getByTestId('terminal')).toContainText('sandboxed', { timeout: 15_000 });
    await page.locator('.lv-term').click();
    const echoes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const mark = `MARK${i}x${Date.now() % 100000}`;
      const s = Date.now();
      await page.keyboard.type(`echo ${mark}\n`, { delay: 0 });
      await expect(page.locator('.lv-term')).toContainText(`${mark}\n`.trim(), { timeout: 10_000 });
      echoes.push(Date.now() - s);
    }
    out.terminalEchoMs = { runs: echoes, median: median(echoes) };

    // Daemon crash → ready again.
    t0 = Date.now();
    await page.evaluate(() => (window as any).atlas.e2e.crashDaemon());
    await expect(page.getByTestId('daemon-status')).toHaveAttribute('data-state', 'restarting', { timeout: 10_000 });
    await expect(page.getByTestId('daemon-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    out.daemonCrashToReadyMs = Date.now() - t0;
  } finally { await app.close(); }

  const dir = path.resolve(here, '../../evals/out');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `metrics-${out.label}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
