import { describe, expect, it } from 'vitest';
import { BackgroundProcesses, detectPorts, MAX_BACKGROUND, type BackgroundHooks, type StartedProcess } from '../src/processes';

/** A scripted process: the test writes its output and decides when it exits. */
function fakeWorld() {
  const procs: { name: string; emit(t: string): void; exit(code: number | null): void; stopped: boolean }[] = [];
  const ended: { id: string; exitCode: number | null; stopped: boolean }[] = [];
  let pid = 100;
  const hooks: BackgroundHooks = {
    start: async (o) => {
      let resolve!: (c: number | null) => void;
      const done = new Promise<number | null>((r) => { resolve = r; });
      let exit: { code: number | null } | null = null;
      const p = {
        name: o.command, stopped: false,
        emit: (t: string) => o.onOutput(t),
        exit: (code: number | null) => { if (!exit) { exit = { code }; resolve(code); } },
      };
      procs.push(p);
      const handle: StartedProcess['handle'] = {
        pid: ++pid, spawnError: o.command === 'missing' ? 'spawn missing ENOENT' : null,
        output: () => '', exited: () => exit,
        stop: async () => { p.stopped = true; p.exit(null); },
      };
      if (handle.spawnError) resolve(null);
      return { handle, done };
    },
    started: () => {},
    output: () => {},
    ended: (p, how) => { ended.push({ id: p.id, ...how }); return `art_${p.id}`; },
    probe: async (port) => (port === 4000 ? 'HTTP 200' : 'not answering (ECONNREFUSED)'),
  };
  return { procs, ended, bg: new BackgroundProcesses(hooks) };
}
const never = new AbortController().signal;
const start = (bg: BackgroundProcesses, command: string, extra: Partial<Parameters<BackgroundProcesses['start']>[0]> = {}) =>
  bg.start({ command, args: [], cwd: '/w', relCwd: '.', serve: false, waitSec: 0, ...extra }, never);

describe('detectPorts', () => {
  it('finds the ports servers commonly print, and nothing in ordinary text', () => {
    expect(detectPorts('  ➜  Local:   http://localhost:5173/\n')).toEqual([5173]);
    expect(detectPorts('Server listening on port 8080')).toEqual([8080]);
    expect(detectPorts('ready - started server on 0.0.0.0:3000, url: http://127.0.0.1:3000')).toEqual([3000]);
    expect(detectPorts('PORT=4000')).toEqual([4000]);
    expect(detectPorts('listening at [::1]:9229')).toEqual([9229]);
    expect(detectPorts('Compiled 12 files in 3000 ms; 2 warnings')).toEqual([]);
    expect(detectPorts('localhost:99999')).toEqual([]);
  });
});

describe('BackgroundProcesses (ADR 0026)', () => {
  it('waits for the expected text, then returns while the process keeps running', async () => {
    const { procs, bg } = fakeWorld();
    const pending = start(bg, 'node', { name: 'watcher', waitFor: 'watching', waitSec: 5 });
    await new Promise((r) => setTimeout(r, 20));
    procs[0].emit('building…\n');
    procs[0].emit('watching for changes\n');
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Started watcher as p1: running for \d+ s \(pid 101\)/);
    expect(r.text).toMatch(/New output:\nbuilding…\nwatching for changes/);
  });

  it('reads only new output, the last lines when there is a lot, and probes ports only when it serves', async () => {
    const { procs, bg } = fakeWorld();
    const r = start(bg, 'node', { serve: true, waitSec: 5 });
    await new Promise((x) => setTimeout(x, 5));
    procs[0].emit('Server listening on http://127.0.0.1:4000\n');
    expect((await r).text).toMatch(/Listening on: http:\/\/127\.0\.0\.1:4000 → HTTP 200/);
    expect((await bg.read('p1', { tail: 5, waitSec: 0 }, never)).text).toMatch(/No new output\./);
    procs[0].emit(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const read = (await bg.read('p1', { tail: 5, waitSec: 0 }, never)).text;
    expect(read).toMatch(/\[25 earlier lines omitted\]\nline 25\nline 26\nline 27\nline 28\nline 29$/);

    // Not served: the port is private to its sandbox, so ATLAS does not pretend it is reachable.
    const quiet = start(bg, 'vite');
    procs[1].emit('  ➜  Local:   http://localhost:5173/\n');
    const q = await quiet;
    expect(q.text).toMatch(/Listening on: http:\/\/127\.0\.0\.1:5173\n\(Started without serve/);
  });

  it('read waits for text that has not appeared yet, and stops waiting when the process exits', async () => {
    const { procs, bg } = fakeWorld();
    await start(bg, 'node');
    const waiting = bg.read('p1', { tail: 50, waitFor: 'tick 3', waitSec: 5 }, never);
    for (let i = 1; i <= 3; i++) procs[0].emit(`tick ${i}\n`);
    expect((await waiting).text).toMatch(/tick 1\ntick 2\ntick 3/);
    const t0 = Date.now();
    const gone = bg.read('p1', { tail: 50, waitFor: 'never printed', waitSec: 5 }, never);
    procs[0].exit(1);
    expect((await gone).text).toMatch(/p1 node: exited with code 1 after \d+ s · full log art_p1/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it(`refuses more than ${MAX_BACKGROUND} at once, a failed start says why, and unknown ids are refused`, async () => {
    const { bg } = fakeWorld();
    for (let i = 0; i < MAX_BACKGROUND; i++) expect((await start(bg, `s${i}`)).ok).toBe(true);
    const fifth = await start(bg, 'one-too-many');
    expect(fifth).toMatchObject({ ok: false });
    expect(fifth.text).toMatch(/4 background processes are already running \(p1 s0, p2 s1, p3 s2, p4 s3\)/);
    await bg.stop('p2');
    const missing = await start(bg, 'missing');
    expect(missing.ok).toBe(false);
    expect(missing.text).toMatch(/Failed to start missing: spawn missing ENOENT/);
    expect((await bg.read('p99', { tail: 5, waitSec: 0 }, never))).toMatchObject({ ok: false, text: expect.stringMatching(/No background process p99/) });
    expect((await bg.stop('p99')).ok).toBe(false);
  });

  it('close() stops everything still running, records each once, and refuses new starts', async () => {
    const { procs, ended, bg } = fakeWorld();
    await start(bg, 'a');
    await start(bg, 'b');
    procs[1].exit(0);
    await new Promise((r) => setTimeout(r, 5));
    await bg.close();
    expect(procs.map((p) => p.stopped)).toEqual([true, false]);
    expect(ended).toEqual([{ id: 'p2', exitCode: 0, stopped: false }, { id: 'p1', exitCode: null, stopped: true }]);
    expect(bg.list()).toMatch(/p1 a: stopped after \d+ s · full log art_p1[^\n]*\np2 b: exited with code 0/);
    expect((await start(bg, 'c')).ok).toBe(false);
  });
});
