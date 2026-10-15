// Windows sandbox (ADR 0012): AppContainer + Job Object via atlas-sandbox.exe, file access by explicit ACL grants.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HELPER_SOURCE, HELPER_VERSION } from './helper';

const real = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function atlasLocalDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ATLAS', 'sandbox');
}

function csc(): string | null {
  const win = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (existsSync(p)) return p;
  }
  return null;
}

let helperPath: string | null = null;
/** Compile atlas-sandbox.exe once per source version with the system C# compiler; cached under %LOCALAPPDATA%. */
export function ensureHelper(): string {
  if (helperPath && existsSync(helperPath)) return helperPath;
  const dir = atlasLocalDir();
  mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, `atlas-sandbox-${HELPER_VERSION}-${sha(HELPER_SOURCE).slice(0, 12)}.exe`);
  if (!existsSync(exe)) {
    const compiler = csc();
    if (!compiler) throw new Error('The .NET Framework C# compiler (csc.exe) was not found; it ships with Windows 10 and 11.');
    // Several processes (daemon restarts, parallel test workers) can get here at once: compile to a private name and
    // rename into place, so nobody runs or overwrites a half-written executable.
    const tmp = `${exe}.${process.pid}.${Date.now()}`;
    writeFileSync(`${tmp}.cs`, HELPER_SOURCE);
    try {
      execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${tmp}.exe`, `${tmp}.cs`], { stdio: 'pipe', windowsHide: true, timeout: 120_000 });
      try { renameSync(`${tmp}.exe`, exe); } catch (e) { if (!existsSync(exe)) throw e; }
    } catch (e) {
      if (!existsSync(exe)) throw new Error(`Compiling the sandbox helper failed: ${String((e as { stdout?: Buffer }).stdout ?? (e as Error).message).slice(0, 600)}`);
    } finally {
      rmSync(`${tmp}.cs`, { force: true });
      rmSync(`${tmp}.exe`, { force: true });
    }
  }
  return (helperPath = exe);
}

const sids = new Map<string, string>();
function helperOut(args: string[]): string { return execFileSync(ensureHelper(), args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim(); }
export function containerSid(name: string): string {
  if (!sids.has(name)) sids.set(name, helperOut(['sid', name]));
  return sids.get(name)!;
}
export function capabilitySid(name: string): string {
  if (!sids.has(`cap:${name}`)) sids.set(`cap:${name}`, helperOut(['capsid', name]));
  return sids.get(`cap:${name}`)!;
}
export const toolchainCapabilitySid = () => capabilitySid('atlasToolchain');

/**
 * Read-only paths shared across tasks (a repository's .git) are granted to a capability derived from the path,
 * once per machine, instead of to each task's container: large object stores are not re-walked per task.
 */
export function readCapability(target: string): string {
  const p = real(target);
  const name = `atlasRead.${sha(p.toLowerCase()).slice(0, 24)}`;
  persistentGrant(capabilitySid(name), p);
  return name;
}

/** A container per sandbox root, so one task's container cannot read another task's grants. */
export function containerName(root: string): string { return `atlas.${sha(real(root).toLowerCase()).slice(0, 24)}`; }

const granted = new Set<string>();
/**
 * Grant a SID access with inheritance (OI)(CI) for directories. `/grant:r` replaces any earlier grant for the same
 * SID, so repeated calls do not accumulate entries. Windows propagates inheritable entries to existing children.
 */
export function grant(sid: string, target: string, mode: 'rw' | 'rx'): void {
  const p = real(target);
  const key = `${sid}|${p.toLowerCase()}|${mode}`;
  if (granted.has(key) || !existsSync(p)) return;
  const dir = statSync(p).isDirectory();
  const perm = mode === 'rw' ? 'M' : 'RX';
  execFileSync('icacls', [p, '/grant:r', `*${sid}:${dir ? '(OI)(CI)' : ''}${perm}`, '/C', '/Q'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 300_000 });
  granted.add(key);
}

/** Run a program without blocking the daemon's event loop; rejects with its stderr on failure. */
export function execAsync(file: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, _out, stderr) => (err ? reject(Object.assign(err, { stderr: Buffer.from(String(stderr ?? '')) })) : resolve()));
  });
}

const granting = new Map<string, Promise<void>>();
/**
 * grant() without blocking: icacls propagating inheritable entries over a worktree takes hundreds of milliseconds,
 * and the daemon must keep answering the UI meanwhile. Afterwards grant() for the same key is a cache hit.
 */
export function grantAsync(sid: string, target: string, mode: 'rw' | 'rx'): Promise<void> {
  const p = real(target);
  const key = `${sid}|${p.toLowerCase()}|${mode}`;
  if (granted.has(key) || !existsSync(p)) return Promise.resolve();
  let run = granting.get(key);
  if (!run) {
    const dir = statSync(p).isDirectory();
    run = execAsync('icacls', [p, '/grant:r', `*${sid}:${dir ? '(OI)(CI)' : ''}${mode === 'rw' ? 'M' : 'RX'}`, '/C', '/Q'], 300_000)
      .then(() => { granted.add(key); })
      .finally(() => granting.delete(key));
    granting.set(key, run);
  }
  return run;
}

/** Directories that are readable by every AppContainer already (Windows, Program Files). */
export function alreadyReadable(p: string): boolean {
  const l = p.toLowerCase();
  const roots = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean).map((r) => r!.toLowerCase());
  return roots.some((r) => l === r || l.startsWith(r + '\\'));
}

/** Read grants to capability SIDs persist across runs; a marker file avoids re-walking large trees. */
function persistentGrant(sid: string, p: string): void {
  const marker = path.join(atlasLocalDir(), 'read-grants.json');
  let done: string[] = [];
  try { done = JSON.parse(readFileSync(marker, 'utf8')); } catch { /* first run */ }
  const key = `${sid}|${p.toLowerCase()}`;
  if (done.includes(key) || !existsSync(p)) return;
  grant(sid, p, 'rx');
  writeFileSync(marker, JSON.stringify([...done, key]));
}

/** Toolchain directories (node, git, npm…) get read access for the ATLAS toolchain capability, once per machine. */
export const grantFailures: string[] = [];
export function grantToolchain(dirs: string[]): void {
  const cap = toolchainCapabilitySid();
  for (const d of dirs) {
    const p = real(d);
    if (!existsSync(p) || alreadyReadable(p)) continue;
    // Not ours to change: commands from it fail visibly with access denied, and the reason is kept for diagnosis.
    try { persistentGrant(cap, p); } catch (e) { grantFailures.push(`${p}: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).slice(0, 300)}`); }
  }
}

/** Per-container home and temp directories (USERPROFILE, APPDATA, TEMP all point inside). */
export function containerHome(name: string): string {
  const home = path.join(atlasLocalDir(), 'homes', name);
  for (const d of ['', 'AppData\\Roaming', 'AppData\\Local', 'Temp']) mkdirSync(path.join(home, d), { recursive: true });
  return home;
}

/** Loopback is blocked for AppContainers unless exempted; the exemption needs elevation and is best effort. */
const exempted = new Set<string>();
export function tryLoopbackExemption(sid: string): boolean {
  if (exempted.has(sid)) return true;
  try { execFileSync('CheckNetIsolation.exe', ['LoopbackExempt', '-a', `-p=${sid}`], { stdio: 'ignore', windowsHide: true, timeout: 30_000 }); exempted.add(sid); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------------------- command lines

/** Resolve a command name the way cmd.exe would (PATH + PATHEXT), so .cmd shims like npm are found. */
export function resolveWindowsCommand(command: string, env: Record<string, string | undefined>): string | null {
  const exts = (env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const candidates = (base: string) => (path.extname(base) ? [base, ...exts.map((e) => base + e)] : exts.map((e) => base + e));
  if (path.isAbsolute(command) || command.includes('\\') || command.includes('/')) return candidates(command).find((c) => existsSync(c)) ?? null;
  const dirs = (env.PATH ?? env.Path ?? process.env.PATH ?? '').split(';').filter(Boolean);
  for (const d of dirs) for (const c of candidates(path.join(d, command))) if (existsSync(c)) return c;
  return null;
}

/** Quote one argument for CommandLineToArgvW / the MSVC runtime. */
export function quoteArg(a: string): string {
  if (a.length && !/[\s"]/.test(a)) return a;
  let out = '"';
  for (let i = 0; i < a.length; i++) {
    let bs = 0;
    while (i < a.length && a[i] === '\\') { bs++; i++; }
    if (i === a.length) { out += '\\'.repeat(bs * 2); break; }
    if (a[i] === '"') out += '\\'.repeat(bs * 2 + 1) + '"';
    else out += '\\'.repeat(bs) + a[i];
  }
  return out + '"';
}

// cmd.exe escaping for .cmd/.bat shims (the approach cross-spawn uses): quote for the program, then caret-escape
// every cmd metacharacter; shims re-parse arguments once more, so they are escaped twice.
const META = /([()\][%!^"`<>&|;, *?])/g;
function cmdArg(a: string, twice: boolean) {
  let s = a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  s = `"${s}"`.replace(META, '^$1');
  return twice ? s.replace(META, '^$1') : s;
}

/**
 * How to start a command on Windows. `.exe` files are started directly (Node/libuv quote the arguments). Batch
 * files go through `cmd.exe /d /s /c` with every argument caret-escaped, so an argument can never inject a second
 * command; Node must pass that line verbatim. `line` is the full CreateProcess command line for the sandbox helper.
 */
/**
 * The JavaScript program a Node .cmd shim runs: npm's own `npm.cmd` (NPM_CLI_JS=%~dp0\…\npm-cli.js) and
 * cmd-shim's `"%dp0%\…\cli.js" %*`. Running it as `node <script>` keeps cmd.exe out of the sandbox: cmd resolves
 * paths with FindFirstFile on every ancestor directory, which an AppContainer may not list (C:\, the tool
 * cache), so shims failed with "Access is denied." even though node could read the same files (CI bisection).
 */
export function shimTarget(shimText: string, shimPath: string): string | null {
  const found = [...shimText.matchAll(/%~?dp0%?\\*([^"%\r\n]+?\.[cm]?js)\b/gi)].map((m) => m[1]);
  if (!found.length) return null;
  const pick = found.find((f) => /(^|[\\/])[\w-]*cli\.[cm]?js$/i.test(f) && !/prefix/i.test(f)) ?? found[found.length - 1];
  return path.win32.normalize(path.win32.join(path.win32.dirname(shimPath), pick));
}

export function windowsCommand(command: string, args: string[], env: Record<string, string | undefined>): { file: string; args: string[]; verbatim: boolean; line: string } {
  const resolved = resolveWindowsCommand(command, env);
  if (!resolved) throw Object.assign(new Error(`Command not found: ${command}`), { code: 'ENOENT' });
  if (/\.(cmd|bat)$/i.test(resolved)) {
    let target: string | null = null;
    try { target = shimTarget(readFileSync(resolved, 'utf8').slice(0, 8192), resolved); } catch { /* unreadable: use cmd.exe */ }
    const localNode = path.join(path.dirname(resolved), 'node.exe');
    const node = existsSync(localNode) ? localNode : resolveWindowsCommand('node', env);
    if (target && node && existsSync(target)) {
      const a = [target, ...args];
      return { file: node, args: a, verbatim: false, line: [quoteArg(node), ...a.map(quoteArg)].join(' ') };
    }
    const comspec = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    const inner = `"${[resolved.replace(META, '^$1'), ...args.map((a) => cmdArg(a, true))].join(' ')}"`;
    return { file: comspec, args: ['/d', '/s', '/c', inner], verbatim: true, line: `${quoteArg(comspec)} /d /s /c ${inner}` };
  }
  return { file: resolved, args, verbatim: false, line: [quoteArg(resolved), ...args.map(quoteArg)].join(' ') };
}
