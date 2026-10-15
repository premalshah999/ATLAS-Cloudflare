// Evolution P0-4: a hard daemon crash must not leave agent commands running forever. A real orchestrator
// process is SIGKILLed mid-command; the next start reaps what it left behind, and only that.
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, Repo } from '@atlas/storage';
import { isAlive, processIdentity, reapJournaled } from '@atlas/terminal';
import { tmpDir } from '../helpers';

const here = path.dirname(fileURLToPath(import.meta.url));

function childScript() {
  const file = path.join(tmpDir('atlas-orphan-'), 'child.ts');
  writeFileSync(file, `
import { makeOrchestrator, startMission, waitFor } from ${JSON.stringify(path.join(here, 'harness.ts'))};
import { sampleRepo } from ${JSON.stringify(path.join(here, '../helpers.ts'))};
import { FakeRuntime } from '@atlas/runtime-fake';
import { setProcessJournal } from '@atlas/terminal';
const rt = new FakeRuntime([{ name: 'hang', matches: (i) => i.roleId === 'coder', steps: () => [{ tool: 'shell_exec', args: { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], timeoutSec: 600 } }] }]);
const h = makeOrchestrator({ runtime: rt });
setProcessJournal(h.repo.processJournal());
h.repo.setSetting('execution.allowUnsandboxed', true);
const id = await startMission(h, sampleRepo());
const a = await waitFor(() => h.repo.approvals(id).find((x) => x.status === 'pending'));
h.orch.respondApproval(a.id, 'approve');
const started = await waitFor(() => h.events.find((e) => e.type === 'process.started'));
console.log(JSON.stringify({ self: process.pid, pid: started.payload.pid, sandboxed: started.payload.sandboxed, data: h.dataDir }));
setInterval(() => {}, 1000);
`);
  return file;
}

async function crashMidCommand(env: Record<string, string>) {
  // The CLI entry is read from vite-node's own package.json, so a version bump cannot silently break the path.
  const vn = path.join(here, '../../node_modules/vite-node');
  const bin = JSON.parse(readFileSync(path.join(vn, 'package.json'), 'utf8')).bin['vite-node'];
  const child = spawn(process.execPath, [path.join(vn, bin), childScript()], { cwd: path.join(here, '../..'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const info = await new Promise<{ self: number; pid: number; sandboxed: boolean; data: string }>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`child did not start: ${out}`)), 60_000);
    child.stdout.on('data', (b) => { out += b; const m = out.match(/\{"self".*\}/); if (m) { clearTimeout(t); resolve(JSON.parse(m[0])); } });
    child.stderr.on('data', (b) => { out += b; });
  });
  process.kill(info.self, 'SIGKILL'); // a crash: no cleanup code runs
  await new Promise((r) => child.on('close', r));
  return info;
}

describe.skipIf(process.platform === 'win32')('orphaned processes after a crash', () => {
  it('unsandboxed: the command survives the crash, and the next start reaps it', async () => {
    const info = await crashMidCommand({ ATLAS_SANDBOX: 'none' });
    expect(info.sandboxed).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(isAlive(info.pid)).toBe(true); // the leak the journal exists for
    const db = openDb(path.join(info.data, 'atlas.db'));
    const journal = new Repo(db).processJournal();
    expect(journal.list().some((e) => e.pid === info.pid)).toBe(true);
    const r = reapJournaled(journal);
    expect(r.killed.map((k) => k.pid)).toContain(info.pid);
    for (let i = 0; i < 40 && isAlive(info.pid); i++) await new Promise((res) => setTimeout(res, 50));
    expect(isAlive(info.pid)).toBe(false);
    expect(journal.list()).toEqual([]);
    db.close();
  }, 90_000);

  it('never kills a process whose identity does not match (pid reuse)', () => {
    const db = openDb(path.join(tmpDir('atlas-journal-'), 'atlas.db'));
    const journal = new Repo(db).processJournal();
    // Our own pid, recorded with a different start time, stands in for a reused pid.
    journal.add({ pid: process.pid, identity: `${processIdentity(process.pid)}-stale`, kind: 'command', command: 'old', startedAt: new Date().toISOString() });
    const r = reapJournaled(journal);
    expect(r).toEqual({ killed: [], stale: 1 });
    expect(isAlive(process.pid)).toBe(true);
    db.close();
  });

  it('the leader died first: its surviving group members are reaped, nothing else (review finding 4)', async () => {
    const db = openDb(path.join(tmpDir('atlas-journal-'), 'atlas.db'));
    const journal = new Repo(db).processJournal();
    // A leader that backgrounds a long-lived child and exits, like npm dying on EPIPE while its server runs.
    const leader = spawn('/bin/sh', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!; sleep 0.3'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const identity = processIdentity(leader.pid!)!;
    const childPid = await new Promise<number>((r) => leader.stdout!.once('data', (b) => r(Number(String(b).trim()))));
    journal.add({ pid: leader.pid!, identity, kind: 'command', command: 'sh', startedAt: new Date().toISOString() });
    const bystander = spawn('/bin/sh', ['-c', 'sleep 300'], { detached: true, stdio: 'ignore' }); // another group
    await new Promise((r) => leader.on('exit', r));
    expect(isAlive(childPid)).toBe(true);
    try {
      const r = reapJournaled(journal);
      expect(r.killed.map((k) => k.pid)).toEqual([childPid]);
      for (let i = 0; i < 40 && isAlive(childPid); i++) await new Promise((res) => setTimeout(res, 50));
      expect(isAlive(childPid)).toBe(false);
      expect(isAlive(bystander.pid!)).toBe(true);
    } finally { try { process.kill(-bystander.pid!, 'SIGKILL'); } catch { /* gone */ } try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ } db.close(); }
  });

  it('finished commands leave nothing in the journal', async () => {
    const { run, setProcessJournal } = await import('@atlas/terminal');
    const db = openDb(path.join(tmpDir('atlas-journal-'), 'atlas.db'));
    const journal = new Repo(db).processJournal();
    setProcessJournal(journal);
    try {
      const p = run({ command: 'node', args: ['-e', 'setTimeout(()=>{},300)'], cwd: tmpDir(), timeoutMs: 10_000 });
      await new Promise((r) => setTimeout(r, 100));
      expect(journal.list().length).toBe(1);
      await p;
      expect(journal.list()).toEqual([]);
    } finally { setProcessJournal(null); db.close(); }
  });
});
