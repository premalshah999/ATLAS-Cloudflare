// The data the design-system screens render. In the design preview it is the sample data; in the live app the
// runtime adapter (live/designBridge.ts) replaces every value in place with data from the ATLAS control plane.
// Screens import from here, never from ./sample directly.
import * as S from './sample';
import type { Agent, Approval, Checkpoint, FileTouch, Mission, PipelineStage, ReviewFinding, Task, TerminalSession, TimelineEvent } from './types';

export interface Deployment { id: string; env: string; mission: string; commit: string; status: string; when: string; url?: string; missionId?: string }
export interface ModelRow { id: string; name: string; provider: string; ctx: string; role: string; status: string }
export interface ProviderRow { id: string; name: string; detail: string; status: 'connected' | 'off' }
export interface BrowserAction { time: string; text: string; status: string; shot?: string }
export interface Template { id: string; name: string; mark: string; desc: string; tools: number }
export interface ActivityRow { time: string; who: string; text: string; kind: 'error' | 'warn' | 'human' | 'ok' | 'info'; mission: string; missionId?: string }
export interface RoleDetail { id: string; title: string; version: string; instructions: string; tools: string[]; capabilities: string[]; writes: boolean; tier: string; model: string; budget: { maxToolCalls: number; maxTokens: number; wallClockMs: number } }
export interface TraceRow { time: string; tool: string; call: string; result: string; ms: string; ok: boolean }
export interface ThreadItem { time: string; who: string; kind: 'message' | 'delegation' | 'human' | 'tools' | 'approval' | 'system'; text: string; tools?: TraceRow[]; approvalId?: string }
export interface ReviewContent { before: string; after: string; lang?: string; comments: { line: number; author: string; mark: string; id?: string; severity?: string; resolved?: boolean; human?: boolean; body: string }[] }

/** True when the screens show the operator's real control-plane data. */
export const live = { on: false, missionId: '' as string, version: 0 };

export const workspace = { ...S.workspace };
export const workspaces = [...S.workspaces];
export const mission: Mission = { ...S.mission };
export const missions: Mission[] = [...S.missions];
export const agents: Agent[] = [...S.agents];
export const tasks: Task[] = [...S.tasks];
export const timeline: TimelineEvent[] = [...S.timeline];
export const approvals: Approval[] = [...S.approvals];
export const terminals: TerminalSession[] = [...S.terminals];
export const checkpoints: Checkpoint[] = [...S.checkpoints];
export const findings: ReviewFinding[] = [...S.findings];
export const reviewFiles: FileTouch[] = [...S.reviewFiles];
export const pipeline: PipelineStage[] = [...S.pipeline];
export const deployments: Deployment[] = [...S.deployments];
export const models: ModelRow[] = [...S.models];
export const providers: ProviderRow[] = [...S.providers];
export const browserActions: BrowserAction[] = [...S.browserActions];
export const templates: Template[] = [...S.templates];
export const activity: ActivityRow[] = [...S.activity];
export const liveEvents = S.liveEvents;
export const liveTermLines = S.liveTermLines;
/** Before/after text of changed files (live: reconstructed from the mission's patch hunks). */
export const diffs = { sessionBefore: S.sessionBefore, sessionAfter: S.sessionAfter, middlewareBefore: S.middlewareBefore, middlewareAfter: S.middlewareAfter };
export const reviewContents: Record<string, ReviewContent> = {};
/** Live: per-agent conversation summary and tool trace. Empty in the design preview (screens show their sample). */
export const threads: Record<string, ThreadItem[]> = {};
export const traces: Record<string, TraceRow[]> = {};
export const roleDetails: Record<string, RoleDetail> = {};
/** Live extras the sample has no equivalent for: verification summary of the current mission, deploy detail. */
export const facts = {
  evidence: { passed: 0, failed: 0, total: 0, unitLabel: '', qaLabel: '' },
  deploy: null as null | { title: string; commit: string; url: string; missionTitle: string; when: string; verdict: string; flows: { label: string; value: string; status: string }[]; health: { label: string; value: string; status: string }[]; notVerified: string[] },
  cost: '',
  checkpoint: '',
};

const FALLBACK: Agent = { ...S.agents[0], id: 'none', name: 'No agent', mark: '—', status: 'idle', assignment: 'No agent selected', activity: '', files: [], terminals: [], children: [], artifacts: [] };
export const agentById = (id: string): Agent => agents.find((a) => a.id === id) ?? agents[0] ?? FALLBACK;

function replace<T>(arr: T[], next: T[]) { arr.splice(0, arr.length, ...next); }
function assign<T extends object>(obj: T, next: T) { for (const k of Object.keys(obj)) delete (obj as Record<string, unknown>)[k]; Object.assign(obj, next); }

export interface Snapshot {
  workspace: typeof workspace; workspaces: typeof workspaces; mission: Mission; missions: Mission[]; agents: Agent[]; tasks: Task[];
  timeline: TimelineEvent[]; approvals: Approval[]; terminals: TerminalSession[]; checkpoints: Checkpoint[]; findings: ReviewFinding[];
  reviewFiles: FileTouch[]; pipeline: PipelineStage[]; deployments: Deployment[]; models: ModelRow[]; providers: ProviderRow[];
  browserActions: BrowserAction[]; templates: Template[]; activity: ActivityRow[]; diffs: typeof diffs; reviewContents: Record<string, ReviewContent>; facts: typeof facts;
  threads: Record<string, ThreadItem[]>; traces: Record<string, TraceRow[]>; roleDetails: Record<string, RoleDetail>;
}

/** Replace every value in place: modules that imported these bindings see the new data on their next render. */
export function hydrate(d: Snapshot, missionId: string) {
  assign(workspace, d.workspace); replace(workspaces, d.workspaces); assign(mission, d.mission); replace(missions, d.missions);
  replace(agents, d.agents); replace(tasks, d.tasks); replace(timeline, d.timeline); replace(approvals, d.approvals);
  replace(terminals, d.terminals); replace(checkpoints, d.checkpoints); replace(findings, d.findings); replace(reviewFiles, d.reviewFiles);
  replace(pipeline, d.pipeline); replace(deployments, d.deployments); replace(models, d.models); replace(providers, d.providers);
  replace(browserActions, d.browserActions); replace(templates, d.templates); replace(activity, d.activity);
  Object.assign(diffs, d.diffs); assign(reviewContents, d.reviewContents); Object.assign(facts, d.facts); assign(threads, d.threads); assign(traces, d.traces); assign(roleDetails, d.roleDetails);
  live.on = true; live.missionId = missionId; live.version++;
}
