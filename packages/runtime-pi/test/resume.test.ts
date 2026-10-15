// Durable sessions: an attempt lost to a daemon restart continues its conversation in a new attempt.
// Pi runs with its scripted faux provider; a second PiRuntime over the same agentDir stands in for the restarted daemon.
import { describe, expect, it } from 'vitest';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import type { AgentEvent, AgentInput, ToolInvoker, ToolResult } from '@atlas/contracts';
import { PiRuntime } from '../src';
import { tmpDir } from '../../../tests/helpers';

function runtime(agentDir: string, responses: FauxResponseStep[]) {
  const faux = createFauxCore({ provider: 'atlas-faux' });
  const fm = faux.getModel();
  faux.setResponses(responses);
  return new PiRuntime({
    agentDir, model: `atlas-faux/${fm.id}`,
    configure: (rt) => rt.registerProvider('atlas-faux', {
      name: 'Faux', baseUrl: 'http://faux.invalid', apiKey: 'test-only', api: faux.api, streamSimple: faux.streamSimple as any,
      models: [{ id: fm.id, name: 'Faux', reasoning: false, input: ['text'], cost: fm.cost, contextWindow: 100_000, maxTokens: 4096 }],
    }),
  });
}

const tools: ToolInvoker = {
  specs: [
    { name: 'write_file', description: 'Write', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'run_tests', description: 'Run tests', parameters: { type: 'object', properties: {} } },
  ],
  async invoke(name, _args, signal): Promise<ToolResult> {
    if (name === 'run_tests') await new Promise<void>((r) => { if (signal.aborted) r(); signal.addEventListener('abort', () => r(), { once: true }); });
    return { ok: true, output: name === 'write_file' ? 'wrote src/fix.js' : 'cancelled', exitCode: null, artifactIds: [], error: null };
  },
};

function input(attemptId: string, signal: AbortSignal, extra: Partial<AgentInput> = {}): AgentInput {
  return {
    missionId: 'msn_aaaaaaaa', taskId: 'tsk_aaaaaaaa', attemptId, workspaceId: 'ws_aaaaaaaa', roleId: 'coder', cwd: tmpDir(),
    instructions: 'Test agent.', prompt: 'Fix the bug in src/fix.js.', permittedTools: ['write_file', 'run_tests'], contextRefs: [],
    budget: { maxToolCalls: 10, maxTokens: 100_000, wallClockMs: 30_000 }, tools, signal, ...extra,
  };
}

async function drain(it: AsyncIterable<AgentEvent>, until?: (e: AgentEvent) => boolean) {
  const out: AgentEvent[] = [];
  for await (const e of it) { out.push(e); if (until?.(e)) break; }
  return out;
}

const texts = (m: any): string => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c: any) => c.text ?? (c.type === 'toolCall' ? `call:${c.name}` : '')).join(''));

describe('Pi durable sessions', () => {
  it('continues the conversation of an attempt interrupted mid-command, in a restarted runtime', async () => {
    const agentDir = tmpDir('atlas-pi-');
    // Attempt 1 edits a file, then starts the tests and the daemon "dies" while they run.
    const first = runtime(agentDir, [
      fauxAssistantMessage([fauxText('Editing.'), fauxToolCall('write_file', { path: 'src/fix.js' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('run_tests', {})], { stopReason: 'toolUse' }),
    ]);
    const ac1 = new AbortController();
    const h1 = await first.start(input('att_first001', ac1.signal));
    expect(h1.resumed).toBe(false);
    await drain(first.stream(h1), (e) => e.type === 'tool_call' && e.tool === 'run_tests');
    expect(first.canResume('att_first001')).toBe(true);

    // The restarted daemon: a new runtime over the same data directory, a new attempt and worktree.
    let seen: any[] = [];
    const second = runtime(agentDir, [(ctx) => { seen = ctx.messages; return fauxAssistantMessage('Tests rerun; done.'); }]);
    expect(second.canResume('att_first001')).toBe(true);
    const resumedCwd = tmpDir();
    const h2 = await second.start(input('att_second01', new AbortController().signal, { cwd: resumedCwd, resume: { attemptId: 'att_first001', prompt: 'ATLAS restarted. Continue.' } }));
    expect(h2.resumed).toBe(true);
    const events = await drain(second.stream(h2));
    expect(events.at(-1)).toMatchObject({ type: 'completed', summary: 'Tests rerun; done.' });

    // The model saw the whole earlier conversation, the interrupted call closed, then the resume prompt.
    // Pi sends system prompt changes as deltas: the original instructions, then only the working directory, which
    // now names the new attempt's worktree.
    const sys = seen.filter((m) => m.role === 'system');
    expect(sys[0].sections.preamble).toBe('Test agent.');
    expect(Object.keys(sys.at(-1).sections)).toEqual(['cwd']);
    // Pi writes the directory with forward slashes on Windows.
    expect(sys.at(-1).sections.cwd.replace(/\\/g, '/')).toContain(resumedCwd.replace(/\\/g, '/'));
    seen = seen.filter((m) => m.role !== 'system');
    const flat = seen.map((m) => `${m.role}:${texts(m)}`);
    expect(flat[0]).toBe('user:Fix the bug in src/fix.js.');
    expect(flat).toContain('toolResult:wrote src/fix.js');
    expect(flat.some((x) => x.includes('call:run_tests'))).toBe(true);
    const callIdx = flat.findIndex((x) => x.includes('call:run_tests'));
    // The interrupted call is closed with the reason (a call without a result is rejected by providers).
    expect(seen[callIdx + 1]).toMatchObject({ role: 'toolResult', toolName: 'run_tests', isError: true });
    expect(texts(seen[callIdx + 1])).toMatch(/^Interrupted: ATLAS restarted/);
    expect(flat.at(-1)).toBe('user:ATLAS restarted. Continue.');

    // The new attempt has its own saved copy; discarding the old one does not touch it.
    second.discard('att_first001');
    expect(second.canResume('att_first001')).toBe(false);
    expect(second.canResume('att_second01')).toBe(true);
    await second.dispose(h2);
    ac1.abort();
    await first.dispose(h1);
  });

  it('starts a fresh conversation with the normal prompt when nothing was saved', async () => {
    let seen: any[] = [];
    const rt = runtime(tmpDir('atlas-pi-'), [(ctx) => { seen = ctx.messages; return fauxAssistantMessage('ok'); }]);
    expect(rt.canResume('att_missing01')).toBe(false);
    const h = await rt.start(input('att_fresh0001', new AbortController().signal, { resume: { attemptId: 'att_missing01', prompt: 'Continue.' } }));
    expect(h.resumed).toBe(false);
    await drain(rt.stream(h));
    expect(seen.filter((m) => m.role !== 'system').map((m) => texts(m))).toEqual(['Fix the bug in src/fix.js.']);
    await rt.dispose(h);
  });

  it('refuses attempt ids that are not ATLAS ids (no path traversal into other directories)', () => {
    const rt = runtime(tmpDir('atlas-pi-'), []);
    for (const id of ['../sessions', 'att_../x', '/etc', 'att_a/b', '']) {
      expect(rt.canResume(id)).toBe(false);
      expect(() => rt.discard(id)).not.toThrow();
    }
  });
});
