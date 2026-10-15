// Holdout acceptance suites (independent acceptance verification). The operator keeps acceptance tests in ATLAS's
// own data directory, never in the repository: agents cannot read them (their sandbox sees only their worktree),
// cannot edit them, and cannot tune the implementation to them. At the gate the suite is copied into the
// integration worktree under `.atlas-acceptance/`, run in the sandbox like any check, and removed again.
// This is the held-out test set idea: visible tests can be overfit (eval case `weak-tests`); hidden ones cannot.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AtlasError } from '@atlas/contracts';

export const ACCEPTANCE_DIR = '.atlas-acceptance';
const MAX_BYTES = 2 * 1024 * 1024;

export interface AcceptanceSuite {
  /** Program and arguments, run with the integration worktree as the working directory. */
  command: string;
  args: string[];
  /** Relative path (inside `.atlas-acceptance/`) → content. */
  files: Record<string, string>;
  updatedAt: string;
}

/** Content hash of a suite: recorded with every acceptance check, so a result names the exact tests it ran. */
export function suiteHash(s: Pick<AcceptanceSuite, 'command' | 'args' | 'files'>): string {
  return createHash('sha256').update(JSON.stringify([s.command, s.args, Object.entries(s.files).sort()])).digest('hex');
}

function validate(s: Pick<AcceptanceSuite, 'command' | 'args' | 'files'>) {
  if (!s.command || /[\\/]/.test(s.command)) throw new AtlasError('invalid_request', 'The acceptance command must be a program name (for example node or npx), not a path');
  let bytes = 0;
  for (const [p, c] of Object.entries(s.files)) {
    const parts = p.split(/[\\/]/);
    if (!p || path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || parts.some((x) => x === '..' || x === '' || x === '.git')) throw new AtlasError('invalid_request', `Invalid acceptance file path: ${p}`);
    bytes += Buffer.byteLength(c);
  }
  if (!Object.keys(s.files).length) throw new AtlasError('invalid_request', 'An acceptance suite needs at least one file');
  if (bytes > MAX_BYTES) throw new AtlasError('invalid_request', 'Acceptance suites are limited to 2 MB');
}

export class AcceptanceStore {
  constructor(private readonly dir: string) {}
  private file(workspaceId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) throw new AtlasError('invalid_request', 'malformed workspace id');
    return path.join(this.dir, `${workspaceId}.json`);
  }
  get(workspaceId: string): AcceptanceSuite | null {
    const f = this.file(workspaceId);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8')) as AcceptanceSuite;
  }
  set(workspaceId: string, s: Pick<AcceptanceSuite, 'command' | 'args' | 'files'>): AcceptanceSuite {
    validate(s);
    mkdirSync(this.dir, { recursive: true });
    const suite: AcceptanceSuite = { command: s.command, args: [...s.args], files: { ...s.files }, updatedAt: new Date().toISOString() };
    const f = this.file(workspaceId);
    writeFileSync(`${f}.tmp`, JSON.stringify(suite));
    renameSync(`${f}.tmp`, f);
    return suite;
  }
  remove(workspaceId: string) { rmSync(this.file(workspaceId), { force: true }); }
}

/** Write the suite into a worktree; returns the directory to remove afterwards. */
export function materialize(worktree: string, s: AcceptanceSuite): string {
  const root = path.join(worktree, ACCEPTANCE_DIR);
  // Windows: a just-ended test process (or antivirus) can hold a handle briefly; force alone does not retry.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  for (const [p, c] of Object.entries(s.files)) {
    const target = path.join(root, p);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, c);
  }
  return root;
}
