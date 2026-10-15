// Background processes for agents (ADR 0026): dev servers, watchers and long builds an agent starts, reads and stops
// while it keeps working. Each one passes the same policy and sandbox as shell_exec (the ToolGate decides before this
// code runs); ATLAS keeps the output, finds the ports it listens on, and stops every one when the attempt ends.
import { redact } from '@atlas/contracts';
import type { ProcessHandle } from '@atlas/terminal';

/** Running at once per attempt. */
export const MAX_BACKGROUND = 4;
/** Output kept per process for the log artifact (the newest part when it is longer). */
const LOG_MAX = 2 * 1024 * 1024;

export interface StartedProcess { handle: ProcessHandle; done: Promise<number | null> }

export interface BackgroundHooks {
  /** Start the process (sandboxed by the caller); `onOutput` gets redacted text. */
  start(o: { command: string; args: string[]; cwd: string; network: boolean; onOutput(text: string): void }): Promise<StartedProcess>;
  started(p: BackgroundProcess): void;
  output(p: BackgroundProcess, text: string): void;
  /** The process ended (by itself or stopped). Returns the id of the artifact holding its full output. */
  ended(p: BackgroundProcess, how: { exitCode: number | null; stopped: boolean }): string;
  /** HTTP status of a loopback port, or why there is none. */
  probe?(port: number): Promise<string>;
}

export interface BackgroundProcess {
  id: string;
  name: string;
  command: string;
  cwd: string;
  serve: boolean;
  pid: number | null;
  startedAt: number;
  log: string;
  /** Characters dropped from the front of `log` to stay under LOG_MAX. */
  dropped: number;
  /** Absolute output offset the agent has read up to. */
  readTo: number;
  ports: number[];
  exit: { code: number | null; stopped: boolean; at: number; artifactId: string } | null;
  /** process_stop or the end of the attempt asked it to stop. */
  stopping: boolean;
  handle: ProcessHandle | null;
  wake: Set<() => void>;
}

const PORT_PATTERNS = [
  /(?:\blocalhost|\b127\.0\.0\.1|\b0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})\b/gi,
  /\b(?:listening|running|serving|started|available)\b[^\n]{0,40}?\bport\b\s*:?\s*(\d{2,5})\b/gi,
  /\bport\s*[:=]\s*(\d{2,5})\b/gi,
];

/** Ports a process says it listens on, from its own output. */
export function detectPorts(text: string): number[] {
  const out = new Set<number>();
  for (const re of PORT_PATTERNS) for (const m of text.matchAll(re)) { const n = Number(m[1]); if (n >= 1 && n <= 65535) out.add(n); }
  return [...out];
}

const lines = (s: string) => s.split(/\r?\n/);

/** The last `n` lines of `text`, saying how many were left out. */
function lastLines(text: string, n: number): string {
  const all = lines(text.replace(/\n$/, ''));
  if (all.length <= n) return all.join('\n');
  return `[${all.length - n} earlier lines omitted]\n${all.slice(-n).join('\n')}`;
}

export class BackgroundProcesses {
  private readonly procs = new Map<string, BackgroundProcess>();
  private seq = 0;
  private closed = false;
  constructor(private readonly hooks: BackgroundHooks) {}

  running(): BackgroundProcess[] { return [...this.procs.values()].filter((p) => !p.exit); }
  get(id: string): BackgroundProcess | undefined { return this.procs.get(id); }

  async start(o: { command: string; args: string[]; cwd: string; relCwd: string; name?: string; serve: boolean; waitFor?: string; waitSec: number }, signal: AbortSignal): Promise<{ ok: boolean; text: string; process?: BackgroundProcess }> {
    if (this.closed) return { ok: false, text: 'The attempt is ending; no new background processes.' };
    if (this.running().length >= MAX_BACKGROUND) {
      return { ok: false, text: `Not started: ${MAX_BACKGROUND} background processes are already running (${this.running().map((p) => `${p.id} ${p.name}`).join(', ')}). Stop one with process_stop first.` };
    }
    const id = `p${++this.seq}`;
    const command = redact([o.command, ...o.args].join(' '));
    const p: BackgroundProcess = {
      id, name: (o.name ?? o.command).slice(0, 60), command, cwd: o.relCwd, serve: o.serve, pid: null, startedAt: Date.now(),
      log: '', dropped: 0, readTo: 0, ports: [], exit: null, stopping: false, handle: null, wake: new Set(),
    };
    this.procs.set(id, p);
    const started = await this.hooks.start({
      command: o.command, args: o.args, cwd: o.cwd, network: o.serve,
      onOutput: (t) => {
        p.log += t;
        if (p.log.length > LOG_MAX) { const cut = p.log.length - LOG_MAX; p.log = p.log.slice(cut); p.dropped += cut; }
        for (const port of detectPorts(t)) if (!p.ports.includes(port)) p.ports.push(port);
        this.hooks.output(p, t);
        for (const w of p.wake) w();
      },
    });
    p.handle = started.handle;
    p.pid = started.handle.pid;
    if (started.handle.spawnError) {
      p.exit = { code: null, stopped: false, at: Date.now(), artifactId: this.hooks.ended(p, { exitCode: null, stopped: false }) };
      return { ok: false, text: `Failed to start ${command}: ${started.handle.spawnError}`, process: p };
    }
    this.hooks.started(p);
    void started.done.then((code) => {
      if (p.exit) return;
      p.exit = { code, stopped: p.stopping, at: Date.now(), artifactId: '' };
      try { p.exit.artifactId = this.hooks.ended(p, { exitCode: code, stopped: p.stopping }); } catch { /* recording failed (shutting down); the process is still over */ }
      for (const w of p.wake) w();
    });
    // Until it prints the expected text, says which port it listens on, exits, or the wait is over.
    await this.waitFor(p, o.waitSec * 1000, signal, () => (o.waitFor ? this.unread(p).includes(o.waitFor) : p.ports.length > 0));
    return { ok: !p.exit || p.exit.code === 0, text: await this.describe(p, { tail: 40, header: `Started ${p.name} as ${p.id}` }), process: p };
  }

  async read(id: string, o: { tail: number; waitFor?: string; waitSec: number }, signal: AbortSignal): Promise<{ ok: boolean; text: string }> {
    const p = this.procs.get(id);
    if (!p) return { ok: false, text: `No background process ${id} in this attempt. process_list shows them.` };
    if (o.waitFor && !p.exit) await this.waitFor(p, o.waitSec * 1000, signal, () => this.unread(p).includes(o.waitFor!));
    return { ok: true, text: await this.describe(p, { tail: o.tail }) };
  }

  async stop(id: string): Promise<{ ok: boolean; text: string }> {
    const p = this.procs.get(id);
    if (!p) return { ok: false, text: `No background process ${id} in this attempt. process_list shows them.` };
    if (!p.exit) await this.kill(p);
    return { ok: true, text: await this.describe(p, { tail: 20 }) };
  }

  list(): string {
    if (!this.procs.size) return 'No background processes in this attempt.';
    return [...this.procs.values()].map((p) => `${p.id} ${p.name}: ${this.status(p)}${p.ports.length ? ` · ports ${p.ports.join(', ')}` : ''} · ${p.command}${p.cwd !== '.' ? ` (in ${p.cwd})` : ''}`).join('\n');
  }

  /** Stop everything (the attempt ended). */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.running().map((p) => this.kill(p)));
  }

  private async kill(p: BackgroundProcess) {
    p.stopping = true;
    await p.handle?.stop().catch(() => {});
    if (!p.exit) {
      const code = p.handle?.exited()?.code ?? null;
      p.exit = { code, stopped: true, at: Date.now(), artifactId: '' };
      p.exit.artifactId = this.hooks.ended(p, { exitCode: code, stopped: true });
    }
    for (const w of p.wake) w();
  }

  private unread(p: BackgroundProcess): string { return p.log.slice(Math.max(0, p.readTo - p.dropped)); }

  private status(p: BackgroundProcess): string {
    const secs = Math.round(((p.exit?.at ?? Date.now()) - p.startedAt) / 1000);
    if (!p.exit) return `running for ${secs} s (pid ${p.pid})`;
    return `${p.exit.stopped ? 'stopped' : `exited with code ${p.exit.code}`} after ${secs} s${p.exit.artifactId ? ` · full log ${p.exit.artifactId}` : ''}`;
  }

  private async describe(p: BackgroundProcess, o: { tail: number; header?: string }): Promise<string> {
    const fresh = this.unread(p);
    const skipped = p.readTo < p.dropped;
    p.readTo = p.dropped + p.log.length;
    const out: string[] = [`${o.header ?? `${p.id} ${p.name}`}: ${this.status(p)}`];
    if (p.ports.length) {
      const probed = await Promise.all(p.ports.map(async (port) => `http://127.0.0.1:${port}${this.hooks.probe && !p.exit && p.serve ? ` → ${await this.hooks.probe(port)}` : ''}`));
      out.push(`Listening on: ${probed.join(', ')}`);
      if (!p.serve && !p.exit) out.push('(Started without serve: its network is private to its sandbox, so nothing else can reach these ports. Start it with serve: true to reach it.)');
    }
    out.push(fresh ? `New output${skipped ? ' (older output was dropped)' : ''}:\n${lastLines(fresh, o.tail)}` : 'No new output.');
    return out.join('\n');
  }

  private waitFor(p: BackgroundProcess, ms: number, signal: AbortSignal, done: () => boolean): Promise<void> {
    if (done() || p.exit || signal.aborted || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(t); p.wake.delete(check); signal.removeEventListener('abort', finish); resolve(); };
      const check = () => { if (done() || p.exit) finish(); };
      const t = setTimeout(finish, ms);
      p.wake.add(check);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
