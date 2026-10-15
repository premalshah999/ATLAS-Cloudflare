import { useSyncExternalStore, useEffect, useRef } from 'react';
import type { AgentStatus, Approval, TimelineEvent } from '../data/types';
/** Illustrative repository shown in the design preview title bar. */
export interface RepoInfo { path: string; name: string; isGit: boolean; branch?: string; head?: string; dirty?: number; ahead?: number; behind?: number }
import { approvals as sampleApprovals, timeline as sampleTimeline, liveEvents, liveTermLines } from '../data/source';

export type ScreenId =
  | 'welcome' | 'home' | 'workspaces' | 'create' | 'mission' | 'graph' | 'agent' | 'terminal' | 'review'
  | 'computer' | 'deploy' | 'studio' | 'settings' | 'report' | 'activity'
  /** Live pages hosted inside the dashboard (registered by the live app through slots.Page). */
  | 'projects' | 'team' | 'preferences';

export interface Toast { id: number; tone: 'success' | 'warning' | 'danger' | 'info' | 'human'; title: string; body?: string; action?: { label: string; screen?: ScreenId } }

export interface AppState {
  screen: ScreenId;
  sidebar: boolean;
  inspector: boolean;
  agent: string;
  palette: boolean;
  approvalDialog: string | null;
  approvals: Approval[];
  resolved: Record<string, 'approved' | 'denied'>;
  scopes: Record<string, string>;
  toasts: Toast[];
  notifications: boolean;
  drawer: null | 'activity' | 'checkpoints';
  recovery: boolean;
  timeline: TimelineEvent[];
  live: number;
  paused: boolean;
  agentStatus: Record<string, AgentStatus>;
  term: Record<string, string[]>;
  takeover: boolean;
  missionTab: 'control' | 'graph' | 'report';
  motion: 'full' | 'reduced';
  simulate: boolean;
  /** A real repository opened through the desktop bridge; sample workspace when unset. */
  repo: RepoInfo | null;
  /** Bumped whenever the runtime adapter replaces the screens' data (data/source.ts). */
  dataVersion: number;
  /** Live: the mission Mission Control shows. */
  missionId: string | null;
}

const initial: AppState = {
  screen: 'mission', sidebar: false, inspector: true, agent: 'be', palette: false, approvalDialog: null,
  approvals: sampleApprovals, resolved: {}, scopes: {}, toasts: [], notifications: false, drawer: null, recovery: false,
  timeline: sampleTimeline, live: 0, paused: false, agentStatus: {}, term: {}, takeover: false, missionTab: 'control',
  motion: 'full', simulate: true, repo: null, dataVersion: 0, missionId: null,
};

type Listener = () => void;

/**
 * Real effects behind the design screens' actions. Unset in the design preview (sample behaviour); the live app
 * installs it (live/designActions.ts) so approving, directing an agent, launching or deciding reaches the control plane.
 */
export interface DesignAdapter {
  resolve(approvalId: string, verdict: 'approved' | 'denied'): Promise<void>;
  direct(agentId: string, text: string): Promise<void>;
  launch(goal: string, opts?: { constraints?: string; target?: string | null; title?: string }): Promise<void>;
  decide(decision: 'accept' | 'reject'): Promise<void>;
  stop(agentId?: string): Promise<void>;
  reverify(): Promise<void>;
  setTier(tier: 'default' | 'fast' | 'strong', model: string): Promise<void>;
  exportAudit(): Promise<void>;
  /** Leave the design screens for a full live page (settings, team, projects). */
  openLive(screen: 'settings' | 'team' | 'projects'): void;
}
export let adapter: DesignAdapter | null = null;
/** Live components the design screens host (the operator's real sandboxed terminal). */
export const slots: { HumanTerminal?: () => JSX.Element; Shot?: (p: { artifactId: string; alt: string }) => JSX.Element; Page?: Partial<Record<'projects' | 'team' | 'preferences', () => JSX.Element>> } = {};
export const setAdapter = (a: DesignAdapter | null) => { adapter = a; };
export function createStore(init: Partial<AppState> = {}) {
  const wide = typeof window === 'undefined' || window.innerWidth >= 1300;
  let state: AppState = { ...initial, inspector: wide, ...init };
  const listeners = new Set<Listener>();
  let toastId = 1;
  const api = {
    get: () => state,
    subscribe: (l: Listener) => { listeners.add(l); return () => listeners.delete(l); },
    set: (patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      listeners.forEach((l) => l());
    },
    go: (screen: ScreenId, extra: Partial<AppState> = {}) => api.set({ screen, palette: false, notifications: false, ...extra }),
    selectAgent: (id: string, open = true) => api.set((s) => ({ agent: id, inspector: open ? true : s.inspector })),
    toast: (t: Omit<Toast, 'id'>) => {
      const id = toastId++;
      api.set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
      setTimeout(() => api.dismiss(id), 6000);
    },
    dismiss: (id: number) => api.set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
    resolve: (id: string, verdict: 'approved' | 'denied', scope?: string) => {
      const ap = state.approvals.find((a) => a.id === id);
      api.set((s) => ({ resolved: { ...s.resolved, [id]: verdict }, scopes: { ...s.scopes, [id]: scope ?? ap?.duration ?? '' }, approvalDialog: null }));
      if (adapter) { void adapter.resolve(id, verdict).catch((e: Error) => api.toast({ tone: 'danger', title: 'Approval not recorded', body: e.message })); return; }
      if (ap) api.toast({
        tone: verdict === 'approved' ? 'info' : 'warning',
        title: verdict === 'approved' ? `Approved · ${ap.title.toLowerCase()}` : `Denied · ${ap.title.toLowerCase()}`,
        body: verdict === 'approved' ? `${scope ?? ap.duration}. The agent continues.` : 'The agent was told why and will propose an alternative.',
      });
    },
    tick: () => {
      const s = state;
      if (s.paused || s.live >= liveEvents.length) return;
      const ev = liveEvents[s.live];
      const term = { ...s.term };
      if (ev.agent === 'be' && ev.kind === 'test') term['t-be'] = liveTermLines['t-be'];
      const patch: Partial<AppState> = { timeline: [...s.timeline, ev], live: s.live + 1, term };
      api.set(patch);
      if (ev.kind === 'milestone') api.toast({ tone: 'success', title: ev.title, body: ev.detail });
    },
  };
  return api;
}
export type Store = ReturnType<typeof createStore>;

let current: Store = createStore();
export const setCurrentStore = (s: Store) => { current = s; };
export const getStore = () => current;

export function useApp<T>(sel: (s: AppState) => T): T {
  const st = current;
  return useSyncExternalStore(st.subscribe, () => sel(st.get()), () => sel(st.get()));
}
export const actions = () => current;

// Sample adapter clock: advances the scripted mission only while Mission Control is on screen and not paused.
export function useSimulation(active: boolean) {
  const ref = useRef<number | null>(null);
  useEffect(() => {
    const st = current;
    if (!active || !st.get().simulate) return;
    ref.current = window.setInterval(() => st.tick(), 3200);
    return () => { if (ref.current) window.clearInterval(ref.current); };
  }, [active]);
}

export const lsGet = (k: string, d: number) => { try { const v = localStorage.getItem('atlas:' + k); return v ? Number(v) : d; } catch { return d; } };
export const lsSet = (k: string, v: number) => { try { localStorage.setItem('atlas:' + k, String(v)); } catch { /* storage unavailable */ } };
