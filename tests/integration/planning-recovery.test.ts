import { expect, it, vi } from 'vitest';
import { FakeRuntime } from '@atlas/runtime-fake';
import { replay } from '@atlas/orchestrator';
import { sampleRepo } from '../helpers';
import { makeOrchestrator } from './harness';

it('recovers interrupted planning without calling an unavailable provider or starting tools', async () => {
  const runtime = new FakeRuntime();
  const planner = vi.fn(async () => { throw new Error('Provider is unavailable; startup must not call it.'); });
  runtime.plan = planner;
  const h = makeOrchestrator({ runtime });
  try {
    const workspace = await h.orch.registerWorkspace(sampleRepo());
    const mission = h.orch.createMission({ workspaceId: workspace.id, title: 'Interrupted planning', goal: 'Inspect the repository', constraints: '', approvalMode: 'ask_risky', runtime: 'fake' });
    // Persist the crash boundary, before a provider returned its plan.
    h.repo.updateMission(mission.id, { state: 'planning' });
    h.repo.append({ missionId: mission.id, taskId: null, attemptId: null, type: 'mission.state', actor: { kind: 'system', component: 'state' }, payload: { from: 'draft', to: 'planning' }, artifactIds: [] });
    const recovered = await h.orch.recover();
    expect(recovered.missions).toContain(mission.id);
    expect(planner).not.toHaveBeenCalled();
    expect(h.repo.mission(mission.id)!.state).toBe('awaiting_approval');
    expect(h.repo.attempts(mission.id)).toEqual([]);
    expect(h.events.some(e => e.type === 'plan.proposed' && e.payload.source === 'default')).toBe(true);
    expect(replay(h.repo.eventsSince(mission.id, 0)).mission).toBe('awaiting_approval');
  } finally { await h.orch.shutdown(); h.db.close(); }
});
