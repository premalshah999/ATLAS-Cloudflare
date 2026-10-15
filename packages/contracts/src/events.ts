// Append-only domain events (manual §38). Payloads are redacted before they are persisted.
export const EventType = [
  'mission.created', 'mission.state', 'mission.decision',
  'plan.proposed', 'plan.rejected', 'plan.approved',
  'task.state', 'attempt.started', 'attempt.ended', 'attempt.stalled',
  'agent.message', 'agent.tool_call', 'agent.tool_result', 'agent.usage',
  'policy.decision', 'approval.requested', 'approval.decided',
  'process.started', 'process.output', 'process.exited',
  'workspace.worktree', 'workspace.tampered', 'artifact.created', 'check.result', 'gate.result',
  'plan.planner', 'integration.result', 'finding.reported', 'finding.updated', 'delegation.requested', 'delegation.result', 'budget.exceeded', 'context.built',
  'browser.step', 'visual.page', 'deploy.event', 'staging.check', 'rollback.result', 'desktop.action', 'desktop.session', 'operator.terminal',
  'operator.action', 'daemon.recovered', 'skill.loaded', 'forge.published', 'forge.ci', 'mcp.called', 'pipeline.step', 'team.shared', 'team.review', 'context.compacted', 'web.searched', 'web.fetched', 'web.browsed', 'error',
] as const;
export type EventType = (typeof EventType)[number];

/** `teammate`: a member of the repository's team space acting through the signed team record (ADR 0021). */
export type Actor = { kind: 'operator' } | { kind: 'agent'; role: string; taskId: string } | { kind: 'system'; component: string } | { kind: 'teammate'; keyId: string; name: string };

export interface AtlasEvent {
  missionId: string;
  /** Monotonic per mission, starting at 1. */
  seq: number;
  type: EventType;
  ts: string;
  actor: Actor;
  taskId: string | null;
  attemptId: string | null;
  payload: Record<string, unknown>;
  artifactIds: string[];
}

export type NewEvent = Omit<AtlasEvent, 'seq' | 'ts'> & { ts?: string };
