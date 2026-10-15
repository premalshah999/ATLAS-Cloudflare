// The renderer-facing API (manual E4). Each method is an intent with a validated request schema.
// Preload exposes exactly these methods; main validates sender + payload; the daemon authorizes and acts.
import { z } from 'zod';
import { AgentRole, ApprovalMode, Id, MissionBudget, RuntimeKind } from './domain';
import { DesktopAction, DesktopControl } from './desktop';
import { MODEL_REF, PROVIDER_IDS } from './providers';
import { MCP_NAME, McpServerConfig } from './mcp';
import { SearchAccount, WEB_ACCOUNT_ID, WebSettings } from './web';
import { PipelineSettings } from './pipeline';
import { EntryBodies, EntryId, ItemPriority, ItemStatus, KeyId, MemberRole, TeamSettingsPatch, TeamSlug, Assignee } from './team';

export const Provider = z.enum(['anthropic', 'openai', 'google', 'openrouter', 'deepseek', 'xai', 'groq', 'mistral', 'cerebras']);
export type ProviderId = z.infer<typeof Provider>;

const empty = z.object({}).strict();
const missionRef = z.object({ missionId: Id }).strict();
const ws = z.object({ workspaceId: Id }).strict();
const modelRef = z.string().regex(MODEL_REF, 'expected provider/model');
const credentialName = z.enum([...PROVIDER_IDS, 'github']);
/** A harness sync target (ADR 0019); project scope needs a workspace. */
const syncTarget = z.object({ harness: z.enum(['claude-code', 'codex', 'opencode']), scope: z.enum(['user', 'project']), workspaceId: Id.optional(), skills: z.boolean().default(true), mcp: z.boolean().default(true) }).strict();

export const Requests = {
  'app.info': empty,
  'workspace.open': empty,
  'workspace.list': empty,
  'workspace.refresh': z.object({ workspaceId: Id }).strict(),
  'workspace.preflight': z.object({ workspaceId: Id, runtime: RuntimeKind.optional() }).strict(),
  'mission.create': z.object({
    workspaceId: Id,
    title: z.string().trim().min(1).max(160),
    goal: z.string().trim().min(1).max(8000),
    constraints: z.string().max(4000).default(''),
    approvalMode: ApprovalMode,
    runtime: RuntimeKind,
    budget: MissionBudget.partial().optional(),
    targetEnvironment: z.string().min(1).max(100).nullable().optional(),
    /** Model for every agent of this mission (provider/model). Default: the Settings choice for each role's tier. */
    model: modelRef.nullable().optional(),
    /** A team work item this mission takes on (ADR 0021): it is claimed and the mission shared with the team. */
    item: EntryId.optional(),
  }).strict(),
  'mission.list': z.object({ workspaceId: Id.optional() }).strict(),
  'mission.get': missionRef,
  'mission.plan': missionRef,
  'mission.approvePlan': missionRef,
  'mission.cancel': missionRef,
  'mission.decide': z.object({ missionId: Id, decision: z.enum(['accept', 'reject']) }).strict(),
  'task.cancel': z.object({ taskId: Id }).strict(),
  'mission.export': missionRef,
  'cloud.publish': missionRef,
  'cloud.status': missionRef,
  'mission.import': empty,
  'mission.delete': missionRef,
  'mission.reverify': missionRef,
  'mission.restore': missionRef,
  'mission.publish': z.object({ missionId: Id, base: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).optional() }).strict(),
  'mission.forge': missionRef,
  'mission.ciRefresh': missionRef,
  'mission.fixCi': missionRef,
  'mission.approveDefinition': z.object({ missionId: Id, hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  'finding.update': z.object({ findingId: Id, status: z.enum(['open', 'accepted', 'dismissed', 'fixed']) }).strict(),
  'workspace.facts.get': z.object({ workspaceId: Id }).strict(),
  'workspace.facts.set': z.object({ workspaceId: Id, text: z.string().max(20_000) }).strict(),
  'workspace.acceptance.get': z.object({ workspaceId: Id }).strict(),
  'workspace.acceptance.set': z.object({ workspaceId: Id, command: z.string().min(1).max(100), args: z.array(z.string().max(1000)).max(100), files: z.record(z.string().max(300), z.string().max(2_000_000)) }).strict(),
  'workspace.acceptance.remove': z.object({ workspaceId: Id }).strict(),
  'skills.list': z.object({ workspaceId: Id.optional() }).strict(),
  'skills.read': z.object({ name: z.string().max(64), source: z.enum(['trusted', 'repository', 'external']), workspaceId: Id.optional(), path: z.string().max(300).optional(), hash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
  'skills.import': z.object({ workspaceId: Id.optional(), name: z.string().max(64), hash: z.string().regex(/^[0-9a-f]{64}$/), from: z.enum(['repository', 'external']).default('repository') }).strict(),
  'skills.save': z.object({ name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64), description: z.string().trim().min(1).max(1024), roles: z.array(AgentRole).max(10).default([]), triggers: z.array(z.string().trim().min(1).max(60)).max(40).default([]), body: z.string().min(1).max(200_000) }).strict(),
  'skills.setEnabled': z.object({ name: z.string().max(64), enabled: z.boolean() }).strict(),
  'sync.preview': syncTarget,
  'sync.apply': syncTarget.extend({ id: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  'sync.foreign': syncTarget,
  'skills.remove': z.object({ name: z.string().max(64) }).strict(),
  'export.keys': empty,
  'export.trust': z.object({ keyId: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
  'export.untrust': z.object({ keyId: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
  'terminal.open': z.object({ missionId: Id, target: z.union([Id, z.literal('integration')]), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }).strict(),
  'terminal.input': z.object({ sessionId: Id, data: z.string().max(65_536) }).strict(),
  'terminal.close': z.object({ sessionId: Id }).strict(),
  'terminal.list': missionRef,
  'terminal.attach': z.object({ sessionId: Id }).strict(),
  'terminal.resize': z.object({ sessionId: Id, cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }).strict(),
  'deployment.list': z.object({ target: z.string().max(100).optional() }).strict(),
  'deployment.rollback': z.object({ deploymentId: Id }).strict(),
  'deploy.targets': z.object({ workspaceId: Id }).strict(),
  'deploy.secrets.list': empty,
  'deploy.secrets.set': z.object({ target: z.string().min(1).max(100), name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), value: z.string().min(1).max(10_000) }).strict(),
  'deploy.secrets.remove': z.object({ target: z.string().min(1).max(100), name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/) }).strict(),
  'roles.list': empty,
  'desktop.list': empty,
  'desktop.control': z.object({ sessionId: Id, op: DesktopControl }).strict(),
  'desktop.input': z.object({ sessionId: Id, input: DesktopAction }).strict(),
  'desktop.frame': z.object({ sessionId: Id }).strict(),
  'approval.respond': z.object({ approvalId: Id, decision: z.enum(['approve', 'deny']) }).strict(),
  'events.since': z.object({ missionId: Id, afterSeq: z.number().int().min(0) }).strict(),
  'artifact.read': z.object({ artifactId: Id }).strict(),
  'runtime.health': empty,
  'models.list': empty,
  'settings.get': empty,
  /** Windows only (ADR 0020): create or remove the sandbox accounts; Windows asks the operator for administrator consent. */
  'sandbox.windows.setup': empty,
  'sandbox.windows.remove': empty,
  'settings.set': z.discriminatedUnion('key', [
    z.object({ key: z.literal('execution.allowUnsandboxed'), value: z.boolean() }).strict(),
    z.object({ key: z.literal('retention.days'), value: z.number().int().min(0).max(3650) }).strict(),
    z.object({ key: z.literal('deploy.allowedTargets'), value: z.array(z.string().min(1).max(100)).max(50) }).strict(),
    z.object({ key: z.literal('deploy.autoRollback'), value: z.boolean() }).strict(),
    z.object({ key: z.literal('desktop.enabled'), value: z.boolean() }).strict(),
    z.object({ key: z.literal('cloud.url'), value: z.union([z.literal(''), z.string().url().max(500)]) }).strict(),
    z.object({ key: z.literal('models.default'), value: modelRef.nullable() }).strict(),
    z.object({ key: z.literal('models.fast'), value: modelRef.nullable() }).strict(),
    z.object({ key: z.literal('models.strong'), value: modelRef.nullable() }).strict(),
    z.object({ key: z.literal('security.gate'), value: z.enum(['blocking', 'advisory']) }).strict(),
    z.object({ key: z.literal('security.aiReview'), value: z.boolean() }).strict(),
    z.object({ key: z.literal('maintenance.auto'), value: z.boolean() }).strict(),
  ]),
  'mcp.list': empty,
  'mcp.save': z.object({ server: McpServerConfig }).strict(),
  'mcp.remove': z.object({ name: z.string().regex(MCP_NAME) }).strict(),
  'mcp.test': z.object({ name: z.string().regex(MCP_NAME) }).strict(),
  'mcp.secret.set': z.object({ server: z.string().regex(MCP_NAME), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/), value: z.string().min(1).max(10_000) }).strict(),
  'mcp.secret.remove': z.object({ server: z.string().regex(MCP_NAME), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/) }).strict(),
  /** Web access for agents (ADR 0030). The key goes to Electron main's credential store, never to the daemon's database. */
  'web.view': empty,
  'web.settings.save': z.object({ settings: WebSettings }).strict(),
  'web.account.save': z.object({ account: SearchAccount, key: z.string().trim().min(8).max(500).optional() }).strict(),
  'web.account.remove': z.object({ id: z.string().regex(WEB_ACCOUNT_ID) }).strict(),
  'web.account.test': z.object({ id: z.string().regex(WEB_ACCOUNT_ID) }).strict(),
  'web.account.reset': z.object({ id: z.string().regex(WEB_ACCOUNT_ID) }).strict(),
  /** Automated delivery for one repository (ADR 0022). */
  'pipeline.get': z.object({ workspaceId: Id }).strict(),
  'pipeline.set': z.object({ workspaceId: Id, settings: PipelineSettings.partial() }).strict(),
  /** Team spaces (ADR 0021). */
  'team.get': ws,
  'team.sync': ws,
  'team.create': ws.extend({ name: z.string().trim().min(1).max(80), displayName: z.string().trim().min(1).max(80), email: z.string().trim().max(200).optional() }).strict(),
  'team.join': ws.extend({ displayName: z.string().trim().min(1).max(80), email: z.string().trim().max(200).optional(), code: z.string().trim().max(60).optional() }).strict(),
  'team.invite': ws.extend({ role: MemberRole, teams: z.array(TeamSlug).max(20).default([]), uses: z.number().int().min(1).max(50).default(1), days: z.number().int().min(1).max(30).default(7), note: z.string().max(200).optional() }).strict(),
  'team.member.add': ws.extend({ keyId: KeyId, role: MemberRole, teams: z.array(TeamSlug).max(20).default([]) }).strict(),
  'team.member.update': ws.extend({ keyId: KeyId, name: z.string().trim().min(1).max(80).optional(), role: MemberRole.optional(), teams: z.array(TeamSlug).max(20).optional() }).strict(),
  'team.member.remove': ws.extend({ keyId: KeyId }).strict(),
  'team.team.save': ws.extend({ team: EntryBodies['team.upsert'] }).strict(),
  'team.team.remove': ws.extend({ slug: TeamSlug }).strict(),
  'team.item.create': ws.extend({ item: EntryBodies['item.create'] }).strict(),
  'team.item.update': ws.extend({ item: EntryId, title: z.string().trim().min(1).max(200).optional(), detail: z.string().max(8000).optional(), team: TeamSlug.nullable().optional(), assignee: Assignee.optional(), status: ItemStatus.optional(), priority: ItemPriority.optional() }).strict(),
  'team.item.claim': ws.extend({ item: EntryId }).strict(),
  'team.mission.share': z.object({ missionId: Id, item: EntryId.nullable().optional(), teams: z.array(TeamSlug).max(20).optional(), people: z.array(KeyId).max(50).optional() }).strict(),
  'team.mission.patch': ws.extend({ missionId: Id }).strict(),
  'team.review': ws.extend({ missionId: Id, commit: z.string().regex(/^[0-9a-f]{40}$/), verdict: z.enum(['approve', 'changes']), note: z.string().max(4000).default('') }).strict(),
  'team.plan.approve': ws.extend({ missionId: Id }).strict(),
  'team.comment': ws.extend({ item: EntryId.optional(), missionId: Id.optional(), text: z.string().trim().min(1).max(4000) }).strict(),
  'team.settings': ws.extend({ settings: TeamSettingsPatch }).strict(),
  /** Session hygiene (ADR 0025): what ATLAS keeps on disk, and clearing what nothing needs. Evidence is never cleared here. */
  'maintenance.report': empty,
  'maintenance.cleanup': z.object({ categories: z.array(z.enum(['logs', 'graphs', 'sessions', 'worktrees', 'database'])).min(1).max(5).optional() }).strict(),
  'credentials.list': empty,
  'credentials.set': z.object({ provider: credentialName, key: z.string().trim().min(8).max(500) }).strict(),
  'credentials.remove': z.object({ provider: credentialName }).strict(),
} as const;

/** Methods only the main process may send to the daemon (never exposed to the renderer). */
export const InternalRequests = {
  'workspace.register': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'mission.exportTo': z.object({ missionId: Id, path: z.string().min(1).max(4096) }).strict(),
  'mission.importFrom': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'credentials.apply': z.object({ keys: z.record(z.string(), z.string()), deploySecrets: z.record(z.string(), z.record(z.string(), z.string())).optional(), mcpSecrets: z.record(z.string(), z.record(z.string(), z.string())).optional(), webKeys: z.record(z.string(), z.string()).optional() }).strict(),
} as const;
export type InternalMethod = keyof typeof InternalRequests;

/** Service tokens stored like provider keys but never given to a model runtime (ADR 0015). */
export const SERVICE_ENV: Record<string, string> = { github: 'ATLAS_GITHUB_TOKEN' };

/** Messages between Electron main and the daemon process. */
export type DaemonInbound = { kind: 'req'; id: number; method: string; params: unknown };
export type DaemonOutbound =
  | { kind: 'res'; id: number; ok: true; data: unknown }
  | { kind: 'res'; id: number; ok: false; error: { kind: string; message: string } }
  | { kind: 'event'; event: import('./events').AtlasEvent }
  | { kind: 'terminal'; sessionId: string; data?: string; seq?: number; exit?: number | null }
  | { kind: 'ready'; pid: number; recovered: { missions: string[]; lostAttempts: number; expiredApprovals: number } };

export type Method = keyof typeof Requests;
export const METHODS = Object.keys(Requests) as Method[];
export type RequestOf<M extends Method> = z.input<(typeof Requests)[M]>;

export const IPC = {
  /** Single invoke channel; the method name is validated against METHODS. */
  invoke: 'atlas:invoke',
  /** Ordered daemon events pushed to the renderer. */
  event: 'atlas:event',
  /** Daemon connection status pushed to the renderer. */
  status: 'atlas:status',
  /** Operator terminal output pushed to the renderer. */
  terminal: 'atlas:terminal',
} as const;

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: { kind: string; message: string } };

export function parseRequest<M extends Method>(method: string, payload: unknown): { method: M; params: z.output<(typeof Requests)[M]> } {
  if (!(METHODS as string[]).includes(method)) throw new Error(`Undeclared method: ${String(method).slice(0, 60)}`);
  const schema = Requests[method as M];
  const params = schema.parse(payload ?? {});
  return { method: method as M, params: params as z.output<(typeof Requests)[M]> };
}
