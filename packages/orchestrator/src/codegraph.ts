// Code graphs for missions (ADR 0024). The graph of a mission's base commit is built in the background as soon as the
// plan is approved, while agents start working; a query from a worktree applies that worktree's edits on top.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sanitizedEnv } from '@atlas/terminal';
import { git } from '@atlas/workspace';
import { buildGraph, indexable, withChanges, type CodeGraph } from '@atlas/graph';

/** Blobs of a commit through one `git cat-file --batch` process: the commit as committed, whatever the checkout holds. */
function catFiles(cwd: string, specs: string[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'cat-file', '--batch'], { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: sanitizedEnv({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }) });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', () => resolve(Buffer.concat(chunks)));
    child.on('error', () => resolve(Buffer.alloc(0)));
    child.stdin.on('error', () => {});
    child.stdin.end(specs.join('\n') + '\n');
  });
}

const MAX_FILES = 6000, MAX_BYTES = 512 * 1024;

export async function graphOfCommit(cwd: string, commit: string): Promise<CodeGraph> {
  const ls = await git(cwd, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], 60_000);
  const entries = ls.code === 0 ? ls.out.split('\0').map((l) => /^\d+ blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m) : [];
  const wanted = entries.filter((m) => indexable(m[3]) && Number(m[2]) <= MAX_BYTES);
  const files: { path: string; text: string }[] = [];
  for (let i = 0; i < Math.min(wanted.length, MAX_FILES); i += 200) {
    const batch = wanted.slice(i, Math.min(i + 200, MAX_FILES));
    let rest = await catFiles(cwd, batch.map((m) => m[1]));
    for (const m of batch) {
      const nl = rest.indexOf(10);
      const h = /^([0-9a-f]+) blob (\d+)$/.exec(rest.subarray(0, nl).toString('utf8'));
      if (!h) break;
      const size = Number(h[2]);
      files.push({ path: m[3], text: rest.subarray(nl + 1, nl + 1 + size).toString('utf8') });
      rest = rest.subarray(nl + 1 + size + 1);
    }
    // Yield between batches: indexing runs alongside the mission without stalling the daemon.
    await new Promise((r) => setImmediate(r));
  }
  return buildGraph(files, wanted.length > MAX_FILES);
}

export class GraphStore {
  private readonly building = new Map<string, Promise<CodeGraph>>();
  private readonly ready = new Map<string, CodeGraph>();
  constructor(private readonly dir: string) {}

  private file(commit: string) { return path.join(this.dir, `${commit}.json`); }

  /** The graph of a commit: from memory, from disk, or built now (once, however many ask). */
  ensure(cwd: string, commit: string): Promise<CodeGraph> {
    const hit = this.ready.get(commit);
    if (hit) return Promise.resolve(hit);
    let p = this.building.get(commit);
    if (!p) {
      p = (async () => {
        const f = this.file(commit);
        if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')) as CodeGraph; } catch { /* rebuild */ } }
        const g = await graphOfCommit(cwd, commit);
        try { mkdirSync(this.dir, { recursive: true }); writeFileSync(f, JSON.stringify(g)); } catch { /* cache only */ }
        return g;
      })().then((g) => { this.ready.set(commit, g); if (this.ready.size > 20) this.ready.delete(this.ready.keys().next().value!); return g; }).finally(() => this.building.delete(commit));
      this.building.set(commit, p);
    }
    return p;
  }

  /** Built already? (Context bundles include the overview only when it is ready, never waiting for it.) */
  peek(commit: string): CodeGraph | null { return this.ready.get(commit) ?? null; }

  /** The graph of a worktree: its base commit's graph with the worktree's committed and uncommitted edits applied. */
  async forWorktree(cwd: string, base: string): Promise<CodeGraph> {
    const g = await this.ensure(cwd, base);
    const changed = (await git(cwd, ['diff', '--name-only', '--no-renames', base])).out.split('\n').filter(Boolean);
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).out.split('\n').filter(Boolean);
    const edits = [...new Set([...changed, ...untracked])].filter(indexable).slice(0, 500).map((p) => {
      const abs = path.join(cwd, p);
      try { return { path: p, text: existsSync(abs) ? readFileSync(abs, 'utf8') : null }; } catch { return { path: p, text: null }; }
    });
    return edits.length ? withChanges(g, edits) : g;
  }
}
