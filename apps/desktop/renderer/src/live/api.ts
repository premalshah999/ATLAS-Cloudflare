// Typed client over the preload bridge. The renderer holds no authority: every call is an intent the
// main process validates and the daemon authorizes.
import type { Approval, Artifact, Attempt, AtlasEvent, CheckRecord, Deployment, DesktopSessionInfo, Finding, McpServerView, Method, Mission, MissionBudget, ModelInfo, PipelineSettings, Plan, RequestOf, RuntimeHealth, Task, TeamView, WebView, Workspace } from '@atlas/contracts';

export type DaemonStatus = { state: 'starting' | 'ready' | 'restarting' | 'stopped'; pid: number | null; restarts: number; detail?: string };

interface Bridge {
  platform: string;
  invoke(method: Method, params?: unknown): Promise<unknown>;
  onEvent(fn: (e: AtlasEvent) => void): () => void;
  onStatus(fn: (s: DaemonStatus) => void): () => void;
  onTerminal(fn: (t: { sessionId: string; data?: string; seq?: number; exit?: number | null }) => void): () => void;
  e2e?: { crashDaemon(): Promise<void> };
}

declare global { interface Window { atlas?: Bridge } }

export const bridge: Bridge | undefined = typeof window !== 'undefined' ? window.atlas : undefined;
export const isDesktop = !!bridge;

export interface MissionSnapshot {
  mission: Mission;
  workspace: Workspace | null;
  plan: { plan: Plan; status: string } | null;
  tasks: Task[];
  attempts: Attempt[];
  approvals: Approval[];
  checks: CheckRecord[];
  findings: Finding[];
  artifacts: Artifact[];
  budget: { budget: MissionBudget; tokens: number; toolCalls: number; tasks: number; agentsNow: number; elapsedMs: number };
  lastSeq: number;
}

export type Preflight = { level: 'block' | 'warn' | 'info'; message: string }[];
export type MissionListItem = Mission & { tasks: { key: string; state: string }[]; pendingApprovals: number };
export type RoleInfo = { id: string; version: string; title: string; tools: string[]; writes: boolean; modelPreference: string; budget: { maxToolCalls: number; maxTokens: number; wallClockMs: number }; capabilities: string[]; instructions: string };
export type DesktopState = { support: { ok: boolean; detail: string }; enabled: boolean; sessions: DesktopSessionInfo[] };
export type SettingsState = { values: { 'execution.allowUnsandboxed': boolean; 'retention.days': number; 'deploy.allowedTargets': string[]; 'deploy.autoRollback': boolean; 'desktop.enabled': boolean; 'cloud.url': string; 'models.default': string | null; 'models.fast': string | null; 'models.strong': string | null; 'security.gate': 'blocking' | 'advisory'; 'security.aiReview': boolean; 'maintenance.auto': boolean }; sandbox: { kind: 'bwrap' | 'sandbox-exec' | 'windows-account' | 'appcontainer' | 'none'; detail: string; path: string | null }; windowsAccounts?: { set: boolean; offline?: string; network?: string; firewall?: boolean } | null };
/** Pull request and CI state of a mission (ADR 0015). */
export interface ForgeView {
  configured: boolean;
  remote: string | null;
  published: { owner: string; repo: string; number: number; url: string; branch: string; headSha: string; created: boolean } | null;
  ci: { state: 'pending' | 'success' | 'failure' | 'none'; headSha: string; number: number; checks: { name: string; status: string; conclusion: string | null; url: string | null }[]; at: string } | null;
  blocker: string | null;
  canFixCi: boolean;
  followUp: { parentMissionId: string; branch: string; headSha: string; pullRequest: number } | null;
  followUps: string[];
}
export type Credentials = { available: boolean; providers: { provider: string; stored: boolean; fromEnvironment: boolean; env: string }[] };
export type AppInfo = { version: string; schema: number; pi: { package: string; version: string; gitHead: string; license: string; repository: string }; platform: string; node: string; electron: string; chrome: string; daemon: DaemonStatus; credentialStore: boolean; git?: { version: string; mode: 'attr-source' | 'neutralize-drivers'; detail: string } };

export type CloudPublication = { name: string; remote: string; verified: boolean; refs: { ref: string; expected: string; actual: string | null; matches: boolean }[]; checkedAt: string };

type Results = {
  'cloud.publish': CloudPublication;
  'cloud.status': CloudPublication | null;
  'app.info': AppInfo;
  'workspace.open': Workspace | null;
  'workspace.list': Workspace[];
  'workspace.refresh': Workspace;
  'workspace.preflight': Preflight;
  'mission.create': Mission;
  'mission.list': MissionListItem[];
  'mission.get': MissionSnapshot;
  'mission.plan': Mission;
  'mission.approvePlan': Mission;
  'mission.cancel': Mission;
  'mission.decide': Mission;
  'task.cancel': Task;
  'mission.export': { path: string; records: number; sha256: string } | null;
  'mission.import': Mission | null;
  'mission.delete': { deleted: string };
  'mission.reverify': Mission;
  'mission.restore': Mission;
  'mission.approveDefinition': Mission;
  'mission.forge': ForgeView;
  'mission.publish': ForgeView;
  'mission.ciRefresh': ForgeView;
  'mission.fixCi': Mission;
  'finding.update': Finding;
  'workspace.facts.get': { text: string };
  'workspace.facts.set': { text: string };
  'workspace.acceptance.get': AcceptanceView | null;
  'workspace.acceptance.set': AcceptanceView | null;
  'workspace.acceptance.remove': AcceptanceView | null;
  'skills.list': SkillsState;
  'skills.read': { text: string; hash: string };
  'skills.import': SkillsState;
  'skills.remove': SkillsState;
  'skills.save': SkillsState;
  'skills.setEnabled': SkillsState;
  'sync.preview': SyncPreview;
  'sync.apply': { changes: SyncChange[]; at: string };
  'sync.foreign': ForeignServer[];
  'export.keys': { own: string; trusted: string[] };
  'export.trust': { own: string; trusted: string[] };
  'export.untrust': { own: string; trusted: string[] };
  'terminal.open': { sessionId: string; writable: boolean; worktree: string; target: string };
  'terminal.input': null;
  'terminal.close': null;
  'terminal.list': { sessionId: string; target: string; writable: boolean; worktree: string; startedAt: string }[];
  'terminal.attach': { sessionId: string; target: string; writable: boolean; worktree: string; snapshot: string; seq: number };
  'terminal.resize': { resized: boolean };
  'deployment.list': Deployment[];
  'deployment.rollback': { ok: boolean; message: string; to: Deployment | null; revisionConfirmed: boolean | null };
  'deploy.targets': { target: string; provider: 'local' | 'command'; allowed: boolean; live: Deployment | null }[];
  'deploy.secrets.list': { target: string; names: string[] }[];
  'deploy.secrets.set': { target: string; names: string[] }[];
  'deploy.secrets.remove': { target: string; names: string[] }[];
  'roles.list': RoleInfo[];
  'desktop.list': DesktopState;
  'desktop.control': DesktopSessionInfo;
  'desktop.input': { ok: boolean; message: string; input: boolean };
  'desktop.frame': { png: string; info: DesktopSessionInfo };
  'approval.respond': Approval;
  'events.since': AtlasEvent[];
  'artifact.read': { artifact: Artifact; intact: boolean; truncated: boolean; text: string; base64?: string | null };
  'runtime.health': RuntimeHealth[];
  'models.list': ModelInfo[];
  'credentials.test': { provider: string; ok: boolean; status: number | null; detail: string };
  'mcp.list': McpServerView[];
  'mcp.save': McpServerView[];
  'mcp.remove': McpServerView[];
  'mcp.test': McpServerView[];
  'mcp.secret.set': McpServerView[];
  'mcp.secret.remove': McpServerView[];
  'web.view': WebView;
  'web.settings.save': WebView;
  'web.account.save': WebView;
  'web.account.remove': WebView;
  'web.account.test': WebView & { test: { ok: boolean; message: string } };
  'web.account.reset': WebView;
  'settings.get': SettingsState;
  'settings.set': SettingsState;
  'sandbox.windows.setup': SettingsState;
  'sandbox.windows.remove': SettingsState;
  'pipeline.get': PipelineSettings;
  'pipeline.set': PipelineSettings;
  'team.get': TeamView;
  'team.sync': TeamView;
  'team.create': TeamView;
  'team.join': TeamView;
  'team.invite': { code: string; view: TeamView };
  'team.member.add': TeamView;
  'team.member.update': TeamView;
  'team.member.remove': TeamView;
  'team.team.save': TeamView;
  'team.team.remove': TeamView;
  'team.item.create': TeamView;
  'team.item.update': TeamView;
  'team.item.claim': TeamView;
  'team.mission.share': TeamView;
  'team.mission.patch': { patch: string | null };
  'team.review': TeamView;
  'team.plan.approve': TeamView;
  'team.comment': TeamView;
  'team.settings': TeamView;
  'maintenance.report': Maintenance;
  'maintenance.cleanup': Maintenance & { result: CleanupResult };
  'credentials.list': Credentials;
  'credentials.set': Credentials;
  'credentials.remove': Credentials;
};

export interface SkillView { name: string; description: string; roles: string[]; version: string; source: 'bundled' | 'operator' | 'repository' | 'external'; hash: string; files: string[]; enabled: boolean; origin?: string; triggers: string[]; tools: string[]; usage?: { missions: number; verified: number; failed: number } }
export interface SkillsState { trusted: SkillView[]; repository: SkillView[]; external: SkillView[]; errors: string[] }
export interface SyncChange { kind: 'skill' | 'mcp'; name: string; path: string; action: 'create' | 'update' | 'delete' | 'unchanged' | 'conflict'; reason?: string }
export interface SyncPreview { id: string; changes: SyncChange[]; notes: string[]; locations: { skills: string | null; mcp: string | null } }
export interface ForeignServer { name: string; config: Record<string, unknown> | null; secretNames: string[]; problem: string | null }
export interface StorageRow { category: string; label: string; bytes: number; items: number; reclaimable: number; note: string }
export interface CleanupResult { at: string; freed: number; removed: Record<string, number>; categories: string[]; automatic: boolean }
export interface Maintenance { rows: StorageRow[]; auto: boolean; last: CleanupResult | null }
export interface AcceptanceView { command: string; args: string[]; files: Record<string, string>; updatedAt: string; hash: string }

export function call<M extends Method>(method: M, params: RequestOf<M> = {} as RequestOf<M>): Promise<Results[M]> {
  if (!bridge) return Promise.reject(new Error('ATLAS is running outside the desktop app'));
  return bridge.invoke(method, params) as Promise<Results[M]>;
}
