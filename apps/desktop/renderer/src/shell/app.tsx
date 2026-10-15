import React, { useEffect } from 'react';
import { actions, useApp, setCurrentStore, type Store, type ScreenId } from '../lib/store';
import { cx } from '../ui/primitives';
import { TitleBar, Rail, StatusBar, Inspector, ActivityDrawer, CheckpointDrawer } from './shell';
import { CommandPalette, ApprovalDialog, Toasts, NotificationCenter } from '../ui/overlays';
import { screens } from '../screens';
import { openRepository } from '../lib/workspace';

const withInspector: ScreenId[] = ['mission', 'agent', 'activity'];

/** One region failing must not blank the app: show what failed, keep the rest working. */
class Guard extends React.Component<{ name: string; children: React.ReactNode }, { error: Error | null; stack: string }> {
  override state = { error: null as Error | null, stack: "" };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: React.ErrorInfo) { this.setState({ stack: (info.componentStack ?? '').split('\n').slice(0, 4).join(' ‹ ') }); console.warn(`[design] ${this.props.name}:`, error.message); }
  override render() {
    if (!this.state.error) return this.props.children;
    return <div className="at-guard" role="alert" data-testid={`guard-${this.props.name}`}><b>{this.props.name}</b> could not render: {this.state.error.message}<span className="at-mono at-subtle">{this.state.stack}</span><button type="button" className="at-btn at-btn--sm" onClick={() => this.setState({ error: null })}>Retry</button></div>;
  }
}

function Keys() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const A = actions(); const s = A.get();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); A.set({ palette: !s.palette }); return; }
      if (e.key === 'Escape') { if (s.palette) A.set({ palette: false }); else if (s.drawer) A.set({ drawer: null }); else if (s.notifications) A.set({ notifications: false }); else if (s.recovery) A.set({ recovery: false }); return; }
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (mod && e.key === '\\') { e.preventDefault(); A.set({ sidebar: !s.sidebar }); }
      if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); A.set({ drawer: s.drawer === 'activity' ? null : 'activity' }); }
      if (mod && e.altKey && e.code === 'KeyI') { e.preventDefault(); A.set({ inspector: !s.inspector }); }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openRepository(); return; }
      if (mod && e.key === ',') { e.preventDefault(); A.go('settings'); }
      const map: Record<string, ScreenId> = { '1': 'home', '2': 'mission', '3': 'agent', '4': 'review', '5': 'deploy' };
      if (mod && map[e.key]) { e.preventDefault(); A.go(map[e.key]); }
      if (e.ctrlKey && e.key === '`') { e.preventDefault(); A.go('terminal'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return null;
}

export function AtlasApp({ store, frame = true }: { store: Store; frame?: boolean }) {
  setCurrentStore(store);
  const screen = useApp((s) => s.screen);
  const inspector = useApp((s) => s.inspector);
  const motion = useApp((s) => s.motion);
  useApp((s) => s.dataVersion); // live data replaced in place: re-render every screen
  const Screen = screens[screen];
  if (screen === 'welcome') {
    return (
      <div className={cx('at-root at-frame', frame && 'at-frame--window')} data-motion={motion}>
        <Keys />
        <div className="at-welcome-shell"><div className="at-titlebar at-titlebar--bare"><div className="at-traffic" aria-hidden><i /><i /><i /></div></div><Guard name="Welcome"><Screen /></Guard></div>
        <Toasts />
      </div>
    );
  }
  return (
    <div className={cx('at-root at-frame', frame && 'at-frame--window')} data-motion={motion}>
      <Keys />
      <div className="at-app">
        <Guard name="Title bar"><TitleBar /></Guard>
        <Guard name="Rail"><Rail /></Guard>
        <div className="at-body">
          <main className="at-canvas" key={screen}><Guard key={screen} name={`Screen ${screen}`}><Screen /></Guard></main>
          {inspector && withInspector.includes(screen) && <Guard name="Inspector"><Inspector /></Guard>}
          <Guard name="Activity drawer"><ActivityDrawer /></Guard>
          <Guard name="Checkpoints"><CheckpointDrawer /></Guard>
        </div>
        <Guard name="Status bar"><StatusBar /></Guard>
        <Guard name="Notifications"><NotificationCenter /></Guard>
      </div>
      <Guard name="Palette"><CommandPalette /></Guard>
      <Guard name="Approval dialog"><ApprovalDialog /></Guard>
      <Toasts />
    </div>
  );
}
