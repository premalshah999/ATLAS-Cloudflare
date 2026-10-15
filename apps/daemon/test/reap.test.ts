// Evolution P0-4 at the daemon level: start() reaps journaled survivors of a crashed predecessor.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openDb, Repo } from '@atlas/storage';
import { isAlive, processIdentity } from '@atlas/terminal';
import { tmpDir } from '../../../tests/helpers';
import { DaemonService } from '../src/service';

it.skipIf(process.platform === 'win32')('daemon start kills processes journaled by a crashed predecessor', async () => {
  const dataDir = tmpDir('atlas-reap-');
  const orphan = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  orphan.unref();
  const pid = orphan.pid!;
  await new Promise((r) => setTimeout(r, 200));
  const db = openDb(path.join(dataDir, 'atlas.db'));
  new Repo(db).processJournal().add({ pid, identity: processIdentity(pid)!, kind: 'command', command: 'node -e …', startedAt: new Date().toISOString() });
  db.close();
  const svc = new DaemonService({ dataDir, version: 'test' });
  await svc.start();
  for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  expect(isAlive(pid)).toBe(false);
  expect(svc.repo.processJournal().list()).toEqual([]);
  await svc.stop();
}, 30_000);

it.skipIf(process.platform === 'win32')('a second daemon on the same data directory refuses to start and reaps nothing (review finding 7)', async () => {
  const dataDir = tmpDir('atlas-lock-');
  const work = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); // stands in for the first daemon
  await new Promise((r) => setTimeout(r, 200));
  try {
    const db = openDb(path.join(dataDir, 'atlas.db'));
    new Repo(db).processJournal().add({ pid: work.pid!, identity: processIdentity(work.pid!)!, kind: 'command', command: 'live work of the first daemon', startedAt: new Date().toISOString() });
    db.close();
    writeFileSync(path.join(dataDir, 'daemon.lock'), JSON.stringify({ pid: other.pid, identity: processIdentity(other.pid!) }));
    const svc = new DaemonService({ dataDir, version: 'test' });
    await expect(svc.start()).rejects.toThrow(/Another ATLAS daemon/);
    expect(isAlive(work.pid!)).toBe(true);
    // Once the first daemon is gone its lock is stale: the next start takes it over and reaps.
    process.kill(other.pid!, 'SIGKILL');
    for (let i = 0; i < 40 && isAlive(other.pid!); i++) await new Promise((r) => setTimeout(r, 50));
    await svc.start();
    for (let i = 0; i < 40 && isAlive(work.pid!); i++) await new Promise((r) => setTimeout(r, 50));
    expect(isAlive(work.pid!)).toBe(false);
    await svc.stop();
    expect(existsSync(path.join(dataDir, 'daemon.lock'))).toBe(false);
  } finally { for (const p of [work, other]) { try { process.kill(p.pid!, 'SIGKILL'); } catch { /* gone */ } } }
}, 30_000);
