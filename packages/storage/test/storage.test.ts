import { describe, expect, it } from 'vitest';
import { cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_BUDGET, newId, nowIso } from '@atlas/contracts';
import { ArtifactStore, openDb, Repo, schemaVersion } from '../src';
import { tmpDir } from '../../../tests/helpers';

function setup(dir = tmpDir()) {
  const db = openDb(path.join(dir, 'atlas.db'));
  return { dir, db, repo: new Repo(db), artifacts: new ArtifactStore(db, path.join(dir, 'artifacts')) };
}
function seed(repo: Repo) {
  const now = nowIso();
  const ws = repo.upsertWorkspace({ id: newId('ws'), name: 'w', root: '/tmp/w-' + Math.random(), isGit: true, branch: 'main', head: 'abc', dirty: 0, createdAt: now, updatedAt: now });
  const id = newId('msn');
  repo.insertMission({ id, workspaceId: ws.id, title: 't', goal: 'g', constraints: '', approvalMode: 'ask_risky', runtime: 'fake', baseCommit: null, state: 'draft', planVersion: 0, policyId: 'p', outcome: null, decision: null, budget: DEFAULT_BUDGET, integrationBranch: null, integrationCommit: null, archived: false, targetEnvironment: null, verdict: null, followUp: null, createdAt: now, updatedAt: now });
  return id;
}

describe('storage', () => {
  it('applies migrations once with WAL and foreign keys', () => {
    const { db } = setup();
    expect(schemaVersion(db)).toBe(9);
    expect((db.prepare('PRAGMA journal_mode').get() as any).journal_mode).toBe('wal');
    expect((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys).toBe(1);
  });

  it('v5 backfills the gate verdict for missions recorded before it existed', () => {
    const dir = tmpDir();
    let { db, repo } = setup(dir);
    const id = seed(repo);
    repo.append({ missionId: id, taskId: null, attemptId: null, type: 'gate.result', actor: { kind: 'system', component: 'release-gate' }, payload: { verdict: 'failed', summary: 'x' }, artifactIds: [] });
    repo.append({ missionId: id, taskId: null, attemptId: null, type: 'gate.result', actor: { kind: 'system', component: 'release-gate' }, payload: { verdict: 'unverified', summary: 'y' }, artifactIds: [] });
    // Roll the database back to v4, as an existing installation would be.
    db.exec("DELETE FROM schema_migrations WHERE version = 5; ALTER TABLE missions DROP COLUMN verdict; DROP TABLE process_journal;");
    db.close();
    ({ db, repo } = setup(dir));
    expect(schemaVersion(db)).toBe(9);
    expect(repo.mission(id)!.verdict).toBe('unverified'); // the latest gate result wins
    repo.updateMission(id, { verdict: 'verified' });
    expect(repo.mission(id)!.verdict).toBe('verified');
  });

  it('v6 stores a CI follow-up and upgrades older databases with none', () => {
    const dir = tmpDir();
    let { db, repo } = setup(dir);
    const id = seed(repo);
    const now = nowIso();
    const follow = { parentMissionId: id, branch: 'atlas/x/integration', headSha: 'a'.repeat(40), pullRequest: 41 };
    repo.insertMission({ ...repo.mission(id)!, id: newId('msn'), followUp: follow, createdAt: now, updatedAt: now });
    expect(repo.missions().find((m) => m.followUp)!.followUp).toEqual(follow);
    // An installation at v5: the column does not exist yet.
    db.exec('DELETE FROM missions WHERE follow_up IS NOT NULL; DELETE FROM schema_migrations WHERE version = 6; ALTER TABLE missions DROP COLUMN follow_up;');
    db.close();
    ({ db, repo } = setup(dir));
    expect(schemaVersion(db)).toBe(9);
    expect(repo.mission(id)!.followUp).toBeNull();
  });

  it('v7 stores a mission model and upgrades older databases with none', () => {
    const dir = tmpDir();
    let { db, repo } = setup(dir);
    const id = seed(repo);
    const now = nowIso();
    const other = newId('msn');
    repo.insertMission({ ...repo.mission(id)!, id: other, model: 'mistral/devstral-2512', createdAt: now, updatedAt: now });
    expect(repo.mission(other)!.model).toBe('mistral/devstral-2512');
    expect(repo.mission(id)!.model).toBeNull();
    db.exec(`DELETE FROM missions WHERE id = '${other}'; DELETE FROM schema_migrations WHERE version IN (7, 8); ALTER TABLE missions DROP COLUMN model; ALTER TABLE findings DROP COLUMN source;`);
    db.close();
    ({ db, repo } = setup(dir));
    expect(schemaVersion(db)).toBe(9);
    expect(repo.mission(id)!.model).toBeNull();
  });

  it('assigns monotonic per-mission sequence numbers and redacts payloads', () => {
    const { repo } = setup();
    const m = seed(repo);
    const a = repo.append({ missionId: m, type: 'mission.created', actor: { kind: 'operator' }, taskId: null, attemptId: null, payload: { note: 'key sk-ant-abcdefghijklmnop' }, artifactIds: [] });
    const b = repo.append({ missionId: m, type: 'mission.state', actor: { kind: 'operator' }, taskId: null, attemptId: null, payload: { to: 'planning' }, artifactIds: [] });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(JSON.stringify(repo.eventsSince(m, 0))).not.toContain('sk-ant-abcdefghijklmnop');
    expect(repo.eventsSince(m, 1).map((e) => e.seq)).toEqual([2]);
  });

  it('enforces foreign keys', () => {
    const { repo } = setup();
    expect(() => repo.insertTask({ id: newId('tsk'), missionId: newId('msn'), key: 'k', title: 't', role: 'coder', dependencies: [], state: 'queued', retries: 0, acceptance: [], resultRef: null, worktree: null, branch: null, checkpoint: null, parentTaskId: null, depth: 0 })).toThrow();
  });

  it('approval decisions are single-use', () => {
    const { repo } = setup();
    const m = seed(repo);
    const id = newId('apr');
    repo.insertApproval({ id, missionId: m, taskId: null, agentRole: 'coder', tool: 'shell_exec', capability: 'shell.privileged', action: 'npm install', environment: 'e', resources: [], reason: 'r', risk: 'elevated', scope: 'once', status: 'pending', requestedAt: nowIso(), expiresAt: nowIso(), decidedAt: null, decidedBy: null });
    expect(repo.decideApproval(id, 'approved', 'operator')).toBe(true);
    expect(repo.decideApproval(id, 'denied', 'operator')).toBe(false);
  });

  it('artifacts are checksummed, redacted and tamper-evident; backup/restore keeps evidence links', () => {
    const { dir, repo, artifacts } = setup();
    const m = seed(repo);
    const a = artifacts.put({ missionId: m, taskId: null, kind: 'log', name: 'log', content: 'ok\nTOKEN=supersecretvalue\n' });
    const r = artifacts.read(a.id);
    expect(r.intact).toBe(true);
    expect(r.text).not.toContain('supersecretvalue');
    repo.append({ missionId: m, type: 'artifact.created', actor: { kind: 'operator' }, taskId: null, attemptId: null, payload: {}, artifactIds: [a.id] });

    // Backup: checkpoint WAL, copy the data directory, reopen from the copy.
    (repo.db as any).exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const copy = tmpDir();
    cpSync(dir, copy, { recursive: true });
    const restored = setup(copy);
    const ev = restored.repo.eventsSince(m, 0).find((e) => e.type === 'artifact.created')!;
    expect(restored.artifacts.read(ev.artifactIds[0]).intact).toBe(true);

    writeFileSync(path.join(dir, 'artifacts', a.id), 'tampered');
    expect(artifacts.read(a.id).intact).toBe(false);
  });

  it('filters events in SQL by type, task and attempt, newest n with last, with no cap past 100,000', () => {
    const { repo, db } = setup();
    const id = seed(repo);
    const sys = { kind: 'system' as const, component: 'test' };
    // 100,050 events: more than the 100,000 the old whole-log reads stopped at.
    for (let i = 0; i < 100_050; i++) repo.append({ missionId: id, taskId: i % 2 ? 'tsk_a' : 'tsk_b', attemptId: i % 3 ? null : 'att_1', type: 'process.output', actor: sys, payload: { i }, artifactIds: [] });
    repo.append({ missionId: id, taskId: 'tsk_a', attemptId: 'att_1', type: 'forge.ci', actor: sys, payload: { state: 'failure' }, artifactIds: ['art_x'] });
    repo.append({ missionId: id, taskId: null, attemptId: null, type: 'mission.state', actor: sys, payload: { to: 'running' }, artifactIds: [] });
    repo.append({ missionId: id, taskId: null, attemptId: null, type: 'mission.state', actor: sys, payload: { to: 'completed' }, artifactIds: [] });

    expect(repo.lastSeq(id)).toBe(100_053);
    expect(repo.lastEvent(id, 'forge.ci')).toMatchObject({ seq: 100_051, artifactIds: ['art_x'] });
    expect(repo.lastEvent(id, 'mission.state')!.payload.to).toBe('completed');
    expect(repo.lastEvent(id, 'forge.published')).toBeNull();
    expect(repo.events(id, { types: ['mission.state'] }).map((e) => e.payload.to)).toEqual(['running', 'completed']);
    expect(repo.events(id, { types: ['mission.state', 'forge.ci'], last: 2 }).map((e) => e.seq)).toEqual([100_052, 100_053]);
    // Events after the first 100,000 are found.
    expect(repo.events(id, { taskId: 'tsk_a', types: ['forge.ci'] })).toHaveLength(1);
    expect(repo.events(id, { attemptId: 'att_1' }).length).toBe(Math.ceil(100_050 / 3) + 1);
    expect(repo.countEvents(id, 'process.output')).toBe(100_050);
    expect(repo.lastSeq('msn_none')).toBe(0);
    // Each lookup uses an index, not a scan of the log.
    const plan = (sql: string, ...a: string[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a) as { detail: string }[]).map((r) => r.detail).join(' ');
    expect(plan('SELECT * FROM events WHERE mission_id = ? AND type IN (?) ORDER BY seq DESC LIMIT 1', id, 'forge.ci')).toMatch(/USING INDEX events_type/);
    expect(plan('SELECT * FROM events WHERE mission_id = ? AND attempt_id = ? ORDER BY seq', id, 'att_1')).toMatch(/USING INDEX events_(attempt|task)|USING COVERING INDEX/);
  }, 120_000);
});

