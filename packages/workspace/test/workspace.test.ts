import { describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { addWorktree, checkpoint, createWorktree, diffSince, inspectRepo, Leases, removeWorktree, resolveInside, retireWorktree } from '../src';
import { sampleRepo, sh, tmpDir } from '../../../tests/helpers';

describe('resolveInside', () => {
  const root = tmpDir();
  const outside = tmpDir();
  writeFileSync(path.join(outside, 'secret.txt'), 'canary');
  mkdirSync(path.join(root, 'src'));
  symlinkSync(outside, path.join(root, 'escape'));
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'src', 'link.txt'));

  it('accepts normal relative paths', () => {
    expect(resolveInside(root, 'src/new.ts', { forWrite: true })).toBe(path.join(realpathSync.native(root), 'src', 'new.ts'));
  });
  it('rejects traversal, absolute paths and .git', () => {
    expect(() => resolveInside(root, '../x')).toThrow(/escapes/);
    expect(() => resolveInside(root, '/etc/passwd')).toThrow(/Absolute/);
    expect(() => resolveInside(root, '.git/config')).toThrow(/\.git/);
  });
  it('rejects symlink escapes for read and write', () => {
    expect(() => resolveInside(root, 'escape/secret.txt')).toThrow(/symlink/);
    expect(() => resolveInside(root, 'escape/new.txt', { forWrite: true })).toThrow(/symlink/);
    expect(() => resolveInside(root, 'src/link.txt')).toThrow(/outside/);
  });
});

describe('worktrees', () => {
  it('isolates changes from the user checkout and checkpoints them', async () => {
    const repo = sampleRepo();
    writeFileSync(path.join(repo, 'README.md'), 'user edit in progress\n'); // dirty user checkout
    const info = await inspectRepo(repo);
    expect(info).toMatchObject({ isGit: true, dirty: 1 });
    const wt = path.join(tmpDir(), 'wt');
    await createWorktree(repo, wt, 'atlas/test', info.head!);
    expect(readFileSync(path.join(wt, 'README.md'), 'utf8')).not.toContain('user edit');
    writeFileSync(path.join(wt, 'src', 'slugify.js'), 'export const slugify = (s) => s;\n');
    const sha = await checkpoint(wt, 'test');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const d = await diffSince(wt, info.head!);
    expect(d.files).toEqual([{ path: 'src/slugify.js', add: 1, del: 5 }]);
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('user edit in progress\n');
    expect(sh(repo, 'git', ['rev-parse', 'HEAD'])).toBe(info.head);
    await removeWorktree(repo, wt, 'atlas/test');
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, 'git', ['branch', '--list', 'atlas/test'])).toBe('');
  });
  it('parallel worktrees from one checkpoint are all created; a taken branch is refused and kept', async () => {
    const repo = sampleRepo();
    const head = (await inspectRepo(repo)).head!;
    const parent = tmpDir();
    const keys = ['review', 'security', 'tester', 'browser', 'docs', 'perf'];
    await Promise.all(keys.map((k) => addWorktree(repo, path.join(parent, k), `atlas/m1/${k}-1`, head)));
    for (const k of keys) expect(sh(path.join(parent, k), 'git', ['rev-parse', 'HEAD'])).toBe(head);
    // The user's (or another mission's) branch is never retried over or deleted.
    await expect(addWorktree(repo, path.join(parent, 'again'), 'atlas/m1/review-1', head)).rejects.toThrow(/already exists/);
    expect(sh(repo, 'git', ['branch', '--list', 'atlas/m1/review-1'])).toContain('atlas/m1/review-1');
    expect(existsSync(path.join(parent, 'again'))).toBe(false);
  });
  it('a worktree add that keeps failing is undone after its retries: no branch, no directory', async () => {
    const repo = sampleRepo();
    const wt = path.join(tmpDir(), 'wt');
    await expect(addWorktree(repo, wt, 'atlas/bad', 'f'.repeat(40), 2)).rejects.toThrow(/git worktree failed/);
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, 'git', ['branch', '--list', 'atlas/bad'])).toBe('');
    // The lock is released: the next add on the repository proceeds.
    await addWorktree(repo, wt, 'atlas/good', (await inspectRepo(repo)).head!);
    expect(existsSync(path.join(wt, 'README.md'))).toBe(true);
  });
  it('checkpoint returns null when nothing changed', async () => {
    const repo = sampleRepo();
    const info = await inspectRepo(repo);
    const wt = path.join(tmpDir(), 'wt');
    await createWorktree(repo, wt, 'atlas/noop', info.head!);
    expect(await checkpoint(wt, 'noop')).toBeNull();
  });
  it('leases allow one writer per checkout', () => {
    const l = new Leases();
    expect(l.acquire('/x', 'a')).toBe(true);
    expect(l.acquire('/x', 'b')).toBe(false);
    l.release('/x', 'a');
    expect(l.acquire('/x', 'b')).toBe(true);
  });
  it('reports non-git directories', async () => {
    expect((await inspectRepo(tmpDir())).isGit).toBe(false);
  });
});

describe('resolveInside: cross-platform forms', () => {
  const root = tmpDir();
  it('refuses drive-qualified, UNC and case-variant .git paths', () => {
    expect(() => resolveInside(root, 'C:\\Windows\\win.ini')).toThrow(/Absolute/);
    expect(() => resolveInside(root, 'C:relative.txt')).toThrow(/Absolute/);
    expect(() => resolveInside(root, '\\\\server\\share\\x')).toThrow(/Absolute|escapes/);
    if (process.platform === 'win32' || process.platform === 'darwin') expect(() => resolveInside(root, '.GIT/config')).toThrow(/\.git/);
  });
  it.skipIf(process.platform !== 'win32')('refuses reserved device names and alternate data streams on Windows', () => {
    for (const p of ['CON', 'nul.txt', 'src/aux', 'COM1', 'file.txt:secret']) expect(() => resolveInside(root, p), p).toThrow(/Reserved/);
  });
});

describe('retireWorktree keeps what it cannot preserve (P1-3 review findings 1-3)', () => {
  async function wt() {
    const repo = sampleRepo();
    const dir = path.join(tmpDir(), 'wt');
    await createWorktree(repo, dir, 'atlas/t/w', 'HEAD');
    writeFileSync(path.join(dir, 'work.txt'), 'precious');
    return { repo, dir };
  }

  // On Windows `GIT~1` is the 8.3 name of the worktree's own .git file, so the directory cannot be created there.
  it.skipIf(process.platform === 'win32')('a path git refuses to snapshot: the worktree and branch stay, nothing is lost', async () => {
    const { repo, dir } = await wt();
    mkdirSync(path.join(dir, 'GIT~1'));
    writeFileSync(path.join(dir, 'GIT~1', 'x'), 'x'); // rejected by core.protectNTFS
    const r = await retireWorktree(repo, dir, 'atlas/t/w', 'refs/atlas/preserved/t/w');
    expect(r.retained).toMatch(/could not be snapshotted/);
    expect(readFileSync(path.join(dir, 'work.txt'), 'utf8')).toBe('precious');
    expect(sh(repo, 'git', ['branch', '--list', 'atlas/t/w'])).toContain('atlas/t/w');
  });

  it('a nested repository (agent ran git init): kept, because a gitlink would lose its files', async () => {
    const { repo, dir } = await wt();
    mkdirSync(path.join(dir, 'sub'));
    sh(path.join(dir, 'sub'), 'git', ['init', '-q']);
    writeFileSync(path.join(dir, 'sub', 'g'), 'nested work');
    sh(path.join(dir, 'sub'), 'git', ['add', 'g']);
    sh(path.join(dir, 'sub'), 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'n']);
    const r = await retireWorktree(repo, dir, 'atlas/t/w', 'refs/atlas/preserved/t/w');
    expect(r.retained).toMatch(/nested repository.*sub/);
    expect(existsSync(path.join(dir, 'sub', 'g'))).toBe(true);
  });

  it('a normal dirty worktree is preserved and removed, and the user\'s other worktrees are untouched', async () => {
    const { repo, dir } = await wt();
    const mine = path.join(tmpDir(), 'mine');
    sh(repo, 'git', ['worktree', 'add', '-q', '-b', 'user-branch', mine, 'HEAD']);
    const moved = `${mine}-moved`;
    sh(tmpDir(), 'mv', [mine, moved]); // e.g. an unmounted drive: `git worktree prune` would drop its metadata
    const r = await retireWorktree(repo, dir, 'atlas/t/w', 'refs/atlas/preserved/t/w');
    expect(r.retained).toBeNull();
    expect(r.refs.map((x) => x.what).sort()).toEqual(['branch', 'uncommitted']);
    expect(sh(repo, 'git', ['show', 'refs/atlas/preserved/t/w/uncommitted:work.txt'])).toBe('precious');
    expect(existsSync(dir)).toBe(false);
    // git prints long, forward-slash paths; the temp dir may be an 8.3 path on Windows.
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    expect(norm(sh(repo, 'git', ['worktree', 'list', '--porcelain']))).toContain(norm(path.join(realpathSync.native(path.dirname(mine)), path.basename(mine))));
  });
});
