import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath as __f } from 'node:url';
const here = path.dirname(__f(import.meta.url));

export const FIXTURE = path.resolve(here, '../fixtures/sample-app');

export function tmpDir(prefix = 'atlas-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
export function sh(cwd: string, cmd: string, args: string[]) {
  try { return execFileSync(cmd, args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).trim().slice(0, 600)}`); }
}

/** A fresh git repository containing the sample project, committed once. */
export function sampleRepo(): string {
  const dir = path.join(tmpDir(), 'sample-app');
  cpSync(FIXTURE, dir, { recursive: true });
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'initial']);
  return dir;
}

export function cleanup(dir: string) { rmSync(dir, { recursive: true, force: true }); }
