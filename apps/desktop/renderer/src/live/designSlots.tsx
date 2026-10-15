// Real control-plane components the design screens host (lib/store slots).
import React from 'react';
import { actions, slots, useApp } from '../lib/store';
import { live } from '../data/source';
import { Button, EmptyState } from '../ui/primitives';
import { IChevronLeft, IFileText } from '../lib/icons';
import { MissionView } from './mission';
import { useMission } from './useMission';
import { Screenshot, TerminalPanel } from './panels';
import { Projects } from './projects';
import { TeamScreen } from './team';
import { Settings } from './settings';

function HumanTerminal() {
  const { snap } = useMission(live.missionId);
  if (!snap) return <div className="at-subtle" style={{ padding: 16, fontSize: 12 }}>Connecting to the mission…</div>;
  return <TerminalPanel snap={snap} />;
}

/** The mission's full record (evidence, changes, Cloudflare publish, deploy, terminal) for the mission Mission Control shows. */
function MissionRecord() {
  const id = useApp((s) => s.missionId) || live.missionId;
  const back = <Button size="sm" variant="ghost" icon={IChevronLeft} data-testid="record-back" onClick={() => actions().go('mission')}>Mission Control</Button>;
  if (!id) return <div className="at-screen lv-page"><div style={{ padding: '12px 16px' }}>{back}</div><EmptyState center icon={IFileText} title="No mission open" body="Start a mission or pick one from Home to see its full record." /></div>;
  return (
    <div className="at-screen lv-record" data-testid="mission-record">
      <div style={{ padding: '8px 16px 0' }}>{back}</div>
      <MissionView key={id} missionId={id} />
    </div>
  );
}

export function installDesignSlots() {
  slots.HumanTerminal = () => <HumanTerminal />;
  slots.Shot = ({ artifactId, alt }) => <Screenshot artifactId={artifactId} alt={alt} />;
  slots.Page = { projects: () => <Projects />, team: () => <TeamScreen />, preferences: () => <Settings />, record: () => <MissionRecord /> };
}
