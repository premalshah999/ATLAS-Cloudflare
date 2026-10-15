// Deterministic fake runtime (manual §44). It drives the same governed tools as a real model, from a script,
// so orchestration, policy and evidence paths are testable without model credentials.
import type { AgentEvent, AgentHandle, AgentInput, AgentRuntime, PlanProposal, PlanRequest, RuntimeHealth } from '@atlas/contracts';
import { EventQueue } from './queue';

export { EventQueue } from './queue';
export { sampleSlugifyScript, SAMPLE_FIX, sampleDesktopScript, sampleRegressionScript, samplePlanner, DESKTOP_SAMPLE_MARKER, sampleUiScript, sampleUiPage, UI_SAMPLE_MARKER } from './scripts';

export type FakeStep =
  | { say: string }
  | { tool: string; args: Record<string, unknown> }
  /** The agent's own claim. It is recorded as a claim and never treated as evidence. */
  | { claim: string }
  /** Simulated model usage, for budget tests. */
  | { usage: number }
  /** Pause, for concurrency tests. */
  | { wait: number }
  /** Simulated context compaction (ADR 0024): the runtime reports it summarized earlier conversation. */
  | { compact: { tokensBefore: number; tokensAfter: number } };

export interface FakeScript {
  name: string;
  matches(input: AgentInput): boolean | Promise<boolean>;
  steps(input: AgentInput): FakeStep[] | Promise<FakeStep[]>;
}

/** Script for one task of a multi-task plan, matched by the task key in the prompt. */
export function forTask(key: string, steps: FakeStep[], role = 'coder'): FakeScript {
  return { name: `task:${key}`, matches: (input) => input.roleId === role && input.prompt.includes(`Work on task ${key} now.`), steps: () => steps };
}

/** Default security review (ADR 0023): read the change and run ATLAS's scan; report nothing it cannot back. */
export const securitySurveyScript: FakeScript = {
  name: 'security-survey',
  matches: (input) => input.roleId === 'security_reviewer',
  steps: () => [
    { say: 'Reviewing the change for security problems.' },
    { tool: 'view_diff', args: {} },
    { tool: 'security_scan', args: {} },
    { claim: 'Security review complete. ATLAS\'s scan results are recorded; no further findings reported (scripted security engineer).' },
  ],
};

/** Default review: read the change and run the tests; report nothing it cannot back. */
export const reviewSurveyScript: FakeScript = {
  name: 'review-survey',
  matches: (input) => input.roleId === 'reviewer',
  steps: () => [
    { say: 'Reviewing the change against the acceptance criteria.' },
    { tool: 'view_diff', args: {} },
    { tool: 'run_tests', args: {} },
    { claim: 'Review complete. No findings reported (scripted reviewer).' },
  ],
};

/** Default behavior for repositories without a matching script: a read-only survey. */
export const surveyScript: FakeScript = {
  name: 'survey',
  matches: () => true,
  steps: () => [
    { say: 'Fake runtime: surveying the repository. No model is connected, so no code changes will be proposed.' },
    { tool: 'git_status', args: {} },
    { tool: 'list_files', args: { path: '.' } },
    { claim: 'Survey complete. No changes made (fake runtime).' },
  ],
};

interface Run { queue: EventQueue<AgentEvent>; abort: AbortController; done: Promise<void> }

export class FakeRuntime implements AgentRuntime {
  readonly kind = 'fake' as const;
  private runs = new Map<string, Run>();
  private seq = 0;
  /** Optional scripted planner. Without one, the orchestrator uses its deterministic plan. */
  plan?: (req: PlanRequest) => Promise<PlanProposal>;

  constructor(private readonly scripts: FakeScript[] = [], private readonly stepDelayMs = 0, planner?: (req: PlanRequest) => unknown) {
    if (planner) this.plan = async (req) => ({ plan: planner(req), rationale: 'Scripted plan (fake runtime).', inputTokens: 0, outputTokens: 0 });
  }

  async health(): Promise<RuntimeHealth> {
    return { ok: true, runtime: 'fake', version: 'fake-1', models: ['scripted'], detail: 'Deterministic scripted runtime. Output is sample behavior, not a model.' };
  }

  async start(input: AgentInput): Promise<AgentHandle> {
    const id = `fake-${++this.seq}`;
    const queue = new EventQueue<AgentEvent>();
    const abort = new AbortController();
    const onOuter = () => abort.abort();
    input.signal.addEventListener('abort', onOuter, { once: true });
    const done = this.drive(input, queue, abort.signal).finally(() => { input.signal.removeEventListener('abort', onOuter); queue.close(); });
    this.runs.set(id, { queue, abort, done });
    return { id, runtime: 'fake' };
  }

  private async drive(input: AgentInput, q: EventQueue<AgentEvent>, signal: AbortSignal) {
    let script: FakeScript | null = null;
    for (const s of this.scripts) if (await s.matches(input)) { script = s; break; }
    script ??= (await reviewSurveyScript.matches(input)) ? reviewSurveyScript : (await securitySurveyScript.matches(input)) ? securitySurveyScript : surveyScript;
    const steps = await script.steps(input);
    let calls = 0;
    let summary = '';
    for (const step of steps) {
      if (signal.aborted) { q.push({ type: 'error', kind: 'cancelled', message: 'Run cancelled' }); return; }
      if (this.stepDelayMs) await new Promise((r) => setTimeout(r, this.stepDelayMs));
      if ('say' in step) q.push({ type: 'message', text: step.say });
      else if ('claim' in step) summary = step.claim;
      else if ('compact' in step) { q.push({ type: 'context', phase: 'compacting', reason: 'threshold' }); q.push({ type: 'context', phase: 'compacted', reason: 'threshold', ...step.compact }); }
      else if ('usage' in step) q.push({ type: 'usage', inputTokens: step.usage, outputTokens: 0 });
      else if ('wait' in step) await new Promise((r) => { const t = setTimeout(r, step.wait); signal.addEventListener('abort', () => { clearTimeout(t); r(undefined); }, { once: true }); });
      else {
        if (++calls > input.budget.maxToolCalls) { q.push({ type: 'error', kind: 'budget_exceeded', message: `Tool-call budget of ${input.budget.maxToolCalls} exhausted` }); return; }
        const callId = `call-${calls}`;
        q.push({ type: 'tool_call', callId, tool: step.tool, args: step.args });
        const r = await input.tools.invoke(step.tool, step.args, signal);
        // Long results keep their start and their end, where commands print their status.
        q.push({ type: 'tool_result', callId, tool: step.tool, ok: r.ok, summary: r.output.length > 2000 ? `${r.output.slice(0, 1000)}\n[…]\n${r.output.slice(-1000)}` : r.output });
        if (signal.aborted) { q.push({ type: 'error', kind: 'cancelled', message: 'Run cancelled' }); return; }
      }
    }
    q.push({ type: 'usage', inputTokens: 0, outputTokens: 0 });
    q.push({ type: 'completed', summary: summary || 'Script finished.' });
  }

  stream(handle: AgentHandle): AsyncIterable<AgentEvent> {
    const r = this.runs.get(handle.id);
    if (!r) throw new Error(`unknown handle ${handle.id}`);
    return r.queue;
  }

  async interrupt(handle: AgentHandle) { this.runs.get(handle.id)?.abort.abort(); }
  async resume(): Promise<void> { throw new Error('The fake runtime cannot resume; the scheduler starts a new attempt instead.'); }
  async dispose(handle: AgentHandle) {
    const r = this.runs.get(handle.id);
    if (!r) return;
    r.abort.abort();
    await r.done.catch(() => {});
    this.runs.delete(handle.id);
  }
  activeRuns() { return this.runs.size; }
}
