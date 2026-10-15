// Export / import / delete / retention (manual §38, §39, §43).
import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerSecret } from '@atlas/contracts';
import { replay } from '@atlas/orchestrator';
import type { FakeScript } from '@atlas/runtime-fake';
import { sampleSlugifyScript } from '@atlas/runtime-fake';
import { sampleRepo, sh, tmpDir } from '../helpers';
import { makeOrchestrator, startMission } from './harness';

describe('export and import', () => {
  it('round-trips a mission into another data directory with intact evidence and no secrets', async () => {
    const root = sampleRepo();
    const secret = 'ghp_exportcanary0123456789abcdefghijkl';
    registerSecret(secret);
    const leak: FakeScript = { ...sampleSlugifyScript, name: 'leak', steps: async (i) => [{ say: `token ${secret}` }, ...(await sampleSlugifyScript.steps(i))] };
    const a = makeOrchestrator({ scripts: [leak] });
    const id = await startMission(a, root);
    await a.orch.settle(id);
    const file = path.join(tmpDir(), 'mission.atlas.jsonl');
    const r = a.orch.exportMission(id, file);
    expect(r.records).toBeGreaterThan(20);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(secret);

    const b = makeOrchestrator();
    const m = b.orch.importMission(file);
    expect(m).toMatchObject({ id, archived: true, state: 'completed' });
    expect(replay(b.repo.eventsSince(id, 0)).mission).toBe('completed');
    for (const art of b.artifacts.list(id)) expect(b.artifacts.read(art.id).intact).toBe(true);
    expect(b.repo.checks(id).find((c) => c.name === 'tests')!.result).toBe('pass');
    // Archived missions are read-only.
    await expect(b.orch.decide(id, 'accept')).rejects.toThrow(/read-only/);
    // Importing twice is refused.
    expect(() => b.orch.importMission(file)).toThrow(/already exists/);
  });

  it('detects a tampered or truncated export', async () => {
    const root = sampleRepo();
    const a = makeOrchestrator();
    const id = await startMission(a, root);
    await a.orch.settle(id);
    const file = path.join(tmpDir(), 'm.jsonl');
    a.orch.exportMission(id, file);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const tampered = lines.map((l) => l.replace('"Verified: tests passed', '"Verified: everything passed'));
    writeFileSync(file, tampered.join('\n'));
    expect(() => makeOrchestrator().orch.importMission(file)).toThrow(/integrity/);
    writeFileSync(file, lines.slice(0, -1).join('\n'));
    expect(() => makeOrchestrator().orch.importMission(file)).toThrow(/truncated/);
  });
});

describe('delete and retention', () => {
  it('deletes rows, artifacts, worktrees and task branches; keeps an accepted branch', async () => {
    const root = sampleRepo();
    const h = makeOrchestrator();
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    const arts = h.artifacts.list(id).map((a) => path.join(h.dataDir, 'artifacts', a.id));
    await h.orch.decide(id, 'accept');
    await h.orch.deleteMission(id);
    expect(h.repo.mission(id)).toBeNull();
    expect(h.repo.eventsSince(id, 0)).toEqual([]);
    expect(arts.some((f) => existsSync(f))).toBe(false);
    expect(sh(root, 'git', ['branch', '--list', 'atlas/*'])).toBe(m.integrationBranch);
  });

  it('refuses to delete a running mission and purges old decided missions', async () => {
    const root = sampleRepo();
    const h = makeOrchestrator();
    const id = await startMission(h, root);
    await expect(h.orch.deleteMission(id)).rejects.toThrow(/Cancel the mission/);
    await h.orch.settle(id);
    await h.orch.decide(id, 'reject');
    expect(await h.orch.purgeOlderThan(30)).toEqual([]);
    h.repo.db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);
    expect(await h.orch.purgeOlderThan(30)).toEqual([id]);
    expect(h.repo.mission(id)).toBeNull();
  });

  it('never purges a cancelled, undecided mission automatically (P1-3 review finding 8)', async () => {
    const root = sampleRepo();
    const h = makeOrchestrator();
    const id = await startMission(h, root);
    await h.orch.cancelMission(id);
    await h.orch.settle(id);
    h.repo.db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);
    expect(await h.orch.purgeOlderThan(30)).toEqual([]);
    expect(h.repo.mission(id)).not.toBeNull();
  });
});

describe('signed exports (closes the final audit forgery finding)', () => {
  async function exported() {
    const a = makeOrchestrator();
    const id = await startMission(a, sampleRepo());
    await a.orch.settle(id);
    const file = path.join(tmpDir(), 'mission.atlas.jsonl');
    const r = a.orch.exportMission(id, file);
    return { a, id, file, keyId: r.keyId! };
  }
  /** What a forger can do: edit records, recompute the trailer hash, optionally re-sign with their own key. */
  function forge(file: string, resign: boolean) {
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const body = lines.slice(0, -1).map((l) => l.replace(/Verified: tests passed/g, 'Verified: tests passed (forged)'));
    const sha256 = createHash('sha256').update(body.join('\n')).digest('hex');
    const end: Record<string, unknown> = { type: 'end', records: body.length, sha256 };
    const old = JSON.parse(lines.at(-1)!);
    if (resign) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const pub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
      end.signature = { alg: 'ed25519', keyId: createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 32), publicKey: pub, signature: sign(null, Buffer.from(sha256), privateKey).toString('base64') };
    } else end.signature = old.signature;
    writeFileSync(file, [...body, JSON.stringify(end)].join('\n') + '\n');
  }
  const provenanceOf = (h: ReturnType<typeof makeOrchestrator>, id: string) => h.repo.eventsSince(id, 0).filter((e) => e.type === 'operator.action' && e.payload.action === 'imported').at(-1)!.payload.provenance as Record<string, unknown>;

  it('an export is signed; re-importing at the same installation reports it as its own', async () => {
    const { a, file, keyId } = await exported();
    expect(keyId).toMatch(/^[0-9a-f]{32}$/);
    expect(keyId).toBe(a.orch.exportKeyId());
    expect(JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1)!).signature.alg).toBe('ed25519');
  });

  it('another installation sees the signer as untrusted until it trusts that key id', async () => {
    const { id, file, keyId } = await exported();
    const b = makeOrchestrator();
    expect(b.orch.importMission(file).provenance).toMatchObject({ signed: true, keyId, trusted: false, own: false });
    // An imported archive is a record, not a change to act on.
    await expect(b.orch.decide(id, 'accept')).rejects.toThrow(/read-only/);
    expect(provenanceOf(b, id)).toMatchObject({ trusted: false });
    const c = makeOrchestrator();
    c.repo.setSetting('export.trustedKeys', [keyId]);
    expect(c.orch.importMission(file).provenance).toMatchObject({ signed: true, keyId, trusted: true });
  });

  it('a forger who recomputes the hashes but keeps the old signature is refused', async () => {
    const { file } = await exported();
    forge(file, false);
    expect(() => makeOrchestrator().orch.importMission(file)).toThrow(/signature is invalid/);
  });

  it('a forger who re-signs with their own key is imported only as untrusted, never as the original signer', async () => {
    const { file, keyId } = await exported();
    forge(file, true);
    const b = makeOrchestrator();
    b.repo.setSetting('export.trustedKeys', [keyId]);
    const p = b.orch.importMission(file).provenance;
    expect(p.signed).toBe(true);
    expect(p.keyId).not.toBe(keyId);
    expect(p.trusted).toBe(false);
  });

  it('the private key is created readable by the user only', async () => {
    const { a } = await exported();
    const { statSync } = await import('node:fs');
    if (process.platform !== 'win32') expect(statSync(path.join(a.dataDir, 'keys', 'export-ed25519.pem')).mode & 0o077).toBe(0);
  });
});
