// Live versions of the design preview's Home, Activity and Agent Studio screens, built only from daemon data.
import React, { useEffect, useState } from 'react';
import type { AtlasEvent } from '@atlas/contracts';
import { Badge, Button, EmptyState, Icon, KV, Status } from '../ui/primitives';
import { IActivity, IAgents, ICheckCircle, IFolderOpen, IHome, IKey, IMissions, IPlus, IShield, IGlobe } from '../lib/icons';
import { call, type MissionListItem, type RoleInfo, type SettingsState } from './api';
import { go, useLive } from './store';
import { ago, describeEvent, missionStatus, roleName } from './format';
import { openRepository } from './shell';

const ACTIVE = new Set(['planning', 'running', 'verifying']);
const needsYou = (m: MissionListItem) => !m.archived && (m.pendingApprovals > 0 || m.state === 'awaiting_approval');
const readyForReview = (m: MissionListItem) => !m.archived && m.state === 'completed' && !m.decision;

function MissionRow({ m, workspace }: { m: MissionListItem; workspace?: string }) {
  const st = missionStatus(m);
  const done = m.tasks.filter((t) => t.state === 'done').length;
  return (
    <button type="button" className="lv-line lv-home-row" data-testid="home-mission" onClick={() => go({ screen: 'mission', missionId: m.id })}>
      <Status s={st.dot} label={st.word} />
      <span className="at-trunc" style={{ flex: 1, textAlign: 'left' }}>{m.title}</span>
      {workspace && <span className="at-subtle lv-small at-trunc">{workspace}</span>}
      {m.tasks.length > 0 && <span className="at-mono at-subtle lv-small">{done}/{m.tasks.length} tasks</span>}
      {m.pendingApprovals > 0 && <Badge tone="warning">{m.pendingApprovals} approval{m.pendingApprovals === 1 ? '' : 's'}</Badge>}
      <span className="at-subtle lv-small">{ago(m.updatedAt)}</span>
    </button>
  );
}

function Group({ label, items, empty, names }: { label: string; items: MissionListItem[]; empty: string; names: Map<string, string> }) {
  return (
    <section className="lv-section" data-testid={`home-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="at-row" style={{ gap: 8 }}><span className="at-label">{label}</span><span className="at-mono at-subtle">{items.length}</span></div>
      {items.length ? items.map((m) => <MissionRow key={m.id} m={m} workspace={names.get(m.workspaceId)} />) : <p className="at-subtle lv-small">{empty}</p>}
    </section>
  );
}

type Setup = { keys: number; sandbox: string; cloud: boolean; settings: SettingsState | null };

export function Home() {
  const missions = useLive((s) => s.missions);
  const workspaces = useLive((s) => s.workspaces);
  const status = useLive((s) => s.status.state);
  const [setup, setSetup] = useState<Setup | null>(null);
  useEffect(() => {
    if (status !== 'ready') return;
    void Promise.all([call('credentials.list'), call('settings.get')]).then(([c, s]) => setSetup({
      keys: c.providers.filter((p) => p.provider !== 'github' && (p.stored || p.fromEnvironment)).length,
      sandbox: s.sandbox.kind, cloud: !!s.values['cloud.url'], settings: s,
    })).catch(() => {});
  }, [status]);
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const live = missions.filter((m) => !m.archived);
  const sorted = [...live].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const verified = live.filter((m) => m.verdict === 'verified').length;
  const accepted = live.filter((m) => m.decision === 'accepted').length;
  const targets = setup?.settings?.values['deploy.allowedTargets'] ?? [];
  const steps: { done: boolean; title: string; detail: string; action?: React.ReactNode }[] = [
    { done: workspaces.length > 0, title: 'Open a repository', detail: workspaces.length ? `${workspaces.length} open` : 'Agents work in isolated worktrees; your checkout is never edited.', action: <Button size="sm" icon={IFolderOpen} onClick={() => void openRepository()}>Open</Button> },
    { done: (setup?.keys ?? 0) > 0, title: 'Add a model provider key', detail: setup?.keys ? `${setup.keys} provider${setup.keys === 1 ? '' : 's'} configured` : 'The local runtime needs no key; model-driven agents do.', action: <Button size="sm" icon={IKey} onClick={() => go({ screen: 'settings' })}>Settings</Button> },
    { done: !!setup && setup.sandbox !== 'none', title: 'OS sandbox', detail: setup ? (setup.sandbox === 'none' ? 'No sandbox found: untrusted commands are refused.' : `${setup.sandbox} isolates every agent command.`) : 'Checking…' },
    { done: !!setup?.cloud, title: 'Connect Cloudflare Artifacts', detail: setup?.cloud ? 'Missions can be published and verified remotely.' : 'Optional: share verified mission history.', action: <Button size="sm" icon={IGlobe} onClick={() => go({ screen: 'settings' })}>Connect</Button> },
    { done: live.some((m) => m.state === 'completed'), title: 'Run a first mission', detail: 'Plan, approve, watch agents work in parallel, then review the evidence.', action: <Button size="sm" icon={IPlus} onClick={() => go({ screen: 'new' })}>New mission</Button> },
  ];
  const remaining = steps.filter((s) => !s.done).length;
  return (
    <div className="at-screen lv-page" data-testid="home">
      <div className="at-pagehead">
        <span className="heading">Home</span><span style={{ flex: 1 }} />
        <Button variant="primary" icon={IPlus} kbd="⌘ N" onClick={() => go({ screen: 'new' })} disabled={status !== 'ready' || !workspaces.length}>New mission</Button>
      </div>
      <div className="lv-scroll">
        <div className="lv-home-stats" data-testid="home-stats">
          {[['Active', live.filter((m) => ACTIVE.has(m.state)).length], ['Needs you', live.filter(needsYou).length], ['Verified', verified], ['Accepted', accepted], ['Missions', live.length]].map(([k, v]) => (
            <div key={k as string} className="lv-card lv-home-stat"><span className="at-label">{k}</span><b className="display">{v}</b></div>
          ))}
        </div>
        {remaining > 0 && (
          <section className="lv-section" data-testid="home-setup">
            <div className="at-row" style={{ gap: 8 }}><span className="at-label">Set up</span><span className="at-mono at-subtle">{steps.length - remaining}/{steps.length}</span></div>
            {steps.map((s) => (
              <div key={s.title} className="lv-line">
                <Icon as={s.done ? ICheckCircle : IShield} className={s.done ? 'at-success' : 'at-subtle'} />
                <span style={{ flex: 1 }}><b>{s.title}</b><br /><span className="at-subtle lv-small">{s.detail}</span></span>
                {!s.done && s.action}
              </div>
            ))}
          </section>
        )}
        <Group label="Needs you" items={sorted.filter(needsYou)} empty="Nothing is waiting for a decision." names={names} />
        <Group label="Running" items={sorted.filter((m) => ACTIVE.has(m.state))} empty="No agents are working right now." names={names} />
        <Group label="Ready for review" items={sorted.filter(readyForReview)} empty="No finished mission is waiting for accept or reject." names={names} />
        <Group label="Recent" items={sorted.slice(0, 8)} empty="No missions yet." names={names} />
        <section className="lv-section" data-testid="home-environments">
          <span className="at-label">Environments</span>
          {targets.length ? <KV rows={targets.map((t) => [t, `${live.filter((m) => m.targetEnvironment === t).length} mission(s) deployed here`] as [string, string])} />
            : <p className="at-subtle lv-small">No staging target is allowed yet. Add one in Settings to let missions deploy and verify a served revision.</p>}
        </section>
      </div>
    </div>
  );
}

/** Recent events across missions, newest first. Reads each mission's tail through events.since. */
export function GlobalActivity() {
  const missions = useLive((s) => s.missions);
  const tick = useLive((s) => s.tick);
  const [rows, setRows] = useState<{ e: AtlasEvent; mission: MissionListItem }[] | null>(null);
  const recent = [...missions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const key = recent.map((m) => `${m.id}:${m.updatedAt}`).join(',');
  useEffect(() => {
    let off = false;
    const t = window.setTimeout(() => {
      void Promise.all(recent.map(async (m) => {
        const snap = await call('mission.get', { missionId: m.id });
        const events = await call('events.since', { missionId: m.id, afterSeq: Math.max(0, snap.lastSeq - 40) });
        return events.map((e) => ({ e, mission: m }));
      })).then((all) => { if (!off) setRows(all.flat().filter((r) => r.e.type !== 'process.output').sort((a, b) => b.e.ts.localeCompare(a.e.ts)).slice(0, 150)); }).catch(() => { if (!off) setRows([]); });
    }, 250);
    return () => { off = true; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return (
    <div className="at-screen lv-page" data-testid="global-activity">
      <div className="at-pagehead"><span className="heading">Activity</span><span style={{ flex: 1 }} /><span className="at-subtle lv-small">Across your {recent.length} most recent missions</span></div>
      <div className="lv-scroll">
        {rows === null ? <p className="at-subtle">Loading…</p> : rows.length === 0 ? <EmptyState center icon={IActivity} title="No activity yet" body="Events from every mission appear here as agents plan, run commands, ask for approval and verify." /> : rows.map(({ e, mission }) => {
          const d = describeEvent(e);
          if (!d) return null;
          return (
            <button type="button" key={`${mission.id}:${e.seq}`} className="lv-line lv-home-row" data-testid="activity-row" onClick={() => go({ screen: 'mission', missionId: mission.id })}>
              <span className="at-mono at-subtle lv-small" style={{ width: 64 }}>{ago(e.ts)}</span>
              <span className="at-subtle lv-small" style={{ width: 110 }}>{d.who}</span>
              <span className="at-trunc" style={{ flex: 1, textAlign: 'left' }}>{d.title}{d.detail ? <span className="at-subtle"> · {d.detail}</span> : null}</span>
              <span className="at-subtle lv-small at-trunc" style={{ maxWidth: 220 }}>{mission.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The agents ATLAS can run: each role's tools, permissions, model tier and limits, as policy enforces them. */
export function Agents() {
  const status = useLive((s) => s.status.state);
  const [roles, setRoles] = useState<RoleInfo[] | null>(null);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    if (status !== 'ready') return;
    void Promise.all([call('roles.list'), call('settings.get')]).then(([r, s]) => { setRoles(r); setSettings(s); setSel((x) => x ?? r[0]?.id ?? null); }).catch(() => setRoles([]));
  }, [status]);
  const role = roles?.find((r) => r.id === sel);
  const tierModel = (tier: string) => (settings?.values as Record<string, unknown> | undefined)?.[`models.${tier}`] as string | null | undefined;
  return (
    <div className="at-screen lv-page" data-testid="agents">
      <div className="at-pagehead"><span className="heading">Agents</span><span style={{ flex: 1 }} /><span className="at-subtle lv-small">Roles are versioned policy: what each agent may read, write and run.</span></div>
      <div className="lv-scroll lv-agents">
        {!roles ? <p className="at-subtle">Loading…</p> : !roles.length ? <EmptyState center icon={IAgents} title="No roles" body="The control plane returned no agent roles." /> : (
          <div className="lv-agents-grid">
            <nav className="lv-agents-list" aria-label="Agent roles">
              {roles.map((r) => (
                <button type="button" key={r.id} data-testid="agent-role" aria-current={r.id === sel ? 'true' : undefined} className="lv-line lv-home-row" onClick={() => setSel(r.id)}>
                  <Icon as={IAgents} /><span style={{ flex: 1, textAlign: 'left' }}>{r.title || roleName(r.id)}</span>
                  <Badge tone={r.writes ? 'warning' : 'outline'}>{r.writes ? 'writes' : 'read-only'}</Badge>
                </button>
              ))}
            </nav>
            {role && (
              <section className="lv-section" data-testid="agent-detail">
                <h2 style={{ margin: 0 }}>{role.title || roleName(role.id)} <span className="at-mono at-subtle lv-small">{role.version}</span></h2>
                <KV col={140} rows={[
                  ['Model tier', <span key="t">{role.modelPreference}{tierModel(role.modelPreference) ? <span className="at-mono"> → {tierModel(role.modelPreference)}</span> : <span className="at-subtle"> → first configured model</span>}</span>],
                  ['Writes code', role.writes ? 'Yes, inside its own worktree only' : 'No'],
                  ['Tool calls', String(role.budget.maxToolCalls)],
                  ['Token budget', role.budget.maxTokens.toLocaleString()],
                  ['Wall clock', `${Math.round(role.budget.wallClockMs / 60000)} min`],
                ]} />
                <span className="at-label">Tools</span>
                <div className="at-row" style={{ gap: 6, flexWrap: 'wrap' }}>{role.tools.map((t) => <Badge key={t} tone="outline">{t}</Badge>)}</div>
                <span className="at-label">Capabilities</span>
                <div className="at-row" style={{ gap: 6, flexWrap: 'wrap' }}>{role.capabilities.length ? role.capabilities.map((c) => <Badge key={c}>{c}</Badge>) : <span className="at-subtle lv-small">None beyond its tools</span>}</div>
                <span className="at-label">Instructions</span>
                <pre className="lv-agents-instr at-mono lv-small">{role.instructions}</pre>
                <div className="at-row" style={{ gap: 8 }}>
                  <Button size="sm" icon={IMissions} onClick={() => go({ screen: 'new' })}>Use in a new mission</Button>
                  <Button size="sm" variant="ghost" icon={IHome} onClick={() => go({ screen: 'settings' })}>Change tier models</Button>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
