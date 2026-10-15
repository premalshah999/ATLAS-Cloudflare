// Context continuity (ADR 0024): after the runtime summarizes an agent's conversation, ATLAS's exact records
// (mission_memory) and its code graph (code_graph) still answer what the agent did and how the code fits together.
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { forTask, SAMPLE_FIX } from '@atlas/runtime-fake';
import { sampleRepo } from '../helpers';
import { explainChecks, makeOrchestrator, startMission, waitFor } from './harness';

const results = (h: ReturnType<typeof makeOrchestrator>, tool: string) => h.events.filter((e) => e.type === 'agent.tool_result' && e.payload.tool === tool).map((e) => String(e.payload.summary));

describe('context continuity (ADR 0024)', () => {
  it('after a compaction, mission_memory returns exact records and code_graph the structure, edits included', async () => {
    const h = makeOrchestrator({
      scripts: [forTask('implement', [
        { tool: 'write_file', args: { path: 'src/slugify.js', content: SAMPLE_FIX } },
        { tool: 'write_file', args: { path: 'src/format.js', content: "import { slugify } from './slugify.js';\nexport function title(s) { return slugify(s).toUpperCase(); }\n" } },
        { tool: 'run_tests', args: {} },
        { compact: { tokensBefore: 182_000, tokensAfter: 41_000 } },
        { tool: 'mission_memory', args: {} },
        { tool: 'code_graph', args: { query: 'file', target: 'src/slugify.js' } },
        { tool: 'code_graph', args: { query: 'symbol', target: 'title' } },
        { tool: 'code_graph', args: { query: 'overview' } },
        { tool: 'code_graph', args: { query: 'file' } },
        { claim: 'Fixed slugify and added a title helper.' },
      ])],
    });
    const root = sampleRepo();
    const id = await startMission(h, root);
    await h.orch.settle(id);
    expect(h.repo.mission(id)!.verdict, explainChecks(h, id)).toBe('verified');

    // The compaction is on the record, with the runtime's token estimates.
    const c = h.events.find((e) => e.type === 'context.compacted')!;
    expect(c.payload).toMatchObject({ ok: true, reason: 'threshold', tokensBefore: 182_000, tokensAfter: 41_000 });

    // Exact facts after it: the objective, the acceptance criteria, both writes, the test run with its exit code.
    const [memory] = results(h, 'mission_memory');
    expect(memory).toMatch(/^Mission memory: exact records kept by ATLAS/);
    expect(memory).toMatch(/# Your task\nimplement: Implement the objective \(coder\)\nAcceptance criteria:\n- Make slugify produce valid URL slugs\./);
    expect(memory).toMatch(/# Files you wrote\n- src\/slugify\.js\n- src\/format\.js/);
    expect(memory).toMatch(/# Commands you ran \(last \d+\)\n- npm test → exit 0/);
    // The change against the base, from git: the edited file, and the new one (not committed yet).
    expect(memory).toMatch(/src\/slugify\.js \| +\d+ [+-]+/);
    expect(memory).toMatch(/Untracked: src\/format\.js/);

    // The graph includes the worktree's new file and its import of slugify.js.
    const [file, symbol, overview, bad] = results(h, 'code_graph');
    expect(file).toMatch(/^src\/slugify\.js \(js, \d+ lines\)/);
    expect(file).toMatch(/Imported by: [^\n]*src\/format\.js/);
    expect(file).toMatch(/Tests that import it: test\/slugify\.test\.js/);
    expect(symbol).toMatch(/function title at src\/format\.js:2 \(exported\)/);
    expect(overview).toMatch(/^Code graph: \d+ source files/);
    // A malformed query is refused before it runs.
    expect(bad).toMatch(/target is required/);

    // The base commit's graph was built in the background when the plan was approved, and cached on disk.
    const base = h.repo.mission(id)!.baseCommit!;
    await waitFor(() => h.orch.graphs.peek(base));
    expect(existsSync(path.join(h.dataDir, 'graphs', `${base}.json`))).toBe(true);
    // Every role gets both tools, read-only.
    const started = h.events.filter((e) => e.type === 'context.built');
    expect(started.length).toBeGreaterThan(0);
  }, 120_000);

  it('mission_memory reports only this mission, and records refusals', async () => {
    const h = makeOrchestrator({
      scripts: [forTask('implement', [
        { tool: 'write_file', args: { path: '../outside.txt', content: 'x' } },
        { tool: 'shell_exec', args: { command: 'sudo', args: ['ls'] } },
        { tool: 'mission_memory', args: { section: 'commands' } },
        { claim: 'done' },
      ])],
    });
    const root = sampleRepo();
    const other = await startMission(h, root, { goal: 'An unrelated mission.' });
    await h.orch.settle(other);
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const memory = results(h, 'mission_memory').at(-1)!;
    expect(memory).not.toMatch(/unrelated/);
    expect(memory).toMatch(/# Refused\n- policy denied write_file: Path escapes the workspace: \.\.\/outside\.txt\n- policy denied shell_exec: sudo is never permitted for agents/);
  }, 120_000);
});
