import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import { tmpDir } from '../helpers';
import { fileURLToPath as __f } from 'node:url';
const here = path.dirname(__f(import.meta.url));

const desktop = path.resolve(here, '../../apps/desktop');

export async function launch(opts: { userData?: string; openDir?: string; env?: Record<string, string> } = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = opts.userData ?? tmpDir('atlas-e2e-');
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ATLAS_E2E: '1', ATLAS_USER_DATA: userData };
  if (opts.openDir) env.ATLAS_E2E_OPEN_DIR = opts.openDir;
  Object.assign(env, opts.env ?? {});
  for (const key of Object.keys(env)) if (/_API_KEY$/.test(key)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  // --no-sandbox only because CI containers run as root; the renderer still runs with sandbox: true.
  const executablePath = process.env.ATLAS_TEST_EXECUTABLE;
  const app = await electron.launch({ executablePath, args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...(executablePath ? [] : [desktop])], cwd: desktop, env });
  const page = await app.firstWindow();
  await page.getByTestId('daemon-status').and(page.locator('[data-state="ready"]')).waitFor({ timeout: 30_000 });
  return { app, page, userData };
}
