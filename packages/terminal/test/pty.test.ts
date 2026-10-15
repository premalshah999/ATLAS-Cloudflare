import { describe, expect, it } from 'vitest';
import { detectSandbox, openPty, ptySupported } from '../src';
import { tmpDir } from '../../../tests/helpers';

describe.skipIf(!ptySupported().ok || detectSandbox().kind === 'none')('operator PTY', () => {
  it('is a real terminal inside the sandbox with the requested size', async () => {
    const dir = tmpDir();
    let out = '';
    let code: number | null | undefined;
    const p = openPty({ cwd: dir, cols: 101, rows: 31, sandbox: { root: dir, writable: true, network: false }, onData: (t) => { out += t; }, onExit: (c) => { code = c; } });
    p.write('tty; stty size; echo HOME=$HOME; touch made-here; exit\n');
    for (let i = 0; i < 100 && code === undefined; i++) await new Promise((r) => setTimeout(r, 50));
    expect(out).toMatch(process.platform === 'darwin' ? /\/dev\/ttys\d+/ : /\/dev\/pts\/\d+/);
    expect(out).toContain('31 101');
    if (process.platform !== 'darwin') expect(out).toContain('HOME=/home/atlas-sandbox');
    expect(code).toBe(0);
    expect((await import('node:fs')).existsSync(`${dir}/made-here`)).toBe(true);
  });

  it('read-only sessions cannot write the worktree', async () => {
    const dir = tmpDir();
    let out = '';
    let code: number | null | undefined;
    const p = openPty({ cwd: dir, cols: 80, rows: 24, sandbox: { root: dir, writable: false, network: false }, onData: (t) => { out += t; }, onExit: (c) => { code = c; } });
    p.write('touch nope 2>&1 || echo WRITE-DENIED; exit\n');
    for (let i = 0; i < 100 && code === undefined; i++) await new Promise((r) => setTimeout(r, 50));
    expect(out).toContain('WRITE-DENIED');
  });

  it('resizes the shell\'s terminal from outside the sandbox (P1-5)', async () => {
    const dir = tmpDir();
    let out = '';
    let code: number | null | undefined;
    const p = openPty({ cwd: dir, cols: 80, rows: 24, sandbox: { root: dir, writable: true, network: false }, onData: (t) => { out += t; }, onExit: (c) => { code = c; } });
    await new Promise((r) => setTimeout(r, 300));
    expect(await p.resize(132, 43)).toBe(true);
    p.write('stty size; exit\n');
    for (let i = 0; i < 100 && code === undefined; i++) await new Promise((r) => setTimeout(r, 50));
    expect(out).toContain('43 132');
  });

  it('close() ends the session', async () => {
    const dir = tmpDir();
    let code: number | null | undefined;
    const p = openPty({ cwd: dir, cols: 80, rows: 24, sandbox: { root: dir, writable: true, network: false }, onData: () => {}, onExit: (c) => { code = c; } });
    await new Promise((r) => setTimeout(r, 200));
    await p.close();
    expect(code).not.toBeUndefined();
  });
});

// Windows: the operator terminal is a ConPTY hosted by the sandbox helper; with sandbox accounts (ADR 0020) a copy of
// the helper running as the account hosts it. Typed input must reach PowerShell and its output come back.
describe.skipIf(process.platform !== 'win32')('operator PTY on Windows', () => {
  process.env.ATLAS_PTY_DEBUG = '1'; // the helper reports every input relay step on stderr (part of the transcript)
  const sleep = () => new Promise((r) => setTimeout(r, 50));
  async function session(sandboxed: boolean) {
    const dir = tmpDir();
    let out = '';
    let code: number | null | undefined;
    const p = openPty({ cwd: dir, cols: 100, rows: 30, ...(sandboxed ? { sandbox: { root: dir, writable: true, network: false } } : {}), onData: (t) => { out += t; }, onExit: (c) => { code = c; } });
    for (let i = 0; i < 400 && !/PS [A-Z]:\\/.test(out) && code === undefined; i++) await sleep();
    // 1. A bare expression: no cmdlet, so no module loading. Keystrokes in, output out.
    let t0 = Date.now();
    p.write('"atlas" + "-pty-" + (40 + 2)\r');
    for (let i = 0; i < 200 && !out.includes('atlas-pty-42') && code === undefined; i++) await sleep();
    const exprMs = Date.now() - t0;
    // 2. A cmdlet (Microsoft.PowerShell.Utility), and an everyday alias (ls: Microsoft.PowerShell.Management).
    t0 = Date.now();
    p.write('Write-Output ("atlas" + "-cmdlet-" + (40 + 2)); ls\r');
    for (let i = 0; i < 900 && !out.includes('atlas-cmdlet-42') && code === undefined; i++) await sleep();
    const cmdletMs = Date.now() - t0;
    const transcript = JSON.stringify(out.slice(-3000));
    p.write('exit\r');
    for (let i = 0; i < 100 && code === undefined; i++) await sleep();
    await p.close();
    return { out, transcript, timing: `expression ${exprMs} ms, cmdlet ${cmdletMs} ms, exit code ${code}` };
  }
  it('typed input reaches PowerShell and its output comes back (helper without a sandbox)', async () => {
    const { out, transcript, timing } = await session(false);
    console.log(`[pty plain] ${timing} ${transcript}`);
    expect(out, transcript).toContain('atlas-pty-42');
    expect(out, transcript).toContain('atlas-cmdlet-42');
  }, 120_000);
  it.skipIf(detectSandbox().kind !== 'windows-account')('the same inside the sandbox account', async () => {
    const { out, transcript, timing } = await session(true);
    console.log(`[pty account] ${timing} ${transcript}`);
    expect(out, transcript).toContain('atlas-pty-42');
    expect(out, transcript).toContain('atlas-cmdlet-42');
  }, 120_000);
});
