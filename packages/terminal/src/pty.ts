// Interactive pseudoterminals for operator sessions (manual §20). The PTY is allocated by the system
// `script` on Linux and a Python standard-library PTY bridge on macOS. The shell runs in the sandbox.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { redact } from '@atlas/contracts';
import { killTree, sanitizedEnv } from './index';
import { wrapCommand, type SandboxSpec } from './sandbox';

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
}

export function ptySupported(): { ok: boolean; detail: string } {
  if (process.platform === 'linux') return existsSync('/usr/bin/script') ? { ok: true, detail: 'util-linux script' } : { ok: false, detail: 'util-linux `script` is not installed' };
  if (process.platform === 'darwin') return { ok: existsSync('/usr/bin/python3'), detail: 'Python 3 PTY bridge (Apple Command Line Tools)' };
  return { ok: false, detail: `No PTY support on ${process.platform}` };
}

export function openPty(o: { cwd: string; cols: number; rows: number; sandbox?: SandboxSpec; onData: (text: string) => void; onExit: (code: number | null) => void; maxTranscript?: number }): PtyHandle {
  const cols = Math.max(20, Math.min(400, Math.floor(o.cols)));
  const rows = Math.max(5, Math.min(200, Math.floor(o.rows)));
  const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const inner = process.platform === 'darwin'
    ? { command: shell, args: shell.endsWith('bash') ? ['--noprofile', '--norc', '-i'] : ['-i'] }
    : { command: '/usr/bin/script', args: ['-qfec', `stty cols ${cols} rows ${rows}; exec ${shell}${shell.endsWith('bash') ? ' --norc' : ''} -i`, '/dev/null'] };
  let env = { ...sanitizedEnv({ TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows), PS1: 'atlas$ ' }) };
  let cmd = inner.command, args = inner.args;
  if (o.sandbox) ({ command: cmd, args, env } = wrapCommand(inner.command, inner.args, o.cwd, o.sandbox, env));
  if (process.platform === 'darwin') {
    args = ['-u', '-c', MAC_PTY, String(cols), String(rows), cmd, ...args];
    cmd = '/usr/bin/python3';
  }
  const child = spawn(cmd, args, { cwd: o.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const max = o.maxTranscript ?? 512 * 1024;
  let transcript = '';
  const take = (b: Buffer) => { const t = redact(b.toString('utf8')); transcript = (transcript + t).slice(-max); o.onData(t); };
  child.stdout!.on('data', take);
  child.stderr!.on('data', take);
  let exited = false;
  const done = new Promise<void>((r) => child.on('close', (code) => { exited = true; o.onExit(code); r(); }));
  child.on('error', (e) => { o.onData(`\r\n[terminal failed to start: ${e.message}]\r\n`); });
  return {
    pid: child.pid ?? null,
    write: (data) => { if (!exited) child.stdin!.write(data); },
    transcript: () => transcript,
    close: async () => {
      if (exited || !child.pid) return;
      killTree(child.pid, 'SIGHUP');
      const t = setTimeout(() => { if (child.pid) killTree(child.pid, 'SIGKILL'); }, 1500);
      await done;
      clearTimeout(t);
    },
  };
}
