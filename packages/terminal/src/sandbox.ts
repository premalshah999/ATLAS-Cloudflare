// OS-level sandbox for untrusted commands (manual §23, ADR 0007).
// Linux: bubblewrap (user, mount, pid, ipc, uts, net namespaces). macOS: sandbox-exec profile.
// Anything else: no sandbox — callers must fail closed unless the operator opted into unsandboxed runs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as win from './win/appcontainer';
import * as acct from './win/account';

export type SandboxKind = 'bwrap' | 'sandbox-exec' | 'windows-account' | 'appcontainer' | 'none';

export interface SandboxSpec {
  /** Directory the command may write (the task worktree). Mounted at the same path. */
  root: string;
  writable: boolean;
  /** Network egress. Off unless a network command was explicitly approved. */
  network: boolean;
  /** Extra read-only paths (e.g. the main repository's .git for a worktree). */
  readOnly?: string[];
  /** Extra writable paths. */
  readWrite?: string[];
  /**
   * Paths that stay read-only even inside the writable root (ADR 0031: the worktree's `.git` pointer file and its admin
   * directory). bwrap binds them read-only after the root; Seatbelt denies writes to them last.
   * TODO(windows): no deny-write ACE yet. There the daemon's pinned git calls never follow the pointer file and the
   * admin directory is not granted to the sandbox account, so a rewritten pointer only makes ATLAS refuse the worktree.
   */
  protect?: string[];
  /** Operator terminal session: may allocate a pseudo-terminal (macOS Seatbelt needs /dev/ptmx and /dev/ttys*). */
  pty?: boolean;
  /** Resource limits applied with prlimit when available. */
  limits?: { cpuSeconds?: number; fileSizeBytes?: number; openFiles?: number };
}

export interface SandboxInfo { kind: SandboxKind; detail: string; path: string | null }

let cached: SandboxInfo | null = null;
let bwrapStatusFd = false;

/**
 * File descriptor on which the wrapper reports the sandboxed child's host pid as JSON ({"child-pid": N}).
 * bwrap's child runs in its own session, so if bwrap itself is killed before the child has armed
 * --die-with-parent (a window during namespace setup), killing bwrap's process group misses the child, which keeps
 * our pipes open. Callers that know the child's pid kill its group too.
 */
export const SANDBOX_STATUS_FD = 3;

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

/** Detect a working sandbox. bwrap is probed with a real run, because user namespaces can be disabled. */
export function detectSandbox(force = false): SandboxInfo {
  if (cached && !force) return cached;
  if (process.env.ATLAS_SANDBOX === 'none') return (cached = { kind: 'none', detail: 'Disabled by ATLAS_SANDBOX=none', path: null });
  if (process.platform === 'linux') {
    const bwrap = which('bwrap');
    if (!bwrap) return (cached = { kind: 'none', detail: 'bubblewrap (bwrap) is not installed. Install it: apt install bubblewrap / dnf install bubblewrap.', path: null });
    try {
      execFileSync(bwrap, ['--ro-bind', '/', '/', '--unshare-all', '--die-with-parent', 'true'], { stdio: 'ignore', timeout: 5000 });
      // --json-status-fd (bubblewrap ≥ 0.5) reports the sandboxed child's host pid; see wrapCommand.
      let statusFd = false;
      try { execFileSync(bwrap, ['--ro-bind', '/', '/', '--json-status-fd', '1', 'true'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); statusFd = true; } catch { /* older bubblewrap */ }
      bwrapStatusFd = statusFd;
      return (cached = { kind: 'bwrap', detail: `bubblewrap at ${bwrap}`, path: bwrap });
    } catch (e) {
      return (cached = { kind: 'none', detail: `bubblewrap is installed but cannot create namespaces (${(e as Error).message.slice(0, 120)}). Enable unprivileged user namespaces.`, path: null });
    }
  }
  if (process.platform === 'darwin') {
    if (!existsSync('/usr/bin/sandbox-exec')) return (cached = { kind: 'none', detail: '/usr/bin/sandbox-exec is missing', path: null });
    try {
      execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore', timeout: 5000 });
      return (cached = { kind: 'sandbox-exec', detail: 'macOS Seatbelt (sandbox-exec)', path: '/usr/bin/sandbox-exec' });
    } catch (e) { return (cached = { kind: 'none', detail: `sandbox-exec cannot run here (${(e as Error).message.slice(0, 120)})`, path: null }); }
  }
  if (process.platform === 'win32') {
    // ADR 0020: the operator's sandbox accounts, once set up, are the Windows sandbox. Without them, the AppContainer
    // mode remains (it cannot host Node's piped child processes, ADR 0016, so test runs fail closed there).
    let accountProblem = '';
    try {
      const accounts = acct.readAccounts();
      if (accounts) {
        acct.probeAccount(accounts);
        return (cached = { kind: 'windows-account', detail: `Windows sandbox account ${accounts.offline.name} + Job Object · ${accounts.firewall ? 'network blocked by a Windows Firewall rule' : 'network NOT enforced: the firewall rule could not be created'}`, path: win.ensureHelper() });
      }
    } catch (e) { accountProblem = ` The sandbox accounts are set up but could not run a command: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().slice(0, 200)}.`; }
    try {
      const helper = win.ensureHelper();
      // Probe: a real contained process must start and exit cleanly.
      // Parallel workers can create the same AppContainer profile at once; one retry, and stderr kept for diagnosis.
      const probe = () => execFileSync(helper, ['run', 'atlas.probe', '--cmdline', `${win.quoteArg(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe')} /d /c exit 0`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 60_000 });
      try { probe(); } catch { probe(); }
      return (cached = { kind: 'appcontainer', detail: `Windows AppContainer + Job Object. Test runs cannot work in this mode; set up the sandbox accounts in Settings.${accountProblem}`, path: helper });
    } catch (e) {
      const stderr = String((e as { stderr?: Buffer }).stderr ?? '').trim();
      return (cached = { kind: 'none', detail: `Windows AppContainer sandbox unavailable (${(stderr || (e as Error).message).slice(0, 300)})`, path: null });
    }
  }
  return (cached = { kind: 'none', detail: `No supported sandbox on ${process.platform}`, path: null });
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
/** Real path of the parent directory, then the last component as written (a symlink there is not followed). */
const lexReal = (p: string) => path.join(real(path.dirname(path.resolve(p))), path.basename(path.resolve(p)));

/** Toolchain directories commands need (node, npm, git…): every PATH entry and its install prefix, read-only. */
export function toolchainPaths(env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || !existsSync(dir)) continue;
    const r = real(dir);
    out.add(r);
    // `/opt/node22/bin` → also `/opt/node22` (lib/node_modules for npm); never a top-level dir like /usr or /home.
    const prefix = path.dirname(r);
    if (path.basename(r) === 'bin' && prefix.split(path.sep).filter(Boolean).length >= 2 && prefix !== os.homedir()) out.add(prefix);
  }
  return [...out];
}

const SYSTEM_RO = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/opt/homebrew', '/nix/store', '/nix/var/nix/profiles',
  '/etc/alternatives', '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group',
  '/etc/ld.so.cache', '/etc/localtime', '/etc/gitconfig'];

export const SANDBOX_HOME = '/home/atlas-sandbox';

/** Proxy and CA settings forwarded only when network egress is granted, so approved network commands work behind corporate proxies. */
export const NETWORK_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO', 'npm_config_cafile'];

function networkEnv(source: NodeJS.ProcessEnv = process.env): { env: Record<string, string>; files: string[] } {
  const env: Record<string, string> = {};
  const files: string[] = [];
  for (const k of NETWORK_ENV) {
    const v = source[k];
    if (!v) continue;
    env[k] = v;
    if (/CERT|CA/i.test(k) && path.isAbsolute(v) && existsSync(v)) files.push(v);
  }
  return { env, files };
}

export interface SeatbeltInput {
  root: string; scratch: string; network: boolean; readWrite: string[]; readOnly: string[]; home: string; userTemp: string;
  /** Allow allocating a pseudo-terminal. Only for operator terminals: /dev/ttys* also names the user's other terminals. */
  pty?: boolean;
  /** Never writable, even inside the root (ADR 0031). */
  protect?: string[];
}

/** Every parent directory of `p` (not `p` itself), e.g. /Users, /Users/runner for /Users/runner/work. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) out.push(d);
  return out;
}

/**
 * macOS Seatbelt profile (evolution P0-5). The default is allow, so user data is denied by location: the home
 * directory, every other user's home, mounted volumes, the per-user temp directory and the shared /tmp. Inside
 * those, only the root, the extra paths and the command's private scratch directory are readable, and only the
 * root, read-write paths and scratch are writable. Parents of granted paths get file-read-metadata only (no data,
 * no listing), which `realpath` needs to resolve them.
 */
export function seatbeltProfile(i: SeatbeltInput): string {
  const q = (p: string) => JSON.stringify(p);
  const writable = [i.root, ...i.readWrite, i.scratch];
  const readable = [...writable, ...i.readOnly];
  const userData = [...new Set([i.home, '/Users', '/Volumes', i.userTemp, '/private/tmp', '/private/var/tmp'])];
  const notReadable = readable.map((p) => `(require-not (subpath ${q(p)}))`).join(' ');
  const inUserData = `(require-any ${userData.map((p) => `(subpath ${q(p)})`).join(' ')})`;
  const parents = [...new Set(readable.flatMap(ancestors))].sort();
  return [
    '(version 1)', '(allow default)',
    `(deny file-write* (require-all ${writable.map((p) => `(require-not (subpath ${q(p)}))`).join(' ')} (require-not (literal "/dev/null")) (require-not (literal "/dev/tty")) (require-not (subpath "/dev/fd"))${i.pty ? ' (require-not (literal "/dev/ptmx")) (require-not (regex #"^/dev/ttys[0-9]+$"))' : ''}))`,
    ...(i.pty ? ['(allow pseudo-tty)'] : []),
    `(deny file-read-data file-read-xattr (require-all ${inUserData} ${notReadable}))`,
    `(deny file-read-metadata (require-all ${inUserData} ${notReadable} ${parents.map((p) => `(require-not (literal ${q(p)}))`).join(' ')}))`,
    ...(i.network ? [] : ['(deny network-outbound (require-not (remote unix-socket)))', '(deny network-inbound)']),
    // Last, so it wins over the writable root it lies in.
    ...(i.protect?.length ? [`(deny file-write* ${i.protect.map((p) => `(literal ${q(p)}) (subpath ${q(p)})`).join(' ')})`] : []),
  ].join('\n');
}

let swept = false;
/** Remove scratch directories left behind by daemons that no longer run (a crash skips per-command cleanup). */
function sweepScratch() {
  if (swept) return;
  swept = true;
  try {
    for (const name of readdirSync(os.tmpdir())) {
      const m = /^atlas-sbhome-(\d+)-/.exec(name);
      if (!m || Number(m[1]) === process.pid) continue;
      try { process.kill(Number(m[1]), 0); continue; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') continue; }
      rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

/**
 * Do a sandbox's slow setup before wrapCommand(), without blocking the event loop. On Windows that is the ACL grants
 * on the sandbox root and its writable paths, which take hundreds of milliseconds per worktree with icacls; while they
 * ran synchronously the daemon stopped answering the UI. wrapCommand() then finds them cached. Elsewhere it is a no-op.
 * Failures are left for wrapCommand() to report.
 */
export async function prepareSandbox(spec: SandboxSpec): Promise<void> {
  if (process.platform !== 'win32') return;
  const info = detectSandbox();
  if (info.kind === 'appcontainer') {
    const sid = win.containerSid(win.containerName(spec.root));
    await win.grantAsync(sid, spec.root, spec.writable ? 'rw' : 'rx');
    for (const p of spec.readWrite ?? []) await win.grantAsync(sid, p, 'rw');
  } else if (info.kind === 'windows-account') {
    const a = acct.readAccounts();
    if (!a) return;
    const sid = (spec.network ? a.network : a.offline).sid;
    await acct.grantForAsync(sid, spec.root, spec.writable ? 'rw' : 'rx');
    for (const p of spec.readWrite ?? []) await acct.grantForAsync(sid, p, 'rw');
    for (const p of spec.readOnly ?? []) await acct.grantForAsync(sid, p, 'rx');
  }
}

/** Wrap a command so it runs inside the sandbox. Throws if no sandbox is available. */
export function wrapCommand(command: string, args: string[], cwd: string, spec: SandboxSpec, env: Record<string, string>, opts: { statusFd?: boolean } = {}): { command: string; args: string[]; env: Record<string, string>; cleanup?: () => void; statusFd?: number } {
  const info = detectSandbox();
  const root = real(spec.root);
  const net = spec.network ? networkEnv() : { env: {}, files: [] };
  const envOut = { ...env, ...net.env, HOME: SANDBOX_HOME, TMPDIR: '/tmp', npm_config_cache: '/tmp/.npm', XDG_CACHE_HOME: '/tmp/.cache' };
  let inner = { command, args };
  if (spec.limits && which('prlimit')) {
    const l: string[] = [];
    if (spec.limits.cpuSeconds) l.push(`--cpu=${spec.limits.cpuSeconds}`);
    if (spec.limits.fileSizeBytes) l.push(`--fsize=${spec.limits.fileSizeBytes}`);
    if (spec.limits.openFiles) l.push(`--nofile=${spec.limits.openFiles}`);
    if (l.length) inner = { command: which('prlimit')!, args: [...l, '--', command, ...args] };
  }
  if (info.kind === 'bwrap') {
    const a: string[] = ['--unshare-all', '--die-with-parent', '--new-session', ...(bwrapStatusFd && opts.statusFd ? ['--json-status-fd', String(SANDBOX_STATUS_FD)] : [])];
    if (spec.network) a.push('--share-net');
    for (const p of SYSTEM_RO) a.push('--ro-bind-try', p, p);
    for (const p of toolchainPaths(env)) a.push('--ro-bind-try', p, p);
    a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', SANDBOX_HOME);
    for (const p of [...(spec.readOnly ?? []), ...net.files]) a.push('--ro-bind-try', real(p), real(p));
    a.push(spec.writable ? '--bind' : '--ro-bind', root, root);
    for (const p of spec.readWrite ?? []) a.push('--bind-try', real(p), real(p));
    // After the root and its writable paths, or their binds would overlay these. A missing protected path fails the
    // command instead of leaving it writable. The last component is not followed: `.git` is bound where it is.
    for (const p of spec.protect ?? []) { const at = lexReal(p); a.push('--ro-bind', at, at); }
    a.push('--chdir', real(cwd), '--', inner.command, ...inner.args);
    return { command: info.path!, args: a, env: envOut, ...(bwrapStatusFd && opts.statusFd ? { statusFd: SANDBOX_STATUS_FD } : {}) };
  }
  if (info.kind === 'sandbox-exec') {
    sweepScratch();
    const scratch = mkdtempSync(path.join(real(os.tmpdir()), `atlas-sbhome-${process.pid}-`));
    const profile = seatbeltProfile({
      root, scratch, network: spec.network,
      readWrite: (spec.readWrite ?? []).map(real),
      readOnly: [...(spec.readOnly ?? []).map(real), ...toolchainPaths(env), ...net.files.map(real)],
      home: real(os.homedir()), userTemp: real(os.tmpdir()), pty: !!spec.pty, protect: (spec.protect ?? []).map(lexReal),
    });
    const file = path.join(scratch, 'profile.sb');
    writeFileSync(file, profile);
    // The scratch directory is the command's private HOME and TMPDIR; it is never shared between commands.
    const scratchEnv = { HOME: scratch, TMPDIR: scratch, npm_config_cache: path.join(scratch, '.npm'), XDG_CACHE_HOME: path.join(scratch, '.cache') };
    return { command: info.path!, args: ['-f', file, inner.command, ...inner.args], env: { ...envOut, ...scratchEnv }, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
  }
  if (info.kind === 'windows-account') return wrapWindowsAccount(command, args, spec, env, net);
  if (info.kind === 'appcontainer') return wrapWindows(command, args, spec, env, net);
  throw Object.assign(new Error(`No OS sandbox is available: ${info.detail}`), { kind: 'sandbox_unavailable' });
}

/**
 * Windows (ADR 0012): one AppContainer per sandbox root. The container SID gets the root (and the worktree's git
 * admin directory) by ACL; shared read-only paths and the toolchain are granted to capabilities the container
 * holds; everything else in the user's profile is unreadable. Network capabilities only when approved.
 */
function wrapWindows(command: string, args: string[], spec: SandboxSpec, env: Record<string, string>, net: { env: Record<string, string>; files: string[] }): { command: string; args: string[]; env: Record<string, string> } {
  const helper = win.ensureHelper();
  const name = win.containerName(spec.root);
  const sid = win.containerSid(name);
  win.grant(sid, spec.root, spec.writable ? 'rw' : 'rx');
  for (const p of spec.readWrite ?? []) win.grant(sid, p, 'rw');
  const caps: string[] = [];
  for (const p of [...(spec.readOnly ?? []), ...net.files]) { try { caps.push(win.readCapability(p)); } catch { /* path vanished */ } }
  win.grantToolchain(toolchainPaths(env));
  const home = win.containerHome(name);
  win.grant(sid, home, 'rw');
  // App servers under test listen on loopback for the browser; AppContainers need an exemption for that.
  if (spec.network) win.tryLoopbackExemption(sid);
  const envOut: Record<string, string> = {
    ...env, ...net.env,
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(home, 'Temp'), TMP: path.join(home, 'Temp'), npm_config_cache: path.join(home, 'npm-cache'),
    // An AppContainer cannot lstat the drive root, and Node's JS realpath walks every ancestor of the entry
    // script and of each module. Keeping symlinked paths as given avoids that walk (granting rights on C:\ would
    // mean changing a system ACL).
    NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main',
  };
  const cmd = win.windowsCommand(command, args, envOut);
  return { command: helper, args: ['run', name, ...(spec.network ? ['--net'] : []), ...caps.flatMap((c) => ['--cap', c]), '--parent', String(process.pid), '--cmdline', cmd.line], env: envOut };
}

/**
 * Windows with sandbox accounts (ADR 0020): the command runs as atlas-sbx (no network) or, for an approved network
 * command, atlas-sbx-net. The account gets the root (and the worktree's git admin directory), the read-only paths
 * and the toolchain by ACL, and a private home; the operator's profile, other projects and credentials stay out of
 * reach because their ACLs name only the operator.
 */
function wrapWindowsAccount(command: string, args: string[], spec: SandboxSpec, env: Record<string, string>, net: { env: Record<string, string>; files: string[] }): { command: string; args: string[]; env: Record<string, string> } {
  const info = acct.readAccounts();
  if (!info) throw Object.assign(new Error('The Windows sandbox accounts are not set up'), { kind: 'sandbox_unavailable' });
  const a = spec.network ? info.network : info.offline;
  acct.grantFor(a.sid, spec.root, spec.writable ? 'rw' : 'rx');
  for (const p of spec.readWrite ?? []) acct.grantFor(a.sid, p, 'rw');
  for (const p of [...(spec.readOnly ?? []), ...net.files]) acct.grantFor(a.sid, p, 'rx');
  // Toolchains outside the operator's profile (Program Files, C:\hostedtoolcache…) are readable by every standard
  // account through Users already; only those inside the profile (%APPDATA%\npm, nvm, scoop) need a grant.
  // Granting the others would rewrite ACLs across large system trees.
  const profile = real(os.homedir()).toLowerCase() + path.sep;
  for (const p of toolchainPaths(env)) {
    if (!real(p).toLowerCase().startsWith(profile)) continue;
    try { acct.grantFor(a.sid, p, 'rx'); } catch { /* not ours to change */ }
  }
  const home = acct.accountHome(spec.root, a.sid);
  const envOut: Record<string, string> = {
    ...env, ...net.env,
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(home, 'Temp'), TMP: path.join(home, 'Temp'), npm_config_cache: path.join(home, 'npm-cache'),
    NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main',
    // Without the firewall rule, a proxy that refuses connections is the remaining guard (labelled in Settings).
    ...(!spec.network && !info.firewall ? { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' } : {}),
  };
  const cmd = win.windowsCommand(command, args, envOut);
  return { command: win.ensureHelper(), args: ['run', '-', '--account', spec.network ? 'network' : 'offline', '--store', info.store, '--parent', String(process.pid), '--cmdline', cmd.line], env: envOut };
}
