// Process journal (evolution P0-4). Every process the executor starts is recorded with an OS identity
// (pid + start time) and removed when it exits. After a crash, `reapJournaled` kills what is still running —
// but only when the identity still matches, so a reused pid is never killed.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { nowIso, type ProcessJournal } from '@atlas/contracts';

let journal: ProcessJournal | null = null;
export function setProcessJournal(j: ProcessJournal | null) { journal = j; }

let boot: string | null = null;
/** Start ticks are per boot: a row from an earlier boot must never match (review finding 11). */
function bootId(): string {
  if (boot === null) { try { boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { boot = 'unknown'; } }
  return boot;
}

/** pgrp and starttime (field 22) from /proc/<pid>/stat, parsed after the last ")" so any comm is safe. */
function linuxStat(pid: number): { pgrp: number; start: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return f[19] ? { pgrp: Number(f[2]), start: f[19] } : null;
  } catch { return null; }
}

/**
 * Members of process group `pgid` that started no earlier than the journaled leader. They outlive a leader that
 * died first (npm exits on EPIPE, its server keeps running), so the leader's identity alone cannot find them.
 */
function groupSurvivors(pgid: number, identity: string): number[] {
  const out: number[] = [];
  try {
    if (process.platform === 'linux') {
      const [, bootOf, start] = identity.split(':');
      if (bootOf !== bootId()) return [];
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const st = linuxStat(Number(name));
        if (st && st.pgrp === pgid && BigInt(st.start) >= BigInt(start)) out.push(Number(name));
      }
    } else if (process.platform === 'darwin') {
      const since = Date.parse(identity.slice('darwin:'.length));
      const rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,lstart='], { encoding: 'utf8', timeout: 5000 }).split('\n');
      for (const r of rows) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(r);
        if (m && Number(m[2]) === pgid && Date.parse(m[3]) >= since) out.push(Number(m[1]));
      }
    }
  } catch { /* nothing provable */ }
  return out.filter((p) => p !== process.pid);
}

/** Stable identity of a running process: its start time as the OS reports it. null when unknown or gone. */
export function processIdentity(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const st = linuxStat(pid);
      return st ? `linux:${bootId()}:${st.start}` : null;
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
      return out ? `darwin:${out}` : null;
    }
  } catch { return null; }
  // Windows: helper-launched processes live in a kill-on-close Job Object, so the OS reaps them.
  return null;
}

export function journalStart(pid: number | null | undefined, kind: string, command: string): (() => void) {
  if (!journal || !pid) return () => {};
  const identity = processIdentity(pid);
  if (!identity) return () => {};
  const j = journal;
  try { j.add({ pid, identity, kind, command, startedAt: nowIso() }); } catch { return () => {}; }
  return () => { try { j.remove(pid, identity); } catch { /* db closed */ } };
}

/** Kill journaled processes (and their process groups) left behind by a crash. Returns what was killed. */
export function reapJournaled(j: ProcessJournal): { killed: { pid: number; kind: string; command: string }[]; stale: number } {
  const killed: { pid: number; kind: string; command: string }[] = [];
  let stale = 0;
  for (const e of j.list()) {
    const now = processIdentity(e.pid);
    if (now === e.identity) {
      // The leader is still the process we started: its whole group is ours.
      // Either kill counts: an orphan's parent is init, which can reap the leader between the two calls, and the
      // second one then fails with ESRCH although the process was killed (CI: reported as not killed).
      let done = false;
      try { process.kill(-e.pid, 'SIGKILL'); done = true; } catch { /* not a group leader */ }
      try { process.kill(e.pid, 'SIGKILL'); done = true; } catch { /* gone (perhaps just now, by the group kill) or not ours */ }
      if (done) killed.push({ pid: e.pid, kind: e.kind, command: e.command });
      continue;
    }
    // A live process with another identity means the pid was reused. POSIX never reuses a pid while a process
    // group with that id exists, so nothing of ours is left in it, and that group is someone else's.
    if (now !== null) { stale++; continue; }
    // The leader is gone: members of the group it led can still be running.
    const survivors = groupSurvivors(e.pid, e.identity);
    if (!survivors.length) { stale++; continue; }
    for (const pid of survivors) { try { process.kill(pid, 'SIGKILL'); killed.push({ pid, kind: e.kind, command: `${e.command} (group member)` }); } catch { /* gone */ } }
  }
  j.clear();
  return { killed, stale };
}
