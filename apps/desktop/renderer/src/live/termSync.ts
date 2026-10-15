// Attaching to a daemon-side terminal (evolution P1-5): subscribe first, then take the snapshot. Pushes that
// arrive before the snapshot are held; afterwards only chunks that end past the snapshot's seq are written, so
// nothing is lost or shown twice.
export interface TermMsg { sessionId: string; data?: string; seq?: number; exit?: number | null }

export function attachGate(write: (data: string) => void, onExit: (code: number | null) => void) {
  let base: number | null = null;
  const held: TermMsg[] = [];
  const apply = (m: TermMsg) => {
    if (m.data !== undefined && (m.seq === undefined || m.seq > base!)) write(m.data);
    if (m.exit !== undefined) onExit(m.exit);
  };
  return {
    push(m: TermMsg) { if (base === null) held.push(m); else apply(m); },
    snapshot(text: string, seq: number) {
      write(text);
      base = seq;
      for (const m of held.splice(0)) apply(m);
    },
  };
}
