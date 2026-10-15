// Command palette (⌘K): every navigation and action in the live app, plus mission search.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { IconType } from 'react-icons';
import { Dot, Icon, Kbd, usePresence } from '../ui/primitives';
import { IEnter, IFolderOpen, IHome, IPalette, IPlus, ISearch, ISettings, IShield, IFolder } from '../lib/icons';
import { get, go, set, useLive } from './store';
import { openRepository, dotFor } from './shell';
import { missionStatus } from './format';

interface Cmd { id: string; label: string; group: string; icon?: IconType; dot?: string; hint?: string; kbd?: string; keywords?: string; run: () => void }

/** Subsequence match with a bonus for contiguous and word-start hits. 0 = no match. */
export function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase(), s = q.toLowerCase();
  if (t.includes(s)) return 100 - t.indexOf(s);
  let ti = 0, hits = 0;
  for (const ch of s) { ti = t.indexOf(ch, ti); if (ti < 0) return 0; hits++; ti++; }
  return hits;
}

export function LivePalette() {
  const open = useLive((s) => s.palette);
  const { mounted, closing } = usePresence(open, 160);
  // A new opening is a new session: query and selection never carry over from the last one.
  const session = useLive((s) => s.paletteSession);
  if (!mounted) return null;
  return <PaletteSession key={session} closing={closing} />;
}

function PaletteSession({ closing }: { closing: boolean }) {
  const missions = useLive((s) => s.missions);
  const workspaces = useLive((s) => s.workspaces);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => set({ palette: false });

  const commands = useMemo<Cmd[]>(() => {
    const pending = missions.filter((m) => m.pendingApprovals > 0);
    return [
      ...pending.map((m) => ({ id: `ap-${m.id}`, label: `Review ${m.pendingApprovals} pending approval${m.pendingApprovals === 1 ? '' : 's'} · ${m.title}`, group: 'Needs you', icon: IShield, run: () => go({ screen: 'mission', missionId: m.id }) })),
      { id: 'new', label: 'New mission', group: 'Actions', icon: IPlus, kbd: '⌘ N', run: () => go({ screen: 'new' }) },
      { id: 'open', label: 'Open repository…', group: 'Actions', icon: IFolderOpen, kbd: '⌘ O', run: () => { close(); void openRepository(); } },
      ...workspaces.map((w) => ({ id: `nw-${w.id}`, label: `New mission in ${w.name}`, group: 'Actions', icon: IFolder, hint: w.branch ?? '', run: () => go({ screen: 'new', workspaceId: w.id }) })),
      { id: 'projects', label: 'Projects', group: 'Go to', icon: IHome, kbd: '⌘ 1', run: () => go({ screen: 'projects' }) },
      { id: 'settings', label: 'Settings', group: 'Go to', icon: ISettings, kbd: '⌘ ,', run: () => go({ screen: 'settings' }) },
      { id: 'preview', label: 'Design preview (sample data)', group: 'Go to', icon: IPalette, run: () => go({ screen: 'preview' }) },
      ...missions.map((m) => ({ id: `m-${m.id}`, label: m.title, group: 'Missions', dot: dotFor(m), hint: missionStatus(m).word, keywords: `${m.id} ${m.goal}`, run: () => go({ screen: 'mission', missionId: m.id }) })),
    ];
  }, [missions, workspaces]);

  const results = useMemo(() => commands
    .map((c) => ({ c, s: Math.max(score(q, c.label), score(q, c.keywords ?? '') * 0.8) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => (q ? b.s - a.s : 0))
    .map((x) => x.c), [q, commands]);
  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  const groups: Record<string, Cmd[]> = {};
  results.forEach((c) => { (groups[c.group] ??= []).push(c); });
  let n = -1;
  return (
    <>
      <div className="at-scrim" data-closing={closing} onMouseDown={close} />
      <div className="at-palette" data-closing={closing} role="dialog" aria-label="Command palette" data-testid={closing ? undefined : 'palette'}>
        <div className="at-palette-input">
          <Icon as={ISearch} size="lg" className="at-subtle" />
          <input autoFocus readOnly={closing} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search missions and commands…" aria-label="Search missions and commands"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
              if (e.key === 'Enter') { e.preventDefault(); results[idx]?.run(); }
              if (e.key === 'Escape') close();
            }} />
        </div>
        <div className="at-palette-list" ref={listRef}>
          {results.length === 0 && <div className="at-palette-empty">Nothing matches “{q}”.</div>}
          {Object.entries(groups).map(([g, cs]) => (
            <div key={g} className="at-palette-group">
              <div className="at-label at-palette-glabel">{g}</div>
              {cs.map((c) => {
                n++; const i = n;
                return (
                  <button key={c.id} type="button" className="at-palette-item" data-active={i === idx} onMouseMove={() => setIdx(i)} onClick={() => c.run()}>
                    {c.dot ? <Dot s={c.dot} /> : c.icon ? <Icon as={c.icon} /> : null}
                    <span className="at-trunc">{c.label}</span>
                    {c.hint && <span className="at-palette-hint at-trunc">{c.hint}</span>}
                    {c.kbd ? <Kbd k={c.kbd} /> : i === idx ? <Icon as={IEnter} size="sm" className="at-subtle" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="at-palette-foot">
          <span><Kbd k="↑" /><Kbd k="↓" /> navigate</span><span><Kbd k="↵" /> run</span><span><Kbd k="esc" /> close</span>
          <span style={{ flex: 1 }} /><span className="at-subtle">{results.length} results</span>
        </div>
      </div>
    </>
  );
}

export const togglePalette = () => { const s = get(); set(s.palette ? { palette: false } : { palette: true, paletteSession: s.paletteSession + 1 }); };
