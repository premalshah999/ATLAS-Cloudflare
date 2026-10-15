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

  it('close() ends the session', async () => {
    const dir = tmpDir();
    let code: number | null | undefined;
    const p = openPty({ cwd: dir, cols: 80, rows: 24, sandbox: { root: dir, writable: true, network: false }, onData: () => {}, onExit: (c) => { code = c; } });
    await new Promise((r) => setTimeout(r, 200));
    await p.close();
    expect(code).not.toBeUndefined();
  });
});
