// The delivery pipeline of a mission (ADR 0022): plan → build → verify → accept → pull request → CI → ready to merge.
// Stages are derived from the mission and its events only; the pipeline stores no state of its own. Automation is
// per repository and off by default. ATLAS never merges and never deploys to production.
import { z } from 'zod';
import type { Mission } from './domain';
import type { AtlasEvent } from './events';

export const PipelineSettings = z.object({
  /** Push and open the pull request as soon as a verified mission is accepted. */
  autoPublish: z.boolean().default(false),
  /** When CI fails on a published change: do nothing, prepare a fix mission for the operator, or run it end to end. */
  fixCi: z.enum(['off', 'propose', 'auto']).default('off'),
  /** Automatic fix rounds per pull request before ATLAS stops and asks a person. */
  maxFixRounds: z.number().int().min(1).max(5).default(2),
  /** Accept an automatic CI fix when it is verified, with no blocking finding. Without it, fixes wait for the operator. */
  autoAcceptFixes: z.boolean().default(false),
}).strict();
export type PipelineSettings = z.infer<typeof PipelineSettings>;
export const DEFAULT_PIPELINE: PipelineSettings = PipelineSettings.parse({});

export type StageState = 'done' | 'active' | 'waiting' | 'failed' | 'idle' | 'skipped';
export interface PipelineStage { key: 'plan' | 'build' | 'verify' | 'accept' | 'pr' | 'ci' | 'ready'; label: string; state: StageState; detail: string | null }
export interface PipelineView { stages: PipelineStage[]; summary: string; automated: string | null }

const last = (ev: AtlasEvent[], type: AtlasEvent['type'], after = 0) => { for (let i = ev.length - 1; i >= 0; i--) if (ev[i].type === type && ev[i].seq > after) return ev[i]; return null; };

/** The only event types pipelineOf reads: callers may pass just these. */
export const PIPELINE_EVENT_TYPES = ['plan.approved', 'forge.published', 'forge.ci', 'pipeline.step'] as const;

export function pipelineOf(m: Pick<Mission, 'state' | 'verdict' | 'decision' | 'followUp' | 'archived'>, ev: AtlasEvent[]): PipelineView {
  const approved = !!last(ev, 'plan.approved');
  const pub = last(ev, 'forge.published');
  const ci = pub ? last(ev, 'forge.ci', pub.seq) : null;
  const ciState = ci ? String(ci.payload.state) : null;
  const step = last(ev, 'pipeline.step');
  const st = (cond: boolean, s: StageState, otherwise: StageState = 'idle') => (cond ? s : otherwise);
  const failedEarly = m.state === 'failed' || m.state === 'cancelled';

  const plan: PipelineStage = { key: 'plan', label: 'Plan', detail: null,
    state: approved ? 'done' : m.state === 'awaiting_approval' ? 'waiting' : m.state === 'planning' ? 'active' : failedEarly ? 'failed' : 'idle' };
  const build: PipelineStage = { key: 'build', label: 'Build', detail: null,
    state: !approved ? 'idle' : m.state === 'running' ? 'active' : ['verifying', 'completed'].includes(m.state) || m.verdict ? 'done' : failedEarly ? 'failed' : 'idle' };
  const verify: PipelineStage = { key: 'verify', label: 'Verify', detail: m.verdict,
    state: m.state === 'verifying' ? 'active' : m.verdict === 'verified' ? 'done' : m.verdict ? 'failed' : failedEarly && approved ? 'failed' : 'idle' };
  const accept: PipelineStage = { key: 'accept', label: 'Accept', detail: m.decision,
    state: m.decision === 'accepted' ? 'done' : m.decision === 'rejected' ? 'failed' : m.state === 'completed' ? 'waiting' : 'idle' };
  const prDetail = pub ? `#${pub.payload.number}` : null;
  const pr: PipelineStage = { key: 'pr', label: 'Pull request', detail: prDetail, state: st(!!pub, 'done', m.decision === 'accepted' ? 'waiting' : 'idle') };
  const ciStage: PipelineStage = { key: 'ci', label: 'CI', detail: ciState,
    state: !pub ? 'idle' : ciState === 'success' ? 'done' : ciState === 'failure' ? 'failed' : ciState === 'none' ? 'waiting' : 'active' };
  const ready: PipelineStage = { key: 'ready', label: 'Ready to merge', detail: null, state: ciState === 'success' ? 'done' : 'idle' };
  const stages = [plan, build, verify, accept, pr, ciStage, ready];

  const summary = m.archived ? 'Imported archive'
    : ciState === 'success' ? `Ready to merge: CI passed on ${prDetail}`
    : ciState === 'failure' ? `CI failed on ${prDetail}`
    : pub ? `${prDetail} open, ${ciState === 'none' ? 'no CI reported yet' : 'CI running'}`
    : m.decision === 'accepted' ? 'Accepted; not published'
    : m.decision === 'rejected' ? 'Rejected'
    : m.state === 'completed' ? (m.verdict === 'verified' ? 'Verified; waiting for acceptance' : 'Finished without verification; waiting for a decision')
    : m.state === 'verifying' ? 'Verifying'
    : m.state === 'running' ? 'Building'
    : m.state === 'awaiting_approval' ? 'Waiting for plan approval'
    : m.state === 'planning' ? 'Planning'
    : m.state === 'failed' ? 'Failed' : m.state === 'cancelled' ? 'Cancelled' : 'Draft';
  return { stages, summary, automated: step ? String(step.payload.text ?? '') || null : null };
}
