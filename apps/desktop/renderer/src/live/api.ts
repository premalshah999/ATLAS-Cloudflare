// Typed client over the preload bridge. The renderer holds no authority: every call is an intent the
// main process validates and the daemon authorizes.
import type { Approval, Artifact, Attempt, AtlasEvent, CheckRecord, Deployment, DesktopSessionInfo, Finding, Method, Mission, MissionBudget, Plan, RequestOf, RuntimeHealth, Task, Workspace } from '@atlas/contracts';

export type DaemonStatus = { state: 'starting' | 'ready' | 'restarting' | 'stopped'; pid: number | null; restarts: number; detail?: string };

interface Bridge {
  platform: string;
  invoke(method: Method, params?: unknown): Promise<unknown>;
  onEvent(fn: (e: AtlasEvent) => void): () => void;
  onStatus(fn: (s: DaemonStatus) => void): () => void;
  onTerminal(fn: (t: { sessionId: string; data?: string; exit?: number | null }) => void): () => void;
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
export type SettingsState = { values: { 'execution.allowUnsandboxed': boolean; 'retention.days': number; 'deploy.allowedTargets': string[]; 'deploy.autoRollback': boolean; 'desktop.enabled': boolean; 'cloud.url': string; 'runtime.model': string }; sandbox: { kind: 'bwrap' | 'sandbox-exec' | 'none'; detail: string; path: string | null } };
export type Credentials = { available: boolean; providers: { provider: string; stored: boolean; fromEnvironment: boolean; env: string }[] };
export type AppInfo = { version: string; schema: number; pi: { package: string; version: string; gitHead: string; license: string; repository: string }; platform: string; node: string; electron: string; chrome: string; daemon: DaemonStatus; credentialStore: boolean };

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
  'finding.update': Finding;
  'workspace.facts.get': { text: string };
  'workspace.facts.set': { text: string };
  'terminal.open': { sessionId: string; writable: boolean; worktree: string };
  'terminal.input': null;
  'terminal.close': null;
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
  'settings.get': SettingsState;
  'settings.set': SettingsState;
  'credentials.list': Credentials;
  'credentials.set': Credentials;
  'credentials.remove': Credentials;
};

export function call<M extends Method>(method: M, params: RequestOf<M> = {} as RequestOf<M>): Promise<Results[M]> {
  if (!bridge) return Promise.reject(new Error('ATLAS is running outside the desktop app'));
  return bridge.invoke(method, params) as Promise<Results[M]>;
}
