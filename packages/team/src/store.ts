// The team record in git (ADR 0021): one file per entry under entries/, named by the entry's id, on the ref
// refs/atlas/team. Files never change once written, so two histories merge by taking the union of their files:
// there is never a conflict to resolve. Sharing is fetch and push of that ref to the repository's origin, a plain
// fast-forward push only; when the push is refused (someone pushed first), ATLAS fetches, merges and tries again.
import { TEAM_REF, type TeamEntry } from '@atlas/contracts';
import { gitOk, gitx } from './git';
import type { TeamRecord } from './fold';

const TRACK = 'refs/atlas/team-origin';
const README = [
  '# ATLAS team record',
  '',
  'This ref holds the team space of this repository: members, teams, work items, shared missions and reviews.',
  'Each file under entries/ is one signed entry, named by the SHA-256 of its content. ATLAS reads it; there is',
  'nothing here to edit by hand. See docs/adr/0021-team-spaces.md in the ATLAS repository.',
  '',
].join('\n');

export interface SyncResult { pulled: number; pushed: number; remote: boolean }

export class TeamStore {
  private readonly blobs = new Map<string, TeamRecord | null>();
  private readonly trees = new Map<string, Map<string, string>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string, private readonly netEnv: () => Promise<Record<string, string>> | Record<string, string> = () => ({})) {}

  /** Serialize writers: appends and syncs never interleave in this process. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  async head(ref = TEAM_REF): Promise<string | null> {
    const r = await gitx(this.root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** entries/<name> → blob, for a commit. */
  private async files(commit: string | null): Promise<Map<string, string>> {
    if (!commit) return new Map();
    const hit = this.trees.get(commit);
    if (hit) return hit;
    const r = await gitx(this.root, ['ls-tree', '-z', `${commit}:entries`]);
    const out = new Map<string, string>();
    if (r.code === 0) for (const line of r.stdout.split('\0')) {
      const m = /^100644 blob ([0-9a-f]{40,64})\t([0-9a-f]{64})\.json$/.exec(line);
      if (m) out.set(m[2], m[1]);
    }
    this.trees.set(commit, out);
    return out;
  }

  /** Every entry on a ref, parsed (not yet checked: `fold` checks). */
  async load(ref = TEAM_REF): Promise<{ head: string | null; records: TeamRecord[] }> {
    const head = await this.head(ref);
    const files = await this.files(head);
    const missing = [...files.values()].filter((b) => !this.blobs.has(b));
    if (missing.length) {
      // One process for all new blobs: `cat-file --batch` answers "<sha> blob <size>\n<content>\n" per request.
      const r = await gitx(this.root, ['cat-file', '--batch'], { input: missing.join('\n') + '\n', timeoutMs: 120_000 });
      let rest = r.raw;
      for (const sha of missing) {
        const nl = rest.indexOf(10);
        const header = rest.subarray(0, nl).toString('utf8');
        const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
        if (!m || m[1] !== sha) { this.blobs.set(sha, null); rest = rest.subarray(nl + 1); continue; }
        const size = Number(m[2]);
        const content = rest.subarray(nl + 1, nl + 1 + size).toString('utf8');
        rest = rest.subarray(nl + 1 + size + 1);
        this.blobs.set(sha, parse(content));
      }
    }
    const records: TeamRecord[] = [];
    for (const [name, blob] of files) {
      const rec = this.blobs.get(blob);
      // A file whose name is not its content's id is ignored here; `fold` reports content/id mismatches.
      if (rec) records.push({ id: name, entry: rec.entry });
    }
    return { head, records };
  }

  private async commit(files: Map<string, string>, parents: string[], message: string): Promise<string> {
    const lines = [...files].map(([name, blob]) => `100644 blob ${blob}\t${name}.json`).join('\n');
    const entriesTree = (await gitOk(this.root, ['mktree', '-z'], { input: lines.split('\n').filter(Boolean).map((l) => `${l}\0`).join('') })).trim();
    const readme = (await gitOk(this.root, ['hash-object', '-w', '--stdin'], { input: README })).trim();
    const root = (await gitOk(this.root, ['mktree', '-z'], { input: `100644 blob ${readme}\tREADME.md\u0000040000 tree ${entriesTree}\tentries\0` })).trim();
    const commit = (await gitOk(this.root, ['commit-tree', root, ...parents.flatMap((p) => ['-p', p]), '-m', message])).trim();
    this.trees.set(commit, new Map(files));
    return commit;
  }

  /** Move the ref only if it still points where we read it (another ATLAS process may share the repository). */
  private async setRef(next: string, prev: string | null, ref = TEAM_REF) {
    await gitOk(this.root, ['update-ref', '-m', 'ATLAS team record', ref, next, prev ?? '0'.repeat(40)]);
  }

  /** Add signed entries locally (sharing happens on sync). */
  append(entries: { id: string; entry: TeamEntry }[], message: string): Promise<string> {
    return this.locked(async () => {
      const head = await this.head();
      const files = new Map(await this.files(head));
      for (const e of entries) {
        if (files.has(e.id)) continue;
        const blob = (await gitOk(this.root, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(e.entry, null, 1) + '\n' })).trim();
        files.set(e.id, blob);
        this.blobs.set(blob, { id: e.id, entry: e.entry });
      }
      const commit = await this.commit(files, head ? [head] : [], message);
      await this.setRef(commit, head);
      return commit;
    });
  }

  async origin(): Promise<string | null> {
    const r = await gitx(this.root, ['config', '--get', 'remote.origin.url']);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  /** Fetch the origin's record, merge it with ours, and push the result. Never a forced update of the origin. */
  sync(): Promise<SyncResult> {
    return this.locked(async () => {
      if (!(await this.origin())) throw new Error('This repository has no origin remote to share the team record through.');
      const env = await this.netEnv();
      const before = await this.files(await this.head());
      const pulledSince = async () => [...(await this.files(await this.head())).keys()].filter((k) => !before.has(k)).length;
      let pushed = 0;
      for (let round = 0; round < 5; round++) {
        const f = await gitx(this.root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+${TEAM_REF}:${TRACK}`], { env, timeoutMs: 120_000 });
        let remote: string | null;
        if (f.code === 0) remote = await this.head(TRACK);
        else if (/couldn't find remote ref|no such remote ref|not our ref/i.test(f.stderr)) {
          remote = null;
          await gitx(this.root, ['update-ref', '-d', TRACK]);
        } else throw new Error(`Could not fetch the team record: ${redactUrl(f.stderr.trim()).slice(-400)}`);
        const local = await this.head();
        const lf = await this.files(local), rf = await this.files(remote);
        let next = local;
        if (!local && !remote) return { pulled: 0, pushed: 0, remote: false };
        if (!local) { await this.setRef(remote!, null); return { pulled: await pulledSince(), pushed, remote: true }; }
        if (remote && local !== remote) {
          if (await this.isAncestor(local, remote)) { await this.setRef(remote, local); return { pulled: await pulledSince(), pushed, remote: true }; }
          if (!(await this.isAncestor(remote, local))) {
            const union = new Map([...lf, ...rf]);
            next = await this.commit(union, [local, remote], 'ATLAS team record: merge');
            await this.setRef(next, local);
          }
        }
        if (next === remote) return { pulled: await pulledSince(), pushed, remote: true };
        const ahead = [...(await this.files(next!)).keys()].filter((k) => !rf.has(k)).length;
        const p = await gitx(this.root, ['push', '--no-verify', '--porcelain', 'origin', `${TEAM_REF}:${TEAM_REF}`], { env, timeoutMs: 120_000 });
        if (p.code === 0) { pushed = ahead; await gitx(this.root, ['update-ref', TRACK, next!]); return { pulled: await pulledSince(), pushed, remote: true }; }
        // Someone pushed in between: fetch again and merge. Anything else is a real failure.
        if (!/non-fast-forward|fetch first|rejected|stale info/i.test(p.stdout + p.stderr)) throw new Error(`Could not push the team record: ${redactUrl((p.stderr || p.stdout).trim()).slice(-400)}`);
      }
      throw new Error('The team record kept changing on the origin while syncing; try again.');
    });
  }

  private async isAncestor(a: string, b: string) {
    return (await gitx(this.root, ['merge-base', '--is-ancestor', a, b])).code === 0;
  }
}

function parse(content: string): TeamRecord | null {
  try {
    // The id is the file name (set by `load`); `fold` checks that it matches the content.
    return { id: '', entry: JSON.parse(content) as TeamEntry };
  } catch { return null; }
}

/** Credentials inside a remote URL never reach a message. */
export const redactUrl = (s: string) => s.replace(/(https?:\/\/)[^@/\s]+@/g, '$1***@');
