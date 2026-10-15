// Context compaction through the real Pi adapter (ADR 0024): with a small context window, Pi summarizes the older
// conversation, and the adapter reports it to ATLAS as a context event with Pi's token counts.
import { describe, expect, it } from 'vitest';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentEvent, ToolInvoker } from '@atlas/contracts';
import { PiRuntime } from '../src';
import { tmpDir } from '../../../tests/helpers';

describe('Pi context compaction (ADR 0024)', () => {
  it('compacts a conversation that outgrows the window and reports it, then finishes the task', async () => {
    const faux = createFauxCore({ provider: 'atlas-faux' });
    const fm = faux.getModel();
    const big = 'x'.repeat(24_000);
    faux.setResponses([
      fauxAssistantMessage([fauxText('Reading the large file.'), fauxToolCall('read_file', { path: 'big.txt' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Reading it again.'), fauxToolCall('read_file', { path: 'big.txt' })], { stopReason: 'toolUse' }),
      // Summaries and the rest of the task: whatever Pi asks next gets a plain answer.
      ...Array.from({ length: 8 }, () => fauxAssistantMessage('Summary: read big.txt twice; nothing else changed. Done.')),
    ]);
    const runtime = new PiRuntime({
      agentDir: tmpDir('atlas-pi-'), model: `atlas-faux/${fm.id}`,
      compaction: { reserveTokens: 1000, keepRecentTokens: 500 },
      configure: (rt) => rt.registerProvider('atlas-faux', {
        name: 'Faux', baseUrl: 'http://faux.invalid', apiKey: 'test-only', api: faux.api, streamSimple: faux.streamSimple as any,
        models: [{ id: fm.id, name: 'Faux', reasoning: false, input: ['text'], cost: fm.cost, contextWindow: 8000, maxTokens: 1000 }],
      }),
    });
    const tools: ToolInvoker = {
      specs: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      async invoke() { return { ok: true, output: big, exitCode: null, artifactIds: [], error: null }; },
    };
    const ac = new AbortController();
    const h = await runtime.start({
      missionId: 'msn_aaaaaaaa', taskId: 'tsk_aaaaaaaa', attemptId: 'att_aaaaaaaa', workspaceId: 'ws_aaaaaaaa', roleId: 'coder', cwd: tmpDir(),
      instructions: 'Test agent.', prompt: 'Read big.txt.', permittedTools: ['read_file'], contextRefs: [],
      budget: { maxToolCalls: 10, maxTokens: 10_000_000, wallClockMs: 60_000 }, tools, signal: ac.signal,
    });
    const events: AgentEvent[] = [];
    for await (const e of runtime.stream(h)) events.push(e);
    await runtime.dispose(h);
    const ctx = events.filter((e) => e.type === 'context');
    expect(ctx.map((e) => (e as { phase: string }).phase)).toContain('compacting');
    const done = ctx.find((e) => (e as { phase: string }).phase === 'compacted') as Extract<AgentEvent, { type: 'context' }> | undefined;
    expect(done, JSON.stringify(ctx)).toBeTruthy();
    expect(done!.tokensBefore).toBeGreaterThan(6000);
    expect(events.at(-1)!.type).toBe('completed');
  }, 60_000);
});
