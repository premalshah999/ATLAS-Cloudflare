// Terminal executor (manual §20). Commands are argument arrays, never shell strings. Each run owns a
// process group so cancellation and timeouts terminate the whole tree.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { redact } from '@atlas/contracts';
import { prepareSandbox, wrapCommand, type SandboxSpec } from './sandbox';
import { windowsCommand } from './win/appcontainer';
import { journalStart } from './journal';
export { setProcessJournal, reapJournaled, processIdentity, journalStart } from './journal';

/**
 * Windows cannot start .cmd/.bat shims (npm, pnpm…) without cmd.exe; resolve PATH/PATHEXT and escape safely.
 * Elsewhere, and for the sandbox helper (an .exe), this is the identity.
 */
export function spawnPlan(command: string, args: string[], env: Record<string, string>): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== 'win32') return { file: command, args, verbatim: false };
  const w = windowsCommand(command, args, env);
  return { file: w.file, args: w.args, verbatim: w.verbatim };
}

export { detectSandbox, prepareSandbox, wrapCommand, seatbeltProfile, toolchainPaths, SANDBOX_HOME, type SandboxSpec, type SandboxInfo, type SandboxKind } from './sandbox';
export { quoteArg, resolveWindowsCommand, windowsCommand } from './win/appcontainer';
export { readAccounts as windowsAccounts, removeAccounts as removeWindowsAccounts, setupAccounts as setupWindowsAccounts, type AccountsInfo } from './win/account';

/** Environment variables passed through to child processes. Everything else is dropped. */
export const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  // Windows programs (node, git) expect these system locations.
  'WINDIR', 'SYSTEMDRIVE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'COMMONPROGRAMFILES', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME'];

export function sanitizedEnv(extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) { const v = source[k]; if (v !== undefined) env[k] = v; }
  return { ...env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
}

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Max bytes of combined output kept in memory (the rest is counted, not stored). */
  maxOutput?: number;
  onStart?: (pid: number) => void;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Run inside the OS sandbox. When set and no sandbox exists, the run fails closed (spawnError). */
  sandbox?: SandboxSpec;
  /** Text written to the command's standard input, which is then closed. Without it, stdin is empty. */
  stdin?: string;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  pid: number | null;
  spawnError: string | null;
}

/** Kill a process and every descendant. POSIX: the negative pid targets the process group. */
export function killTree(pid: number, sig: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* already gone */ } }
}

/**
 * The sandboxed child that bwrap reports on its status fd. It runs in its own session, so it is not in bwrap's
 * process group: when bwrap is killed during setup, before the child arms --die-with-parent, the child survives
 * and holds our pipes. Knowing its pid lets every kill reach it too.
 */
export function trackSandboxChild(child: ChildProcess, statusFd?: number) {
  let childPid: number | null = null;
  let done = statusFd === undefined;
  const waiters: (() => void)[] = [];
  const fire = () => { for (const w of waiters.splice(0)) w(); };
  const status = statusFd !== undefined ? (child.stdio[statusFd] as Readable | null) : null;
  if (status) {
    let buf = '';
    status.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      const m = /"child-pid":\s*(\d+)/.exec(buf);
      if (m && childPid === null) { childPid = Number(m[1]); fire(); }
    });
    status.on('error', () => {});
    status.on('close', () => { done = true; fire(); });
  } else done = true;
  return {
    pid: () => childPid,
    /** Resolves once the child pid is known, or can no longer become known, or after `ms`. */
    ready(ms: number): Promise<void> {
      if (childPid !== null || done) return Promise.resolve();
      return new Promise((r) => { const t = setTimeout(r, ms); waiters.push(() => { clearTimeout(t); r(); }); });
    },
    /** Signal the leader's group and the sandboxed child's group. */
    kill(leader: number | undefined, sig: NodeJS.Signals) {
      if (leader) killTree(leader, sig);
      if (childPid) killTree(childPid, sig);
    },
  };
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function run(o: RunOptions): Promise<RunResult> {
  // Slow sandbox setup (Windows ACL grants) off the event loop; wrapCommand below then finds it done.
  if (o.sandbox && !o.signal?.aborted) await prepareSandbox(o.sandbox).catch(() => {});
  const started = Date.now();
  const max = o.maxOutput ?? 512 * 1024;
  return new Promise((resolve) => {
    let output = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    if (o.signal?.aborted) {
      resolve({ exitCode: null, signal: null, durationMs: 0, output: '', truncated: false, timedOut: false, cancelled: true, pid: null, spawnError: null });
      return;
    }

    let cmd = o.command, argv = o.args, env = o.env ?? sanitizedEnv();
    let cleanup: (() => void) | undefined;
    let statusFd: number | undefined;
    if (o.sandbox) {
      try { ({ command: cmd, args: argv, env, cleanup, statusFd } = wrapCommand(o.command, o.args, o.cwd, o.sandbox, env, { statusFd: true })); }
      catch (e) {
        resolve({ exitCode: null, signal: null, durationMs: 0, output: '', truncated: false, timedOut: false, cancelled: false, pid: null, spawnError: (e as Error).message });
        return;
      }
    }
    let plan: ReturnType<typeof spawnPlan>;
    try { plan = spawnPlan(cmd, argv, env); }
    catch (e) {
      cleanup?.();
      resolve({ exitCode: null, signal: null, durationMs: 0, output: '', truncated: false, timedOut: false, cancelled: false, pid: null, spawnError: (e as Error).message });
      return;
    }
    const child = spawn(plan.file, plan.args, {
      cwd: o.cwd,
      env,
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
      stdio: [o.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(statusFd !== undefined ? ['pipe' as const] : [])],
    });
    if (o.stdin !== undefined && child.stdin) {
      // A command that exits without reading its input closes the pipe early: that is not an error.
      child.stdin.on('error', () => {});
      child.stdin.end(o.stdin);
    }
    const pid = child.pid ?? null;
    const inner = trackSandboxChild(child, statusFd);
    const unjournal = journalStart(pid, 'command', [o.command, ...o.args].join(' '));
    if (pid) o.onStart?.(pid);

    const take = (stream: 'stdout' | 'stderr') => (buf: Buffer) => {
      const text = redact(buf.toString('utf8'));
      o.onOutput?.(stream, text);
      if (output.length < max) output += text.slice(0, max - output.length);
      if (output.length >= max) truncated = true;
    };
    child.stdout!.on('data', take('stdout'));
    child.stderr!.on('data', take('stderr'));

    const stop = () => {
      if (!pid) return;
      // Wait (briefly) for the sandboxed child's pid, so a kill during sandbox setup cannot miss it.
      void inner.ready(2000).then(() => {
        inner.kill(pid, 'SIGTERM');
        setTimeout(() => inner.kill(pid, 'SIGKILL'), 1500).unref();
      });
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
    const onAbort = () => { cancelled = true; stop(); };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, sig: string | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      unjournal();
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      // Reap any descendants that outlived the leader (e.g. backgrounded children).
      if (pid && process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL'); } catch { /* group already empty */ } }
      const c = inner.pid();
      if (c) { try { process.kill(-c, 'SIGKILL'); } catch { /* group already empty */ } }
      cleanup?.();
      resolve({ exitCode, signal: sig, durationMs: Date.now() - started, output, truncated, timedOut, cancelled, pid, spawnError });
    };
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, sig) => finish(code, sig, null));
    // The leader exited but something still holds our pipes (an escaped descendant): do not wait forever.
    child.on('exit', (code, sig) => {
      setTimeout(() => {
        if (settled) return;
        for (const st of child.stdio) (st as Readable | null)?.destroy();
        finish(code, sig, null);
      }, 3000).unref();
    });
  });
}

export interface ProcessHandle {
  pid: number | null;
  spawnError: string | null;
  output(): string;
  exited(): { code: number | null } | null;
  stop(): Promise<void>;
  /** With `io`: the process's stdin and stdout, owned by the caller (stderr still goes to output()). */
  stdin?: Writable | null;
  stdout?: Readable | null;
}

/** Start a long-lived process (an app server under test, a local staging deployment). Same isolation rules as run(). */
export function startProcess(o: { command: string; args: string[]; cwd: string; env?: Record<string, string>; sandbox?: SandboxSpec; maxOutput?: number; onOutput?: (text: string) => void; onExit?: (code: number | null) => void; io?: boolean }): ProcessHandle {
  let cmd = o.command, argv = o.args, env = o.env ?? sanitizedEnv();
  let cleanup: (() => void) | undefined;
  let statusFd: number | undefined;
  if (o.sandbox) {
    try { ({ command: cmd, args: argv, env, cleanup, statusFd } = wrapCommand(o.command, o.args, o.cwd, o.sandbox, env, { statusFd: true })); }
    catch (e) { return { pid: null, spawnError: (e as Error).message, output: () => '', exited: () => ({ code: null }), stop: async () => {} }; }
  }
  const max = o.maxOutput ?? 256 * 1024;
  let buf = '';
  let exit: { code: number | null } | null = null;
  let spawnError: string | null = null;
  let plan: ReturnType<typeof spawnPlan>;
  try { plan = spawnPlan(cmd, argv, env); }
  catch (e) { cleanup?.(); return { pid: null, spawnError: (e as Error).message, output: () => '', exited: () => ({ code: null }), stop: async () => {} }; }
  const child = spawn(plan.file, plan.args, { cwd: o.cwd, env, detached: process.platform !== 'win32', shell: false, windowsHide: true, windowsVerbatimArguments: plan.verbatim, stdio: [o.io ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(statusFd !== undefined ? ['pipe' as const] : [])] });
  const inner = trackSandboxChild(child, statusFd);
  const take = (b: Buffer) => { const t = redact(b.toString('utf8')); o.onOutput?.(t); buf = (buf + t).slice(-max); };
  if (!o.io) child.stdout!.on('data', take);
  child.stderr!.on('data', take);
  let notified = false;
  const notify = (code: number | null) => { if (!notified) { notified = true; o.onExit?.(code); } };
  child.on('error', (e) => { spawnError = e.message; exit = { code: null }; notify(null); });
  const unjournal = journalStart(child.pid, 'service', [o.command, ...o.args].join(' '));
  const done = new Promise<void>((r) => child.on('close', (code) => {
    exit = { code };
    unjournal();
    // Like run(): children a service left behind die with it (review finding 4).
    if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already empty */ } }
    const c = inner.pid();
    if (c && process.platform !== 'win32') { try { process.kill(-c, 'SIGKILL'); } catch { /* group already empty */ } }
    cleanup?.();
    r();
    notify(code);
  }));
  child.on('exit', () => setTimeout(() => { if (!exit) for (const st of child.stdio) (st as Readable | null)?.destroy(); }, 3000).unref());
  return {
    pid: child.pid ?? null,
    get spawnError() { return spawnError; },
    output: () => buf,
    exited: () => exit,
    ...(o.io ? { stdin: child.stdin, stdout: child.stdout } : {}),
    stop: async () => {
      if (exit || !child.pid) return;
      await inner.ready(2000);
      inner.kill(child.pid, 'SIGTERM');
      const t = setTimeout(() => inner.kill(child.pid, 'SIGKILL'), 2000);
      await done;
      clearTimeout(t);
    },
  };
}
export { openPty, ptySupported, type PtyHandle } from './pty';
