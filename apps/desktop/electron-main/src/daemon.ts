// Supervises the daemon utility process: request/response correlation, event fan-out and restart with backoff.
import { utilityProcess, type UtilityProcess } from 'electron';
import type { AtlasEvent, DaemonInbound, DaemonOutbound } from '@atlas/contracts';

export type DaemonStatus = { state: 'starting' | 'ready' | 'restarting' | 'stopped'; pid: number | null; restarts: number; detail?: string };

export class DaemonClient {
  private proc: UtilityProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void> = Promise.resolve();
  private markReady: () => void = () => {};
  private stopping = false;
  status: DaemonStatus = { state: 'starting', pid: null, restarts: 0 };

  constructor(
    private readonly entry: string,
    private readonly env: () => Record<string, string>,
    private readonly onEvent: (e: AtlasEvent) => void,
    private readonly onStatus: (s: DaemonStatus) => void,
    private readonly onTerminal: (m: { sessionId: string; data?: string; seq?: number; exit?: number | null }) => void,
    private readonly log: (msg: string) => void,
  ) {}

  start() {
    this.ready = new Promise((r) => { this.markReady = r; });
    const proc = utilityProcess.fork(this.entry, [], { serviceName: 'ATLAS daemon', env: this.env(), stdio: 'pipe' });
    this.proc = proc;
    this.setStatus({ ...this.status, state: this.status.restarts ? 'restarting' : 'starting', pid: proc.pid ?? null });
    proc.stderr?.on('data', (d: Buffer) => this.log(`[daemon] ${d.toString().trimEnd()}`));
    proc.on('message', (m: DaemonOutbound) => this.receive(m));
    proc.on('exit', (code) => {
      this.proc = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Daemon exited before replying')); }
      this.pending.clear();
      if (this.stopping) { this.setStatus({ ...this.status, state: 'stopped', pid: null }); return; }
      const restarts = this.status.restarts + 1;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(restarts, 5));
      this.log(`daemon exited with code ${code}; restarting in ${delay} ms`);
      this.setStatus({ state: 'restarting', pid: null, restarts, detail: `Daemon exited (code ${code}). Restarting and recovering state.` });
      setTimeout(() => { if (!this.stopping) this.start(); }, delay);
    });
  }

  private setStatus(s: DaemonStatus) { this.status = s; this.onStatus(s); }

  private receive(m: DaemonOutbound) {
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'ready') { this.setStatus({ state: 'ready', pid: m.pid, restarts: this.status.restarts, detail: m.recovered.missions.length ? `Recovered ${m.recovered.missions.length} mission(s) after restart` : undefined }); this.markReady(); return; }
    if (m.kind === 'event') { this.onEvent(m.event); return; }
    if (m.kind === 'terminal') { this.onTerminal({ sessionId: m.sessionId, data: m.data, seq: m.seq, exit: m.exit }); return; }
    if (m.kind === 'res') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data);
      else p.reject(Object.assign(new Error(m.error.message), { kind: m.error.kind }));
    }
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    await this.ready;
    if (!this.proc) throw Object.assign(new Error('Daemon is restarting'), { kind: 'stale_session' });
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`${method} timed out`), { kind: 'tool_timeout' })); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      const msg: DaemonInbound = { kind: 'req', id, method, params };
      this.proc!.postMessage(msg);
    });
  }

  /** Restart to apply new credentials; the daemon recovers state on start. */
  restart() { this.proc?.kill(); }

  /** Test hook: simulate a crash. */
  crash() { if (this.proc?.pid) process.kill(this.proc.pid, 'SIGKILL'); }

  async stop() {
    this.stopping = true;
    const p = this.proc;
    if (!p) return;
    await new Promise<void>((r) => { p.once('exit', () => r()); p.kill(); setTimeout(r, 3000); });
  }
}
