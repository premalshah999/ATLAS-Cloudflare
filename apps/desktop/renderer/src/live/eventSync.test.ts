import { describe, expect, it } from 'vitest';
import type { AtlasEvent } from '@atlas/contracts';
import { fetchAllSince, mergeInOrder } from './eventSync';

const ev = (seq: number) => ({ missionId: 'm', seq, type: 'agent.message', ts: '', actor: { kind: 'operator' }, taskId: null, attemptId: null, payload: {}, artifactIds: [] }) as AtlasEvent;
const log = Array.from({ length: 4321 }, (_, i) => ev(i + 1));
const daemon = (page: number) => async (after: number) => log.filter((e) => e.seq > after).slice(0, page);

describe('mission event sync', () => {
  it('pages until the whole log is fetched (regression: stopped after the first 2000 events)', async () => {
    const got = await fetchAllSince(daemon(2000), 0);
    expect(got.length).toBe(4321);
    expect(got.at(-1)!.seq).toBe(4321);
    expect(mergeInOrder([], got).length).toBe(4321);
  });
  it('stops on an exact multiple of the page size', async () => {
    const exact = Array.from({ length: 4000 }, (_, i) => ev(i + 1));
    let calls = 0;
    const got = await fetchAllSince(async (after) => { calls++; return exact.filter((e) => e.seq > after).slice(0, 2000); }, 0);
    expect(got.length).toBe(4000);
    expect(calls).toBe(3);
  });
  it('merges without duplicates or gaps', () => {
    const a = mergeInOrder([], [ev(1), ev(2)]);
    expect(mergeInOrder(a, [ev(2), ev(3), ev(5)]).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe('stalledTasks (P1-6)', () => {
  const ev = (seq: number, type: string, attemptId: string | null, taskId: string | null) => ({ missionId: 'm', seq, type, ts: '', actor: { kind: 'operator' }, taskId, attemptId, payload: {}, artifactIds: [] }) as any;
  it('flags a task only while the stall is the latest event of its attempt', async () => {
    const { stalledTasks } = await import('./format');
    expect([...stalledTasks([ev(1, 'attempt.started', 'a1', 't1'), ev(2, 'attempt.stalled', 'a1', 't1')])]).toEqual(['t1']);
    expect([...stalledTasks([ev(1, 'attempt.stalled', 'a1', 't1'), ev(2, 'agent.message', 'a1', 't1')])]).toEqual([]);
    expect([...stalledTasks([ev(1, 'attempt.stalled', 'a1', 't1'), ev(2, 'mission.state', null, null)])]).toEqual(['t1']);
  });
});
