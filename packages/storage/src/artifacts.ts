// Content-addressed-by-id artifact files (manual §39): atomic write then rename, checksummed.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, openSync, fsyncSync, closeSync, rmSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { AtlasError, newId, nowIso, redact, type Artifact, type ArtifactKind } from '@atlas/contracts';
import type { Db } from './db';

export class ArtifactStore {
  constructor(private readonly db: Db, private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(id: string) {
    if (!/^art_[A-Za-z0-9]+$/.test(id)) throw new Error('malformed artifact id');
    return path.join(this.dir, id);
  }

  /** Persist text content (redacted) as an immutable artifact. */
  put(input: { missionId: string; taskId: string | null; kind: ArtifactKind; name: string; content: string }): Artifact {
    return this.putBytes({ ...input, bytes: Buffer.from(redact(input.content), 'utf8') });
  }

  /** Persist binary content (screenshots, traces). Binary data is not text-redacted; callers must not pass secrets. */
  putBytes(input: { missionId: string; taskId: string | null; kind: ArtifactKind; name: string; bytes: Buffer }): Artifact {
    const id = newId('art');
    const body = input.bytes;
    // Fail clearly instead of half-writing when the disk is nearly full (manual §39).
    try {
      const fs = statfsSync(this.dir);
      if (Number(fs.bavail) * Number(fs.bsize) < body.length + 64 * 1024 * 1024) throw new AtlasError('internal', 'Disk almost full: refusing to write artifact (need 64 MB free)');
    } catch (e) { if (e instanceof AtlasError) throw e; }
    const sha256 = createHash('sha256').update(body).digest('hex');
    const target = this.file(id);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, body, { flag: 'wx' });
    const fd = openSync(tmp, 'r+'); // Windows FlushFileBuffers needs write access
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, target);
    const a: Artifact = { id, missionId: input.missionId, taskId: input.taskId, kind: input.kind, name: input.name, size: body.length, sha256, createdAt: nowIso() };
    this.db.prepare('INSERT INTO artifacts (id, mission_id, task_id, kind, name, size, sha256, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(a.id, a.missionId, a.taskId, a.kind, a.name, a.size, a.sha256, a.createdAt);
    return a;
  }

  get(id: string): Artifact | null {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Record<string, any> | undefined;
    return r ? rowToArtifact(r) : null;
  }

  list(missionId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at').all(missionId) as Record<string, any>[]).map(rowToArtifact);
  }

  /** Read and verify an artifact. A missing or tampered file is reported, never silently returned. */
  readBytes(id: string): { artifact: Artifact; bytes: Buffer; intact: boolean } {
    const artifact = this.get(id);
    if (!artifact) throw new Error(`artifact not found: ${id}`);
    const f = this.file(id);
    if (!existsSync(f)) return { artifact, bytes: Buffer.alloc(0), intact: false };
    const bytes = readFileSync(f);
    return { artifact, bytes, intact: createHash('sha256').update(bytes).digest('hex') === artifact.sha256 };
  }

  /** Restore an artifact with its original id (import). The content must match the recorded checksum. */
  restore(a: Artifact, bytes: Buffer): void {
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== a.sha256) throw new AtlasError('invalid_request', `Artifact ${a.id} failed its checksum on import`);
    const target = this.file(a.id);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
    this.db.prepare('INSERT INTO artifacts (id, mission_id, task_id, kind, name, size, sha256, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(a.id, a.missionId, a.taskId, a.kind, a.name, a.size, a.sha256, a.createdAt);
  }

  /** Remove the files of a mission's artifacts (rows are removed by Repo.deleteMission). */
  removeFiles(missionId: string) {
    for (const a of this.list(missionId)) rmSync(this.file(a.id), { force: true });
  }

  read(id: string): { artifact: Artifact; text: string; intact: boolean } {
    const artifact = this.get(id);
    if (!artifact) throw new Error(`artifact not found: ${id}`);
    const f = this.file(id);
    if (!existsSync(f)) return { artifact, text: '', intact: false };
    const body = readFileSync(f);
    const intact = createHash('sha256').update(body).digest('hex') === artifact.sha256;
    return { artifact, text: body.toString('utf8'), intact };
  }
}

function rowToArtifact(r: Record<string, any>): Artifact {
  return { id: r.id, missionId: r.mission_id, taskId: r.task_id, kind: r.kind, name: r.name, size: r.size, sha256: r.sha256, createdAt: r.created_at };
}
