// Live mission view: snapshot + ordered event log, resumable after a daemon restart via events.since.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AtlasEvent } from '@atlas/contracts';
import { call, type MissionSnapshot } from './api';
import { onEvent, useLive } from './store';
import { fetchAllSince, mergeInOrder } from './eventSync';

export function useMission(missionId: string) {
  const [snap, setSnap] = useState<MissionSnapshot | null>(null);
  const [events, setEvents] = useState<AtlasEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const status = useLive((s) => s.status.state);

  const reload = useCallback(async () => {
    try {
      const s = await call('mission.get', { missionId });
      setSnap(s);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [missionId]);

  // Merge strictly by sequence: concurrent catch-ups and live pushes may overlap, but each seq is kept once.
  const merge = useCallback((incoming: AtlasEvent[]) => {
    setEvents((prev) => {
      const out = mergeInOrder(prev, incoming);
      lastSeq.current = out.length ? out[out.length - 1].seq : 0;
      return out;
    });
  }, []);

  // Catch up from the last sequence we saw, page by page until the log is exhausted: no gaps, no duplicates.
  const catchUp = useCallback(async () => {
    const more = await fetchAllSince((after) => call('events.since', { missionId, afterSeq: after }), lastSeq.current);
    if (more.length) merge(more);
  }, [missionId, merge]);

  useEffect(() => {
    lastSeq.current = 0;
    setEvents([]);
    setSnap(null);
    void reload();
    void catchUp().catch(() => {});
  }, [missionId, reload, catchUp]);

  useEffect(() => {
    let t: number | undefined;
    return onEvent((e) => {
      if (e.missionId !== missionId) return;
      if (e.seq === lastSeq.current + 1) merge([e]);
      else if (e.seq > lastSeq.current + 1) void catchUp().catch(() => {});
      if (e.type !== 'process.output') { window.clearTimeout(t); t = window.setTimeout(() => void reload(), 120); }
    });
  }, [missionId, reload, catchUp, merge]);

  // After a daemon restart, resync both views.
  useEffect(() => { if (status === 'ready') { void reload(); void catchUp().catch(() => {}); } }, [status, reload, catchUp]);

  return { snap, events, error, reload };
}
