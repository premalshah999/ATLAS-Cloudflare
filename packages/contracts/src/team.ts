// Team spaces (ADR 0021): people and their ATLAS agents working on one repository together. The space is a signed,
// append-only record kept in the repository's own git remote (refs/atlas/team). There is no server and no account:
// a member is an installation key, and access to the record is access to the repository.
import { z } from 'zod';
import { AgentRole, CheckResult, Id, MissionState, RuntimeKind } from './domain';
import { MODEL_REF } from './providers';

export const TEAM_REF = 'refs/atlas/team';
export const KeyId = z.string().regex(/^[0-9a-f]{32}$/);
export const EntryId = z.string().regex(/^[0-9a-f]{64}$/);
export const TeamSlug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40);
export const MemberRole = z.enum(['maintainer', 'member']);
export const ItemStatus = z.enum(['open', 'in_progress', 'review', 'done', 'closed']);
export const ItemPriority = z.enum(['low', 'normal', 'high', 'urgent']);
/** A person (their key) or the agents of the item's team; null: nobody yet. */
export const Assignee = z.union([KeyId, z.literal('agents')]).nullable();
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const PersonName = z.string().trim().min(1).max(80);
const Email = z.string().trim().max(200);
const PublicKey = z.string().regex(/^[A-Za-z0-9+/=]{40,200}$/);
const Glob = z.string().trim().min(1).max(200).refine((g) => !g.includes('..') && !g.startsWith('/'), 'a path pattern inside the repository');

/** What a member publishes about one of their missions: enough for teammates to follow and review it. */
export const SharedMission = z.object({
  missionId: Id,
  item: EntryId.nullable().default(null),
  title: z.string().max(200),
  goal: z.string().max(8000),
  state: MissionState,
  verdict: z.enum(['verified', 'unverified', 'failed']).nullable(),
  decision: z.enum(['accepted', 'rejected']).nullable(),
  runtime: RuntimeKind,
  model: z.string().regex(MODEL_REF).nullable().default(null),
  baseCommit: Sha.nullable(),
  commit: Sha.nullable(),
  files: z.array(z.string().max(300)).max(500).default([]),
  checks: z.array(z.object({ name: z.string().max(200), result: CheckResult, required: z.boolean() }).strict()).max(100).default([]),
  tasks: z.array(z.object({ key: z.string().max(40), title: z.string().max(200), role: AgentRole, state: z.string().max(20) }).strict()).max(60).default([]),
  plan: z.object({ version: z.number().int().positive(), summary: z.string().max(2000), hash: z.string().regex(/^[0-9a-f]{64}$/), awaitingApproval: z.boolean() }).strict().nullable().default(null),
  pullRequest: z.object({ number: z.number().int().positive(), url: z.string().url().max(300), ci: z.enum(['pending', 'success', 'failure', 'none']).nullable() }).strict().nullable().default(null),
  /** Where the automated pipeline (ADR 0022) is for this mission, in words. */
  pipeline: z.string().max(200).nullable().default(null),
  /** The integrated change as a unified diff, redacted; cut at 200 kB. */
  patch: z.string().max(200_000).nullable().default(null),
  patchTruncated: z.boolean().default(false),
  /** Reviews the author asks for: whole teams (any member) and named people. */
  requested: z.object({ teams: z.array(TeamSlug).max(20).default([]), people: z.array(KeyId).max(50).default([]) }).strict().default({ teams: [], people: [] }),
}).strict();
export type SharedMission = z.infer<typeof SharedMission>;

/** The body of each kind of entry. Entries are signed; who may write each kind is decided when the log is read. */
export const EntryBodies = {
  'space.create': z.object({ name: z.string().trim().min(1).max(80), member: z.object({ name: PersonName, email: Email.optional() }).strict() }).strict(),
  /** An invitation: whoever holds the code can join with this role and these teams, up to `uses` times. */
  'member.invite': z.object({ invitePublicKey: PublicKey, role: MemberRole, teams: z.array(TeamSlug).max(20), uses: z.number().int().min(1).max(50), expiresAt: z.string().datetime(), note: z.string().max(200).default('') }).strict(),
  'member.join': z.object({ name: PersonName, email: Email.optional(), invite: z.object({ id: EntryId, signature: z.string().regex(/^[A-Za-z0-9+/=]{40,200}$/) }).strict().optional() }).strict(),
  'member.add': z.object({ keyId: KeyId, role: MemberRole, teams: z.array(TeamSlug).max(20) }).strict(),
  'member.update': z.object({ keyId: KeyId, name: PersonName.optional(), role: MemberRole.optional(), teams: z.array(TeamSlug).max(20).optional() }).strict(),
  'member.remove': z.object({ keyId: KeyId }).strict(),
  'team.upsert': z.object({
    slug: TeamSlug, name: z.string().trim().min(1).max(80), description: z.string().max(500).default(''),
    /** Paths this team owns: a change touching them needs an approving review from one of its members. */
    owns: z.array(Glob).max(50).default([]),
    /** Model for missions run for this team's work (provider/model); null: each member's Settings. */
    model: z.string().regex(MODEL_REF).nullable().default(null),
  }).strict(),
  'team.remove': z.object({ slug: TeamSlug }).strict(),
  'item.create': z.object({ title: z.string().trim().min(1).max(200), detail: z.string().max(8000).default(''), team: TeamSlug.nullable().default(null), assignee: Assignee.default(null), priority: ItemPriority.default('normal') }).strict(),
  'item.update': z.object({ item: EntryId, title: z.string().trim().min(1).max(200).optional(), detail: z.string().max(8000).optional(), team: TeamSlug.nullable().optional(), assignee: Assignee.optional(), status: ItemStatus.optional(), priority: ItemPriority.optional() }).strict(),
  /** Take an item: refused when someone else already has it. */
  'item.claim': z.object({ item: EntryId, missionId: Id.optional() }).strict(),
  'mission.share': SharedMission,
  'review': z.object({ missionId: Id, commit: Sha, verdict: z.enum(['approve', 'changes']), note: z.string().max(4000).default('') }).strict(),
  /** A teammate approves a mission's plan; the installation running it acts on it only when its operator allowed that. */
  'plan.approve': z.object({ missionId: Id, planVersion: z.number().int().positive(), planHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  'comment': z.object({ item: EntryId.optional(), missionId: Id.optional(), text: z.string().trim().min(1).max(4000) }).strict().refine((c) => !!c.item !== !!c.missionId, 'a comment is on one item or one mission'),
} as const;
export type EntryKind = keyof typeof EntryBodies;
export const ENTRY_KINDS = Object.keys(EntryBodies) as EntryKind[];
export type EntryBody<K extends EntryKind> = z.output<(typeof EntryBodies)[K]>;

/** One signed record as stored in the ref (entries/<id>.json); the id is the SHA-256 of its signed content. */
export const TeamEntry = z.object({
  v: z.literal(1),
  /** The id of the space's `space.create` entry; null on that entry itself. */
  space: EntryId.nullable(),
  kind: z.enum(ENTRY_KINDS as [EntryKind, ...EntryKind[]]),
  at: z.string().datetime(),
  author: KeyId,
  publicKey: PublicKey,
  body: z.record(z.string(), z.unknown()),
  sig: z.string().regex(/^[A-Za-z0-9+/=]{40,200}$/),
}).strict();
export type TeamEntry = z.infer<typeof TeamEntry>;

// ---- What the renderer sees ----

export interface MemberView { keyId: string; name: string; email: string | null; role: 'maintainer' | 'member'; teams: string[]; joinedAt: string; via: 'created' | 'invite' | 'added'; lastActiveAt: string; me: boolean }
export interface TeamInfo { slug: string; name: string; description: string; owns: string[]; model: string | null; members: string[] }
export interface InviteView { id: string; by: string; role: 'maintainer' | 'member'; teams: string[]; uses: number; used: number; expiresAt: string; note: string; expired: boolean }
export interface JoinRequestView { keyId: string; name: string; email: string | null; at: string }
export interface ItemView {
  id: string; title: string; detail: string; team: string | null; assignee: string | null; priority: z.infer<typeof ItemPriority>; status: z.infer<typeof ItemStatus>;
  createdBy: string; createdAt: string; updatedAt: string; missions: string[]; comments: CommentView[];
}
export interface CommentView { id: string; by: string; at: string; text: string }
export interface ReviewView { id: string; by: string; at: string; commit: string; verdict: 'approve' | 'changes'; note: string; current: boolean }
export interface SharedMissionView extends Omit<SharedMission, 'patch'> {
  author: string; sharedAt: string; updatedAt: string; hasPatch: boolean; reviews: ReviewView[]; comments: CommentView[];
  planApprovals: { by: string; at: string; planVersion: number; planHash: string }[];
  /** Teams whose paths the change touches, and whether a current approval from one of their members exists. */
  owners: { team: string; paths: string[]; approvedBy: string | null }[];
  mine: boolean;
}
export interface ActivityView { id: string; at: string; by: string; text: string; kind: EntryKind; item: string | null; missionId: string | null }

export interface TeamSettings {
  /** Fetch and push the team record in the background (every 30 s) and right after each change made here. */
  autoSync: boolean;
  /** Share every mission of this repository with the team as it runs. */
  shareAll: boolean;
  /** Act on plan approvals teammates give for missions running on this machine. */
  acceptPlanApprovals: boolean;
  /** Pick up items assigned to the agents of these teams and run them as missions here. */
  runner: { enabled: boolean; teams: string[]; runtime: 'fake' | 'pi'; approvalMode: 'ask_risky' | 'ask_all_writes' | 'plan_only' };
}
export const TeamSettingsPatch = z.object({
  autoSync: z.boolean().optional(),
  shareAll: z.boolean().optional(),
  acceptPlanApprovals: z.boolean().optional(),
  runner: z.object({ enabled: z.boolean(), teams: z.array(TeamSlug).max(20), runtime: RuntimeKind, approvalMode: z.enum(['ask_risky', 'ask_all_writes', 'plan_only']) }).strict().optional(),
}).strict();

export interface TeamSyncStatus { state: 'idle' | 'syncing' | 'error' | 'local'; at: string | null; error: string | null; pulled: number; pushed: number }

export interface TeamView {
  workspaceId: string;
  /** Git repository with an origin remote: the record can be shared. */
  remote: string | null;
  me: { keyId: string; name: string; email: string | null; member: boolean; maintainer: boolean; requested: boolean };
  space: { id: string; name: string; createdAt: string; createdBy: string } | null;
  members: MemberView[];
  teams: TeamInfo[];
  invites: InviteView[];
  joinRequests: JoinRequestView[];
  items: ItemView[];
  missions: SharedMissionView[];
  activity: ActivityView[];
  /** Entries in the record that were not accepted (bad signature, not a member, not allowed), with the reason. */
  rejected: { id: string; kind: string; reason: string }[];
  sync: TeamSyncStatus;
  settings: TeamSettings;
}
