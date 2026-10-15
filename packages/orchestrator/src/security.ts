// The security engineer's deterministic scan (ADR 0023) over a worktree's change against the mission base:
// committed and uncommitted edits plus untracked files, and the whole before/after of manifests and CI workflows.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { git } from '@atlas/workspace';
import { scanChange, WHOLE_FILE, type FileChange, type SecurityHit } from '@atlas/security';

const MAX = 1024 * 1024;
const readText = (p: string) => { try { if (!existsSync(p) || statSync(p).size > MAX) return null; const s = readFileSync(p, 'utf8'); return s.includes('\u0000') ? null : s; } catch { return null; } };

export async function scanWorktree(cwd: string, base: string): Promise<SecurityHit[]> {
  let diff = (await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-renames', base])).out;
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).out.split('\n').filter(Boolean).slice(0, 500);
  for (const f of untracked) {
    const text = readText(path.join(cwd, f));
    const lines = text === null ? [] : text.split('\n');
    diff += `\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
  }
  const changed = (await git(cwd, ['diff', '--name-only', '--no-renames', base])).out.split('\n').filter(Boolean);
  const files: FileChange[] = [];
  for (const f of [...new Set([...changed, ...untracked])].filter((x) => WHOLE_FILE.test(x))) {
    const before = await git(cwd, ['show', `${base}:${f}`]);
    files.push({ path: f, before: before.code === 0 ? before.out : null, after: readText(path.join(cwd, f)) });
  }
  return scanChange(diff, files);
}
