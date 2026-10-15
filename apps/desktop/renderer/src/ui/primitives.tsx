import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import type { IconType } from 'react-icons';
import { IChevronDown, ICheck } from '../lib/icons';
import { lsGet, lsSet } from '../lib/store';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Icon({ as: C, size, className, style }: { as: IconType; size?: 'sm' | 'lg'; className?: string; style?: CSSProperties }) {
  return <C className={cx(size === 'sm' ? 'at-ico-sm' : size === 'lg' ? 'at-ico-lg' : 'at-ico', className)} style={style} aria-hidden />;
}

/* ---------- Tooltip ---------- */
export function Tip({ label, kbd, side = 'bottom', children, delay = 450 }: { label: ReactNode; kbd?: string; side?: 'right' | 'bottom' | 'top' | 'left'; children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number>();
  const show = () => {
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      if (side === 'right') setPos({ x: r.right + 8, y: r.top + r.height / 2 - 12 });
      else if (side === 'left') setPos({ x: r.left - 8, y: r.top + r.height / 2 - 12 });
      else if (side === 'top') setPos({ x: r.left + r.width / 2, y: r.top - 30 });
      else setPos({ x: r.left + r.width / 2, y: r.bottom + 6 });
    }, delay);
  };
  const hide = () => { window.clearTimeout(timer.current); setPos(null); };
  useEffect(() => { const off = () => hide(); window.addEventListener('scroll', off, true); window.addEventListener('blur', off); return () => { window.clearTimeout(timer.current); window.removeEventListener('scroll', off, true); window.removeEventListener('blur', off); }; }, []);
  const centered = side === 'bottom' || side === 'top';
  return (
    <span ref={ref} onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide} onFocus={(e) => { if ((e.target as HTMLElement).matches?.(':focus-visible')) show(); }} onBlur={hide} style={{ display: 'inline-flex' }}>
      {children}
      {pos && (
        <span className="at-tip" role="tooltip" style={{ left: pos.x, top: pos.y, transform: centered ? 'translateX(-50%)' : side === 'left' ? 'translateX(-100%)' : undefined }}>
          {label}{kbd && <Kbd k={kbd} />}
        </span>
      )}
    </span>
  );
}

/* ---------- Buttons ---------- */
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'danger-fill' | 'human'; size?: 'sm' | 'md'; icon?: IconType; iconRight?: IconType; kbd?: string; block?: boolean;
};
export function Button({ variant = 'default', size = 'md', icon, iconRight, kbd, block, className, children, ...rest }: BtnProps) {
  return (
    <button type="button" className={cx('at-btn', variant !== 'default' && `at-btn--${variant}`, size === 'sm' && 'at-btn--sm', block && 'at-btn--block', className)} {...rest}>
      {icon && <Icon as={icon} />}
      {children}
      {iconRight && <Icon as={iconRight} />}
      {kbd && <Kbd k={kbd} />}
    </button>
  );
}

export function IconButton({ icon, label, kbd, size, pressed, danger, side = 'bottom', className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconType; label: string; kbd?: string; size?: 'sm'; pressed?: boolean; danger?: boolean; side?: 'right' | 'bottom' | 'top' | 'left' }) {
  return (
    <Tip label={label} kbd={kbd} side={side}>
      <button type="button" aria-label={label} aria-pressed={pressed} className={cx('at-iconbtn', size === 'sm' && 'at-iconbtn--sm', danger && 'at-iconbtn--danger', className)} {...rest}>
        <Icon as={icon} />
      </button>
    </Tip>
  );
}

export function Kbd({ k }: { k: string }) {
  return <span className="at-kbd-group" style={{ display: 'inline-flex', gap: 2 }}>{k.split(' ').map((p, i) => <kbd key={i} className="at-kbd">{p}</kbd>)}</span>;
}

/* ---------- Badges / status ---------- */
export function Badge({ tone, icon, children, className, title }: { tone?: 'accent' | 'success' | 'warning' | 'danger' | 'human' | 'outline' | 'sample'; icon?: IconType; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cx('at-badge', tone && `at-badge--${tone}`, className)}>{icon && <Icon as={icon} size="sm" />}{children}</span>;
}

export function SampleTag({ children = 'Sample data' }: { children?: ReactNode }) {
  return <Badge tone="sample" title="Illustrative prototype content — not from a live runtime">{children}</Badge>;
}

export function Activity({ paused }: { paused?: boolean }) {
  return <span className={cx('at-act', paused && 'at-act--paused')} aria-hidden><i /><i /><i /></span>;
}

export function Dot({ s }: { s: string }) {
  return <span className="at-sdot" data-s={s} aria-hidden />;
}

const statusWords: Record<string, string> = {
  running: 'Working', waiting: 'Waiting', blocked: 'Blocked', failed: 'Failed', done: 'Done', idle: 'Idle', paused: 'Paused', pending: 'Pending',
  passed: 'Passed', verified: 'Verified', warning: 'Warning', locked: 'Locked', review: 'In review', draft: 'Draft',
};
export function Status({ s, label, paused }: { s: string; label?: ReactNode; paused?: boolean }) {
  return (
    <span className="at-status" data-s={s}>
      {s === 'running' ? <Activity paused={paused} /> : <Dot s={s === 'review' ? 'waiting' : s} />}
      <span>{label ?? statusWords[s] ?? s}</span>
    </span>
  );
}

export function RoleMark({ mark, s, size, human }: { mark: string; s?: string; size?: 'sm' | 'lg' | 'xl'; human?: boolean }) {
  return <span className={cx('at-mark', size && `at-mark--${size}`, human && 'at-mark--human')} data-s={s}>{mark}</span>;
}

/* ---------- Tabs ---------- */
export function Tabs<T extends string>({ items, value, onChange, className }: { items: { id: T; label: ReactNode; count?: number | string; icon?: IconType }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx('at-tabs', className)} role="tablist">
      {items.map((it) => (
        <button key={it.id} role="tab" type="button" className="at-tab" aria-selected={it.id === value} onClick={() => onChange(it.id)}>
          {it.icon && <Icon as={it.icon} size="sm" />}
          {it.label}
          {it.count !== undefined && <span className="at-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ items, value, onChange }: { items: { id: T; label: ReactNode; icon?: IconType }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="at-seg" role="radiogroup">
      {items.map((it) => (
        <button key={it.id} type="button" role="radio" aria-checked={it.id === value} aria-pressed={it.id === value} onClick={() => onChange(it.id)}>
          {it.icon && <Icon as={it.icon} size="sm" />}{it.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Inputs ---------- */
export function Input({ icon, kbd, className, style, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { icon?: IconType; kbd?: string }) {
  return (
    <label className={cx('at-input', className)} style={style}>
      {icon && <Icon as={icon} />}
      <input {...rest} />
      {kbd && <Kbd k={kbd} />}
    </label>
  );
}

export function Field({ label, help, aside, children }: { label: ReactNode; help?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="at-field">
      <div className="at-flabel"><span>{label}</span>{aside}</div>
      {children}
      {help && <div className="at-help">{help}</div>}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange?: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={on} className="at-toggle" onClick={() => onChange?.(!on)} />;
}

export function Check({ on, onChange, label }: { on: boolean; onChange?: (v: boolean) => void; label?: string }) {
  return <button type="button" role="checkbox" aria-label={label} aria-checked={on} className="at-check" onClick={() => onChange?.(!on)}>{on && <ICheck style={{ width: 10, height: 10, strokeWidth: 3 }} />}</button>;
}

export function useOutside(ref: React.RefObject<HTMLElement | null>, on: boolean, close: () => void) {
  useEffect(() => {
    if (!on) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [on]);
}

export function Select<T extends string>({ value, options, onChange, icon, width, align = 'left' }: { value: T; options: { id: T; label: ReactNode; hint?: ReactNode; icon?: IconType }[]; onChange: (v: T) => void; icon?: IconType; width?: number | string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, open, () => setOpen(false));
  const cur = options.find((o) => o.id === value);
  return (
    <div ref={ref} style={{ position: 'relative', width }}>
      <button type="button" className="at-input at-select" style={{ width: '100%' }} onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="at-row" style={{ gap: 8 }}>{icon && <Icon as={icon} />}{cur?.icon && <Icon as={cur.icon} />}<span className="at-trunc">{cur?.label}</span></span>
        <Icon as={IChevronDown} size="sm" />
      </button>
      {open && (
        <div className="at-pop" role="listbox" style={{ top: 'calc(100% + 4px)', [align]: 0, minWidth: '100%' }}>
          {options.map((o) => (
            <button key={o.id} type="button" role="option" aria-selected={o.id === value} className="at-menu-item" data-active={o.id === value} onClick={() => { onChange(o.id); setOpen(false); }}>
              {o.icon && <Icon as={o.icon} />}<span className="at-trunc">{o.label}</span>
              {o.hint ? <span className="at-hint">{o.hint}</span> : o.id === value ? <Icon as={ICheck} className="at-acc" style={{ marginLeft: 'auto' }} /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Menu({ trigger, children, align = 'left', width = 220 }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, open, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger(open, () => setOpen(!open))}
      {open && <div className="at-pop" role="menu" style={{ top: 'calc(100% + 4px)', [align]: 0, width, transformOrigin: align === 'right' ? 'top right' : 'top left' }}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function MenuItem({ icon, children, kbd, hint, onClick, active }: { icon?: IconType; children: ReactNode; kbd?: string; hint?: ReactNode; onClick?: () => void; active?: boolean }) {
  return (
    <button type="button" role="menuitem" className="at-menu-item" data-active={active} onClick={onClick}>
      {icon && <Icon as={icon} />}<span className="at-trunc">{children}</span>
      {hint && <span className="at-hint">{hint}</span>}{kbd && <Kbd k={kbd} />}
    </button>
  );
}

/* ---------- Meters ---------- */
export function Meter({ value, max = 1, tone, style }: { value: number; max?: number; tone?: 'accent' | 'warning' | 'success'; style?: CSSProperties }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return <div className="at-meter" data-tone={tone} style={style} role="meter" aria-valuenow={value} aria-valuemax={max}><i style={{ width: `${pct}%` }} /></div>;
}

export function ContextMeter({ used, limit }: { used: number; limit: number }) {
  const r = used / limit;
  const tone = r > 0.75 ? 'warning' : 'accent';
  return (
    <div className="at-col" style={{ gap: 6 }}>
      <div className="at-row" style={{ justifyContent: 'space-between' }}>
        <span className="at-mono at-tnum">{Math.round(used / 1000)}k <span className="at-subtle">/ {Math.round(limit / 1000)}k tokens</span></span>
        <span className={cx('at-mono at-tnum', r > 0.75 ? 'at-warn' : 'at-muted')}>{Math.round(r * 100)}%</span>
      </div>
      <Meter value={used} max={limit} tone={tone} />
    </div>
  );
}

/* ---------- Panels ---------- */
export function PanelHead({ title, label, icon, children, count }: { title?: ReactNode; label?: ReactNode; icon?: IconType; children?: ReactNode; count?: ReactNode }) {
  return (
    <div className="at-phead">
      {icon && <Icon as={icon} className="at-subtle" />}
      {label && <span className="at-label">{label}</span>}
      {title && <span className="at-ptitle">{title}</span>}
      {count !== undefined && <span className="at-mono at-subtle">{count}</span>}
      <span className="at-spacer" />
      {children}
    </div>
  );
}

export function Section({ label, aside, children, style }: { label?: ReactNode; aside?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <section className="at-section" style={style}>
      {label && <div className="at-label">{label}{aside && <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{aside}</span>}</div>}
      {children}
    </section>
  );
}

export function KV({ rows, col = 96 }: { rows: [ReactNode, ReactNode][]; col?: number }) {
  return (
    <dl className="at-kv" style={{ gridTemplateColumns: `${col}px 1fr` }}>
      {rows.map(([k, v], i) => <React.Fragment key={i}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}
    </dl>
  );
}

export function EmptyState({ icon, title, body, children, center }: { icon: IconType; title: ReactNode; body: ReactNode; children?: ReactNode; center?: boolean }) {
  return (
    <div className={cx('at-empty', center && 'at-empty--center')}>
      <span className="at-empty-glyph"><Icon as={icon} size="lg" /></span>
      <h4>{title}</h4>
      <p>{body}</p>
      {children && <div className="at-row">{children}</div>}
    </div>
  );
}

export function Skeleton({ w = '100%', h = 10, style }: { w?: number | string; h?: number; style?: CSSProperties }) {
  return <div className="at-skel" style={{ width: w, height: h, ...style }} />;
}

/* ---------- Split pane (sizes remembered per workspace via localStorage key) ---------- */
export function Split({ dir = 'h', id, initial, min = 160, max, children, collapsedSecond }: { dir?: 'h' | 'v'; id: string; initial: number; min?: number; max?: number; children: [ReactNode, ReactNode]; collapsedSecond?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => lsGet('split:storefront:' + id, initial));
  const [drag, setDrag] = useState(false);
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current; if (!el) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(true);
    const r = el.getBoundingClientRect();
    const total = dir === 'h' ? r.width : r.height;
    const move = (ev: PointerEvent) => {
      const p = dir === 'h' ? ev.clientX - r.left : ev.clientY - r.top;
      const hi = max ?? total - min;
      const px = Math.max(min, Math.min(hi, p));
      setSize(px / total);
    };
    const up = () => {
      setDrag(false);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setSize((s) => { lsSet('split:storefront:' + id, s); return s; });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const onDouble = () => { setSize(initial); lsSet('split:storefront:' + id, initial); };
  const basis = collapsedSecond ? '100%' : `${size * 100}%`;
  return (
    <div ref={ref} className={cx('at-split', dir === 'h' ? 'at-split--h' : 'at-split--v')}>
      <div className="at-pane" style={{ flex: `0 0 ${basis}`, transition: drag ? 'none' : 'flex-basis var(--dur-3) var(--ease-out)' }}>{children[0]}</div>
      {!collapsedSecond && <div className="at-splitter" data-drag={drag} onPointerDown={onDown} onDoubleClick={onDouble} role="separator" aria-orientation={dir === 'h' ? 'vertical' : 'horizontal'} title="Drag to resize · double-click to reset" />}
      {!collapsedSecond && <div className="at-pane" style={{ flex: '1 1 0' }}>{children[1]}</div>}
    </div>
  );
}

/* ---------- Mount helper for presence animations ---------- */
export function usePresence(open: boolean, ms = 160) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useLayoutEffect(() => {
    if (open) { setMounted(true); setClosing(false); return; }
    if (!mounted) return;
    setClosing(true);
    const t = window.setTimeout(() => { setMounted(false); setClosing(false); }, ms);
    return () => window.clearTimeout(t);
  }, [open]);
  return { mounted, closing };
}
