// Daemon-owned git metadata (ADR 0031).
//
// An agent can write its worktree. ATLAS used to run git there the way a user would: git found the repository through
// the worktree's `.git` pointer file and read whatever configuration and attributes it found. A shell_exec could
// repoint `.git` at a git dir it planted, or plant a filter driver together with a .gitattributes, and the daemon's next
// `git add -A` ran the agent's program as the operator. Now every ATLAS git call on a worktree it created:
//   - names the admin and work directories explicitly (--git-dir, --work-tree, GIT_COMMON_DIR), so the pointer file is
//     never followed, and first verifies the metadata ATLAS owns (verifyWorktreeMetadata), failing closed on a mismatch;
//   - reads no global or system configuration, and lets no in-tree attribute select a driver (GIT_ATTR_SOURCE = the
//     empty tree on git ≥ 2.40; before that, every driver name the tree or the configuration mentions is neutralized);
//   - never runs an external diff or textconv program, and never starts git inside a nested repository.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtlasError } from '@atlas/contracts';
import { BASE_FLAGS, spawnGit, type GitResult } from './exec';

/** The empty tree. As GIT_ATTR_SOURCE it makes git read no .gitattributes from the work tree or the index. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Flags of every pinned call, after BASE_FLAGS. (`-c include.path=` from the design is not here: git rejects it.) */
const PINNED_FLAGS = [
  '-c', 'core.attributesFile=/dev/null', '-c', 'core.pager=cat', '-c', 'core.sshCommand=false',
  // A nested repository (an agent's `git init`) has its own config and info/attributes, which a `git status` started
  // inside it would honour. Nothing ATLAS runs looks inside one.
  '-c', 'diff.ignoreSubmodules=dirty', '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false',
];

const RECORD = 'atlas-pin.json';
const MAX_LISTING = 256 * 1024 * 1024;

export type TamperField = 'admin' | 'pointer' | 'gitdir' | 'commondir' | 'config.worktree' | 'head';

/** Git metadata of a worktree no longer matches what ATLAS created. Never retryable: the attempt fails. */
export class WorktreeTampered extends AtlasError {
  constructor(readonly worktree: string, readonly field: TamperField, readonly detail: string) {
    super('workspace_conflict', `The worktree's git metadata was tampered with (${field}: ${detail}). ATLAS runs no git there; the worktree is kept for audit.`);
  }
}

export interface WorktreePin {
  /** The worktree root (real path). */
  worktree: string;
  /** Its admin directory, `<commonDir>/worktrees/<id>` (real path). Read-only to the sandbox. */
  adminDir: string;
  /** The repository's common git directory (real path). */
  commonDir: string;
  /** sha256 of config.worktree as `git worktree add` wrote it for ATLAS; null: there must be none. */
  configWorktree: string | null;
  /** HEAD as ATLAS created it (`ref: refs/heads/atlas/…`); null when unknown. */
  head: string | null;
}

/* ---------------- paths ---------------- */

// Windows and macOS file systems are case-insensitive by default.
const fold = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
const real = (p: string) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
/** Real path of the parent, then the last component as written: a symlink at the end is not followed. */
const lexReal = (p: string) => path.join(real(path.dirname(path.resolve(p))), path.basename(path.resolve(p)));
const sameReal = (a: string, b: string) => fold(real(a)) === fold(real(b));
const sameLex = (a: string, b: string) => fold(lexReal(a)) === fold(lexReal(b));
const within = (root: string, p: string) => { const r = fold(root), q = fold(p); return q === r || q.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };

function readSmall(f: string, max = 64 * 1024): string | null {
  try {
    const st = lstatSync(f);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(f, 'utf8');
  } catch { return null; }
}

const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

/* ---------------- tamper reports ---------------- */

const listeners = new Set<(e: WorktreeTampered) => void>();

/** Called for every refused call on tampered metadata (the orchestrator records `workspace.tampered`). */
export function onWorktreeTampered(fn: (e: WorktreeTampered) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function tampered(worktree: string, field: TamperField, detail: string): never {
  const e = new WorktreeTampered(worktree, field, detail);
  for (const fn of listeners) { try { fn(e); } catch { /* a listener never changes the outcome */ } }
  throw e;
}

/* ---------------- verification ---------------- */

/**
 * The metadata ATLAS owns must be exactly what it created: `<worktree>/.git` is a regular file (not a symlink) that
 * says `gitdir: <adminDir>`, the admin dir's `gitdir` points back to it, its `commondir` resolves to the repository's
 * common dir, `config.worktree` exists only as git wrote it when ATLAS added the worktree, and HEAD is the branch ATLAS
 * created. Anything else throws WorktreeTampered (kind workspace_conflict) and is reported to the listeners.
 */
export function verifyWorktreeMetadata(worktree: string, adminDir: string, expected: Partial<Pick<WorktreePin, 'commonDir' | 'configWorktree' | 'head'>> = {}): void {
  if (!existsSync(worktree)) throw new AtlasError('workspace_conflict', `The worktree ${worktree} no longer exists`);
  let admin: Stats;
  try { admin = lstatSync(adminDir); } catch { tampered(worktree, 'admin', `its admin directory ${adminDir} is missing`); }
  if (admin.isSymbolicLink() || !admin.isDirectory()) tampered(worktree, 'admin', `${adminDir} is not a directory`);
  const commonDir = expected.commonDir ?? path.dirname(path.dirname(adminDir));
  if (path.basename(path.dirname(adminDir)) !== 'worktrees' || !sameReal(path.dirname(path.dirname(adminDir)), commonDir)) tampered(worktree, 'admin', `${adminDir} is not in the repository's worktrees directory`);

  const pointer = path.join(worktree, '.git');
  let st: Stats;
  try { st = lstatSync(pointer); } catch { tampered(worktree, 'pointer', '.git is missing'); }
  if (st.isSymbolicLink()) tampered(worktree, 'pointer', '.git is a symbolic link');
  if (!st.isFile()) tampered(worktree, 'pointer', '.git is not a regular file');
  const m = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readSmall(pointer, 4096) ?? '');
  if (!m || !sameLex(path.resolve(worktree, m[1]), adminDir)) tampered(worktree, 'pointer', `.git does not say gitdir: ${adminDir}`);

  const back = readSmall(path.join(adminDir, 'gitdir'), 4096);
  if (back === null || !sameLex(path.resolve(adminDir, back.trim()), pointer)) tampered(worktree, 'gitdir', `${path.join(adminDir, 'gitdir')} does not point back to ${pointer}`);
  const common = readSmall(path.join(adminDir, 'commondir'), 4096);
  if (common === null || !sameReal(path.resolve(adminDir, common.trim()), commonDir)) tampered(worktree, 'commondir', `${path.join(adminDir, 'commondir')} does not resolve to ${commonDir}`);

  const cw = path.join(adminDir, 'config.worktree');
  let cwExists = false;
  try { lstatSync(cw); cwExists = true; } catch { /* absent */ }
  if (cwExists && (!expected.configWorktree || readSmall(cw, 1024 * 1024) === null || sha256(cw) !== expected.configWorktree)) tampered(worktree, 'config.worktree', `${cw} was not written by ATLAS`);

  if (expected.head != null && readSmall(path.join(adminDir, 'HEAD'), 4096)?.trim() !== expected.head) tampered(worktree, 'head', `HEAD is no longer ${expected.head}`);
}

/* ---------------- pins ---------------- */

const pins = new Map<string, WorktreePin>();
const keyOf = (p: string) => fold(lexReal(p));

/** The pin of the registered worktree containing `cwd`, if any. */
export function registeredPin(cwd: string): WorktreePin | null {
  if (!pins.size) return null;
  for (let d = fold(real(cwd)); ; d = path.dirname(d)) {
    const hit = pins.get(d);
    if (hit) return hit;
    if (path.dirname(d) === d) return null;
  }
}

export function forgetWorktree(worktree: string): void { pins.delete(keyOf(worktree)); }

async function commonDirOf(repoRoot: string): Promise<string> {
  const r = await spawnGit(repoRoot, [...BASE_FLAGS, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code !== 0 || !r.out.trim()) throw new AtlasError('workspace_conflict', `Not a git repository: ${repoRoot}`);
  return real(r.out.trim().split('\n').pop()!.trim());
}

/** Find the worktree's admin dir from the repository side (never from the worktree's own pointer file). */
function findAdminDir(commonDir: string, worktree: string): string {
  const pointer = path.join(worktree, '.git');
  const hits: string[] = [];
  let ids: string[] = [];
  try { ids = readdirSync(path.join(commonDir, 'worktrees')); } catch { /* no linked worktrees */ }
  for (const id of ids) {
    const admin = path.join(commonDir, 'worktrees', id);
    const target = readSmall(path.join(admin, 'gitdir'), 4096);
    if (target !== null && sameLex(path.resolve(admin, target.trim()), pointer)) hits.push(admin);
  }
  if (hits.length !== 1) tampered(worktree, 'gitdir', hits.length ? `${hits.length} admin directories claim it` : `the repository at ${commonDir} has no admin directory for it`);
  return real(hits[0]);
}

interface PinRecord { v: 1; head: string; configWorktree: string | null }

function readRecord(adminDir: string): PinRecord | null {
  try {
    const r = JSON.parse(readSmall(path.join(adminDir, RECORD), 4096) ?? '') as PinRecord;
    return r && r.v === 1 && typeof r.head === 'string' && (r.configWorktree === null || /^[0-9a-f]{64}$/.test(r.configWorktree)) ? r : null;
  } catch { return null; }
}

/**
 * Pin a worktree of `repoRoot`. The admin dir is found from the repository's common dir, which agents cannot write.
 * `created` marks the call right after ATLAS ran `git worktree add`: what git wrote is recorded as the expected state
 * (also in `<adminDir>/atlas-pin.json`, read-only to the sandbox, so a restarted daemon expects the same). A worktree
 * pinned later without a record must be on an `atlas/` branch and have no config.worktree.
 */
export async function pinWorktree(repoRoot: string, worktree: string, created?: { branch: string }): Promise<WorktreePin> {
  const known = registeredPin(worktree);
  if (known && !created && sameLex(known.worktree, worktree)) return known;
  const commonDir = await commonDirOf(repoRoot);
  const wt = real(worktree);
  if (!existsSync(wt)) throw new AtlasError('workspace_conflict', `The worktree ${worktree} does not exist`);
  const adminDir = findAdminDir(commonDir, wt);
  const head = readSmall(path.join(adminDir, 'HEAD'), 4096)?.trim() ?? '';
  let pin: WorktreePin;
  if (created) {
    if (head !== `ref: refs/heads/${created.branch}`) tampered(wt, 'head', `HEAD is ${head || 'missing'}, not the new branch ${created.branch}`);
    const cw = path.join(adminDir, 'config.worktree');
    pin = { worktree: wt, adminDir, commonDir, head, configWorktree: existsSync(cw) ? sha256(cw) : null };
    writeFileSync(path.join(adminDir, RECORD), JSON.stringify({ v: 1, head, configWorktree: pin.configWorktree } satisfies PinRecord));
  } else {
    const rec = readRecord(adminDir);
    if (rec) pin = { worktree: wt, adminDir, commonDir, head: rec.head, configWorktree: rec.configWorktree };
    else {
      if (!/^ref: refs\/heads\/atlas\/\S+$/.test(head)) tampered(wt, 'head', `HEAD is ${head || 'missing'}, not an ATLAS branch`);
      pin = { worktree: wt, adminDir, commonDir, head, configWorktree: null };
    }
  }
  verifyWorktreeMetadata(pin.worktree, pin.adminDir, pin);
  pins.set(keyOf(wt), pin);
  return pin;
}

/* ---------------- worktrees ATLAS manages ---------------- */

type OwnerOf = (worktree: string) => string | null | undefined;
const managed = new Set<{ root: string; depth: number; owner: OwnerOf }>();

/**
 * Declare `root` as the place this daemon keeps worktrees (`<root>/<mission>/<name>` for depth 2). git() then never
 * runs there without a pin: an unregistered worktree (after a restart) is pinned through `owner`, which names the
 * repository it belongs to, and a path ATLAS cannot attribute is refused instead of discovered.
 */
export function manageWorktrees(root: string, owner: OwnerOf, depth = 2): () => void {
  const entry = { root, depth, owner };
  managed.add(entry);
  return () => { managed.delete(entry); };
}

/** The pin for a git call in `cwd`: a registered worktree, a managed one (pinned now), or null for any other path. */
export async function pinFor(cwd: string): Promise<WorktreePin | null> {
  const hit = registeredPin(cwd);
  if (hit) return hit;
  if (!managed.size) return null;
  const rc = real(cwd);
  let inside: string | null = null;
  for (const m of managed) {
    const rr = real(m.root);
    if (!within(rr, rc)) continue;
    const segs = path.relative(rr, rc).split(path.sep).filter(Boolean);
    if (segs.length < m.depth) throw new AtlasError('workspace_conflict', `ATLAS runs git only inside a worktree it created, not in ${cwd}`);
    const worktree = path.join(rr, ...segs.slice(0, m.depth));
    inside = worktree;
    let repoRoot: string | null | undefined = null;
    try { repoRoot = m.owner(worktree); } catch { /* an owner that is shutting down */ }
    if (repoRoot) return pinWorktree(repoRoot, worktree);
  }
  if (inside) throw new AtlasError('workspace_conflict', `ATLAS has no record of the worktree ${inside}`);
  return null;
}

/* ---------------- git version and attribute mode ---------------- */

export interface GitHardening {
  version: string;
  /** attr-source: GIT_ATTR_SOURCE hides in-tree attributes. neutralize-drivers: each driver name found is disabled. */
  mode: 'attr-source' | 'neutralize-drivers';
  detail: string;
}

let detected: Promise<GitHardening> | null = null;
let forcedVersion: string | null = null;

/** Tests only: behave as if `git version` printed this (null: the real git). */
export function forceGitVersionForTests(version: string | null): void { forcedVersion = version; detected = null; }

export function gitHardening(): Promise<GitHardening> { return (detected ??= detectHardening()); }

async function detectHardening(): Promise<GitHardening> {
  const raw = forcedVersion ?? (await spawnGit(os.tmpdir(), ['version'], 15_000)).out;
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  const version = m ? m[0] : 'unknown';
  const [major, minor] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (major < 2 || (major === 2 && minor < 40)) return { version, mode: 'neutralize-drivers', detail: `git ${version} predates GIT_ATTR_SOURCE (2.40): every filter and diff driver named in the tree or defined in the configuration is disabled by name` };
  if (!(await attrSourceHonoured())) return { version, mode: 'neutralize-drivers', detail: `git ${version} did not honour GIT_ATTR_SOURCE in a probe: every filter and diff driver is disabled by name` };
  return { version, mode: 'attr-source', detail: `git ${version}: in-tree .gitattributes select no driver for ATLAS's own git calls (GIT_ATTR_SOURCE = empty tree)` };
}

/** Probe the behaviour instead of trusting the version number: a custom attribute must vanish under GIT_ATTR_SOURCE. */
async function attrSourceHonoured(): Promise<boolean> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-attrprobe-'));
  try {
    const env = { GIT_CONFIG_GLOBAL: '/dev/null' };
    if ((await spawnGit(dir, [...BASE_FLAGS, 'init', '-q'], 15_000, env)).code !== 0) return false;
    writeFileSync(path.join(dir, '.gitattributes'), '* atlas-attr-probe\n');
    const check = (extra: Record<string, string>) => spawnGit(dir, [...BASE_FLAGS, 'check-attr', 'atlas-attr-probe', '--', 'probe.txt'], 15_000, { ...env, ...extra });
    const [plain, pinned] = [await check({}), await check({ GIT_ATTR_SOURCE: EMPTY_TREE })];
    return plain.code === 0 && /: set$/.test(plain.out.trim()) && pinned.code === 0 && /: unspecified$/.test(pinned.out.trim());
  } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ---------------- pinned calls ---------------- */

interface Target { worktree: string; gitDir: string; commonDir: string | null }

export interface PinnedOptions {
  timeoutMs?: number;
  /** Extra environment (e.g. GIT_INDEX_FILE). It cannot override the pinning variables. */
  env?: Record<string, string>;
  /** Directory to run in (default: the worktree root). */
  cwd?: string;
  /** What ATLAS recorded for this worktree (default: the registered pin, else what the admin dir implies). */
  pin?: Partial<WorktreePin>;
}

/**
 * Run git on an agent-writable worktree: verify the metadata, then name every location explicitly. Diffs get
 * --no-ext-diff --no-textconv; diff and status never look inside nested repositories; `add` skips populated gitlinks
 * (git would otherwise run `git status` inside them, under their own configuration).
 */
export async function gitPinned(worktree: string, adminDir: string, args: string[], opts: PinnedOptions = {}): Promise<GitResult> {
  const reg = registeredPin(worktree);
  const pin = opts.pin ?? (reg && sameReal(reg.adminDir, adminDir) ? reg : {});
  const commonDir = pin.commonDir ?? path.dirname(path.dirname(adminDir));
  verifyWorktreeMetadata(worktree, adminDir, { commonDir, configWorktree: pin.configWorktree ?? null, head: pin.head ?? null });
  return pinnedSpawn({ worktree, gitDir: adminDir, commonDir }, args, opts);
}

async function pinnedSpawn(t: Target, args: string[], opts: PinnedOptions): Promise<GitResult> {
  const h = await gitHardening();
  // A caller may choose the index file; no other GIT_* variable may redirect or reconfigure a pinned call.
  const extra = Object.fromEntries(Object.entries(opts.env ?? {}).filter(([k]) => !/^GIT_/i.test(k) || k === 'GIT_INDEX_FILE'));
  const env: Record<string, string> = {
    ...extra, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    ...(t.commonDir && !sameReal(t.commonDir, t.gitDir) ? { GIT_COMMON_DIR: t.commonDir } : {}),
    ...(h.mode === 'attr-source' ? { GIT_ATTR_SOURCE: EMPTY_TREE } : {}),
  };
  const flags = [...BASE_FLAGS, ...PINNED_FLAGS, ...(h.mode === 'neutralize-drivers' ? await neutralizers(t, env) : [])];
  const where = [`--git-dir=${t.gitDir}`, `--work-tree=${t.worktree}`];
  return spawnGit(opts.cwd ?? t.worktree, [...flags, ...where, ...(await harden(t, where, env, args))], opts.timeoutMs ?? 30_000, env);
}

const DIFF_OVERRIDES = /^--(ext-diff|textconv|ignore-submodules(=.*)?)$/;

async function harden(t: Target, where: string[], env: Record<string, string>, args: string[]): Promise<string[]> {
  let i = 0;
  while (args[i] === '-c') i += 2;
  const pre = args.slice(0, i), sub = args[i], rest = args.slice(i + 1);
  const dd = rest.indexOf('--');
  const opts = dd < 0 ? rest : rest.slice(0, dd), tail = dd < 0 ? [] : rest.slice(dd);
  if (sub === 'diff') return [...pre, sub, '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', ...opts.filter((a) => !DIFF_OVERRIDES.test(a)), ...tail];
  if (sub === 'status') return [...pre, sub, '--ignore-submodules=dirty', ...opts.filter((a) => !/^--ignore-submodules(=.*)?$/.test(a)), ...tail];
  if (sub === 'add') {
    const links = await populatedGitlinks(t, where, env);
    if (!links.length) return args;
    const excludes = links.map((p) => `:(top,literal,exclude)${p}`);
    const named = dd < 0 ? rest.some((a) => !a.startsWith('-')) : tail.length > 1;
    return [...pre, sub, ...opts, '--', ...(dd < 0 ? [] : tail.slice(1)), ...(named ? [] : [':/']), ...excludes];
  }
  return args;
}

/** Index entries that are gitlinks with a repository checked out at their path. */
async function populatedGitlinks(t: Target, where: string[], env: Record<string, string>): Promise<string[]> {
  const r = await spawnGit(t.worktree, [...BASE_FLAGS, ...PINNED_FLAGS, ...where, 'ls-files', '-s', '-z'], 120_000, env, MAX_LISTING);
  if (r.code !== 0) throw new AtlasError('workspace_conflict', `git ls-files failed: ${r.out.slice(0, 200)}`);
  if (r.truncated) throw new AtlasError('workspace_conflict', 'The index is too large to list safely');
  return r.out.split('\0').filter((l) => l.startsWith('160000 ')).map((l) => l.slice(l.indexOf('\t') + 1))
    .filter((p) => { try { lstatSync(path.join(t.worktree, p, '.git')); return true; } catch { return false; } });
}

/* ---------------- fallback: neutralize drivers by name (git < 2.40) ---------------- */

const DRIVER_TOKEN = /(?:^|\s)(?:filter|diff)=(\S+)/g;

/** `filter=<d>` and `diff=<d>` names in attribute text, read by the daemon (never interpreted by git). */
export function attributeDrivers(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(DRIVER_TOKEN)) out.add(m[1]);
  }
  return [...out];
}

async function neutralizers(t: Target, env: Record<string, string>): Promise<string[]> {
  const where = [`--git-dir=${t.gitDir}`, `--work-tree=${t.worktree}`];
  const g = (args: string[]) => spawnGit(t.worktree, [...BASE_FLAGS, ...PINNED_FLAGS, ...where, ...args], 120_000, env, MAX_LISTING);
  const names = new Set<string>();
  // 1. Every .gitattributes git could read for a path it processes: in each directory holding a tracked or
  //    untracked-not-ignored file, and tracked ones that exist only in the index.
  const listed = await g(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listed.code !== 0 || listed.truncated) throw new AtlasError('workspace_conflict', `Could not list the worktree to neutralize attribute drivers: ${listed.out.slice(0, 200)}`);
  const files = listed.out.split('\0').filter(Boolean);
  const dirs = new Set<string>(['']);
  for (const f of files) for (let d = path.posix.dirname(f); d !== '.' && !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
  for (const d of dirs) {
    const f = path.join(t.worktree, d, '.gitattributes');
    if (!existsSync(f)) continue;
    let text: string;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const n of attributeDrivers(text)) names.add(n);
  }
  for (const f of files.filter((x) => x === '.gitattributes' || x.endsWith('/.gitattributes'))) {
    if (existsSync(path.join(t.worktree, f))) continue;
    const blob = await g(['cat-file', 'blob', `:${f}`]);
    if (blob.code === 0) for (const n of attributeDrivers(blob.out)) names.add(n);
  }
  // 2. Every driver defined in the configuration this call reads: a driver only runs if it is defined.
  const cfg = await g(['config', '-z', '--get-regexp', '^(filter|diff)\\.']);
  for (const entry of cfg.out.split('\0')) {
    const key = entry.split('\n')[0];
    const first = key.indexOf('.'), last = key.lastIndexOf('.');
    if (first > 0 && last > first) names.add(key.slice(first + 1, last));
  }
  if (names.size > 500) throw new AtlasError('workspace_conflict', `Too many attribute drivers to neutralize (${names.size})`);
  const out: string[] = [];
  for (const d of names) {
    if (/[=\n\r\0]/.test(d)) throw new AtlasError('workspace_conflict', `An attribute driver named ${JSON.stringify(d)} cannot be neutralized on git before 2.40`);
    for (const kv of [`filter.${d}.clean=`, `filter.${d}.smudge=`, `filter.${d}.process=`, `filter.${d}.required=false`, `diff.${d}.textconv=`, `diff.${d}.command=`]) out.push('-c', kv);
  }
  return out;
}

/* ---------------- audit snapshot of a tampered worktree ---------------- */

/**
 * Snapshot a worktree whose metadata was tampered with, without using any of it: the repository's common dir is the
 * git dir, a throwaway index starts from the task branch, and the result is a commit under `ref`. The worktree's
 * files (planted ones included) stay on disk; nothing in them runs. Returns the commit, or null if nothing changed.
 */
export async function preserveTampered(repoRoot: string, worktree: string, branch: string | null, ref: string): Promise<string | null> {
  const commonDir = await commonDirOf(repoRoot);
  const wt = real(worktree);
  if (!existsSync(wt)) return null;
  const tip = branch ? (await spawnGit(repoRoot, [...BASE_FLAGS, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])).out.trim() : '';
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'atlas-audit-'));
  const t: Target = { worktree: wt, gitDir: commonDir, commonDir: null };
  const opts = { env: { GIT_INDEX_FILE: path.join(tmp, 'index') }, timeoutMs: 120_000 };
  try {
    for (const args of [tip ? ['read-tree', tip] : ['read-tree', '--empty'], ['add', '-A']]) {
      const r = await pinnedSpawn(t, args, opts);
      if (r.code !== 0) throw new AtlasError('workspace_conflict', `Could not snapshot ${worktree} for audit: ${r.out.slice(0, 200)}`);
    }
    const tree = (await pinnedSpawn(t, ['write-tree'], opts)).out.trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new AtlasError('workspace_conflict', `Could not snapshot ${worktree} for audit`);
    if (tip && (await pinnedSpawn(t, ['rev-parse', `${tip}^{tree}`], opts)).out.trim() === tree) return null;
    const commit = (await pinnedSpawn(t, ['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', `ATLAS: ${path.basename(wt)} kept for audit (its git metadata was tampered with)`], opts)).out.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new AtlasError('workspace_conflict', `Could not snapshot ${worktree} for audit`);
    const u = await spawnGit(repoRoot, [...BASE_FLAGS, 'update-ref', ref, commit]);
    if (u.code !== 0) throw new AtlasError('workspace_conflict', `Could not record ${ref}: ${u.out.slice(0, 200)}`);
    return commit;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** The admin dir of a worktree of `repoRoot`, found from the repository side; null if there is none. */
export async function adminDirOf(repoRoot: string, worktree: string): Promise<string | null> {
  const reg = registeredPin(worktree);
  if (reg && sameLex(reg.worktree, worktree)) return reg.adminDir;
  try { return findAdminDirQuiet(await commonDirOf(repoRoot), worktree); } catch { return null; }
}

function findAdminDirQuiet(commonDir: string, worktree: string): string | null {
  const pointer = path.join(real(worktree), '.git');
  let ids: string[] = [];
  try { ids = readdirSync(path.join(commonDir, 'worktrees')); } catch { return null; }
  const hits = ids.map((id) => path.join(commonDir, 'worktrees', id)).filter((admin) => {
    const target = readSmall(path.join(admin, 'gitdir'), 4096);
    return target !== null && sameLex(path.resolve(admin, target.trim()), pointer);
  });
  return hits.length === 1 ? hits[0] : null;
}
