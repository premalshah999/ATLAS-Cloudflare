// Real control-plane components the design screens host (lib/store slots).
import React from 'react';
import { slots } from '../lib/store';
import { live } from '../data/source';
import { useMission } from './useMission';
import { Screenshot, TerminalPanel } from './panels';
import { Projects } from './projects';
import { TeamScreen } from './team';
import { Settings } from './settings';
import { LiveBrowser } from './liveBrowser';

function HumanTerminal() {
  const { snap } = useMission(live.missionId);
  if (!snap) return <div className="at-subtle" style={{ padding: 16, fontSize: 12 }}>Connecting to the mission…</div>;
  return <TerminalPanel snap={snap} />;
}

export function installDesignSlots() {
  slots.HumanTerminal = () => <HumanTerminal />;
  slots.LiveBrowser = () => <LiveBrowser />;
  slots.Shot = ({ artifactId, alt }) => <Screenshot artifactId={artifactId} alt={alt} />;
  slots.Page = { projects: () => <Projects />, team: () => <TeamScreen />, preferences: () => <Settings /> };
}
