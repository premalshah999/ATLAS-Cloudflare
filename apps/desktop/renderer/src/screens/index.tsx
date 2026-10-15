import React from 'react';
import { slots, type HostedId, type ScreenId } from '../lib/store';
import { MissionControl } from './mission';
import { Welcome, Home, Workspaces, MissionCreate } from './start';
import { AgentDetail, GraphScreen, AgentStudio } from './agent';
import { TerminalWorkspace, Review, Computer } from './tools';
import { Deploy, Settings, Report, ActivityScreen } from './ops';

export const screens: Record<ScreenId, React.ComponentType> = {
  welcome: Welcome, home: Home, workspaces: Workspaces, create: MissionCreate, mission: MissionControl, graph: GraphScreen,
  agent: AgentDetail, terminal: TerminalWorkspace, review: Review, computer: Computer, deploy: Deploy, studio: AgentStudio,
  settings: Settings, report: Report, activity: ActivityScreen,
  projects: () => <Hosted id="projects" />, team: () => <Hosted id="team" />, preferences: () => <Hosted id="preferences" />,
  record: () => <Hosted id="record" />,
};

function Hosted({ id }: { id: HostedId }) {
  const Page = slots.Page?.[id];
  return <div className="at-screen at-hosted">{Page ? <Page /> : <div className="at-subtle" style={{ padding: 24 }}>Available in the desktop app.</div>}</div>;
}
