// Pure event-log synchronisation used by the mission view. The daemon returns at most one page per call,
// so catching up must keep paging until a short page proves the log is exhausted.
import type { AtlasEvent } from '@atlas/contracts';

export const EVENT_PAGE = 2000;

export async function fetchAllSince(fetchPage: (afterSeq: number) => Promise<AtlasEvent[]>, afterSeq: number, pageSize = EVENT_PAGE): Promise<AtlasEvent[]> {
  const out: AtlasEvent[] = [];
  let after = afterSeq;
  for (;;) {
    const page = await fetchPage(after);
    out.push(...page);
    if (page.length < pageSize || page.length === 0) return out;
    after = page[page.length - 1].seq;
  }
}

/** Append events strictly in sequence: duplicates are dropped and nothing is accepted past a gap. */
export function mergeInOrder(prev: AtlasEvent[], incoming: AtlasEvent[]): AtlasEvent[] {
  const fresh = [...incoming].sort((a, b) => a.seq - b.seq);
  const out = prev.slice();
  for (const e of fresh) if (e.seq === (out.length ? out[out.length - 1].seq : 0) + 1) out.push(e);
  return out.length === prev.length ? prev : out;
}
