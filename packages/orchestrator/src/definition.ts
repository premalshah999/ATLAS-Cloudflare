// What defines "verified" for a project, and how a mission changed it (evolution D1, backlog P0-3, revised after
// the independent review in docs/evolution/04-implementation-log.md). The agent writes the integrated commit, so it
// must not be able to redefine its own test:
//   - the verification definition (scripts, runner/type/lint config, package manager, atlas.config.json sections,
//     every package.json in a workspace) is compared between the approved base and the integrated commit;
//   - deleted tests and newly tracked tooling (node_modules) are reported;
//   - modified or renamed tests trigger a run of the base commit's original test suite against the new code.
// Weakening changes block the gate until the operator approves that exact change at that exact commit.
import { createHash } from 'node:crypto';
import { git } from '@atlas/workspace';

/** Scripts verification runs, plus npm lifecycle hooks around them. */
export const VERIFY_SCRIPTS = ['test', 'typecheck', 'lint'];
const RUNNER_KEYS = ['jest', 'mocha', 'ava', 'c8', 'nyc', 'vitest', 'tap', 'workspaces', 'packageManager', 'type', 'imports', 'exports'];
/** Script runners that fan out to other scripts by pattern: when used, every script counts as definition. */
const FANOUT = /\b(run-s|run-p|npm-run-all2?|concurrently|turbo|nx|lerna|wireit)\b|\s(-r|--recursive|--filter|--workspaces?|-ws)\b/;
/** Config files (any directory, outside node_modules) that change what a check does or which program runs. */
const CONFIG_FILE = /(^|\/)((vitest|vite|jest|playwright|karma|cypress|ava|webpack|babel|swc|rollup|esbuild)\.config\.[cm]?[jt]s(on)?|vitest\.workspace\.[\w.]+|\.mocharc(\.[\w]+)?|\.nycrc(\.\w+)?|\.c8rc(\.\w+)?|tsconfig([.\w-]*)\.json|\.eslintrc(\.\w+)?|eslint\.config\.[cm]?[jt]s|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|pnpm-workspace\.yaml|\.babelrc(\.\w+)?|\.swcrc|pytest\.ini|tox\.ini|conftest\.py)$/;
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];
/** Paths that hold tests (and their support files). */
export const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|specs|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|(^|\/)conftest\.py$/;
const MAX_BLOB = 1024 * 1024;

export interface Definition { hash: string; items: Record<string, string>; files: string[] }

async function gitStrict(repo: string, args: string[]): Promise<string> {
  const r = await git(repo, args, 60_000);
  if (r.code !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${r.out.slice(0, 200)}`);
  return r.out;
}

async function blob(repo: string, commit: string, file: string): Promise<string> {
  const size = Number((await git(repo, ['cat-file', '-s', `${commit}:${file}`])).out.trim());
  if (!Number.isFinite(size)) return '(unreadable)';
  if (size > MAX_BLOB) return `sha:${(await gitStrict(repo, ['rev-parse', `${commit}:${file}`])).trim()}`;
  const r = await git(repo, ['show', `${commit}:${file}`]);
  return r.code === 0 ? r.out : '(unreadable)';
}

/** All tracked files at a commit (NUL-separated, so unusual names cannot break parsing). */
async function filesAt(repo: string, commit: string): Promise<string[]> {
  return (await gitStrict(repo, ['ls-tree', '-r', '-z', '--name-only', commit])).split('\0').filter(Boolean);
}

/** Collect the verification-relevant definition at a commit. */
export async function definitionAt(repo: string, commit: string): Promise<Definition> {
  const files = await filesAt(repo, commit);
  const outside = (f: string) => !/(^|\/)node_modules\//.test(f);
  const items: Record<string, string> = {};
  for (const pj of files.filter((f) => outside(f) && /(^|\/)package\.json$/.test(f))) {
    const text = await blob(repo, commit, pj);
    let pkg: unknown;
    try { pkg = JSON.parse(text); } catch { pkg = undefined; }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) { items[`${pj}`] = `unparseable:${createHash('sha256').update(text).digest('hex')}`; continue; }
    const p = pkg as Record<string, unknown>;
    const scripts = (p.scripts && typeof p.scripts === 'object' && !Array.isArray(p.scripts) ? p.scripts : {}) as Record<string, unknown>;
    const want = new Set<string>();
    const visit = (name: string) => {
      if (want.has(name) || scripts[name] === undefined) return;
      want.add(name);
      const body = String(scripts[name]);
      if (FANOUT.test(body)) for (const n of Object.keys(scripts)) want.add(n);
      for (const m of body.matchAll(/\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([\w:.-]+)/g)) visit(m[1]);
    };
    for (const s of VERIFY_SCRIPTS) for (const n of [`pre${s}`, s, `post${s}`]) visit(n);
    for (const n of [...want].sort()) items[`${pj}#scripts.${n}`] = String(scripts[n]);
    for (const k of RUNNER_KEYS) if (p[k] !== undefined) items[`${pj}#${k}`] = JSON.stringify(p[k]);
  }
  items['package-manager'] = LOCKFILES.filter((l) => files.includes(l)).join(',') || '(none)';
  if (files.includes('atlas.config.json')) {
    const text = await blob(repo, commit, 'atlas.config.json');
    try {
      const cfg = JSON.parse(text);
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not an object');
      for (const k of ['checks', 'app', 'api', 'browser', 'deploy']) if (cfg[k] !== undefined) items[`atlas.config.json#${k}`] = JSON.stringify(cfg[k]);
    } catch { items['atlas.config.json'] = `unparseable:${createHash('sha256').update(text).digest('hex')}`; }
  }
  for (const f of files.filter((x) => outside(x) && CONFIG_FILE.test(x)).sort()) items[f] = await blob(repo, commit, f);
  const hash = createHash('sha256').update(JSON.stringify(Object.entries(items).sort())).digest('hex');
  return { hash, items, files };
}

export interface DefinitionChange {
  /** Definition items that changed or disappeared: weakening until the operator approves. */
  changed: string[];
  /** Items that did not exist at the base (a new lint script, a first test script): informational. */
  added: string[];
  deletedTests: string[];
  modifiedTests: string[];
  addedTests: string[];
  /** Tooling the mission started tracking (node_modules): could shadow node, npm, the runner. */
  trackedTooling: string[];
  /** Test files at the base commit (the original suite). */
  baseTests: string[];
  /** Config files at the base / at the commit, for restoring the original suite. */
  baseConfig: string[];
  commitConfig: string[];
  baseHash: string;
  /** Binds an approval to this exact change at this exact commit. */
  hash: string;
}

/** Items whose first appearance can change which program runs: never "just an addition". */
const NEW_IS_WEAKENING = (k: string) => k === 'package-manager' || !k.includes('#') || /#(packageManager|workspaces|type|imports|exports)$/.test(k);

/** Compare the definition between the approved base and the integrated commit. */
export async function definitionChange(repo: string, base: string, commit: string): Promise<DefinitionChange> {
  const [a, b] = await Promise.all([definitionAt(repo, base), definitionAt(repo, commit)]);
  const keys = [...new Set([...Object.keys(a.items), ...Object.keys(b.items)])].sort();
  const changed: string[] = [];
  const added: string[] = [];
  for (const k of keys) {
    if (a.items[k] === b.items[k]) continue;
    if (a.items[k] === undefined && !NEW_IS_WEAKENING(k)) added.push(k);
    else changed.push(k);
  }
  const deletedTests: string[] = [];
  const modifiedTests: string[] = [];
  const addedTests: string[] = [];
  const trackedTooling: string[] = [];
  const tok = (await gitStrict(repo, ['diff', '--name-status', '-z', '-M', base, commit])).split('\0');
  for (let i = 0; i < tok.length; ) {
    const st = tok[i++];
    if (!st) continue;
    const from = tok[i++] ?? '';
    const to = st[0] === 'R' || st[0] === 'C' ? tok[i++] ?? '' : '';
    const target = to || from;
    if (/(^|\/)node_modules\//.test(target) && st[0] !== 'D') trackedTooling.push(target);
    const wasTest = TEST_PATH.test(from);
    if (st[0] === 'D' && wasTest) deletedTests.push(from);
    else if (st[0] === 'R' && wasTest) modifiedTests.push(`${from} → ${to}`);
    else if ((st[0] === 'M' || st[0] === 'T') && wasTest) modifiedTests.push(from);
    else if ((st[0] === 'A' || st[0] === 'C') && TEST_PATH.test(target)) addedTests.push(target);
  }
  const outside = (f: string) => !/(^|\/)node_modules\//.test(f);
  // Bound to the integrated *content* (tree), not the commit: re-integration makes a new commit for the same tree,
  // while any other content (even with the same definition and deletions) produces a different hash.
  const tree = (await gitStrict(repo, ['rev-parse', `${commit}^{tree}`])).trim();
  const hash = createHash('sha256').update(JSON.stringify([tree, base, b.hash, changed, deletedTests, modifiedTests, trackedTooling])).digest('hex');
  return {
    changed, added, deletedTests, modifiedTests, addedTests, trackedTooling,
    baseTests: a.files.filter((f) => outside(f) && TEST_PATH.test(f)),
    baseConfig: a.files.filter((f) => outside(f) && (CONFIG_FILE.test(f) || LOCKFILES.includes(f))),
    commitConfig: b.files.filter((f) => outside(f) && (CONFIG_FILE.test(f) || LOCKFILES.includes(f))),
    baseHash: a.hash, hash,
  };
}

/** Changes that must be approved before the gate can pass. */
export const weakening = (d: DefinitionChange) => [...d.changed.map((c) => `changed ${c}`), ...d.deletedTests.map((t) => `deleted test ${t}`), ...d.trackedTooling.slice(0, 5).map((t) => `tracks tooling file ${t}`)];
