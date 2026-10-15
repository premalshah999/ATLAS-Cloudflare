// Session hygiene (ADR 0025): what is cleared, and what never is.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { candidates, cleanup, report, type HygieneInput } from '../src/hygiene';
import { createLogger, rotateLog } from '../src/log';
import { tmpDir } from '../../../tests/helpers';

function dataDir() {
  const d = tmpDir('atlas-hyg-');
  const put = (p: string, bytes = 1000) => { mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); writeFileSync(path.join(d, p), 'x'.repeat(bytes)); };
  put('atlas.db', 5000); put('atlas.db-wal', 3000); put('artifacts/ab/art_1', 4000);
  put('logs/daemon.log', 100); put('logs/daemon.log.1', 2000); put('logs/daemon.log.2', 2000);
  put('graphs/aaaa.json', 700); put('graphs/bbbb.json', 900);
  put('pi/sessions/att_live0001/s.jsonl', 300); put('pi/sessions/att_done0001/s.jsonl', 600);
  put('worktrees/msn_live0001/implement-1/f.txt', 50); put('worktrees/msn_gone0001/implement-1/f.txt', 800);
  put('releases/staging/dep_1/index.html', 100);
  return d;
}
const input = (d: string): HygieneInput => ({ dataDir: d, liveMissions: [{ id: 'msn_live0001', baseCommit: 'aaaa' }], keepAttempts: new Set(['att_live0001']), knownMissions: new Set(['msn_live0001']) });

describe('session hygiene (ADR 0025)', () => {
  it('reports sizes and what can be cleared, and clears only derived data', () => {
    const d = dataDir();
    const rows = Object.fromEntries(report(input(d)).map((r) => [r.category, r]));
    expect(rows.evidence).toMatchObject({ bytes: 9000, reclaimable: 0 });
    expect(rows.logs.reclaimable).toBe(4000);
    expect(rows.graphs.reclaimable).toBe(900);
    expect(rows.sessions.reclaimable).toBe(600);
    expect(rows.worktrees.reclaimable).toBe(800);
    expect(rows.database.reclaimable).toBe(3000);

    let checkpointed = false;
    const r = cleanup(input(d), ['logs', 'graphs', 'sessions', 'worktrees', 'database'], () => { checkpointed = true; writeFileSync(path.join(d, 'atlas.db-wal'), ''); });
    expect(r.removed).toEqual({ logs: 2, graphs: 1, sessions: 1, worktrees: 1, database: 1 });
    expect(r.freed).toBe(4000 + 900 + 600 + 800 + 3000);
    expect(checkpointed).toBe(true);
    // Kept: evidence, the current log, the graph and conversation a live mission uses, its worktree, releases.
    for (const p of ['atlas.db', 'artifacts/ab/art_1', 'logs/daemon.log', 'graphs/aaaa.json', 'pi/sessions/att_live0001/s.jsonl', 'worktrees/msn_live0001/implement-1/f.txt', 'releases/staging/dep_1/index.html']) expect(existsSync(path.join(d, p)), p).toBe(true);
    for (const p of ['logs/daemon.log.1', 'graphs/bbbb.json', 'pi/sessions/att_done0001', 'worktrees/msn_gone0001']) expect(existsSync(path.join(d, p)), p).toBe(false);
    // Nothing left to clear.
    expect(Object.values(candidates(input(d))).flat()).toEqual([]);
  });

  it('never removes the worktrees of a mission that exists, decided or not, and only folders that look like missions', () => {
    const d = dataDir();
    mkdirSync(path.join(d, 'worktrees', 'notes'), { recursive: true });
    const keepAll: HygieneInput = { ...input(d), knownMissions: new Set(['msn_live0001', 'msn_gone0001']) };
    expect(candidates(keepAll).worktrees).toEqual([]);
  });

  it('rotates the daemon log by size, keeping a bounded number of old logs', () => {
    const dir = tmpDir('atlas-log-');
    const log = createLogger(dir, { maxBytes: 2000, keep: 2 });
    for (let i = 0; i < 2000; i++) log.info('line', { i });
    const files = ['daemon.log', 'daemon.log.1', 'daemon.log.2', 'daemon.log.3'].map((f) => existsSync(path.join(dir, f)));
    expect(files).toEqual([true, true, true, false]);
    expect(readFileSync(path.join(dir, 'daemon.log'), 'utf8').length).toBeLessThan(200 * 80);
    expect(rotateLog(path.join(dir, 'missing.log'))).toBe(false);
  });
});
