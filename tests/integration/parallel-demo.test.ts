import { it, expect } from 'vitest';
import { samplePlanner, sampleRegressionScript, sampleSlugifyScript } from '@atlas/runtime-fake';
import { sampleRepo, sh } from '../helpers';
import { makeOrchestrator, startMission } from './harness';

it('parallel demo overlaps two writers, integrates both and leaves the checkout untouched', async () => {
  const root = sampleRepo();
  const head = sh(root, 'git', ['rev-parse', 'HEAD']);
  const h = makeOrchestrator({ scripts: [sampleRegressionScript, sampleSlugifyScript], planner: samplePlanner });
  try {
    const id = await startMission(h, root, { goal: '[parallel sample] Fix slugify and add regression coverage.' });
    await h.orch.settle(id);
    const tasks = h.repo.tasks(id);
    const impl = tasks.find((t) => t.key === 'implement')!;
    const regression = tasks.find((t) => t.key === 'regression')!;
    const index = (type: string, taskId: string) => h.events.findIndex((e) => e.type === type && e.taskId === taskId);
    expect(index('attempt.started', impl.id)).toBeLessThan(index('attempt.ended', regression.id));
    expect(index('attempt.started', regression.id)).toBeLessThan(index('attempt.ended', impl.id));
    const m = h.repo.mission(id)!;
    expect(m.state).toBe('completed');
    expect(sh(root, 'git', ['show', `${m.integrationCommit}:test/slugify.additional.test.js`])).toContain('accented titles');
    expect(sh(root, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  } finally { await h.orch.shutdown(); h.db.close(); }
});
