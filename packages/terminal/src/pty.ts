// Interactive pseudoterminals for operator sessions (manual §20). The PTY is allocated by the system
// `script` utility inside the sandbox, so no native Node module is needed for any Electron ABI.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { redact } from '@atlas/contracts';
import { sanitizedEnv, trackSandboxChild } from './index';
import { wrapCommand, type SandboxSpec } from './sandbox';
import { ensureHelper, windowsCommand } from './win/appcontainer';
import { journalStart } from './journal';

// BSD script requires a terminal on stdin; Electron gives us pipes. Allocate the PTY in this
// trusted bridge, then exec the sandbox wrapper in the child. No repository code runs in Python.
const MAC_PTY = String.raw`
import os, sys, pty, select, fcntl, termios, struct, signal, errno
cols, rows = int(sys.argv[1]), int(sys.argv[2])
pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[3], sys.argv[3:], os.environ)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
def stop(sig, frame):
    try: os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    sys.exit(0)
for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT): signal.signal(sig, stop)
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [])
        if master in ready:
            try: data = os.read(master, 65536)
            except OSError as e:
                if e.errno == errno.EIO: break
                raise
            if not data: break
            os.write(sys.stdout.fileno(), data)
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data: stop(signal.SIGHUP, None)
            os.write(master, data)
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    os.close(master)
`;

export interface PtyHandle {
  pid: number | null;
  write(data: string): void;
  close(): Promise<void>;
  transcript(): string;
  /** Change the window size of the shell's terminal. Resolves false where it is not supported (Windows). */
  resize(cols: number, rows: number): Promise<boolean>;
}

/**
 * The terminal device of the interactive shell under `root` (a descendant of the `script` process). On Linux the
 * /proc fd link is used as the path, so it works across the sandbox's mount namespace and private devpts.
 */
function shellTty(root: number): string | null {
  if (process.platform === 'linux') {
    const kids = new Map<number, number[]>();
    for (const n of readdirSync('/proc')) {
      if (!/^\d+$/.test(n)) continue;
      try {
        const st = readFileSync(`/proc/${n}/stat`, 'utf8');
        const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
        kids.set(ppid, [...(kids.get(ppid) ?? []), Number(n)]);
      } catch { /* exited */ }
    }
    const queue = [...(kids.get(root) ?? [])];
    while (queue.length) {
      const pid = queue.shift()!;
      try { if (/^\/dev\/pts\/\d+$/.test(readlinkSync(`/proc/${pid}/fd/0`))) return `/proc/${pid}/fd/0`; } catch { /* no access */ }
      queue.push(...(kids.get(pid) ?? []));
    }
    return null;
  }
  if (process.platform === 'darwin') {
    const rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,tty='], { encoding: 'utf8', timeout: 3000 }).split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 3);
    const queue = [root];
    while (queue.length) {
      const pid = queue.shift()!;
      for (const [p, pp, tty] of rows) if (Number(pp) === pid) { if (tty && tty !== '??') return `/dev/${tty}`; queue.push(Number(p)); }
    }
  }
  return null;
}

export function ptySupported(): { ok: boolean; detail: string } {
  if (process.platform === 'linux') return existsSync('/usr/bin/script') ? { ok: true, detail: 'util-linux script' } : { ok: false, detail: 'util-linux `script` is not installed' };
  if (process.platform === 'darwin') return existsSync('/usr/bin/python3') ? { ok: true, detail: 'Python 3 PTY bridge (Apple Command Line Tools)' } : { ok: false, detail: '/usr/bin/python3 is missing: install the Xcode Command Line Tools' };
  if (process.platform === 'win32') {
    try { ensureHelper(); return { ok: true, detail: 'Windows ConPTY (atlas-sandbox helper)' }; }
    catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
  return { ok: false, detail: `No PTY support on ${process.platform}` };
}

export function openPty(o: { cwd: string; cols: number; rows: number; sandbox?: SandboxSpec; onData: (text: string) => void; onExit: (code: number | null) => void; maxTranscript?: number }): PtyHandle {
  const cols = Math.max(20, Math.min(400, Math.floor(o.cols)));
  const rows = Math.max(5, Math.min(200, Math.floor(o.rows)));
  let env = { ...sanitizedEnv({ TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows), PS1: 'atlas$ ' }) };
  let cmd: string, args: string[];
  let cleanup: (() => void) | undefined;
  let statusFd: number | undefined;
  if (process.platform === 'win32') {
    // ConPTY hosted by the sandbox helper: inside the task's AppContainer when sandboxed, otherwise uncontained
    // (only reachable when the operator allowed unsandboxed execution).
    const shell = 'powershell.exe';
    // The first cmdlet from a module that is not loaded yet (ls, echo, cat…) makes Windows PowerShell analyse every
    // module on PSModulePath unless its analysis cache is warm, and it never is for a sandbox account (a fresh
    // LOCALAPPDATA per task). CI round 9: the typed line was accepted, then no output for 15 s. Importing the two
    // modules behind the everyday aliases by name needs no analysis.
    const shellArgs = ['-NoLogo', '-NoProfile', '-NoExit', '-Command', 'Import-Module Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility'];
    if (o.sandbox) {
      const w = wrapCommand(shell, shellArgs, o.cwd, o.sandbox, env);
      env = w.env;
      cmd = w.command;
      args = [...w.args.slice(0, 2), '--pty', `${cols}x${rows}`, ...(process.env.ATLAS_PTY_DEBUG ? ['--debug'] : []), ...w.args.slice(2)];
    } else {
      cmd = ensureHelper();
      args = ['run', '-', '--pty', `${cols}x${rows}`, ...(process.env.ATLAS_PTY_DEBUG ? ['--debug'] : []), '--parent', String(process.pid), '--cmdline', windowsCommand(shell, shellArgs, env).line];
    }
  } else {
    const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const start = `stty cols ${cols} rows ${rows}; exec ${shell}${shell.endsWith('bash') ? ' --norc' : ''} -i`;
    // macOS: BSD script needs a terminal on stdin and Node gives it socketpairs; `cat | script` works but outlives
    // the shell's exit. The trusted Python bridge allocates the PTY and sets its size, then execs the sandbox wrapper.
    const inner = process.platform === 'darwin'
      ? { command: shell, args: shell.endsWith('bash') ? ['--noprofile', '--norc', '-i'] : ['-i'] }
      : { command: '/usr/bin/script', args: ['-qfec', start, '/dev/null'] };
    cmd = inner.command; args = inner.args;
    if (o.sandbox) ({ command: cmd, args, env, cleanup, statusFd } = wrapCommand(inner.command, inner.args, o.cwd, { ...o.sandbox, pty: true }, env, { statusFd: true }));
    if (process.platform === 'darwin') { args = ['-u', '-c', MAC_PTY, String(cols), String(rows), cmd, ...args]; cmd = '/usr/bin/python3'; }
  }
  const child = spawn(cmd, args, { cwd: o.cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: statusFd !== undefined ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'] });
  const sandboxed = trackSandboxChild(child, statusFd);
  const max = o.maxTranscript ?? 512 * 1024;
  let transcript = '';
  const take = (b: Buffer) => { const t = redact(b.toString('utf8')); transcript = (transcript + t).slice(-max); o.onData(t); };
  child.stdout!.on('data', take);
  child.stderr!.on('data', take);
  let exited = false;
  const unjournal = journalStart(child.pid, 'terminal', 'operator terminal');
  const done = new Promise<void>((r) => child.on('close', (code) => { exited = true; unjournal(); cleanup?.(); o.onExit(code); r(); }));
  child.on('error', (e) => { o.onData(`\r\n[terminal failed to start: ${e.message}]\r\n`); });
  return {
    pid: child.pid ?? null,
    write: (data) => { if (!exited) child.stdin!.write(data); },
    transcript: () => transcript,
    resize: async (c, r) => {
      if (exited || !child.pid || process.platform === 'win32') return false;
      const tty = shellTty(child.pid);
      if (!tty) return false;
      const size = ['rows', String(Math.max(5, Math.min(200, Math.floor(r)))), 'cols', String(Math.max(20, Math.min(400, Math.floor(c))))];
      // TIOCSWINSZ on the shell's terminal; the kernel sends SIGWINCH to its foreground job.
      return new Promise((resolve) => execFile(process.platform === 'darwin' ? '/bin/stty' : 'stty', [process.platform === 'darwin' ? '-f' : '-F', tty, ...size], { timeout: 3000 }, (err) => resolve(!err)));
    },
    close: async () => {
      if (exited || !child.pid) return;
      await sandboxed.ready(2000);
      sandboxed.kill(child.pid, 'SIGHUP');
      const t = setTimeout(() => sandboxed.kill(child.pid, 'SIGKILL'), 1500);
      await done;
      clearTimeout(t);
    },
  };
}
