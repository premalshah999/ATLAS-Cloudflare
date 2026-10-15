// Real effects for the design screens' actions (lib/store DesignAdapter), and the hook that keeps the design data
// in sync with the control plane while those screens are open.
import { useEffect, useState } from 'react';
import { setAdapter, type Store } from '../lib/store';
import { live } from '../data/source';
import { call } from './api';
import { buildSnapshot, hydrate, shortId } from './designBridge';
import { refreshLists, useLive, get, go } from './store';
import { installDesignSlots } from './designSlots';

async function currentMission() {
  const id = live.missionId;
  if (!id) throw new Error('No mission is open in Mission Control.');
  return call('mission.get', { missionId: id });
}

export function installDesignAdapter(store: Store) {
  setAdapter({
    async resolve(approvalId, verdict) {
      await call('approval.respond', { approvalId, decision: verdict === 'approved' ? 'approve' : 'deny' });
    },
    async direct(agentId, text) {
      const snap = await currentMission();
      const t = snap.tasks.find((x) => x.key === agentId) ?? snap.tasks.find((x) => x.state === 'running');
      if (!t) throw new Error('No agent of this mission is running.');
      await call('task.direct', { taskId: t.id, text });
      store.toast({ tone: 'info', title: `Directed ${t.key}`, body: 'Delivered as its next turn. It keeps its context.' });
    },
    async launch(goal, opts = {}) {
      const { workspaces, missions } = get();
      const wsId = missions.find((m) => m.id === live.missionId)?.workspaceId ?? workspaces[0]?.id;
      if (!wsId) throw new Error('Open a repository first (Projects → Open repository).');
      const health = await call('runtime.health').catch(() => []);
      const runtime = health.find((h) => h.runtime === 'pi')?.ok ? 'pi' : 'fake';
      const title = opts.title ?? (goal.split(/[.\n]/)[0].slice(0, 80) || 'New mission');
      const m = await call('mission.create', { workspaceId: wsId, title, goal, constraints: opts.constraints ?? '', approvalMode: 'ask_risky', runtime, targetEnvironment: opts.target ?? null });
      store.set({ missionId: m.id });
      live.missionId = m.id;
      await refreshLists();
      store.go('mission');
      store.toast({ tone: 'info', title: `${title} — planning`, body: runtime === 'pi' ? 'The orchestrator model is planning. You approve the plan before anything runs.' : 'No model key: the scripted runtime plans it.' });
      void call('mission.plan', { missionId: m.id }).catch((e: Error) => store.toast({ tone: 'danger', title: 'Planning failed', body: e.message }));
    },
    async decide(decision) {
      const snap = await currentMission();
      await call('mission.decide', { missionId: snap.mission.id, decision });
      store.toast({ tone: decision === 'accept' ? 'success' : 'warning', title: decision === 'accept' ? 'Changes accepted' : 'Changes rejected', body: decision === 'accept' ? 'The integration branch is kept for you to merge or publish.' : 'Isolated work removed; your checkout was never touched.' });
    },
    async setTier(tier, model) {
      await call('settings.set', { key: `models.${tier}`, value: model } as never);
    },
    async exportAudit() {
      const r = await call('mission.export', { missionId: live.missionId });
      if (r) store.toast({ tone: 'success', title: 'Audit log exported', body: `${r.records} records · SHA-256 ${r.sha256.slice(0, 16)}… → ${r.path}` });
    },
    openLive(screen) { go({ screen } as never); },
    async reverify() {
      const snap = await currentMission();
      await call('mission.reverify', { missionId: snap.mission.id });
      store.toast({ tone: 'info', title: 'Re-running verification' });
    },
    async stop(agentId) {
      const snap = await currentMission();
      const t = agentId ? snap.tasks.find((x) => x.key === agentId) : undefined;
      if (t) await call('task.cancel', { taskId: t.id });
      else await call('mission.cancel', { missionId: snap.mission.id });
      store.toast({ tone: 'warning', title: t ? `Stopped ${t.key}` : 'Mission stopped' });
    },
  });
}

/** While the design screens are open: rebuild their data from the control plane on every change. */
export function useDesignLive(store: Store, active: boolean) {
  const tick = useLive((s) => s.tick);
  const missions = useLive((s) => s.missions);
  const workspaces = useLive((s) => s.workspaces);
  const [sel, setSel] = useState(store.get().missionId);
  useEffect(() => { const off = store.subscribe(() => { const id = store.get().missionId; setSel((x) => (x === id ? x : id)); }); return () => { off(); }; }, [store]);
  useEffect(() => { if (active) { installDesignAdapter(store); installDesignSlots(); } return () => setAdapter(null); }, [active, store]);
  useEffect(() => { if (active) void call('settings.get').then((st) => { (window as unknown as Record<string, unknown>).__atlasTargets = st.values['deploy.allowedTargets']; }).catch(() => {}); }, [active]);
  useEffect(() => {
    if (!active) return;
    let off = false;
    const t = window.setTimeout(() => {
      void buildSnapshot(store.get().missionId, missions, workspaces as never).then((r) => {
        if (off || !r) return;
        hydrate(r.snap, r.missionId);
        const w = window as unknown as Record<string, unknown>;
        w.__atlasMissionIds = Object.fromEntries(missions.map((m) => [shortId(m.id), m.id]));
        w.__atlasOpenApprovals = new Set(r.snap.approvals.map((a) => a.id));
        const s = store.get();
        const agentOk = r.snap.agents.some((a) => a.id === s.agent);
        const running = r.snap.agents.find((a) => a.status === 'running' && a.id !== 'orch');
        store.set({ simulate: false, approvals: r.snap.approvals, timeline: r.snap.timeline, live: 0, missionId: r.missionId, dataVersion: s.dataVersion + 1, agent: agentOk ? s.agent : running?.id ?? r.snap.agents[0]?.id ?? 'orch',
          repo: (() => { const w = r.snap.workspace; return { path: w.path, name: w.name, isGit: true, branch: w.branch, head: w.head }; })() });
      }).catch(() => {});
    }, 250);
    return () => { off = true; window.clearTimeout(t); };
  }, [active, store, tick, missions, workspaces, sel]);
}
