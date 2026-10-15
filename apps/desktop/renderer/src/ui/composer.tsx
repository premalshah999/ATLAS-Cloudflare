import React, { useEffect, useRef, useState } from 'react';
import { agents, live, workspace, models } from '../data/source';
import { cx, Icon, IconButton, RoleMark, Seg, Kbd, Tip, Select } from './primitives';
import { IAttach, IAt, ISlash, ISend, IStop, IRepo, IBranch, IShield, ICpu, IFile, IFolder, IPause, IShield as IReview, IHelp, IBan } from '../lib/icons';

const slash = [
  { cmd: '/plan', desc: 'Draft a plan without executing', icon: IHelp },
  { cmd: '/delegate', desc: 'Hand a task to another agent', icon: IAt },
  { cmd: '/pause', desc: 'Pause after the current step', icon: IPause },
  { cmd: '/review', desc: 'Ask an agent to review a change', icon: IReview },
  { cmd: '/constrain', desc: 'Add a rule the agent must keep', icon: IBan },
  { cmd: '/checkpoint', desc: 'Snapshot the worktree now', icon: IShield },
];
const files = ['src/auth/session.ts', 'src/auth/tokens.ts', 'src/middleware.ts', 'db/migrations/', 'e2e/auth.spec.ts'];

export function Composer({ placeholder = 'Direct this agent — it keeps its context.', running = true, quick = [], onSend, mode: initialMode = 'execute', large, autoFocus, target }: {
  placeholder?: string; running?: boolean; quick?: string[]; onSend?: (text: string) => void; mode?: 'plan' | 'execute'; large?: boolean; autoFocus?: boolean; target?: React.ReactNode;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'plan' | 'execute'>(initialMode);
  const [model, setModel] = useState('sonnet');
  const [menu, setMenu] = useState<null | 'slash' | 'at' | 'file'>(null);
  const [mi, setMi] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ta.current; if (!t) return;
    t.style.height = '0px'; t.style.height = Math.min(large ? 220 : 140, Math.max(large ? 72 : 22, t.scrollHeight)) + 'px';
    const word = text.slice(0, t.selectionStart).split(/\s/).pop() ?? '';
    setMenu(word.startsWith('/') && !text.slice(0, t.selectionStart - word.length).trim() ? 'slash' : word.startsWith('@') ? 'at' : word.startsWith('#') ? 'file' : null);
  }, [text]);
  useEffect(() => setMi(0), [menu]);
  const word = (ta.current ? text.slice(0, ta.current.selectionStart) : text).split(/\s/).pop() ?? '';
  const items: { key: string; node: React.ReactNode; insert: string }[] =
    menu === 'slash' ? slash.filter((s) => s.cmd.startsWith(word)).map((s) => ({ key: s.cmd, insert: s.cmd + ' ', node: <><Icon as={s.icon} /><span className="at-mono">{s.cmd}</span><span className="at-hint">{s.desc}</span></> }))
      : menu === 'at' ? agents.filter((a) => a.name.toLowerCase().includes(word.slice(1).toLowerCase()) || a.mark.toLowerCase().startsWith(word.slice(1).toLowerCase())).map((a) => ({ key: a.id, insert: '@' + a.name.replace(/\s/g, '') + ' ', node: <><RoleMark mark={a.mark} s={a.status} size="sm" /><span>{a.name}</span><span className="at-hint">{a.status === 'idle' ? 'idle' : a.status}</span></> }))
        : menu === 'file' ? files.filter((f) => f.includes(word.slice(1))).map((f) => ({ key: f, insert: '#' + f + ' ', node: <><Icon as={f.endsWith('/') ? IFolder : IFile} /><span className="at-mono">{f}</span></> })) : [];
  const pick = (ins: string) => {
    const t = ta.current!; const pos = t.selectionStart;
    const before = text.slice(0, pos - word.length); const after = text.slice(pos);
    setText(before + ins + after); setMenu(null);
    requestAnimationFrame(() => { t.focus(); const p = (before + ins).length; t.setSelectionRange(p, p); });
  };
  const send = () => { if (!text.trim()) return; onSend?.(text.trim()); setText(''); };
  return (
    <div className={cx('at-composer', large && 'at-composer--large')}>
      {quick.length > 0 && (
        <div className="at-composer-quick">
          {quick.map((q) => <button key={q} type="button" className="at-chip" onClick={() => { setText(q); ta.current?.focus(); }}>{q}</button>)}
        </div>
      )}
      <div className="at-composer-box">
        {menu && items.length > 0 && (
          <div className="at-pop at-composer-menu" role="listbox">
            <div className="at-label at-menu-label">{menu === 'slash' ? 'Commands' : menu === 'at' ? 'Mention an agent' : 'Reference a file'}</div>
            {items.slice(0, 7).map((it, i) => <button key={it.key} type="button" className="at-menu-item" data-active={i === mi} onMouseMove={() => setMi(i)} onMouseDown={(e) => { e.preventDefault(); pick(it.insert); }}>{it.node}</button>)}
          </div>
        )}
        {target && <div className="at-composer-target"><span className="at-subtle">To</span> {target}</div>}
        <textarea ref={ta} value={text} autoFocus={autoFocus} rows={1} placeholder={placeholder} spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (menu && items.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMi((i) => (i + 1) % Math.min(7, items.length)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMi((i) => (i - 1 + Math.min(7, items.length)) % Math.min(7, items.length)); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[mi].insert); return; }
              if (e.key === 'Escape') { setMenu(null); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }} />
        <div className="at-composer-bar">
          <IconButton icon={IAttach} label="Attach file or screenshot" size="sm" />
          <IconButton icon={IAt} label="Mention agent" kbd="@" size="sm" onClick={() => { setText((t) => t + '@'); ta.current?.focus(); }} />
          <IconButton icon={ISlash} label="Commands" kbd="/" size="sm" onClick={() => { setText('/'); ta.current?.focus(); }} />
          <span className="at-sep-v" style={{ margin: '4px 4px' }} />
          <Seg value={mode} onChange={setMode} items={[{ id: 'plan', label: 'Plan' }, { id: 'execute', label: 'Execute' }]} />
          <div style={{ width: 168 }}><Select value={live.on ? (models[0]?.id ?? model) : model} onChange={setModel} icon={ICpu} options={live.on ? models.map((m) => ({ id: m.id, label: m.name })) : [{ id: 'opus', label: 'Claude Opus 5.5' }, { id: 'sonnet', label: 'Claude Sonnet 5.5' }, { id: 'haiku', label: 'Claude Haiku 5.5' }]} /></div>
          <span style={{ flex: 1 }} />
          <Tip label={live.on ? 'Writes: the agent’s worktree only · Shell: safe list, sandboxed · Network: off unless approved' : 'Writes: src/auth/** · Shell: allowlist · Network: off'}><span className="at-composer-perm"><Icon as={IShield} size="sm" />scoped</span></Tip>
          <span className="at-composer-ctx"><Icon as={IRepo} size="sm" />{live.on ? workspace.name : 'storefront'}<Icon as={IBranch} size="sm" />{live.on ? workspace.branch : 'auth-refactor'}</span>
          {running && !text ? <IconButton icon={IStop} label="Stop after current step" kbd="⌘ ." size="sm" danger />
            : <button type="button" className="at-composer-send" aria-label="Send" onClick={send} disabled={!text.trim()}><Icon as={ISend} size="sm" /></button>}
        </div>
      </div>
      <div className="at-composer-hint"><Kbd k="↵" /> send <Kbd k="⇧ ↵" /> newline <Kbd k="/" /> commands <Kbd k="@" /> agents <Kbd k="#" /> files</div>
    </div>
  );
}
