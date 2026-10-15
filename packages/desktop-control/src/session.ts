// Desktop control on a disposable virtual display (manual §26–27). The operator's own desktop is never
// controlled. One session = one Xvfb display (XQuartz's Xvfb on macOS); input via xdotool; screenshots read
// straight from the Xvfb framebuffer file. Windows has no virtual X display: desktop control is unavailable there.
// An exclusive controller lease decides who may emit input: the agent, the operator (takeover), or nobody.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { xwdToPng } from './xwd';
import { newId, nowIso, type DesktopAction, type DesktopController, type DesktopSessionInfo } from '@atlas/contracts';
import { classifyCommand } from '@atlas/policy';
import { journalStart, sanitizedEnv, startProcess, wrapCommand, type ProcessHandle, type SandboxSpec } from '@atlas/terminal';

export type Controller = DesktopController;

const which = (b: string) => [...(process.env.PATH ?? '').split(path.delimiter), '/opt/X11/bin', '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).map((d) => path.join(d, b)).find((p) => existsSync(p)) ?? null;
const X_PATH = () => [...new Set([...(process.env.PATH ?? '').split(path.delimiter), '/opt/X11/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].filter(Boolean).join(path.delimiter);

export function desktopSupport(): { ok: boolean; detail: string } {
  if (process.platform === 'win32') return { ok: false, detail: 'Desktop control needs an X virtual display (Xvfb), which Windows does not provide. Run ATLAS on Linux or macOS for desktop missions.' };
  if (process.platform !== 'linux' && process.platform !== 'darwin') return { ok: false, detail: `Desktop control is not available on ${process.platform}.` };
  const missing = ['Xvfb', 'xdotool'].filter((b) => !which(b));
  const how = process.platform === 'darwin' ? 'install XQuartz (brew install --cask xquartz) and xdotool (brew install xdotool)' : 'apt install xvfb xdotool / dnf install xorg-x11-server-Xvfb xdotool';
  return missing.length ? { ok: false, detail: `Missing: ${missing.join(', ')} — ${how}` } : { ok: true, detail: `Xvfb (${which('Xvfb')}) + xdotool` };
}

function freeDisplay(): number {
  for (let n = 90; n < 200; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  throw new Error('No free X display number');
}

export interface InputRecord { at: string; by: 'agent' | 'operator'; action: string; detail: string }

export class DesktopSession {
  readonly id = newId('dsk');
  readonly display: string;
  readonly width: number;
  readonly height: number;
  controller: Controller = 'agent';
  /** Every input actually emitted, by whom. Tests and the audit log use this as ground truth. */
  readonly inputLog: InputRecord[] = [];
  private xvfb: ChildProcess | null = null;
  private unjournal: () => void = () => {};
  private fbdir: string | null = null;
  private apps: ProcessHandle[] = [];
  readonly startedAt = nowIso();
  private readonly launcher: (cmd: string, args: string[]) => { command: string; args: string[]; env: Record<string, string> } | null;

  /**
   * `sandbox`: the spec launched apps run under; `null` means no OS sandbox is available, so nothing is
   * launched; `'unsandboxed'` only when the operator explicitly allowed unsandboxed execution.
   */
  constructor(readonly owner: { missionId: string; taskId: string | null; worktree: string }, sandbox: SandboxSpec | null | 'unsandboxed', size = { width: 1280, height: 800 }) {
    this.display = `:${freeDisplay()}`;
    this.width = size.width;
    this.height = size.height;
    this.launcher = DesktopSession.sandboxLauncher(this.display, owner.worktree, sandbox);
  }

  get environment() { return `Virtual display ${this.display} (${this.width}×${this.height}, Xvfb) — not your desktop`; }

  info(): DesktopSessionInfo {
    return { id: this.id, missionId: this.owner.missionId, taskId: this.owner.taskId, display: this.display, width: this.width, height: this.height, controller: this.controller, startedAt: this.startedAt, inputs: this.inputLog.length, environment: this.environment };
  }

  async start() {
    // -noreset: keep server state (pointer, windows) when short-lived clients like xdotool disconnect.
    this.fbdir = mkdtempSync(path.join(os.tmpdir(), 'atlas-fb-'));
    this.xvfb = spawn(which('Xvfb') ?? 'Xvfb', [this.display, '-screen', '0', `${this.width}x${this.height}x24`, '-nolisten', 'tcp', '-noreset', '-fbdir', this.fbdir], { stdio: 'ignore', detached: true });
    this.xvfb.unref();
    // Detached and unref'd, so it would outlive a daemon crash forever: journal it for the reaper (P0-4 review).
    this.unjournal = journalStart(this.xvfb.pid, 'service', `Xvfb ${this.display}`);
    const sock = `/tmp/.X11-unix/X${this.display.slice(1)}`;
    for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
    if (!existsSync(sock)) throw new Error('Virtual display did not start');
    await this.x('xsetroot', ['-solid', '#1b1d22']).catch(() => {});
  }

  private x(cmd: string, args: string[], encoding: 'utf8' | 'buffer' = 'utf8'): Promise<any> {
    return new Promise((resolve, reject) => {
      execFile(which(cmd) ?? cmd, args, { env: { PATH: X_PATH(), DISPLAY: this.display }, encoding: encoding as BufferEncoding, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (err, out) => (err ? reject(err) : resolve(out)));
    });
  }

  /** The Xvfb framebuffer is a live XWD file; read and encode it (no X client involved). */
  async screenshot(): Promise<Buffer> {
    if (!this.fbdir) throw new Error('Virtual display is not running');
    return xwdToPng(await readFile(path.join(this.fbdir, 'Xvfb_screen0'))).png;
  }

  async pointer(): Promise<{ x: number; y: number }> {
    const out: string = await this.x('xdotool', ['getmouselocation', '--shell']);
    return { x: Number(/X=(\d+)/.exec(out)?.[1] ?? -1), y: Number(/Y=(\d+)/.exec(out)?.[1] ?? -1) };
  }

  async windows(): Promise<{ id: string; title: string }[]> {
    const ids: string = await this.x('xdotool', ['search', '--onlyvisible', '--name', '.*']).catch(() => '');
    const out: { id: string; title: string }[] = [];
    for (const id of ids.split('\n').filter(Boolean)) out.push({ id, title: ((await this.x('xdotool', ['getwindowname', id]).catch(() => '')) as string).trim() });
    return out.filter((w) => w.title);
  }

  /**
   * Perform one action. Input is emitted only by the current controller; anything else is refused
   * before reaching the display (manual §26: pause means no further input).
   */
  async act(by: 'agent' | 'operator', a: DesktopAction): Promise<{ ok: boolean; message: string; input: boolean }> {
    // One action at a time per display, so agent and operator input never interleave.
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      let r: { ok: boolean; message: string };
      try { r = await this.perform(by, a); } catch (e) { r = { ok: false, message: `Desktop action failed: ${(e as Error).message.split('\n')[0]}` }; }
      return { ...r, input: !['screenshot', 'windows', 'waitFor'].includes(a.action) && r.ok };
    } finally { release(); }
  }

  private lock: Promise<void> = Promise.resolve();
  /** Re-checked between steps of a longer action, so a pause or takeover stops input mid-action. */
  private holds(by: 'agent' | 'operator') { return this.controller === by; }

  private async perform(by: 'agent' | 'operator', a: DesktopAction): Promise<{ ok: boolean; message: string }> {
    const input = !['screenshot', 'windows', 'waitFor'].includes(a.action);
    if (this.controller === 'stopped') return { ok: false, message: 'Desktop session has been stopped by the operator.' };
    if (input && this.controller !== by) {
      return { ok: false, message: this.controller === 'paused' ? 'Desktop control is paused by the operator; no input was sent.' : by === 'agent' ? 'The operator has taken over the desktop; no input was sent.' : 'The agent holds the desktop; take over first.' };
    }
    const inBounds = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < this.width && y < this.height;
    const record = (detail: string) => { this.inputLog.push({ at: nowIso(), by, action: a.action, detail }); };
    switch (a.action) {
      case 'screenshot': return { ok: true, message: `${this.width}×${this.height} screenshot` };
      case 'windows': { const w = await this.windows(); return { ok: true, message: w.length ? w.map((x) => `${x.id}\t${x.title}`).join('\n') : '(no windows)' }; }
      case 'move': case 'click': {
        if (!inBounds(a.x, a.y)) return { ok: false, message: `(${a.x}, ${a.y}) is outside the ${this.width}×${this.height} display` };
        // No --sync: it waits for a motion event and hangs when the pointer is already there. Verify instead.
        await this.x('xdotool', ['mousemove', String(Math.round(a.x)), String(Math.round(a.y))]);
        for (let i = 0; i < 20; i++) { const p = await this.pointer(); if (p.x === Math.round(a.x) && p.y === Math.round(a.y)) break; await new Promise((r) => setTimeout(r, 10)); }
        record(`move ${a.x},${a.y}`);
        if (a.action === 'click' && !this.holds(by)) return { ok: false, message: 'Control changed before the click; only the pointer moved.' };
        if (a.action === 'click') await this.x('xdotool', ['click', ...(a.double ? ['--repeat', '2'] : []), a.button === 'right' ? '3' : a.button === 'middle' ? '2' : '1']);
        if (a.action === 'click') record(`click ${a.x},${a.y} ${a.button ?? 'left'}`);
        return { ok: true, message: `${a.action === 'click' ? 'Clicked' : 'Moved to'} (${a.x}, ${a.y})` };
      }
      case 'type': {
        if (a.text.length > 2000) return { ok: false, message: 'Text too long (max 2000 characters per action)' };
        // Typed in short chunks; a pause or takeover between chunks stops the rest.
        const chars = Array.from(a.text);
        let sent = 0;
        for (let i = 0; i < chars.length; i += 16) {
          if (!this.holds(by)) return { ok: false, message: `Control changed after ${sent} of ${chars.length} characters; the rest was not typed.` };
          const chunk = chars.slice(i, i + 16).join('');
          await this.x('xdotool', ['type', '--delay', '12', '--', chunk]);
          sent += Array.from(chunk).length;
          record(`type ${Array.from(chunk).length} chars`);
        }
        return { ok: true, message: `Typed ${sent} characters` };
      }
      case 'key': {
        if (!/^[A-Za-z0-9_+\- ]{1,100}$/.test(a.keys)) return { ok: false, message: 'Invalid key combination' };
        await this.x('xdotool', ['key', '--', ...a.keys.split(' ')]);
        record(`key ${a.keys}`);
        return { ok: true, message: `Pressed ${a.keys}` };
      }
      case 'scroll': {
        const steps: string[] = [];
        const dy = Math.max(-20, Math.min(20, Math.round(a.dy ?? 0))), dx = Math.max(-20, Math.min(20, Math.round(a.dx ?? 0)));
        if (dy) steps.push('--repeat', String(Math.abs(dy)), dy > 0 ? '5' : '4');
        if (steps.length) await this.x('xdotool', ['click', ...steps]);
        if (dx) await this.x('xdotool', ['click', '--repeat', String(Math.abs(dx)), dx > 0 ? '7' : '6']);
        record(`scroll ${dx},${dy}`);
        return { ok: true, message: `Scrolled ${dx},${dy}` };
      }
      case 'focus': {
        if (!/^\d+$/.test(a.windowId)) return { ok: false, message: 'Invalid window id' };
        await this.x('xdotool', ['windowfocus', '--sync', a.windowId]).catch(() => this.x('xdotool', ['windowraise', a.windowId]));
        record(`focus ${a.windowId}`);
        return { ok: true, message: `Focused ${a.windowId}` };
      }
      case 'launch': {
        const args = a.args ?? [];
        const c = classifyCommand(a.app, args);
        if (!c.capability) return { ok: false, message: `Not launched: ${c.reason}` };
        const wrapped = this.launcher(a.app, args);
        if (!wrapped) return { ok: false, message: 'No OS sandbox available; applications are not launched unsandboxed on the virtual desktop.' };
        const h = startProcess({ command: wrapped.command, args: wrapped.args, cwd: this.owner.worktree, env: { ...wrapped.env, DISPLAY: this.display } });
        if (h.spawnError) return { ok: false, message: h.spawnError };
        this.apps.push(h);
        record(`launch ${a.app}`);
        return { ok: true, message: `Launched ${a.app} (pid ${h.pid})` };
      }
      case 'waitFor': {
        const end = Date.now() + Math.min(60_000, a.timeoutMs ?? 10_000);
        while (Date.now() < end) {
          const w = (await this.windows()).find((x) => x.title.includes(a.windowTitle));
          if (w) return { ok: true, message: `Window "${w.title}" (${w.id}) is present` };
          await new Promise((r) => setTimeout(r, 200));
        }
        return { ok: false, message: `No window titled "${a.windowTitle}" appeared` };
      }
    }
  }

  setController(c: Controller) { if (this.controller !== 'stopped') this.controller = c; }

  async stop() {
    this.controller = 'stopped';
    for (const a of this.apps) await a.stop().catch(() => {});
    this.apps = [];
    if (this.xvfb?.pid) { try { process.kill(-this.xvfb.pid, 'SIGTERM'); } catch { try { this.xvfb.kill('SIGTERM'); } catch { /* gone */ } } }
    this.xvfb = null;
    this.unjournal();
    if (this.fbdir) { rmSync(this.fbdir, { recursive: true, force: true }); this.fbdir = null; }
  }

  /** Sandbox wrapper for launched apps: worktree root, only this display's X socket mounted, no network. */
  static sandboxLauncher(display: string, worktree: string, spec: SandboxSpec | null | 'unsandboxed') {
    return (cmd: string, args: string[]) => {
      if (spec === null) return null;
      const env = sanitizedEnv({ DISPLAY: display });
      if (spec === 'unsandboxed') return { command: cmd, args, env };
      const sock = `/tmp/.X11-unix/X${display.slice(1)}`;
      return wrapCommand(cmd, args, worktree, { ...spec, root: worktree, network: false, readWrite: [...(spec.readWrite ?? []), sock] }, env);
    };
  }
}
