// Canonical path checks (manual §18). Every file operation resolves through here; symlinks may not escape a root.
import { realpathSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { AtlasError } from '@atlas/contracts';

// Windows and macOS file systems are case-insensitive by default: compare paths without case there.
const fold = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
const within = (root: string, p: string) => { const r = fold(root), q = fold(p); return q === r || q.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
// Native realpath expands Windows 8.3 short names (RUNNER~1) so the same directory always compares equal.
const realpath = (p: string) => realpathSync.native(p);
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Resolve `rel` inside `root`, following symlinks, and refuse anything that lands outside. */
export function resolveInside(root: string, rel: string, opts: { forWrite?: boolean } = {}): string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 4096 || rel.includes('\0')) throw new AtlasError('policy_deny', 'Invalid path');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) throw new AtlasError('policy_deny', 'Absolute paths are not allowed; use a path relative to the workspace');
  if (process.platform === 'win32' && rel.split(/[\\/]/).some((seg) => WIN_RESERVED.test(seg) || seg.includes(':'))) throw new AtlasError('policy_deny', `Reserved Windows name or stream in path: ${rel}`);
  const realRoot = realpath(root);
  const target = path.resolve(realRoot, rel);
  if (!within(realRoot, target)) throw new AtlasError('policy_deny', `Path escapes the workspace: ${rel}`);
  const rel2 = path.relative(realRoot, target);
  if (fold(rel2.split(path.sep)[0]) === '.git') throw new AtlasError('policy_deny', 'The .git directory is managed by ATLAS, not by agents');

  // Walk up to the nearest existing ancestor and make sure its real location is still inside.
  let probe = target;
  while (!existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const realProbe = realpath(probe);
  if (!within(realRoot, realProbe)) throw new AtlasError('policy_deny', `Path resolves outside the workspace through a symlink: ${rel}`);
  if (existsSync(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      const real = realpath(target);
      if (!within(realRoot, real)) throw new AtlasError('policy_deny', `Symlink points outside the workspace: ${rel}`);
      if (opts.forWrite) throw new AtlasError('policy_deny', `Refusing to write through a symlink: ${rel}`);
    }
  }
  return target;
}
