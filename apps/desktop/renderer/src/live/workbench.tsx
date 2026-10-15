// Cross-mission workbenches (the design's Reviews, Deployments, Terminal and Browser & desktop screens, live): pick a
// mission on the left, work with its live panel on the right. Every panel is the same one the mission view uses.
import React, { useState } from 'react';
import type { IconType } from 'react-icons';
import { Badge, Button, EmptyState, Status } from '../ui/primitives';
import { IComputer, IDeploy, IGlobe, IMerge, IReviews, ITerminal, IUndo } from '../lib/icons';
import { call, type MissionListItem } from './api';
import { go, useLive } from './store';
import { useMission } from './useMission';
import { ago, missionStatus } from './format';
import { BrowserPanel, DeployPanel, DesktopPanel, Findings, TerminalPanel } from './panels';
import { Changes } from './mission';
import { toast } from './toast';

export type WorkbenchKind = 'reviews' | 'deployments' | 'terminal' | 'browser';

const META: Record<WorkbenchKind, { title: string; icon: IconType; hint: string; empty: string; filter: (m: MissionListItem) => boolean; rank?: (m: MissionListItem) => number }> = {
  reviews: { title: 'Reviews', icon: IReviews, hint: 'Changes waiting for your decision, with their review findings and patch.', empty: 'No mission has produced a change to review yet.', filter: (m) => !m.archived && ['completed', 'failed'].includes(m.state), rank: (m) => (m.state === 'completed' && !m.decision ? 0 : 1) },
  deployments: { title: 'Deployments', icon: IDeploy, hint: 'Staging deployments: served revision, synthetic traffic, verification and rollback.', empty: 'No mission has a staging target. Allow one in Settings and pick it when you create a mission.', filter: (m) => !!m.targetEnvironment },
  terminal: { title: 'Terminal', icon: ITerminal, hint: 'A sandboxed shell in a mission’s worktree, with every command recorded.', empty: 'Terminals open in a mission’s worktree. Create a mission first.', filter: (m) => !m.archived },
  browser: { title: 'Browser & desktop', icon: IGlobe, hint: 'Browser QA runs with every step and screenshot; desktop sessions where supported.', empty: 'Browser runs appear once a mission’s app has been checked in a browser.', filter: (m) => !m.archived },
};

export function Workbench({ kind }: { kind: WorkbenchKind }) {
  const meta = META[kind];
  const missions = useLive((s) => s.missions).filter(meta.filter)
    .sort((a, b) => (meta.rank ? meta.rank(a) - meta.rank(b) : 0) || b.updatedAt.localeCompare(a.updatedAt));
  const [sel, setSel] = useState<string | null>(null);
  const selected = missions.find((m) => m.id === sel) ?? missions[0];
  return (
    <div className="at-screen lv-page" data-testid={`workbench-${kind}`}>
      <div className="at-pagehead"><span className="heading">{meta.title}</span><span style={{ flex: 1 }} /><span className="at-subtle lv-small">{meta.hint}</span></div>
      {!missions.length ? <div className="lv-scroll"><EmptyState center icon={meta.icon} title={meta.title} body={meta.empty} /></div> : (
        <div className="lv-wb">
          <nav className="lv-wb-list" aria-label={`${meta.title} missions`}>
            {missions.map((m) => {
              const st = missionStatus(m);
              return (
                <button type="button" key={m.id} data-testid="wb-mission" aria-current={m.id === selected?.id ? 'true' : undefined} className="lv-wb-item" onClick={() => setSel(m.id)}>
                  <span className="at-trunc"><b>{m.title}</b></span>
                  <span className="at-row lv-small" style={{ gap: 8 }}><Status s={st.dot} label={st.word} />{kind === 'reviews' && m.state === 'completed' && !m.decision && <Badge tone="warning">decide</Badge>}{m.decision && <Badge tone="outline">{m.decision}</Badge>}<span style={{ flex: 1 }} /><span className="at-subtle">{ago(m.updatedAt)}</span></span>
                </button>
              );
            })}
          </nav>
          {selected && <WorkbenchBody key={selected.id} kind={kind} missionId={selected.id} />}
        </div>
      )}
    </div>
  );
}

function WorkbenchBody({ kind, missionId }: { kind: WorkbenchKind; missionId: string }) {
  const { snap, events } = useMission(missionId);
  const [busy, setBusy] = useState(false);
  if (!snap) return <div className="lv-wb-body at-subtle" style={{ padding: 24 }}>Loading…</div>;
  const m = snap.mission;
  const decide = async (decision: 'accept' | 'reject') => {
    setBusy(true);
    try { await call('mission.decide', { missionId, decision }); toast({ tone: 'info', title: decision === 'accept' ? 'Changes accepted' : 'Changes rejected' }); }
    catch (e) { toast({ tone: 'danger', title: 'Decision not recorded', body: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const showLog = (artifactId: string) => void call('artifact.read', { artifactId }).then((r) => toast({ tone: 'info', title: r.artifact.name, body: r.text.slice(0, 400) })).catch(() => {});
  return (
    <div className="lv-wb-body" data-testid="wb-body">
      <div className="lv-wb-head">
        <b className="at-trunc">{m.title}</b>
        <span className="at-subtle lv-small at-trunc">{m.outcome ?? m.goal}</span>
        <span style={{ flex: 1 }} />
        {kind === 'reviews' && m.state === 'completed' && !m.decision && !m.archived && <>
          <Button size="sm" variant="ghost" icon={IUndo} disabled={busy} onClick={() => void decide('reject')}>Reject</Button>
          <Button size="sm" variant={m.verdict === 'verified' ? 'primary' : 'default'} icon={IMerge} disabled={busy} onClick={() => void decide('accept')} data-testid="wb-accept">Accept</Button>
        </>}
        <Button size="sm" variant="ghost" onClick={() => go({ screen: 'mission', missionId })}>Open mission</Button>
      </div>
      <div className="lv-wb-panel">
        {kind === 'reviews' && <div className="lv-wb-split"><Findings snap={snap} onLog={showLog} /><Changes snap={snap} /></div>}
        {kind === 'deployments' && <DeployPanel snap={snap} events={events} />}
        {kind === 'terminal' && (m.archived ? <EmptyState center icon={ITerminal} title="Archived mission" body="Imported missions are read-only." /> : <TerminalPanel snap={snap} />)}
        {kind === 'browser' && <div className="lv-wb-split"><BrowserPanel snap={snap} events={events} />{events.some((e) => e.type.startsWith('desktop.')) && <DesktopPanel snap={snap} events={events} />}</div>}
      </div>
      {kind === 'browser' && !events.some((e) => e.type.startsWith('browser.') || e.type === 'check.result' && String(e.payload.name ?? '').startsWith('browser')) && <p className="at-subtle lv-small" style={{ padding: '0 20px' }}><IComputer /> No browser run recorded for this mission yet.</p>}
    </div>
  );
}
