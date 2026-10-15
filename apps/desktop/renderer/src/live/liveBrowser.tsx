// The operator's live browser: a real Chromium tab in the daemon, streamed about six frames a second
// and driven by your mouse, wheel and keyboard. Every tab is a fresh, isolated context (no cookies or
// storage shared with your own browser or with agents). Agents never drive this view.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, cx, Icon, IconButton } from '../ui/primitives';
import { IArrowRight, IChevronLeft, IChevronRight, IClose, IGlobe, ILock, IRetry, IShield } from '../lib/icons';
import type { RequestOf } from '@atlas/contracts';
import { call, type LiveBrowserState } from './api';
import { toast } from './toast';

const FRAME_MS = 166;
const TYPE_FLUSH_MS = 30;
const WHEEL_FLUSH_MS = 40;
const MOVE_MS = 100;
const SPECIAL = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const MOD_KEY = /^([A-Za-z0-9]|[-=[\];',./`\\])$/;

type Session = { id: string; width: number; height: number };
type Link = 'idle' | 'opening' | 'live' | 'paused' | 'reconnecting';
type Input = Omit<RequestOf<'browser.live.input'>, 'sessionId'>;

/** What the address bar accepts: a full http(s) URL, a loopback host:port, a domain, or else a web search. */
export function toAddress(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(t) && !/\s/.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

export function LiveBrowser() {
  const [session, setSession] = useState<Session | null>(null);
  const [page, setPage] = useState<LiveBrowserState>({ url: '', title: '' });
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [link, setLink] = useState<Link>('idle');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const visible = useRef(true);
  const sessionRef = useRef<Session | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const typed = useRef<{ text: string; timer: number | null }>({ text: '', timer: null });
  const wheel = useRef<{ dx: number; dy: number; x: number; y: number; timer: number | null }>({ dx: 0, dy: 0, x: 0, y: 0, timer: null });
  const move = useRef<{ at: number; timer: number | null; x: number; y: number }>({ at: 0, timer: null, x: 0, y: 0 });
  sessionRef.current = session;

  useEffect(() => { void call('browser.live.urls', {}).then(setSuggestions).catch(() => setSuggestions([])); }, []);

  // Pause streaming while the view is scrolled away or the window is hidden.
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => { visible.current = e.isIntersecting; });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Close the tab when the operator leaves the Browser screen.
  useEffect(() => () => { const s = sessionRef.current; if (s) void call('browser.live.close', { sessionId: s.id }).catch(() => {}); }, []);

  useEffect(() => { if (!editing) setAddress(page.url === 'about:blank' ? '' : page.url); }, [page.url, editing]);

  // The frame loop: one request in flight at a time, about FRAME_MS apart.
  useEffect(() => {
    if (!session) return;
    let stop = false;
    let timer: number | undefined;
    let failures = 0;
    const tick = async () => {
      if (stop) return;
      const t0 = performance.now();
      if (document.hidden || !visible.current) setLink('paused');
      else {
        try {
          const f = await call('browser.live.frame', { sessionId: session.id });
          if (stop) return;
          failures = 0;
          setSrc(`data:${f.mime};base64,${f.png}`);
          setPage((p) => (p.url === f.url && p.title === f.title ? p : { url: f.url, title: f.title }));
          setLink('live');
        } catch (e) {
          if (stop) return;
          if ((e as { kind?: string }).kind === 'stale_session' || ++failures > 20) { setSession(null); setSrc(null); setLink('idle'); setError('The browser tab closed. Enter an address to open a new one.'); return; }
          setLink('reconnecting');
        }
      }
      timer = window.setTimeout(() => { void tick(); }, Math.max(16, FRAME_MS - (performance.now() - t0)));
    };
    void tick();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [session]);

  /** Inputs go out strictly in order; navigation-like ones update the address bar from the result. */
  const send = useCallback((input: Input) => {
    const s = sessionRef.current;
    if (!s) return Promise.resolve();
    const nav = ['navigate', 'back', 'forward', 'reload'].includes(input.kind);
    if (nav) setLoading(true);
    const run = chain.current.then(() => call('browser.live.input', { sessionId: s.id, ...input }));
    chain.current = run.catch(() => {});
    return run.then((r) => {
      setPage({ url: r.url, title: r.title });
      if (r.error && nav) setError(r.error); else if (nav) setError(null);
    }, (e: Error) => { if (nav) setError(e.message); }).finally(() => { if (nav) setLoading(false); });
  }, []);

  const flushTyped = useCallback(() => {
    const t = typed.current;
    if (t.timer != null) { window.clearTimeout(t.timer); t.timer = null; }
    if (!t.text) return;
    const text = t.text;
    t.text = '';
    void send({ kind: 'type', text });
  }, [send]);

  const open = useCallback(async (raw: string) => {
    const url = toAddress(raw);
    if (!url) return;
    setEditing(false);
    setError(null);
    if (sessionRef.current) { await send({ kind: 'navigate', url }); return; }
    const box = stage.current?.getBoundingClientRect();
    const width = Math.round(Math.min(2560, Math.max(320, box?.width ?? 1280)));
    const height = Math.round(Math.min(1600, Math.max(240, box?.height ?? 800)));
    setLink('opening');
    setLoading(true);
    try {
      const r = await call('browser.live.open', { url, width, height });
      setSession({ id: r.sessionId, width: r.width, height: r.height });
      setPage({ url: r.url, title: r.title });
      if (r.error) setError(r.error);
      window.setTimeout(() => stage.current?.focus(), 0);
    } catch (e) {
      setLink('idle');
      toast({ tone: 'danger', title: 'Could not open the page', body: (e as Error).message });
    } finally { setLoading(false); }
  }, [send]);

  const closeTab = useCallback(() => {
    const s = sessionRef.current;
    setSession(null); setSrc(null); setLink('idle'); setError(null); setPage({ url: '', title: '' });
    if (s) void call('browser.live.close', { sessionId: s.id }).catch(() => {});
  }, []);

  /** Map a pointer position on the frame to the page's own viewport coordinates. */
  const toPage = (clientX: number, clientY: number) => {
    const s = sessionRef.current, el = img.current;
    if (!s || !el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = ((clientX - r.left) / r.width) * s.width, y = ((clientY - r.top) / r.height) * s.height;
    return x < 0 || y < 0 || x > s.width || y > s.height ? null : { x, y };
  };

  const onClick = (e: React.MouseEvent) => {
    stage.current?.focus();
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    flushTyped();
    void send({ kind: 'click', ...p });
  };

  const onMove = (e: React.MouseEvent) => {
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    const m = move.current;
    m.x = p.x; m.y = p.y;
    if (m.timer != null) return;
    m.timer = window.setTimeout(() => { m.timer = null; m.at = Date.now(); void send({ kind: 'move', x: m.x, y: m.y }); }, Math.max(0, MOVE_MS - (Date.now() - m.at)));
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    const w = wheel.current;
    const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    w.dx += e.deltaX * scale; w.dy += e.deltaY * scale; w.x = p.x; w.y = p.y;
    if (w.timer != null) return;
    w.timer = window.setTimeout(() => {
      const clamp = (v: number) => Math.max(-10_000, Math.min(10_000, Math.round(v)));
      const { dx, dy, x, y } = w;
      w.dx = 0; w.dy = 0; w.timer = null;
      if (dx || dy) void send({ kind: 'scroll', x, y, dx: clamp(dx), dy: clamp(dy) });
    }, WHEEL_FLUSH_MS);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!sessionRef.current) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta'].filter(Boolean) as string[];
    if (e.key.length === 1 && !mods.length) {
      e.preventDefault();
      const t = typed.current;
      t.text += e.key;
      if (t.text.length >= 200) flushTyped();
      else if (t.timer == null) t.timer = window.setTimeout(flushTyped, TYPE_FLUSH_MS);
      return;
    }
    let key: string | null = null;
    if (SPECIAL.has(e.key)) key = e.key;
    else if (mods.length && MOD_KEY.test(e.key)) key = e.key.toLowerCase();
    if (!key) return;
    e.preventDefault();
    flushTyped();
    const combo = [...mods, ...(e.shiftKey && (mods.length || SPECIAL.has(e.key)) ? ['Shift'] : []), key].join('+');
    void send({ kind: 'key', key: combo });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text || !sessionRef.current) return;
    e.preventDefault();
    flushTyped();
    void send({ kind: 'type', text: text.slice(0, 2000) });
  };

  const secure = page.url.startsWith('https://');
  const chip = link === 'live' ? 'Live' : link === 'opening' ? 'Connecting' : link === 'paused' ? 'Paused' : link === 'reconnecting' ? 'Reconnecting' : 'Idle';

  return (
    <div className="lv-lb" data-testid="live-browser">
      <form className="lv-lb-bar" onSubmit={(e) => { e.preventDefault(); void open(address); }}>
        <IconButton icon={IChevronLeft} label="Back" size="sm" disabled={!session} onClick={() => void send({ kind: 'back' })} />
        <IconButton icon={IChevronRight} label="Forward" size="sm" disabled={!session} onClick={() => void send({ kind: 'forward' })} />
        <IconButton icon={IRetry} label="Reload" size="sm" disabled={!session} onClick={() => void send({ kind: 'reload' })} />
        <label className={cx('lv-lb-url', loading && 'lv-lb-url--loading')}>
          <Icon as={secure ? ILock : IGlobe} size="sm" className={secure ? 'lv-lb-secure' : 'at-subtle'} />
          <input data-testid="live-browser-url" value={address} list="lv-lb-suggest" spellCheck={false} autoComplete="off" placeholder="Enter an https address, or http://127.0.0.1:port for an app on this machine"
            onFocus={(e) => { setEditing(true); e.currentTarget.select(); }} onBlur={() => setEditing(false)} onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(false); setAddress(page.url); e.currentTarget.blur(); } }} />
          <datalist id="lv-lb-suggest">{suggestions.map((u) => <option key={u} value={u} />)}</datalist>
        </label>
        <Button size="sm" variant="primary" icon={IArrowRight} type="submit" disabled={!address.trim() || link === 'opening'}>Go</Button>
        <span className="lv-lb-chip" data-link={link} data-testid="live-browser-status"><i />{chip}</span>
        {session && <IconButton icon={IClose} label="Close tab" size="sm" onClick={closeTab} />}
      </form>
      {error && <div className="lv-lb-error" role="status">{error}</div>}
      <div ref={stage} className={cx('lv-lb-stage', focused && 'lv-lb-stage--focus')} tabIndex={0} data-testid="live-browser-viewport" aria-label={page.title ? `Live page: ${page.title}` : 'Live browser viewport'}
        onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); flushTyped(); }} onKeyDown={onKeyDown} onPaste={onPaste}>
        {session && src ? (
          <img ref={img} className="lv-lb-img" src={src} alt={page.title || 'Live page'} draggable={false} onClick={onClick} onMouseMove={onMove} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()} />
        ) : session ? (
          <div className="lv-lb-empty at-subtle">Loading {page.url || 'page'}…</div>
        ) : (
          <div className="lv-lb-empty">
            <span className="lv-lb-empty-icon"><Icon as={IGlobe} /></span>
            <div className="heading">A real browser, live inside ATLAS</div>
            <p className="at-muted">Open a staging deploy, a preview on 127.0.0.1, or any https site. Click, scroll and type here exactly as in a normal browser. Each tab is a fresh, isolated profile with no cookies shared.</p>
            {suggestions.length > 0 && (
              <div className="lv-lb-suggest">
                <span className="at-label">Recent deployments</span>
                {suggestions.slice(0, 6).map((u) => <button key={u} type="button" className="lv-lb-sugg" onClick={() => { setAddress(u); void open(u); }}><Icon as={IGlobe} size="sm" /><span className="at-trunc">{u}</span></button>)}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="lv-lb-foot">
        <Icon as={IShield} size="sm" />
        <span>Isolated profile · https anywhere, http only on this machine · downloads blocked</span>
        <span className="lv-lb-spacer" />
        {session && <span className="at-mono at-trunc">{page.title || '—'}</span>}
        {session && <span className="at-mono at-subtle">{session.width}×{session.height}</span>}
        <span className="at-subtle">{focused ? 'Keyboard goes to the page · Esc in the address bar cancels' : 'Click the page to interact'}</span>
      </div>
    </div>
  );
}
