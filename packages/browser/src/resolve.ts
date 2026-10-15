// Locate a Chromium to drive. Browsers are not bundled with ATLAS: we use Playwright's installed build,
// an operator-provided path, or a system Chrome/Chromium.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/** playwright-core is loaded only when a browser is actually looked up (evolution P2-1: ~36 MB resident). */
const playwrightChromium = (): { executablePath(): string } => createRequire(import.meta.url)('playwright-core').chromium;

export function resolveBrowser(): { path: string | null; detail: string } {
  const candidates: [string | undefined, string][] = [
    [process.env.ATLAS_CHROMIUM_PATH, 'ATLAS_CHROMIUM_PATH'],
  ];
  try { candidates.push([playwrightChromium().executablePath(), 'Playwright Chromium']); } catch { /* not installed */ }
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) candidates.push([path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium'), 'PLAYWRIGHT_BROWSERS_PATH']);
  const sys = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium'];
  for (const s of sys) candidates.push([s, 'system']);
  for (const [p, src] of candidates) if (p && existsSync(p)) return { path: p, detail: `${src}: ${p}` };
  return { path: null, detail: 'No Chromium found. Install Chrome/Chromium, run `npx playwright install chromium`, or set ATLAS_CHROMIUM_PATH.' };
}
