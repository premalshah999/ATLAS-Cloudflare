// Live application shell: title bar, rail, canvas and status bar wired to the daemon.
import React from 'react';
import type { IconType } from 'react-icons';
import { cx, Dot, Icon, Kbd, Menu, MenuItem, Tip } from '../ui/primitives';
import { IActivity, IAgents, IReviews, IDeploy, ITerminal, IGlobe, IBranch, IChevronDown, IFolder, IFolderOpen, IHome, IWorkspaces, IMissions, IPlus, ISettings, IPalette, ISearch, IShield, IUsers } from '../lib/icons';
import { call } from './api';
import { go, refreshLists, useLive, type Route } from './store';
import { missionStatus } from './format';
import { toast } from './toast';
import { togglePalette } from './palette';

export async function openRepository(): Promise<string | null> {
  try {
    const w = await call('workspace.open');
    if (!w) return null;
    await refreshLists();
    toast(w.isGit
      ? { tone: 'info', title: `Opened ${w.name}`, body: `${w.branch ?? 'detached'} · ${w.head?.slice(0, 7) ?? 'no commits'}${w.dirty ? ` · ${w.dirty} uncommitted change${w.dirty === 1 ? '' : 's'}` : ' · clean'}` }
      : { tone: 'warning', title: `Opened ${w.name}`, body: 'Not a git repository. Missions need git to create isolated worktrees.' });
    return w.id;
  } catch (e) {
    toast({ tone: 'danger', title: 'Could not open the folder', body: (e as Error).message });
    return null;
  }
}

const NAV: { id: Route['screen']; label: string; icon: IconType; kbd?: string }[] = [
  { id: 'home', label: 'Home', icon: IHome, kbd: '⌘ 0' },
  { id: 'projects', label: 'Projects', icon: IWorkspaces, kbd: '⌘ 1' },
  { id: 'new', label: 'New mission', icon: IPlus, kbd: '⌘ N' },
  { id: 'team', label: 'Team', icon: IUsers, kbd: '⌘ 2' },
  { id: 'agents', label: 'Agents', icon: IAgents, kbd: '⌘ 4' },
  { id: 'reviews', label: 'Reviews', icon: IReviews, kbd: '⌘ 5' },
  { id: 'deployments', label: 'Deployments', icon: IDeploy, kbd: '⌘ 6' },
  { id: 'activity', label: 'Activity', icon: IActivity, kbd: '⌘ 3' },
  { id: 'terminal', label: 'Terminal', icon: ITerminal, kbd: '⌘ 7' },
  { id: 'browser', label: 'Browser & desktop', icon: IGlobe, kbd: '⌘ 8' },
];

export function LiveTitleBar() {
  const route = useLive((s) => s.route);
  const workspaces = useLive((s) => s.workspaces);
  const missions = useLive((s) => s.missions);
  const current = route.screen === 'mission' ? missions.find((m) => m.id === route.missionId) : undefined;
  const ws = workspaces.find((w) => w.id === (current?.workspaceId ?? (route.screen === 'new' ? route.workspaceId : undefined))) ?? workspaces[0];
  return (
    <header className="at-titlebar">
      <div className="at-traffic" aria-hidden><i /><i /><i /></div>
      <Menu width={320} trigger={(open, t) => (
        <button type="button" className="at-tb-ws" onClick={t} aria-expanded={open}>
          <span className="at-tb-wsmark">{(ws?.name ?? 'A').charAt(0).toUpperCase()}</span>
          <span className="at-tb-wsname">{ws?.name ?? 'No project'}</span><Icon as={IChevronDown} size="sm" className="at-subtle" />
        </button>
      )}>
        {(close) => (
          <>
            <div className="at-label at-menu-label">Projects</div>
            {workspaces.map((w) => <MenuItem key={w.id} icon={IFolder} active={w.id === ws?.id} hint={w.branch ?? ''} onClick={() => { close(); go({ screen: 'new', workspaceId: w.id }); }}>{w.name}</MenuItem>)}
            {workspaces.length > 0 && <div className="at-menu-sep" />}
            <MenuItem icon={IFolderOpen} kbd="⌘ O" onClick={() => { close(); void openRepository(); }}>Open repository…</MenuItem>
          </>
        )}
      </Menu>
      {ws?.isGit && <Tip label={`HEAD ${ws.head?.slice(0, 7)} · ${ws.dirty ? `${ws.dirty} uncommitted` : 'clean'} · ${ws.root}`}><span className="at-tb-branch"><Icon as={IBranch} size="sm" />{ws.branch}</span></Tip>}
      {current && (
        <>
          <span className="at-sep-v" />
          <button type="button" className="at-tb-mission" onClick={() => go({ screen: 'mission', missionId: current.id })}>
            <Dot s={missionStatus(current).dot} />
            <span className="at-trunc">{current.title}</span>
            <span className="at-subtle">{missionStatus(current).word}</span>
          </button>
        </>
      )}
      <button type="button" className="at-tb-search lv-tb-search" onClick={togglePalette} data-testid="open-palette">
        <Icon as={ISearch} size="sm" /><span className="at-trunc">Search missions and commands</span><Kbd k="⌘ K" />
      </button>
      <span style={{ flex: 1 }} />
      <NeedsYouChip />
    </header>
  );
}

function NeedsYouChip() {
  const missions = useLive((s) => s.missions);
  const waiting = missions.filter((m) => m.pendingApprovals > 0 || m.state === 'awaiting_approval');
  const n = waiting.reduce((a, m) => a + m.pendingApprovals + (m.state === 'awaiting_approval' ? 1 : 0), 0);
  if (!n) return null;
  return (
    <Tip label={`${n} decision${n === 1 ? '' : 's'} waiting: ${waiting.map((m) => m.title).join(', ')}`}>
      <button type="button" className="lv-needs-chip" data-testid="needs-you-chip" onClick={() => go({ screen: 'mission', missionId: waiting[0].id })}>
        <Icon as={IShield} size="sm" />{n} need{n === 1 ? 's' : ''} you
      </button>
    </Tip>
  );
}

export const dotFor = (m: { state: string; verdict?: string | null }) => missionStatus(m).dot;

export function LiveRail() {
  const route = useLive((s) => s.route);
  const missions = useLive((s) => s.missions);
  const item = (n: (typeof NAV)[number]) => (
    <Tip key={n.id} label={n.label} kbd={n.kbd} side="right" delay={250}>
      <button type="button" className="at-rail-item" aria-current={route.screen === n.id ? 'page' : undefined} aria-label={n.label} onClick={() => go(n.id === 'new' ? { screen: 'new' } : { screen: n.id } as Route)}>
        <Icon as={n.icon} size="lg" />
      </button>
    </Tip>
  );
  const active = missions.filter((m) => ['planning', 'awaiting_approval', 'running', 'verifying'].includes(m.state));
  const needs = missions.filter((m) => m.pendingApprovals > 0 || m.state === 'awaiting_approval');
  return (
    <nav className="at-rail" aria-label="Primary">
      <div className="at-rail-group">
        {NAV.map(item)}
        <Tip label={active.length ? `${active.length} active mission${active.length === 1 ? '' : 's'}` : 'Missions'} side="right" delay={250}>
          <button type="button" className="at-rail-item" aria-label="Missions" aria-current={route.screen === 'mission' ? 'page' : undefined}
            onClick={() => { const m = needs[0] ?? active[0] ?? missions[0]; if (m) go({ screen: 'mission', missionId: m.id }); else go({ screen: 'projects' }); }}>
            <Icon as={IMissions} size="lg" />
            {needs.length > 0 ? <span className="at-rail-badge lv-badge-warn">{needs.length}</span> : active.length > 0 && <span className="at-rail-badge">{active.length}</span>}
          </button>
        </Tip>
      </div>
      <div style={{ flex: 1 }} />
      <div className="at-rail-group">
        <Tip label="Command center · the full mission-control design on live data" side="right" delay={250}>
          <button type="button" className="at-rail-item" aria-label="Command center" onClick={() => go({ screen: 'preview' })}><Icon as={IPalette} size="lg" /></button>
        </Tip>
        <Tip label="Settings" kbd="⌘ ," side="right" delay={250}>
          <button type="button" className="at-rail-item" aria-label="Settings" aria-current={route.screen === 'settings' ? 'page' : undefined} onClick={() => go({ screen: 'settings' })}><Icon as={ISettings} size="lg" /></button>
        </Tip>
      </div>
    </nav>
  );
}

export function LiveStatusBar() {
  const status = useLive((s) => s.status);
  const missions = useLive((s) => s.missions);
  const running = missions.filter((m) => m.state === 'running' || m.state === 'verifying').length;
  const waiting = missions.reduce((a, m) => a + m.pendingApprovals + (m.state === 'awaiting_approval' ? 1 : 0), 0);
  const word = { starting: 'Daemon starting', ready: 'Daemon ready', restarting: 'Daemon restarting', stopped: 'Daemon stopped' }[status.state];
  return (
    <footer className="at-statusbar" data-testid="statusbar">
      <Tip label={status.detail ?? `Control plane process${status.pid ? ` · pid ${status.pid}` : ''}`}>
        <span className="at-sb-item" data-testid="daemon-status" data-state={status.state}><Dot s={status.state === 'ready' ? 'healthy' : status.state === 'restarting' ? 'waiting' : 'idle'} />{word}{status.restarts ? ` · ${status.restarts} restart${status.restarts === 1 ? '' : 's'}` : ''}</span>
      </Tip>
      <span className="at-sep-v" style={{ margin: '6px 2px' }} />
      <span className="at-sb-item">{running} running</span>
      <span className={cx('at-sb-item', waiting > 0 && 'at-warn')} data-testid="awaiting-count">{waiting} awaiting you</span>
      <span style={{ flex: 1 }} />
      <span className="at-sb-item at-subtle">Local-first · governed execution · explicit cloud publication</span>
      <button type="button" className="at-sb-item at-sb-btn" onClick={togglePalette} aria-label="Command palette"><Kbd k="⌘ K" /></button>
    </footer>
  );
}

export function PreviewBanner({ onExit, live }: { onExit: () => void; live?: boolean }) {
  return (
    <div className={cx('lv-preview-banner', live && 'lv-preview-banner--live')} role="status" data-live={live ? 'true' : 'false'}>
      <span>{live ? 'Command center · live data from your ATLAS control plane: missions, agents, terminals, reviews and deployments.' : 'Design preview · every value on these screens is sample data, not your projects.'}</span>
      <button type="button" className="at-btn at-btn--sm" onClick={onExit}><Icon as={IHome} size="sm" />Back to ATLAS</button>
    </div>
  );
}
