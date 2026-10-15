// Drives the installed ATLAS app with the operator's own profile, exactly as the UI does (window.atlas.invoke).
// Provider keys stay inside the app: this script never reads or prints them.
import { _electron as electron } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

export async function openAtlas({ openDir } = {}) {
  const env = { ...process.env, ATLAS_E2E: '1', ATLAS_USER_DATA: path.join(os.homedir(), 'Library/Application Support/ATLAS') };
  if (openDir) env.ATLAS_E2E_OPEN_DIR = openDir;
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (/_API_KEY$/.test(k)) delete env[k];
  const app = await electron.launch({ executablePath: path.join(os.homedir(), 'Applications/ATLAS.app/Contents/MacOS/atlas'), env });
  const proc = app.process();
  const tag = (d) => String(d).split('\n').filter((l) => l.trim() && !/task_name_for_pid/.test(l)).forEach((l) => console.log(`[app] ${l.slice(0, 300)}`));
  proc.stdout?.on('data', tag); proc.stderr?.on('data', tag);
  proc.on('exit', (code, signal) => console.log(`[app] exited code=${code} signal=${signal}`));
  app.on('close', () => console.log('[app] closed'));
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.getByTestId('daemon-status').and(page.locator('[data-state="ready"]')).waitFor({ timeout: 60_000 });
  const invoke = (method, params = {}) => page.evaluate(([m, p]) => window.atlas.invoke(m, p), [method, params]);
  return { app, page, invoke };
}
