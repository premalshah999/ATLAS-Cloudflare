// Daemon-owned git metadata (ADR 0031): ATLAS's own git calls on an agent-writable worktree never discover the
// repository through the worktree's `.git` pointer and never select a filter, textconv or diff driver. Every negative
// test plants a program that would leave a mark if it ran, and checks the mark never appears.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  attributeDrivers, checkpoint, createWorktree, diffSince, forceGitVersionForTests, forgetWorktree, git, gitHardening, gitOk, manageWorktrees,
  onWorktreeTampered, preserveTampered, registeredPin, removeWorktree, retireWorktree, WorktreeTampered,
} from '../src';
import { sampleRepo, sh, tmpDir } from '../../../tests/helpers';

const reports: WorktreeTampered[] = [];
onWorktreeTampered((e) => reports.push(e));
const reportFor = (wt: string) => reports.filter((e) => e.worktree === realpathSync.native(wt)).at(-1);

let n = 0;
async function worktree(repo = sampleRepo()) {
  const wt = path.join(tmpDir(), 'wt');
  const branch = `atlas/t/w${++n}`;
  await createWorktree(repo, wt, branch, 'HEAD');
  return { repo, wt, branch, admin: registeredPin(wt)!.adminDir, base: sh(repo, 'git', ['rev-parse', 'HEAD']) };
}
const mark = (name = 'PWNED') => path.join(tmpDir('atlas-marks-'), name);
const blob = (repo: string, spec: string) => execFileSync('git', ['cat-file', 'blob', spec], { cwd: repo });
/** Controls: git exactly as ATLAS ran it before ADR 0031 (discovery through `.git`, these flags, no system config). */
const unpinned = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'protocol.file.allow=user', ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'ATLAS', GIT_AUTHOR_EMAIL: 'a@l', GIT_COMMITTER_NAME: 'ATLAS', GIT_COMMITTER_EMAIL: 'a@l' },
});

/** A worktree whose `.git` pointer the agent replaced with one to a git dir it planted, with a filter that leaves a mark. */
async function plantedGitdir() {
  const repo = sampleRepo();
  const wt = path.join(tmpDir(), 'wt');
  await createWorktree(repo, wt, 'atlas/t/planted', 'HEAD');
  const marks = tmpDir('atlas-pwned-');
  const pwned = path.join(marks, 'PWNED');
  const evil = path.join(wt, 'evil');
  mkdirSync(evil);
  cpSync(path.join(repo, '.git', 'objects'), path.join(evil, 'objects'), { recursive: true });
  cpSync(path.join(repo, '.git', 'refs'), path.join(evil, 'refs'), { recursive: true });
  writeFileSync(path.join(evil, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[filter "x"]\n\tclean = touch ${pwned}\n`);
  writeFileSync(path.join(wt, '.git'), `gitdir: ${evil}`);
  writeFileSync(path.join(wt, '.gitattributes'), '* filter=x\n');
  writeFileSync(path.join(wt, 'README.md'), 'agent edit\n');
  return { repo, wt, pwned };
}

describe('planted git metadata (the PWNED_CLEAN escape)', () => {
  it('checkpoint fails closed on a redirected .git pointer and never runs the planted filter', async () => {
    const { repo, wt, pwned } = await plantedGitdir();
    const before = sh(repo, 'git', ['rev-parse', 'atlas/t/planted']);
    const r = await checkpoint(wt, 'checkpoint').then((sha) => `committed ${sha}`, (e: Error) => e);
    expect(existsSync(pwned), 'the planted clean filter ran as the operator').toBe(false);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/tampered/i);
    expect(r).toBeInstanceOf(WorktreeTampered);
    expect((r as WorktreeTampered).kind).toBe('workspace_conflict');
    expect(reportFor(wt)?.field).toBe('pointer');
    // Nothing was committed anywhere: not on the task branch, not in the planted repository.
    expect(sh(repo, 'git', ['rev-parse', 'atlas/t/planted'])).toBe(before);
    expect(existsSync(path.join(wt, 'evil', 'index'))).toBe(false);
  });

  it('every ATLAS git call in the worktree is refused, not only checkpoint (status, diff, rev-parse)', async () => {
    const { wt, pwned } = await plantedGitdir();
    for (const args of [['status', '--short'], ['diff', '--stat'], ['rev-parse', 'HEAD']]) await expect(git(wt, args), args.join(' ')).rejects.toBeInstanceOf(WorktreeTampered);
    await expect(diffSince(wt, 'HEAD')).rejects.toBeInstanceOf(WorktreeTampered);
    await expect(gitOk(path.join(wt, 'src'), ['status'])).rejects.toBeInstanceOf(WorktreeTampered);
    expect(existsSync(pwned)).toBe(false);
  });

  it('a config.worktree planted in the admin dir is refused, and its filter never runs', async () => {
    const repo = sampleRepo();
    sh(repo, 'git', ['config', 'extensions.worktreeConfig', 'true']); // what `git sparse-checkout` turns on
    const { wt, admin } = await worktree(repo);
    const pwned = mark();
    writeFileSync(path.join(admin, 'config.worktree'), `[filter "x"]\n\tclean = touch ${pwned}\n`);
    writeFileSync(path.join(wt, '.gitattributes'), '* filter=x\n');
    writeFileSync(path.join(wt, 'README.md'), 'agent edit\n');
    await expect(checkpoint(wt, 'c')).rejects.toBeInstanceOf(WorktreeTampered);
    expect(reportFor(wt)?.field).toBe('config.worktree');
    expect(existsSync(pwned)).toBe(false);
  });

  it('a commondir redirected to a planted repository is refused', async () => {
    const { wt, admin } = await worktree();
    const pwned = mark();
    const evil = path.join(wt, 'evilcommon');
    mkdirSync(path.join(evil, 'objects'), { recursive: true });
    mkdirSync(path.join(evil, 'refs'));
    writeFileSync(path.join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n[filter "x"]\n\tclean = touch ${pwned}\n`);
    writeFileSync(path.join(admin, 'commondir'), `${evil}\n`);
    writeFileSync(path.join(wt, '.gitattributes'), '* filter=x\n');
    await expect(checkpoint(wt, 'c')).rejects.toBeInstanceOf(WorktreeTampered);
    expect(reportFor(wt)?.field).toBe('commondir');
    expect(existsSync(pwned)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('a symlinked .git pointer is refused, even when the file it names is correct', async () => {
    const { wt } = await worktree();
    const elsewhere = path.join(tmpDir(), 'pointer');
    writeFileSync(elsewhere, readFileSync(path.join(wt, '.git')));
    rmSync(path.join(wt, '.git'));
    symlinkSync(elsewhere, path.join(wt, '.git'));
    writeFileSync(path.join(wt, 'README.md'), 'agent edit\n');
    await expect(checkpoint(wt, 'c')).rejects.toThrow(/symbolic link/);
    expect(reportFor(wt)?.field).toBe('pointer');
  });

  it("HEAD redirected to the user's branch is refused: a checkpoint never moves that branch", async () => {
    const { repo, wt, admin } = await worktree();
    const main = sh(repo, 'git', ['rev-parse', 'main']);
    writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(wt, 'README.md'), 'agent edit\n');
    await expect(checkpoint(wt, 'c')).rejects.toBeInstanceOf(WorktreeTampered);
    expect(reportFor(wt)?.field).toBe('head');
    expect(sh(repo, 'git', ['rev-parse', 'main'])).toBe(main);
  });

  it('retiring a tampered worktree keeps it (directory, branch, planted files) for audit and runs nothing', async () => {
    const { repo, wt, pwned } = await plantedGitdir();
    const r = await retireWorktree(repo, wt, 'atlas/t/planted', 'refs/atlas/preserved/t/planted');
    expect(r.retained).toMatch(/tampered/);
    expect(r.refs).toEqual([]);
    expect(existsSync(path.join(wt, 'evil', 'config'))).toBe(true);
    expect(sh(repo, 'git', ['branch', '--list', 'atlas/t/planted'])).toContain('atlas/t/planted');
    expect(existsSync(pwned)).toBe(false);
    // The audit snapshot reads none of the tampered metadata: the repository's own git dir and a throwaway index.
    const sha = await preserveTampered(repo, wt, 'atlas/t/planted', 'refs/atlas/preserved/t/planted-tampered');
    expect(sh(repo, 'git', ['rev-parse', 'refs/atlas/preserved/t/planted-tampered'])).toBe(sha);
    expect(sh(repo, 'git', ['ls-tree', '-r', '--name-only', sha!]).split('\n')).toEqual(expect.arrayContaining(['README.md', '.gitattributes', 'evil/config']));
    expect(blob(repo, `${sha}:README.md`).toString()).toBe('agent edit\n');
    expect(existsSync(pwned)).toBe(false);
  });

  it("removeWorktree deletes the admin dir the repository names, never the one a rewritten pointer claims", async () => {
    const repo = sampleRepo();
    const a = await worktree(repo);
    const b = await worktree(repo);
    writeFileSync(path.join(a.wt, '.git'), `gitdir: ${b.admin}\n`);
    await removeWorktree(repo, a.wt, a.branch);
    expect(existsSync(a.admin)).toBe(false);
    expect(existsSync(b.admin)).toBe(true);
    writeFileSync(path.join(b.wt, 'README.md'), 'b still works\n');
    expect(await checkpoint(b.wt, 'b')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('in-tree attributes select no driver', () => {
  it('reports the git version and the active mode', async () => {
    const h = await gitHardening();
    const [major, minor] = h.version.split('.').map(Number);
    expect(h.version).toMatch(/^\d+\.\d+/);
    // GIT_ATTR_SOURCE is probed, not assumed; every git from 2.42 on honours it.
    if (major > 2 || (major === 2 && minor >= 42)) expect(h.mode).toBe('attr-source');
  });

  it("a normal checkpoint records exactly the agent's bytes, as before", async () => {
    const { repo, wt, base, branch } = await worktree();
    writeFileSync(path.join(wt, 'src', 'slugify.js'), 'export const slugify = (s) => s;\n');
    writeFileSync(path.join(wt, 'NEW.md'), 'new file\n');
    const sha = await checkpoint(wt, 'c');
    expect(sha).toBe(sh(repo, 'git', ['rev-parse', branch]));
    expect(blob(repo, `${sha}:src/slugify.js`).toString()).toBe('export const slugify = (s) => s;\n');
    expect((await diffSince(wt, base)).files).toEqual([{ path: 'NEW.md', add: 1, del: 0 }, { path: 'src/slugify.js', add: 1, del: 5 }]);
    expect(await checkpoint(wt, 'again')).toBeNull();
  });

  it("a filter defined in the repository's config and selected by the agent's .gitattributes never runs", async () => {
    const repo = sampleRepo();
    const pwned = mark();
    sh(repo, 'git', ['config', 'filter.x.clean', `touch ${pwned}`]);
    const { wt } = await worktree(repo);
    writeFileSync(path.join(wt, '.gitattributes'), '* filter=x\n');
    writeFileSync(path.join(wt, 'src', 'slugify.js'), 'export const slugify = (s) => s;\n');
    const sha = await checkpoint(wt, 'c');
    expect(blob(repo, `${sha}:src/slugify.js`).toString()).toBe('export const slugify = (s) => s;\n');
    writeFileSync(path.join(wt, 'src', 'slugify.js'), 'export const slugify = (s) => s + 1;\n');
    expect((await git(wt, ['status', '--short'])).out).toContain('src/slugify.js');
    await git(wt, ['diff', '--stat']);
    expect(existsSync(pwned)).toBe(false);
    // Control: git as ATLAS ran it before ADR 0031 does run it.
    unpinned(wt, ['add', '-A']);
    expect(existsSync(pwned)).toBe(true);
  });

  it('diffs never run a textconv or an external diff driver', async () => {
    const repo = sampleRepo();
    const textconv = mark('TEXTCONV'), external = mark('EXTERNAL');
    sh(repo, 'git', ['config', 'diff.x.textconv', `touch ${textconv}; cat`]);
    sh(repo, 'git', ['config', 'diff.x.command', `touch ${external}`]);
    const { wt, base } = await worktree(repo);
    writeFileSync(path.join(wt, '.gitattributes'), '*.js diff=x\n');
    writeFileSync(path.join(wt, 'src', 'slugify.js'), 'export const slugify = (s) => s;\n');
    await checkpoint(wt, 'c');
    const d = await diffSince(wt, base);
    expect(d.patch).toContain('+export const slugify = (s) => s;');
    writeFileSync(path.join(wt, 'src', 'slugify.js'), 'export const slugify = (s) => s.trim();\n');
    // The worktree diffs ToolGate, context and the security scan run go through the same pinned git().
    for (const args of [['diff', base], ['diff', '--stat', base], ['diff', '--ext-diff', '--textconv', base]]) expect((await git(wt, args)).out, args.join(' ')).toContain('slugify');
    expect(existsSync(textconv)).toBe(false);
    expect(existsSync(external)).toBe(false);
  });

  it('a repository whose .gitattributes uses an lfs filter still checkpoints the worktree bytes', async () => {
    const repo = sampleRepo();
    writeFileSync(path.join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(path.join(repo, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
    sh(repo, 'git', ['add', '-A']);
    sh(repo, 'git', ['commit', '-qm', 'asset']);
    // git-lfs is configured but missing: its required clean filter fails whenever git selects it.
    sh(repo, 'git', ['config', 'filter.lfs.clean', 'false']);
    sh(repo, 'git', ['config', 'filter.lfs.smudge', 'cat']);
    sh(repo, 'git', ['config', 'filter.lfs.required', 'true']);
    const { wt } = await worktree(repo);
    const bytes = Buffer.from([9, 8, 7, 0, 255, 10]);
    writeFileSync(path.join(wt, 'asset.bin'), bytes);
    expect(() => unpinned(wt, ['add', '-A']), 'control: git as ATLAS ran it before selects the lfs filter').toThrow(/lfs/);
    const sha = await checkpoint(wt, 'c');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(blob(repo, `${sha}:asset.bin`).equals(bytes)).toBe(true);
  });

  it("a nested repository's own filter never runs in checkpoint, status or diff", async () => {
    const { repo, wt, base } = await worktree();
    const nested = path.join(wt, 'vendor', 'lib');
    mkdirSync(nested, { recursive: true });
    sh(nested, 'git', ['init', '-q']);
    writeFileSync(path.join(nested, 'f.txt'), 'x\n');
    sh(nested, 'git', ['add', '-A']);
    sh(nested, 'git', ['commit', '-qm', 'n']);
    await checkpoint(wt, 'records the gitlink');
    const pwned = mark();
    sh(nested, 'git', ['config', 'filter.z.clean', `touch ${pwned}`]);
    mkdirSync(path.join(nested, '.git', 'info'), { recursive: true });
    writeFileSync(path.join(nested, '.git', 'info', 'attributes'), '* filter=z\n');
    // Same size, new mtime: git must read the file again, through any filter that applies.
    let k = 0;
    const restat = () => { const t = new Date(Date.now() + 5000 * ++k); utimesSync(path.join(nested, 'f.txt'), t, t); };
    restat();
    writeFileSync(path.join(wt, 'README.md'), 'edit\n');
    const sha = await checkpoint(wt, 'second');
    expect(blob(repo, `${sha}:README.md`).toString()).toBe('edit\n');
    restat();
    expect((await git(wt, ['status', '--short'])).code).toBe(0);
    restat();
    expect((await git(wt, ['diff', '--stat', base])).code).toBe(0);
    expect(existsSync(pwned)).toBe(false);
    // Control: `git status` as ATLAS ran it before starts git inside the nested repository, which runs it.
    restat();
    unpinned(wt, ['status', '--short']);
    expect(existsSync(pwned)).toBe(true);
  });
});

describe('after a daemon restart (pins are rebuilt from the repository side)', () => {
  it('a managed worktree is pinned again from the record git wrote, and tampering is still refused', async () => {
    const repo = sampleRepo();
    const root = tmpDir('atlas-wts-');
    const wt = path.join(root, 'msn_1', 'implement-1');
    await createWorktree(repo, wt, 'atlas/msn_1/implement-1', 'HEAD');
    const stop = manageWorktrees(root, (w) => (path.basename(path.dirname(w)) === 'msn_1' ? repo : null));
    try {
      forgetWorktree(wt);
      expect(registeredPin(wt)).toBeNull();
      writeFileSync(path.join(wt, 'README.md'), 'after restart\n');
      expect(await checkpoint(wt, 'c')).toMatch(/^[0-9a-f]{40}$/);
      expect(registeredPin(wt)?.head).toBe('ref: refs/heads/atlas/msn_1/implement-1');
      const admin = registeredPin(wt)!.adminDir;
      forgetWorktree(wt);
      writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/main\n');
      await expect(git(wt, ['status'])).rejects.toBeInstanceOf(WorktreeTampered);
      expect(reportFor(wt)?.field).toBe('head');
      // A directory under the root that no mission owns is refused, never discovered.
      mkdirSync(path.join(root, 'msn_2', 'x'), { recursive: true });
      await expect(git(path.join(root, 'msn_2', 'x'), ['status'])).rejects.toThrow(/no record/);
      await expect(git(path.join(root, 'msn_1'), ['status'])).rejects.toThrow(/only inside a worktree/);
    } finally { stop(); }
  });
});

describe('before git 2.40 (git version mocked at 2.39)', () => {
  beforeAll(() => forceGitVersionForTests('git version 2.39.5 (Apple Git-154)'));
  afterAll(() => forceGitVersionForTests(null));

  it('reports the fallback mode', async () => {
    expect(await gitHardening()).toMatchObject({ version: '2.39.5', mode: 'neutralize-drivers' });
  });

  it('still neutralizes every driver the tree selects: filters, textconv, macros and nested .gitattributes', async () => {
    const repo = sampleRepo();
    const marks = { x: mark('X'), m: mark('MACRO'), sub: mark('SUB'), tc: mark('TEXTCONV') };
    sh(repo, 'git', ['config', 'filter.x.clean', `touch ${marks.x}`]);
    sh(repo, 'git', ['config', 'filter.m.clean', `touch ${marks.m}`]);
    sh(repo, 'git', ['config', 'filter.sub.clean', `touch ${marks.sub}`]);
    sh(repo, 'git', ['config', 'diff.x.textconv', `touch ${marks.tc}; cat`]);
    const { wt, base } = await worktree(repo);
    writeFileSync(path.join(wt, '.gitattributes'), '# drivers\n[attr]evil filter=m\n*.js filter=x diff=x\n*.md evil\n');
    writeFileSync(path.join(wt, 'src', '.gitattributes'), '*.js filter=sub\n');
    writeFileSync(path.join(wt, 'src', 'slugify.js'), 'export const slugify = (s) => s;\n');
    writeFileSync(path.join(wt, 'README.md'), 'readme\n');
    const sha = await checkpoint(wt, 'c');
    expect(blob(repo, `${sha}:src/slugify.js`).toString()).toBe('export const slugify = (s) => s;\n');
    expect((await diffSince(wt, base)).patch).toContain('+export const slugify = (s) => s;');
    writeFileSync(path.join(wt, 'src', 'slugify.js'), 'export const slugify = (s) => s.trim();\n');
    await git(wt, ['status', '--short']);
    await git(wt, ['diff', base]);
    for (const [k, f] of Object.entries(marks)) expect(existsSync(f), k).toBe(false);
    // Control: without the neutralizing flags the same tree selects them.
    unpinned(wt, ['add', '-A']);
    expect(existsSync(marks.sub)).toBe(true);
  });

  it('a driver name that cannot be neutralized on the command line fails closed', async () => {
    const repo = sampleRepo();
    const { wt } = await worktree(repo);
    writeFileSync(path.join(wt, '.gitattributes'), '* filter=a=b\n');
    writeFileSync(path.join(wt, 'README.md'), 'edit\n');
    await expect(checkpoint(wt, 'c')).rejects.toThrow(/cannot be neutralized/);
  });
});

describe('attributeDrivers', () => {
  it('reads filter and diff driver names as text, macros included, comments skipped', () => {
    expect(attributeDrivers('# filter=commented\n[attr]evil filter=m diff=n\n*.bin filter=lfs diff=lfs merge=lfs -text\n"a b" diff=q\n*.x -diff !filter\n').sort())
      .toEqual(['lfs', 'm', 'n', 'q']);
  });
});
