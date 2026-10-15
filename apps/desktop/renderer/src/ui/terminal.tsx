import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalSession, TermLine } from '../data/types';
import { agentById, live, workspace } from '../data/source';
import { cx, Icon, IconButton, RoleMark, Badge, Tip } from './primitives';
import { IPlus, ISearch, ICopy, IRecord, IClose, ISplit, IArrowUp, IArrowDown, IHand } from '../lib/icons';

const lineClass: Record<string, string> = { cmd: 'at-tl-cmd', ok: 'at-ok', err: 'at-err', warn: 'at-warn', dim: 'at-subtle', info: 'at-acc', path: 'at-tcyan' };

function renderText(text: string, q: string) {
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((p, i) => (p.toLowerCase() === q.toLowerCase() ? <mark key={i} className="at-tmark">{p}</mark> : p));
}

function Line({ l, prompt, q }: { l: TermLine; prompt: React.ReactNode; q: string }) {
  if (l.t === 'cmd') return <div className="at-tline at-tl-cmd">{prompt}<span>{renderText(l.text, q)}</span></div>;
  if (l.segs) return <div className="at-tline">{l.segs.map((s, i) => <span key={i} style={s.c ? { color: s.c } : undefined}>{renderText(s.text, q)}</span>)}</div>;
  return <div className={cx('at-tline', l.t && lineClass[l.t])}>{renderText(l.text, q) || ' '}</div>;
}

export function ExitChip({ s }: { s: TerminalSession }) {
  if (s.status === 'running') return <Badge tone="accent"><span className="at-act" style={{ height: 8, width: 8 }}><i /><i /><i /></span>running · {s.duration}</Badge>;
  if (s.status === 'idle') return <Badge tone="outline">idle</Badge>;
  if (s.exit === 0) return <Badge tone="success">exit 0 · {s.duration}</Badge>;
  return <Badge tone="danger">exit {s.exit} · {s.duration}</Badge>;
}

export function TerminalView({ s, extra = [], focused, onFocus, onClose, onSplit, showHeader = true, simulatedLabel = true }: {
  s: TerminalSession; extra?: string[]; focused?: boolean; onFocus?: () => void; onClose?: () => void; onSplit?: () => void; showHeader?: boolean; simulatedLabel?: boolean;
}) {
  const [search, setSearch] = useState(false);
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState<TermLine[]>([]);
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const agent = s.agent ? agentById(s.agent) : null;
  const lines = useMemo<TermLine[]>(() => [...s.lines, ...extra.map((t) => ({ t: (t.includes('passed') || t.includes('✓') ? 'ok' : 'out') as TermLine['t'], text: t })), ...typed], [s, extra, typed]);
  const status = extra.length && s.id === 't-be' ? { ...s, status: 'exited' as const, exit: 0, duration: '4.1s' } : s;
  useEffect(() => { const b = bodyRef.current; if (b) b.scrollTop = b.scrollHeight; }, [lines.length]);
  const matches = q ? lines.filter((l) => (l.text + (l.segs?.map((x) => x.text).join('') ?? '')).toLowerCase().includes(q.toLowerCase())).length : 0;
  const human = s.owner === 'human';
  const prompt = human
    ? <span className="at-tprompt"><span className="at-tcyan">{live.on ? workspace.path : '~/code/acme/storefront'}</span> <span className="at-subtle">({live.on ? workspace.branch : 'feat/auth-refactor'})</span> <span className="at-human-c">❯</span> </span>
    : <span className="at-tprompt"><span className="at-subtle">{s.cwd}</span> <span className="at-acc">❯</span> </span>;

  return (
    <div className={cx('at-term', focused && 'at-term--focus', human && 'at-term--human')} onMouseDown={onFocus}
      onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); setSearch(true); } }}>
      {showHeader && (
        <div className="at-term-head">
          {human ? <RoleMark mark="YOU" size="sm" human /> : <RoleMark mark={agent!.mark} size="sm" s={agent!.status} />}
          <span className="at-term-owner">{human ? 'You' : agent!.name}</span>
          <span className="at-mono at-subtle at-trunc" title={s.command}>{s.command}</span>
          <span style={{ flex: 1 }} />
          {s.recording && <Tip label="Session is recorded · replay from Activity"><span className="at-rec"><Icon as={IRecord} size="sm" />REC</span></Tip>}
          <ExitChip s={status} />
          <IconButton icon={ISearch} label="Search output" kbd="⌘ F" size="sm" onClick={() => setSearch(!search)} pressed={search} />
          <IconButton icon={ICopy} label="Copy output" size="sm" />
          {onSplit && <IconButton icon={ISplit} label="Split pane" kbd="⌘ D" size="sm" onClick={onSplit} />}
          {onClose && <IconButton icon={IClose} label="Close pane" size="sm" onClick={onClose} />}
        </div>
      )}
      {search && (
        <div className="at-term-search">
          <Icon as={ISearch} size="sm" className="at-subtle" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find in scrollback" onKeyDown={(e) => e.key === 'Escape' && (setSearch(false), setQ(''))} />
          <span className="at-mono at-subtle at-tnum">{q ? `${matches} lines` : ''}</span>
          <IconButton icon={IArrowUp} label="Previous" size="sm" /><IconButton icon={IArrowDown} label="Next" size="sm" />
          <IconButton icon={IClose} label="Close search" size="sm" onClick={() => { setSearch(false); setQ(''); }} />
        </div>
      )}
      <div className="at-term-body" ref={bodyRef}>
        {lines.map((l, i) => <Line key={i} l={l} prompt={prompt} q={q} />)}
        {human ? (
          <form className="at-tline at-tinput" onSubmit={(e) => { e.preventDefault(); if (!input.trim()) return; setTyped((t) => [...t, { t: 'cmd', text: input }, { t: 'dim', text: 'prototype · input is echoed, not executed' }]); setInput(''); }}>
            {prompt}<input value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} aria-label="Terminal input" /><span className="at-caret" />
          </form>
        ) : status.status === 'running' ? (
          <div className="at-tline">{prompt}<span className="at-caret at-caret--busy" /></div>
        ) : null}
      </div>
      <div className="at-term-foot">
        <span className="at-mono at-subtle">pid {s.pid}</span>
        <span className="at-mono at-subtle">{s.cwd}</span>
        <span style={{ flex: 1 }} />
        {simulatedLabel && !human && <span className="at-mono at-subtle at-trunc">{live.on ? 'recorded process output · sandboxed' : 'sample output · not a live process'}</span>}
        {human && <span className="at-row" style={{ gap: 6 }}><Icon as={IHand} size="sm" className="at-human-c" /><span className="at-mono at-subtle">human session · agents cannot write here</span></span>}
      </div>
    </div>
  );
}

export function TermTabs({ sessions, active, onSelect }: { sessions: TerminalSession[]; active: string; onSelect: (id: string) => void }) {
  return (
    <div className="at-ttabs" role="tablist">
      {sessions.map((s) => {
        const a = s.agent ? agentById(s.agent) : null;
        return (
          <button key={s.id} role="tab" type="button" aria-selected={s.id === active} className="at-ttab" onClick={() => onSelect(s.id)} data-human={s.owner === 'human'}>
            <span className={cx('at-ttab-owner', s.owner === 'human' && 'at-human-c')}>{a ? a.mark : 'YOU'}</span>
            <span className="at-trunc">{s.title}</span>
            {s.status === 'running' ? <span className="at-act" style={{ width: 8, height: 8 }}><i /><i /><i /></span>
              : s.status === 'failed' || (s.exit ?? 0) > 0 ? <span className="at-sdot" data-s="failed" /> : s.status === 'exited' ? <span className="at-sdot" data-s="done" /> : null}
          </button>
        );
      })}
      <span style={{ flex: 1 }} />
      <span className="at-row" style={{ paddingRight: 4, flex: 'none' }}><IconButton icon={IPlus} label="New human shell" kbd="⌃ ⇧ `" size="sm" /></span>
    </div>
  );
}
