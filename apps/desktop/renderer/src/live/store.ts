// Renderer view state. The daemon is the source of truth; this only caches what it last said.
import { useSyncExternalStore } from 'react';
import type { AtlasEvent, Workspace } from '@atlas/contracts';
import { bridge, call, type DaemonStatus, type MissionListItem } from './api';

export type Route =
  | { screen: 'projects' }
  | { screen: 'new'; workspaceId?: string; item?: { id: string; title: string; detail: string } }
  | { screen: 'team'; workspaceId?: string }
  | { screen: 'mission'; missionId: string }
  | { screen: 'settings' }
  | { screen: 'preview' };

interface LiveState {
  route: Route;
  status: DaemonStatus;
  workspaces: Workspace[];
  missions: MissionListItem[];
  /** Bumped on every daemon event so subscribed views can refetch. */
  tick: number;
  palette: boolean;
  /** Incremented on every opening so the palette starts each session empty. */
  paletteSession: number;
}

let state: LiveState = {
  route: (() => { try { const r = JSON.parse(localStorage.getItem('atlas:route') ?? 'null'); return r && r.screen !== 'preview' ? r : { screen: 'projects' }; } catch { return { screen: 'projects' }; } })(),
  status: { state: 'starting', pid: null, restarts: 0 },
  workspaces: [],
  missions: [],
  tick: 0,
  palette: false,
  paletteSession: 0,
};
const listeners = new Set<() => void>();
const eventListeners = new Set<(e: AtlasEvent) => void>();

export function set(patch: Partial<LiveState>) {
  state = { ...state, ...patch };
  if (patch.route) { try { localStorage.setItem('atlas:route', JSON.stringify(patch.route)); } catch { /* storage unavailable */ } }
  listeners.forEach((l) => l());
}
export const get = () => state;
export const go = (route: Route) => set({ route, palette: false });

export function useLive<T>(sel: (s: LiveState) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => sel(state), () => sel(state));
}

export function onEvent(fn: (e: AtlasEvent) => void) { eventListeners.add(fn); return () => { eventListeners.delete(fn); }; }

export async function refreshLists() {
  const [workspaces, missions] = await Promise.all([call('workspace.list'), call('mission.list', {})]);
  set({ workspaces, missions });
}

let refreshTimer: number | undefined;
export function connect() {
  if (!bridge) return;
  bridge.onStatus((status) => {
    set({ status });
    if (status.state === 'ready') void refreshLists().catch(() => {});
  });
  bridge.onEvent((e) => {
    eventListeners.forEach((l) => l(e));
    set({ tick: state.tick + 1 });
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => { void refreshLists().catch(() => {}); }, 200);
  });
  // The daemon may already be ready before the renderer subscribed.
  void call('app.info').then((info) => { set({ status: info.daemon }); return refreshLists(); }).catch(() => {});
}
