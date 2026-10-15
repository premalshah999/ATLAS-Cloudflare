import { it, expect } from 'vitest';
import { publishMission } from '../../packages/cloudflare/src/index';
import { samplePlanner, sampleRegressionScript, sampleSlugifyScript } from '@atlas/runtime-fake';
import { sampleRepo } from '../helpers';
import { makeOrchestrator, startMission } from './harness';

// Opt-in: talks to a deployed Worker and real Cloudflare Artifacts (billable operations).
const url = process.env.ATLAS_CLOUD_URL, secret = process.env.ATLAS_CLOUD_TOKEN;

it.runIf(url && secret)('live: concurrent mission checkpoints publish to Artifacts and every remote hash matches', async () => {
  const root = sampleRepo();
  const h = makeOrchestrator({ scripts: [sampleRegressionScript, sampleSlugifyScript], planner: samplePlanner });
  try {
    const id = await startMission(h, root, { goal: '[parallel sample] Fix slugify and add regression coverage.' });
    await h.orch.settle(id);
    const m = h.repo.mission(id)!;
    expect(m.state).toBe('completed');
    const pub = await publishMission({ root, missionId: m.id, baseCommit: m.baseCommit!, url: url!, secret: secret! });
    console.log(JSON.stringify(pub, null, 2));
    expect(pub.verified).toBe(true);
    expect(pub.refs.length).toBeGreaterThanOrEqual(3);
    expect(pub.refs.every((r) => r.matches)).toBe(true);
  } finally { await h.orch.shutdown(); h.db.close(); }
}, 300_000);
