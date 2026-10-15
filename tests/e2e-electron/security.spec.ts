// Electron acceptance (manual E8): branded window, no Node in the renderer, only declared IPC.
import { expect, test } from '@playwright/test';
import { launch } from './app';

test('boots a branded ATLAS window with a hardened renderer', async () => {
  const { app, page } = await launch();
  try {
    expect(await page.title()).toBe('ATLAS');
    await expect(page.getByTestId('projects')).toBeVisible();

    const probe = await page.evaluate(() => ({
      require: typeof (window as any).require,
      process: typeof (window as any).process,
      module: typeof (window as any).module,
      bridgeKeys: Object.keys((window as any).atlas).sort(),
      frozen: Object.isFrozen((window as any).atlas),
    }));
    expect(probe).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined', bridgeKeys: ['e2e', 'invoke', 'onEvent', 'onStatus', 'onTerminal', 'platform'], frozen: true });

    const webPrefs = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const p = (w.webContents as any).getLastWebPreferences?.() ?? {};
      return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox };
    });
    expect(webPrefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });
  } finally { await app.close(); }
});

test('undeclared, malformed and unknown-target requests are denied', async () => {
  const { app, page } = await launch();
  try {
    const results = await page.evaluate(async () => {
      const a = (window as any).atlas;
      const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); return 'allowed'; } catch (e) { return (e as Error).message; } };
      return {
        undeclared: await attempt(() => a.invoke('shell.exec', { command: 'id' })),
        internal: await attempt(() => a.invoke('workspace.register', { path: '/etc' })),
        malformed: await attempt(() => a.invoke('mission.get', { missionId: '../../etc/passwd' })),
        extraKeys: await attempt(() => a.invoke('mission.get', { missionId: 'msn_AAAAAAAAAAAA', path: '/etc' })),
        unknownMission: await attempt(() => a.invoke('mission.get', { missionId: 'msn_AAAAAAAAAAAA' })),
        ok: await attempt(() => a.invoke('workspace.list', {})),
      };
    });
    expect(results.undeclared).toMatch(/Undeclared method/);
    expect(results.internal).toMatch(/Undeclared method/);
    expect(results.malformed).toMatch(/Malformed request/);
    expect(results.extraKeys).toMatch(/Malformed request/);
    expect(results.unknownMission).toMatch(/Unknown mission/);
    expect(results.ok).toBe('allowed');
  } finally { await app.close(); }
});

test('network audit: the idle app makes no outbound requests (manual §43)', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { tmpDir } = await import('../helpers');
  const log = path.join(tmpDir('atlas-netlog-'), 'netlog.json');
  const { app, page } = await launch({ args: [`--log-net-log=${log}`, '--net-log-capture-mode=Default'] });
  try {
    // Visit every top-level screen, then sit idle.
    await page.keyboard.press('Control+,');
    await expect(page.getByTestId('settings')).toBeVisible();
    await expect(page.getByTestId('roles')).toContainText('Coder');
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(10_000);
  } finally { await app.close(); }
  const text = readFileSync(log, 'utf8');
  expect(text.length).toBeGreaterThan(100); // the log was actually written
  const urls = [...text.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]);
  const hosts = [...text.matchAll(/"host":"([^"]+)"/g)].map((m) => m[1]);
  const local = (u: string) => /^(file|devtools|chrome|chrome-extension|data|blob|about):/.test(u) || /^(https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(u);
  expect(urls.filter((u) => !local(u))).toEqual([]);
  expect(hosts.filter((h) => !/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/.test(h))).toEqual([]);
});
