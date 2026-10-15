// `pnpm doctor` (manual §46): checks local requirements without printing secrets.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const checks = [];
const add = (ok, name, detail) => checks.push({ ok, name, detail });
const ver = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim().split('\n')[0]; } catch { return null; } };

const [maj, min] = process.versions.node.split('.').map(Number);
add(maj > 22 || (maj === 22 && min >= 19), 'Node.js ≥ 22.19', process.versions.node);
let sqlite = false;
try { await import('node:sqlite'); sqlite = true; } catch {}
add(sqlite, 'node:sqlite available', sqlite ? 'yes' : 'upgrade Node');
const git = ver('git', ['--version']);
add(!!git, 'git', git ?? 'not found — required for worktrees');
const pnpm = ver('pnpm', ['--version']);
add(!!pnpm, 'pnpm', pnpm ?? 'not found — run `corepack enable`');
add(existsSync('node_modules/electron/dist'), 'Electron binary', existsSync('node_modules/electron/dist') ? 'installed' : 'downloaded on first launch, or now with `npx install-electron`');
const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'].filter((k) => process.env[k]);
add(true, 'Model credentials', keys.length ? `found in environment: ${keys.join(', ')} (values not shown)` : 'none in environment — the scripted runtime works without; add a key in Settings for Pi');
add(true, 'Platform', `${process.platform} ${process.arch}${process.platform === 'linux' ? ' (tested)' : process.platform === 'darwin' ? ' (local validation: docs/VALIDATION-2026-10-14.md)' : ' (not yet tested — see docs/adr/0004)'}`);
let sandbox = { ok: false, detail: '' };
if (process.platform === 'linux') {
  const bwrap = ver('bwrap', ['--version']);
  if (!bwrap) sandbox = { ok: false, detail: 'bubblewrap missing — apt install bubblewrap (agent commands will not run without it)' };
  else {
    try { execFileSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true'], { stdio: 'ignore' }); sandbox = { ok: true, detail: `${bwrap} (namespaces working)` }; }
    catch { sandbox = { ok: false, detail: `${bwrap} installed but user namespaces are blocked (Ubuntu 24.04: sysctl kernel.apparmor_restrict_unprivileged_userns=0 or an AppArmor profile for bwrap)` }; }
  }
} else if (process.platform === 'darwin') sandbox = { ok: existsSync('/usr/bin/sandbox-exec'), detail: 'macOS sandbox-exec (untested in CI)' };
else sandbox = { ok: false, detail: `no supported sandbox on ${process.platform}; commands run only if you allow unsandboxed execution` };
add(sandbox.ok, 'OS sandbox for agent commands', sandbox.detail);
{
  const cands = [process.env.ATLAS_CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  let found = cands.find((p) => existsSync(p));
  if (!found) { try { const { chromium } = await import('playwright-core'); const p = chromium.executablePath(); if (existsSync(p)) found = p; } catch {} }
  add(true, 'Browser for QA', found ? found : 'none found — browser flows will be inconclusive (install Chrome/Chromium or `npx playwright install chromium`)');
}
{
  const onPath = (b) => (process.env.PATH ?? '').split(':').some((d) => d && existsSync(`${d}/${b}`));
  const missing = ['Xvfb', 'xdotool', 'import'].filter((b) => !onPath(b));
  add(true, 'Desktop control (optional)', process.platform !== 'linux' ? `not available on ${process.platform}` : missing.length ? `missing ${missing.join(', ')} — install xvfb xdotool imagemagick to enable` : 'Xvfb + xdotool + ImageMagick');
}

for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(30)} ${c.detail}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
