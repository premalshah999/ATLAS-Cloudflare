import { PROVIDER_ENV } from '@atlas/contracts';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import { tmpDir } from '../helpers';
import { fileURLToPath as __f } from 'node:url';
const here = path.dirname(__f(import.meta.url));

const desktop = path.resolve(here, '../../apps/desktop');

export async function launch(opts: { userData?: string; openDir?: string; env?: Record<string, string>; args?: string[] } = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = opts.userData ?? tmpDir('atlas-e2e-');
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ATLAS_E2E: '1', ATLAS_USER_DATA: userData };
  if (opts.openDir) env.ATLAS_E2E_OPEN_DIR = opts.openDir;
  // A developer's own GitHub token never reaches a test app; a test passes its fake one explicitly.
  delete env.ATLAS_GITHUB_TOKEN; delete env.ATLAS_GITHUB_API;
  env.ATLAS_NO_GH_CLI = '1';
  // Nor a real search key (ADR 0030).
  for (const k of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CSE_ID', 'ATLAS_WEB_TEST_BASE']) delete env[k];
  // No real provider key from the developer's shell reaches the app; a test passes its own fake key in opts.env.
  for (const v of Object.values(PROVIDER_ENV)) delete env[v];
  // Nor any other *_API_KEY from the shell. Scrub before applying opts.env so a test's own fake keys survive.
  for (const key of Object.keys(env)) if (/_API_KEY$/.test(key)) delete env[key];
  Object.assign(env, opts.env ?? {});
  delete env.ELECTRON_RUN_AS_NODE;
  // --no-sandbox only because CI containers run as root; the renderer still runs with sandbox: true.
  const executablePath = process.env.ATLAS_TEST_EXECUTABLE;
  const app = await electron.launch({ executablePath, args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...(opts.args ?? []), ...(executablePath ? [] : [desktop])], cwd: desktop, env });
  const page = await app.firstWindow();
  // The renderer must run clean: an uncaught error or a console error anywhere in a test fails it when the app closes.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  const close = app.close.bind(app);
  app.close = async () => {
    await close();
    if (errors.length) throw new Error(`The renderer reported ${errors.length} error(s):\n${errors.slice(0, 10).join('\n')}`);
  };
  await page.getByTestId('daemon-status').and(page.locator('[data-state="ready"]')).waitFor({ timeout: 30_000 });
  return { app, page, userData };
}
