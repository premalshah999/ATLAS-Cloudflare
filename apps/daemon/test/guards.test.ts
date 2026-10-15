import { describe, expect, it } from 'vitest';
import { installCrashGuards, once } from '../src/guards';

describe('daemon crash guards', () => {
  it('an unhandled rejection is logged with its stack and the daemon keeps running', () => {
    const logged: { msg: string; data?: Record<string, unknown> }[] = [];
    const exits: number[] = [];
    const remove = installCrashGuards({ error: (msg, data) => logged.push({ msg, data }) }, { exit: (c) => exits.push(c) });
    try {
      process.emit('unhandledRejection', new Error('graph build failed'), Promise.resolve());
      expect(exits).toEqual([]);
      expect(logged[0].msg).toBe('unhandled rejection (daemon kept running)');
      expect(logged[0].data).toMatchObject({ message: 'graph build failed', stack: expect.stringMatching(/Error: graph build failed/) });
      process.emit('unhandledRejection', 'a plain string', Promise.resolve());
      expect(logged[1].data).toEqual({ message: 'a plain string' });
    } finally { remove(); }
  });

  it('an uncaught exception is logged, then the daemon exits', () => {
    const logged: string[] = [];
    const exits: number[] = [];
    const remove = installCrashGuards({ error: (msg) => logged.push(msg) }, { exit: (c) => exits.push(c) });
    try {
      (process.emit as (e: string, ...a: unknown[]) => boolean)('uncaughtException', new Error('corrupt state'), 'uncaughtException');
      expect(logged).toEqual(['uncaught exception (daemon exiting)']);
      expect(exits).toEqual([1]);
    } finally { remove(); }
  });

  it('shutdown runs once when SIGTERM and SIGINT arrive together', async () => {
    let runs = 0;
    const stop = once(async () => { runs++; await new Promise((r) => setTimeout(r, 10)); return runs; });
    const [a, b] = await Promise.all([stop(), stop()]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
  });
});
