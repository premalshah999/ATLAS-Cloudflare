// Execution for agents (ADR 0026): shell_exec with a working directory, standard input and long output kept whole in
// a log; background processes an agent starts, reads and stops, in the same sandbox and under the same policy, and that
// ATLAS stops when the task ends.
import { describe, expect, it } from 'vitest';
import { forTask, SAMPLE_FIX, type FakeScript } from '@atlas/runtime-fake';
import { realExecutors, ToolGate, type Executors } from '@atlas/orchestrator';
import { isAlive } from '@atlas/terminal';
import { sampleRepo } from '../helpers';
import { explainChecks, makeOrchestrator, startMission, waitFor } from './harness';

const FILES: Record<string, string> = {
  'tools/upper.mjs': "let s = '';\nprocess.stdin.on('data', (d) => { s += d; });\nprocess.stdin.on('end', () => console.log(s.toUpperCase()));\n",
  'tools/where.mjs': "import path from 'node:path';\nconsole.log(`in ${path.basename(process.cwd())}`);\n",
  'tools/big.mjs': "for (let i = 0; i < 20000; i++) console.log(`row ${i}`);\n",
  'server.mjs': "import http from 'node:http';\nconst s = http.createServer((q, r) => r.end('ok'));\ns.listen(0, '127.0.0.1', () => console.log(`Server listening on http://127.0.0.1:${s.address().port}`));\n",
  'watch.mjs': "console.log('watching for changes');\nlet i = 0;\nsetInterval(() => console.log(`tick ${++i}`), 100);\n",
};

const results = (h: ReturnType<typeof makeOrchestrator>, tool: string) => h.events.filter((e) => e.type === 'agent.tool_result' && e.payload.tool === tool).map((e) => ({ ok: e.payload.ok, text: String(e.payload.summary) }));

describe('execution for agents (ADR 0026)', () => {
  it('shell_exec takes a directory and standard input; long output keeps its start and end; background processes run, serve, and stop', async () => {
    const h = makeOrchestrator({
      scripts: [forTask('implement', [
        { tool: 'write_file', args: { path: 'src/slugify.js', content: SAMPLE_FIX } },
        ...Object.entries(FILES).map(([path, content]) => ({ tool: 'write_file', args: { path, content } })),
        { tool: 'shell_exec', args: { command: 'node', args: ['tools/upper.mjs'], stdin: 'hello from stdin\n' } },
        { tool: 'shell_exec', args: { command: 'node', args: ['../tools/where.mjs'], cwd: 'src' } },
        { tool: 'shell_exec', args: { command: 'node', args: ['where.mjs'], cwd: '../outside' } },
        { tool: 'shell_exec', args: { command: 'node', args: ['tools/big.mjs'] } },
        { tool: 'process_start', args: { command: 'node', args: ['server.mjs'], name: 'api', serve: true, waitSec: 30 } },
        { tool: 'process_start', args: { command: 'node', args: ['watch.mjs'], name: 'watcher', waitFor: 'watching', waitSec: 30 } },
        { tool: 'process_read', args: { id: 'p2', waitFor: 'tick 3', waitSec: 30 } },
        { tool: 'process_list', args: {} },
        { tool: 'process_stop', args: { id: 'p1' } },
        { tool: 'process_read', args: { id: 'p9' } },
        { claim: 'Fixed slugify; left the watcher running.' },
      ])],
    });
    const root = sampleRepo();
    const id = await startMission(h, root);
    // Serving on loopback gives the process network access: a person approves it, and sees what it is.
    const a = await waitFor(() => h.repo.approvals(id).find((x) => x.status === 'pending'), 60_000);
    expect(a).toMatchObject({ tool: 'process_start', action: 'serve: node server.mjs', capability: 'shell.privileged' });
    expect(a.resources).toContain('network (serves on loopback)');
    h.orch.respondApproval(a.id, 'approve');
    await h.orch.settle(id);
    expect(h.repo.mission(id)!.verdict, explainChecks(h, id)).toBe('verified');

    const shell = results(h, 'shell_exec');
    expect(shell[0].text).toMatch(/^HELLO FROM STDIN\n/);
    expect(shell[1].text).toMatch(/^in src\n/);
    expect(shell[2]).toMatchObject({ ok: false });
    expect(shell[2].text).toMatch(/escapes the workspace/i);
    // 20,000 rows: the start and the end, and where the rest is.
    // (The scripted runtime's record of a result keeps its first and last 1,000 characters, hence the [...] here.)
    expect(shell[3].text).toMatch(/^row 0\nrow 1\n/);
    expect(shell[3].text).toMatch(/row 19999\n+Exit code 0 · log art_\w+$/);
    // What the agent itself receives: the first 3,000 and last 9,000 characters, and where the rest is.
    const task = h.repo.tasks(id).find((t) => t.key === 'implement')!;
    const rows = Array.from({ length: 20000 }, (_, i) => `row ${i}`).join('\n');
    const gate = new ToolGate({
      isolation: { mode: 'unsandboxed' }, missionId: id, taskId: task.id, attemptId: h.repo.attempts(id).find((x) => x.taskId === task.id)!.id, role: 'coder', mode: 'ask_risky',
      cwd: root, permitted: ['shell_exec'], approvalTtlMs: 1000, base: h.repo.mission(id)!.baseCommit!, awaitApproval: async (x) => x,
    }, h.repo, h.artifacts, { ...realExecutors, exec: async () => ({ exitCode: 0, signal: null, durationMs: 1, output: rows, truncated: false, timedOut: false, cancelled: false, pid: 1, spawnError: null }) });
    const big = await gate.invoke('shell_exec', { command: 'cat', args: ['rows.txt'] }, new AbortController().signal);
    expect(big.output.startsWith(rows.slice(0, 3000))).toBe(true);
    expect(big.output).toContain(`\n… [${rows.length - 12_000} characters omitted; the full output is in ${big.artifactIds[0]}]\n${rows.slice(-9000)}\nExit code 0 · log ${big.artifactIds[0]}`);
    expect(h.artifacts.read(big.artifactIds[0]).text).toContain(rows);
    const bigLog = h.events.find((e) => e.type === 'process.exited' && e.payload.command === 'node tools/big.mjs')!.artifactIds[0];
    expect(h.artifacts.read(bigLog).text).toContain('row 10000\n');

    const [server, watcher] = results(h, 'process_start');
    expect(server.ok).toBe(true);
    expect(server.text).toMatch(/^Started api as p1: running for \d+ s \(pid \d+\)/);
    expect(server.text).toMatch(/Listening on: http:\/\/127\.0\.0\.1:\d+ → HTTP 200/);
    expect(watcher.text).toMatch(/^Started watcher as p2: running/);
    expect(watcher.text).toMatch(/watching for changes/);
    expect(watcher.text).not.toMatch(/Listening on/);

    const [ticks, unknown] = results(h, 'process_read');
    expect(ticks.text).toMatch(/tick 1\n(?:[^\n]*\n)*tick 3/);
    expect(unknown).toMatchObject({ ok: false, text: expect.stringMatching(/No background process p9/) });
    expect(results(h, 'process_list')[0].text).toMatch(/^p1 api: running[^\n]*ports \d+ · node server\.mjs\np2 watcher: running/);
    expect(results(h, 'process_stop')[0].text).toMatch(/^p1 api: stopped after \d+ s · full log art_\w+/);

    // Each background process is on the record: started, its output, and how it ended, with its full log.
    const started = h.events.filter((e) => e.type === 'process.started' && e.payload.background);
    expect(started.map((e) => [e.payload.background, e.payload.name, e.payload.network])).toEqual([['p1', 'api', true], ['p2', 'watcher', false]]);
    const ended = h.events.filter((e) => e.type === 'process.exited' && e.payload.background);
    expect(ended.map((e) => [e.payload.background, e.payload.stopped])).toEqual([['p1', true], ['p2', true]]);
    // The watcher was still running when the task ended: ATLAS stopped it, after the agent's last call.
    const lastCall = h.events.filter((e) => e.type === 'agent.tool_call' && e.taskId === ended[1].taskId).at(-1)!;
    expect(ended[1].seq).toBeGreaterThan(lastCall.seq);
    expect(h.artifacts.read(ended[1].artifactIds[0]).text).toMatch(/^\$ node watch\.mjs\nwatching for changes\ntick 1\n/);
    for (const e of started) expect(isAlive(Number(e.payload.pid))).toBe(false);
  }, 180_000);

  it('a background command the policy refuses never reaches an executor; tasks without a shell have no process tools', async () => {
    const touched: string[] = [];
    const spy: Executors = { ...realExecutors, start: async (o) => { touched.push(o.command); return realExecutors.start!(o); } };
    const evil: FakeScript = forTask('implement', [
      { tool: 'process_start', args: { command: 'sudo', args: ['node', 'server.mjs'] } },
      { tool: 'process_start', args: { command: 'node;rm', args: [] } },
      { tool: 'process_start', args: { command: 'node', args: ['x.mjs'], cwd: '../..' } },
      { claim: 'done' },
    ]);
    const reviewer: FakeScript = forTask('review', [
      { tool: 'process_start', args: { command: 'node', args: ['--version'] } },
      { tool: 'process_list', args: {} },
      { claim: 'done' },
    ], 'reviewer');
    const h = makeOrchestrator({ scripts: [evil, reviewer], executors: spy });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    // The path escape is refused before the process exists; the others before anything runs.
    expect(touched).toEqual([]);
    const denied = h.events.filter((e) => e.type === 'policy.decision' && e.payload.tool === 'process_start' && e.payload.decision === 'deny').map((e) => e.payload.reason);
    expect(denied).toEqual(expect.arrayContaining(['sudo is never permitted for agents', 'Executable name contains shell metacharacters', 'Tool "process_start" is not permitted for this task']));
    // The default review task has no shell_exec, so no background processes either.
    const reviewTask = h.repo.tasks(id).find((t) => t.key === 'review')!;
    const listed = h.events.find((e) => e.type === 'agent.tool_result' && e.taskId === reviewTask.id && e.payload.tool === 'process_list')!;
    expect(listed.payload.ok).toBe(false);
  }, 120_000);
});
