// ADR 0017: which model each agent gets. The mission's own model wins; otherwise each role's tier (fast/strong)
// from Settings, falling back to the default model; with nothing set the runtime chooses. Every attempt records it.
import { describe, expect, it } from 'vitest';
import type { AgentInput, PlanRequest } from '@atlas/contracts';
import { FakeRuntime, samplePlanner, sampleSlugifyScript } from '@atlas/runtime-fake';
import { makeOrchestrator } from './harness';
import { sampleRepo } from '../helpers';

function recording() {
  const starts: AgentInput[] = [];
  const plans: PlanRequest[] = [];
  const fake = new FakeRuntime([sampleSlugifyScript], 0, (req) => { plans.push(req); return samplePlanner(req); });
  const start = fake.start.bind(fake);
  fake.start = (input) => { starts.push(input); return start(input); };
  return { fake, starts, plans };
}

async function run(model: string | null, settings: Record<string, string | null>) {
  const r = recording();
  const h = makeOrchestrator({ runtime: r.fake });
  for (const [k, v] of Object.entries(settings)) h.repo.setSetting(k, v);
  const ws = await h.orch.registerWorkspace(sampleRepo());
  const m = h.orch.createMission({ workspaceId: ws.id, title: 'Fix slugify', goal: 'Make slugify produce valid URL slugs.', constraints: '', approvalMode: 'ask_risky', runtime: 'fake', model });
  await h.orch.plan(m.id);
  await h.orch.approvePlan(m.id);
  await h.orch.settle(m.id);
  const byRole = Object.fromEntries(r.starts.map((s) => [s.roleId, s.model ?? null]));
  const recorded = h.events.filter((e) => e.type === 'attempt.started').map((e) => [e.payload.role, e.payload.model ?? null]);
  return { h, id: m.id, byRole, recorded, plannerModel: r.plans[0]?.model ?? null };
}

describe('model selection (ADR 0017)', () => {
  it('uses the tier models from Settings per role, and records them on every attempt', async () => {
    const { byRole, recorded, plannerModel, h, id } = await run(null, { 'models.default': 'openai/gpt-default', 'models.strong': 'anthropic/strong-one' });
    expect(h.repo.mission(id)!.state).toBe('completed');
    expect(byRole.coder).toBe('openai/gpt-default');
    expect(byRole.reviewer).toBe('anthropic/strong-one');
    expect(plannerModel).toBe('anthropic/strong-one');
    for (const [role, model] of recorded) expect(model, String(role)).toBe(byRole[String(role)]);
  });

  it('a tier with no model falls back to the default model', async () => {
    const { byRole, plannerModel } = await run(null, { 'models.default': 'mistral/devstral' });
    expect(byRole.reviewer).toBe('mistral/devstral');
    expect(plannerModel).toBe('mistral/devstral');
  });

  it("the mission's own model overrides every tier, and is stored with the mission", async () => {
    const { byRole, plannerModel, h, id } = await run('groq/llama-x', { 'models.default': 'openai/gpt-default', 'models.strong': 'anthropic/strong-one' });
    expect(new Set(Object.values(byRole))).toEqual(new Set(['groq/llama-x']));
    expect(plannerModel).toBe('groq/llama-x');
    expect(h.repo.mission(id)!.model).toBe('groq/llama-x');
  });

  it('with nothing chosen the runtime picks, and attempts record no model', async () => {
    const { byRole, recorded, plannerModel } = await run(null, {});
    expect(Object.values(byRole).every((v) => v === null)).toBe(true);
    expect(plannerModel).toBeNull();
    expect(recorded.every(([, m]) => m === null)).toBe(true);
  });
});
