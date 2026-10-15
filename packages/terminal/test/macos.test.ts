import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src';
import { sampleRepo, cleanup } from '../../../tests/helpers';

describe.skipIf(process.platform !== 'darwin')('macOS Seatbelt', () => {
  it('runs npm installed under home while denying a home credential canary', async () => {
    const repo = sampleRepo();
    const dir = mkdtempSync(path.join(os.homedir(), '.atlas-canary-'));
    const canary = path.join(dir, 'secret');
    writeFileSync(canary, 'PRIVATE-CANARY');
    const sandbox = { root: repo, writable: true, network: false };
    try {
      const test = await run({ command: 'npm', args: ['test'], cwd: repo, timeoutMs: 30_000, sandbox });
      expect(test.output).toMatch(/fail 5/);
      expect(test.exitCode).toBe(1); // Fixture bug, not a sandbox/startup error.
      const denied = await run({ command: 'cat', args: [canary], cwd: repo, timeoutMs: 5000, sandbox });
      expect(denied.exitCode).not.toBe(0);
      expect(denied.output).not.toContain('PRIVATE-CANARY');
      const write = await run({ command: 'touch', args: [path.join(dir, 'escaped')], cwd: repo, timeoutMs: 5000, sandbox });
      expect(write.exitCode).not.toBe(0);
    } finally { cleanup(repo); rmSync(dir, { recursive: true, force: true }); }
  });
});
