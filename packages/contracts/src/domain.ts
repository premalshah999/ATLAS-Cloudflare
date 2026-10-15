// ATLAS domain model (manual §11–12). These are product contracts: no SDK types appear here.
import { z } from 'zod';

export const Id = z.string().regex(/^[a-z]+_[A-Za-z0-9]{6,32}$/, 'malformed id');
export type Id = z.infer<typeof Id>;

export const MissionState = z.enum(['draft', 'planning', 'awaiting_approval', 'running', 'verifying', 'completed', 'failed', 'cancelled']);
export type MissionState = z.infer<typeof MissionState>;

export const TaskState = z.enum(['queued', 'blocked', 'ready', 'running', 'reviewing', 'done', 'failed', 'cancelled']);
export type TaskState = z.infer<typeof TaskState>;

export const AttemptState = z.enum(['starting', 'running', 'succeeded', 'failed', 'cancelled', 'lost']);
export type AttemptState = z.infer<typeof AttemptState>;

export const ApprovalMode = z.enum(['ask_risky', 'ask_all_writes', 'plan_only']);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

export const RuntimeKind = z.enum(['fake', 'pi']);
export type RuntimeKind = z.infer<typeof RuntimeKind>;

export const AgentRole = z.enum(['orchestrator', 'coder', 'reviewer', 'tester', 'browser_qa', 'desktop_operator', 'deployment_verifier', 'security_reviewer']);
export type AgentRole = z.infer<typeof AgentRole>;

export interface Workspace {
  id: string;
  name: string;
  root: string;
  isGit: boolean;
  branch: string | null;
  head: string | null;
  dirty: number;
  createdAt: string;
  updatedAt: string;
}

export interface Mission {
  id: string;
  workspaceId: string;
  title: string;
  goal: string;
  constraints: string;
  approvalMode: ApprovalMode;
  runtime: RuntimeKind;
  baseCommit: string | null;
  state: MissionState;
  planVersion: number;
  policyId: string;
  /** Final outcome in words, computed by the release gate — never a model summary. */
  outcome: string | null;
  decision: 'accepted' | 'rejected' | null;
  budget: MissionBudget;
  /** Branch and commit produced by the controlled integration step. */
  integrationBranch: string | null;
  integrationCommit: string | null;
  /** Imported from an export: read-only, never scheduled. */
  archived: boolean;
  /** Staging target the operator chose for this mission (manual §34); null = no deployment. */
  targetEnvironment: string | null;
  /** Release-gate verdict once verification ran: only `verified` means a required check actually passed. */
  verdict: 'verified' | 'unverified' | 'failed' | null;
  /**
   * Set when the mission fixes CI on an earlier mission's pull request (ADR 0015): it starts from the pull request's
   * head instead of the checkout's HEAD, and its result is pushed to the same branch.
   */
  followUp: { parentMissionId: string; branch: string; headSha: string; pullRequest: number } | null;
  /** provider/model for every agent of the mission; null: the Settings choice for each role's tier (ADR 0017). */
  model?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Resource governance per mission (manual §16, §41). */
export const MissionBudget = z.object({
  maxConcurrentAgents: z.number().int().min(1).max(8).default(2),
  maxTasks: z.number().int().min(1).max(50).default(12),
  maxDelegationDepth: z.number().int().min(0).max(4).default(2),
  maxTokens: z.number().int().min(1000).max(50_000_000).default(2_000_000),
  maxWallClockMinutes: z.number().int().min(1).max(24 * 60).default(120),
});
export type MissionBudget = z.infer<typeof MissionBudget>;
export const DEFAULT_BUDGET: MissionBudget = MissionBudget.parse({});

export interface Task {
  id: string;
  missionId: string;
  key: string;
  title: string;
  role: AgentRole;
  dependencies: string[];
  state: TaskState;
  retries: number;
  acceptance: string[];
  resultRef: string | null;
  worktree: string | null;
  branch: string | null;
  /** Checkpoint commit produced by this task, the base for its dependents. */
  checkpoint: string | null;
  /** Set for subtasks created by delegation. */
  parentTaskId: string | null;
  depth: number;
}

/** A staging deployment record (manual §30). Production deployment does not exist in this release. */
export interface Deployment {
  id: string;
  missionId: string | null;
  target: string;
  provider: 'local' | 'command';
  revision: string;
  url: string | null;
  externalId: string | null;
  /** deploying → live | failed; live → superseded | rolled_back | stopped; unknown after a crash mid-deploy. */
  status: 'deploying' | 'live' | 'failed' | 'superseded' | 'rolled_back' | 'stopped' | 'unknown';
  verified: boolean;
  releaseDir: string | null;
  previousId: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export const FindingSeverity = z.enum(['high', 'medium', 'low', 'info']);
export const FindingKind = z.enum(['confirmed', 'suspected', 'informational']);

/** A structured review finding (manual §29). `confirmed` requires a reproduction ATLAS itself observed. */
export interface Finding {
  id: string;
  missionId: string;
  taskId: string;
  file: string;
  line: number | null;
  endLine: number | null;
  severity: z.infer<typeof FindingSeverity>;
  kind: z.infer<typeof FindingKind>;
  title: string;
  observation: string;
  recommendation: string | null;
  evidence: string;
  /** Artifact of the failing command run ATLAS recorded, when the finding is confirmed. */
  reproductionArtifactId: string | null;
  confidence: number;
  status: 'open' | 'accepted' | 'dismissed' | 'fixed';
  fingerprint: string;
  createdAt: string;
  /** An agent's review, or ATLAS's deterministic security scan (ADR 0023). */
  source?: 'review' | 'security';
}

export interface Attempt {
  id: string;
  taskId: string;
  missionId: string;
  number: number;
  state: AttemptState;
  runtime: RuntimeKind;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  tokens: number;
}

export const ArtifactKind = z.enum(['log', 'patch', 'transcript', 'test_report', 'plan', 'evidence', 'screenshot', 'context', 'trace', 'manifest', 'export']);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export interface Artifact {
  id: string;
  missionId: string;
  taskId: string | null;
  kind: ArtifactKind;
  name: string;
  size: number;
  sha256: string;
  createdAt: string;
}

export const ApprovalStatus = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export interface Approval {
  id: string;
  missionId: string;
  taskId: string | null;
  agentRole: AgentRole;
  tool: string;
  capability: string;
  /** Exact command, path or target, already redacted. */
  action: string;
  environment: string;
  resources: string[];
  reason: string;
  risk: 'low' | 'elevated' | 'high';
  scope: 'once';
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export const CheckResult = z.enum(['pass', 'fail', 'skipped', 'inconclusive', 'not_configured']);
export type CheckResult = z.infer<typeof CheckResult>;

export interface CheckRecord {
  id: string;
  missionId: string;
  name: string;
  command: string | null;
  required: boolean;
  result: CheckResult;
  exitCode: number | null;
  durationMs: number | null;
  reason: string;
  artifactId: string | null;
  commit: string | null;
}

/** Plan as proposed by a planner; validated before it can be approved (§14). */
export const PlanTask = z.object({
  key: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().min(1).max(200),
  role: AgentRole,
  dependsOn: z.array(z.string()).default([]),
  acceptance: z.array(z.string().min(1)).min(1),
  tools: z.array(z.string()).min(1),
  risk: z.enum(['low', 'elevated', 'high']),
  rollback: z.string().optional(),
  /** Paths the task expects to touch; informs scheduling of writers. */
  files: z.array(z.string()).max(200).optional(),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const Plan = z.object({
  version: z.number().int().positive(),
  summary: z.string(),
  scope: z.string().min(1),
  tasks: z.array(PlanTask).min(1),
  verification: z.array(z.object({ name: z.string(), required: z.boolean() })),
});
export type Plan = z.infer<typeof Plan>;
