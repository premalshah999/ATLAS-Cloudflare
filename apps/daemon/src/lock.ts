// One daemon per data directory (P0-4 review finding 7). A second daemon on the same database would reap the
// first one's live processes as "orphans" and re-run recovery over its missions.
import { openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import { AtlasError } from '@atlas/contracts';
import { isAlive, processIdentity } from '@atlas/terminal';

interface Holder { pid: number; identity: string | null }

/** The holder still running, or null. Identity-checked where the OS provides one, so a reused pid is not a holder. */
function liveHolder(file: string): Holder | null {
  let h: Holder;
  try { h = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!h || typeof h.pid !== 'number' || h.pid === process.pid) return null;
  if (h.identity) return processIdentity(h.pid) === h.identity ? h : null;
  return isAlive(h.pid) ? h : null;
}

/** Take the data directory lock or throw. Returns the release function. */
export function lockDataDir(dataDir: string): () => void {
  const file = path.join(dataDir, 'daemon.lock');
  for (let i = 0; i < 2; i++) {
    const holder = liveHolder(file);
    if (holder) throw new AtlasError('invalid_request', `Another ATLAS daemon (pid ${holder.pid}) is using ${dataDir}. Close the other ATLAS window first.`);
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) } satisfies Holder));
      closeSync(fd);
      return () => { try { if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) rmSync(file, { force: true }); } catch { /* gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Exists: ours from an earlier start in this process, or a stale lock from a dead daemon. Re-check once.
      if (!liveHolder(file)) rmSync(file, { force: true });
    }
  }
  throw new AtlasError('invalid_request', `Could not lock ${dataDir}`);
}
