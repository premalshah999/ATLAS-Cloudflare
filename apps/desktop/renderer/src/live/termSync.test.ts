import { describe, expect, it } from 'vitest';
import { attachGate } from './termSync';

describe('attachGate (P1-5)', () => {
  it('writes the snapshot once, drops pushes it already contains, keeps later ones in order', () => {
    let screen = '';
    const g = attachGate((d) => { screen += d; }, () => {});
    g.push({ sessionId: 's', data: 'abc', seq: 3 }); // raced the snapshot: already in it
    g.push({ sessionId: 's', data: 'de', seq: 5 }); // after it
    g.snapshot('xyzabc', 3);
    g.push({ sessionId: 's', data: 'f', seq: 6 });
    expect(screen).toBe('xyzabcdef');
  });
  it('reports exit even when it arrives before the snapshot', () => {
    let code: number | null | undefined;
    const g = attachGate(() => {}, (c) => { code = c; });
    g.push({ sessionId: 's', exit: 0 });
    expect(code).toBeUndefined();
    g.snapshot('', 0);
    expect(code).toBe(0);
  });
});
