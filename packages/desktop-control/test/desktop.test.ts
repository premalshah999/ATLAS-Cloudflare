import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Approval } from '@atlas/contracts';
import { detectSandbox } from '@atlas/terminal';
import { createDesktopTool, DesktopManager, desktopSupport, type DesktopSession } from '../src';

const support = desktopSupport();
const sandbox = detectSandbox();
const owner = () => ({ missionId: 'msn_test', taskId: 'tsk_test', worktree: mkdtempSync(path.join(os.tmpdir(), 'atlas-dsk-')) });
const pointer = (s: DesktopSession) => execFileSync('xdotool', ['getmouselocation'], { env: { PATH: process.env.PATH!, DISPLAY: s.display } }).toString();

// CI sets ATLAS_REQUIRE_DESKTOP on runners that install Xvfb and xdotool (Linux; macOS with XQuartz), so the suites
// below cannot pass by skipping there.
it.runIf(process.env.ATLAS_REQUIRE_DESKTOP === '1')('desktop control is available on this runner', () => {
  expect(support, support.detail).toMatchObject({ ok: true });
});

describe.skipIf(!support.ok)('virtual desktop control', () => {
  const events: string[] = [];
  const mgr = new DesktopManager({ session: (i, change, by) => events.push(`${change}:${by}:${i.controller}`) });
  afterEach(async () => { await mgr.shutdown(); });

  it('drives a real virtual display and captures it', async () => {
    const s = await mgr.open(owner(), null, { width: 640, height: 480 });
    expect(await s.act('agent', { action: 'click', x: 123, y: 77 })).toMatchObject({ ok: true, input: true });
    expect(pointer(s)).toMatch(/x:123 y:77/);
    const png = await s.screenshot();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect((await s.act('agent', { action: 'move', x: 700, y: 10 })).ok).toBe(false); // outside the display
  });

  it('pause: no further input reaches the display', async () => {
    const s = await mgr.open(owner(), null, { width: 640, height: 480 });
    await s.act('agent', { action: 'move', x: 10, y: 10 });
    await mgr.control(s.id, 'pause');
    const before = s.inputLog.length;
    const r = await s.act('agent', { action: 'click', x: 300, y: 300 });
    expect(r).toMatchObject({ ok: false, input: false });
    expect(r.message).toMatch(/paused/);
    expect(pointer(s)).toMatch(/x:10 y:10/);
    expect(s.inputLog.length).toBe(before);
    // Read-only actions still work while paused.
    expect((await s.act('agent', { action: 'screenshot' })).ok).toBe(true);
    await mgr.control(s.id, 'resume');
    expect((await s.act('agent', { action: 'move', x: 50, y: 60 })).ok).toBe(true);
    expect(pointer(s)).toMatch(/x:50 y:60/);
  });

  it('pause in the middle of typing stops the remaining characters', async () => {
    const s = await mgr.open(owner(), null, { width: 640, height: 480 });
    const text = 'x'.repeat(400);
    const typing = s.act('agent', { action: 'type', text });
    await new Promise((r) => setTimeout(r, 250));
    await mgr.control(s.id, 'pause');
    const pausedAt = s.inputLog.length;
    const r = await typing;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Control changed after \d+ of 400/);
    const typed = s.inputLog.filter((x) => x.action === 'type').length * 16;
    expect(typed).toBeLessThan(400);
    // At most the chunk already in flight when pause landed.
    expect(s.inputLog.length - pausedAt).toBeLessThanOrEqual(1);
  });

  it('takeover blocks the agent; the operator drives; release hands back', async () => {
    const s = await mgr.open(owner(), null, { width: 640, height: 480 });
    await mgr.control(s.id, 'takeover');
    const r = await s.act('agent', { action: 'move', x: 200, y: 200 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/operator has taken over/);
    expect((await mgr.operatorInput(s.id, { action: 'move', x: 222, y: 111 })).ok).toBe(true);
    expect(pointer(s)).toMatch(/x:222 y:111/);
    expect(s.inputLog.every((x) => x.by === 'operator')).toBe(true);
    await mgr.control(s.id, 'release');
    expect((await mgr.operatorInput(s.id, { action: 'move', x: 1, y: 1 })).ok).toBe(false);
    expect((await s.act('agent', { action: 'move', x: 5, y: 5 })).ok).toBe(true);
    await expect(mgr.control(s.id, 'resume')).rejects.toThrow(/Cannot resume while the desktop is agent/);
  });

  it('stop tears the display down and refuses everything after', async () => {
    const s = await mgr.open(owner(), null, { width: 640, height: 480 });
    const sock = `/tmp/.X11-unix/X${s.display.slice(1)}`;
    expect(existsSync(sock)).toBe(true);
    await mgr.control(s.id, 'stop');
    for (let i = 0; i < 40 && existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(sock)).toBe(false);
    expect((await s.act('agent', { action: 'screenshot' })).ok).toBe(false);
    expect(mgr.list()).toHaveLength(0);
    expect(events).toContain('stopped by operator:operator:stopped');
  });

  it('launch: denied programs never start; without a sandbox nothing is launched', async () => {
    const s = await mgr.open(owner(), null, { width: 640, height: 480 });
    expect((await s.act('agent', { action: 'launch', app: 'sudo', args: ['xterm'] })).message).toMatch(/never permitted/);
    expect((await s.act('agent', { action: 'launch', app: 'xmessage', args: ['hi'] })).message).toMatch(/No OS sandbox/);
    expect(await s.windows()).toEqual([]);
  });

  it.skipIf(sandbox.kind !== 'bwrap' || !existsSync('/usr/bin/xmessage'))('launches an app inside the sandbox on the virtual display', async () => {
    const o = owner();
    const s = await mgr.open(o, { root: o.worktree, writable: false, network: false }, { width: 640, height: 480 });
    expect((await s.act('agent', { action: 'launch', app: 'xmessage', args: ['-name', 'atlas-probe', '-title', 'atlas-probe', 'hello'] })).ok).toBe(true);
    const w = await s.act('agent', { action: 'waitFor', windowTitle: 'atlas-probe', timeoutMs: 10_000 });
    expect(w.ok, w.message).toBe(true);
    // The framebuffer screenshot shows the window: some pixels are no longer the black root.
    const { inflateSync } = await import('node:zlib');
    const png = await s.screenshot();
    const raw = inflateSync(png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8));
    expect(raw.some((b, i) => i % (640 * 3 + 1) !== 0 && b > 200)).toBe(true);
  });
});

describe.skipIf(!support.ok)('desktop_action consent', () => {
  const mgr = new DesktopManager({ session: () => {} });
  afterEach(async () => { await mgr.shutdown(); });
  const approval = (status: Approval['status']) => async () => ({ status } as Approval);
  const base = (over: Partial<Parameters<typeof createDesktopTool>[0]>) => {
    const shots: string[] = [];
    const emitted: unknown[] = [];
    const tool = createDesktopTool({ manager: mgr, missionId: 'msn_x', taskId: 'tsk_x', worktree: os.tmpdir(), sandbox: null, enabled: () => true, requestApproval: approval('approved'), putScreenshot: (n) => { shots.push(n); return `art_${shots.length}`; }, emit: (_t, p) => emitted.push(p), size: { width: 320, height: 240 }, ...over });
    return { tool, shots, emitted };
  };

  it('refuses when desktop control is off, without asking or starting a display', async () => {
    let asked = 0;
    const { tool } = base({ enabled: () => false, requestApproval: async () => { asked++; return { status: 'approved' } as Approval; } });
    const r = await tool.invoke({ action: 'screenshot' });
    expect(r).toMatchObject({ ok: false, error: 'policy_denied' });
    expect(asked).toBe(0);
    expect(mgr.list()).toHaveLength(0);
  });

  it('a declined session approval starts nothing and stays declined', async () => {
    const { tool } = base({ requestApproval: approval('denied') });
    expect(await tool.invoke({ action: 'click', x: 1, y: 1 })).toMatchObject({ ok: false, error: 'approval_denied' });
    expect(await tool.invoke({ action: 'screenshot' })).toMatchObject({ ok: false, error: 'approval_denied' });
    expect(mgr.list()).toHaveLength(0);
  });

  it('approved once: actions run, each input leaves a screenshot, dispose ends the session', async () => {
    const { tool, shots, emitted } = base({});
    expect((await tool.invoke({ action: 'click', x: 10, y: 10 })).ok).toBe(true);
    expect((await tool.invoke({ action: 'type', text: 'secret words' })).ok).toBe(true);
    expect(shots).toHaveLength(2);
    expect(JSON.stringify(emitted)).not.toContain('secret words');
    expect(mgr.list()).toHaveLength(1);
    expect((await tool.invoke({ action: 'bogus' })).error).toBe('invalid_args');
    await tool.dispose();
    expect(mgr.list()).toHaveLength(0);
  });
});

describe.skipIf(!support.ok)('pointer edge cases', () => {
  const mgr = new DesktopManager({ session: () => {} });
  afterEach(async () => { await mgr.shutdown(); });
  it('moving to where the pointer already is returns promptly (Xvfb starts it at the centre)', async () => {
    const s = await mgr.open(owner(), null, { width: 640, height: 480 });
    const t0 = Date.now();
    expect((await s.act('agent', { action: 'click', x: 320, y: 240 })).ok).toBe(true);
    expect((await s.act('agent', { action: 'click', x: 320, y: 240 })).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
