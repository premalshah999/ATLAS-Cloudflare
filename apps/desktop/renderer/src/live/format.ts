// Plain-language rendering of audit events. Words carry the meaning; color only reinforces it.
import type { AtlasEvent } from '@atlas/contracts';

export type Tone = 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'human';
export interface Row { title: string; detail?: string; meta?: string; tone: Tone; kind: 'activity' | 'decision' | 'file' | 'error' | 'approval' | 'milestone' | 'test' | 'delegation'; who: string }

const ROLE_MARK: Record<string, string> = { coder: 'CO', tester: 'TE', reviewer: 'RV', orchestrator: 'OR', browser_qa: 'QA', desktop_operator: 'DK', deployment_verifier: 'DV' };
export const markOf = (e: AtlasEvent) => e.actor.kind === 'operator' ? 'YOU' : e.actor.kind === 'agent' ? ROLE_MARK[e.actor.role] ?? 'AG' : 'AT';
export const roleName = (r: string) => ({ coder: 'Coder', tester: 'Tester', reviewer: 'Reviewer', orchestrator: 'Orchestrator', browser_qa: 'Browser QA', desktop_operator: 'Desktop operator', deployment_verifier: 'Deployment verifier' } as Record<string, string>)[r] ?? r;
export const roleMark = (r: string) => ROLE_MARK[r] ?? r.slice(0, 2).toUpperCase();

const STATE_WORD: Record<string, string> = {
  draft: 'Draft', planning: 'Planning', awaiting_approval: 'Awaiting plan approval', running: 'Running', verifying: 'Verifying', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  queued: 'Queued', blocked: 'Blocked', ready: 'Ready', reviewing: 'Reviewing', done: 'Done',
};
export const stateWord = (s: string) => STATE_WORD[s] ?? s;

function argText(tool: string, a: Record<string, unknown>) {
  if (tool === 'shell_exec') return [a.command, ...((a.args as string[]) ?? [])].join(' ');
  if (typeof a.path === 'string') return a.path;
  return '';
}

/** Returns null for events that belong to other panes (process output) or add no information. */
export function describeEvent(e: AtlasEvent): Row | null {
  const p = e.payload as Record<string, any>;
  const who = e.actor.kind === 'operator' ? 'You' : e.actor.kind === 'agent' ? roleName(e.actor.role) : 'ATLAS';
  switch (e.type) {
    case 'mission.created': return { title: 'Mission created', detail: p.goal, meta: `${p.runtime} runtime`, tone: 'human', kind: 'activity', who };
    case 'mission.state': return { title: `Mission ${stateWord(p.to).toLowerCase()}`, detail: p.reason, tone: p.to === 'failed' ? 'danger' : p.to === 'completed' ? 'success' : 'muted', kind: p.to === 'failed' ? 'error' : 'activity', who };
    case 'plan.proposed': return { title: `Plan v${p.version} proposed`, detail: p.summary, meta: `${p.tasks?.length ?? 0} task${p.tasks?.length === 1 ? '' : 's'}`, tone: 'accent', kind: 'decision', who };
    case 'plan.rejected': return { title: 'Plan rejected by validation', detail: (p.issues ?? []).map((i: any) => i.message).join('\n'), tone: 'danger', kind: 'error', who };
    case 'plan.approved': return { title: `Plan v${p.version} approved`, meta: `base ${String(p.baseCommit).slice(0, 7)}`, tone: 'human', kind: 'decision', who };
    case 'task.state': return p.from === null ? null : { title: `Task ${p.key}: ${stateWord(p.to).toLowerCase()}`, detail: p.reason ?? p.errorKind, tone: p.to === 'failed' ? 'danger' : 'muted', kind: p.to === 'failed' ? 'error' : 'activity', who };
    case 'attempt.started': return { title: `${roleName(p.role)} started attempt ${p.number}`, detail: `Isolated worktree on ${p.branch}`, meta: p.roleVersion, tone: 'muted', kind: 'delegation', who };
    case 'attempt.ended': return p.state === 'succeeded' ? null : { title: `Attempt ${p.number} ${p.state}`, detail: p.message, tone: p.state === 'lost' ? 'warning' : 'danger', kind: 'error', who };
    case 'agent.message': return p.claim
      ? { title: 'Agent summary — a claim, not evidence', detail: p.text, tone: 'muted', kind: 'decision', who }
      : { title: p.text, tone: 'muted', kind: 'activity', who };
    case 'agent.tool_call': return { title: `${p.tool}`, meta: argText(p.tool, p.args ?? {}), tone: 'muted', kind: p.tool === 'write_file' ? 'file' : p.tool === 'run_tests' ? 'test' : 'activity', who };
    case 'agent.tool_result': return p.ok ? null : { title: `${p.tool} did not succeed`, detail: String(p.summary ?? '').slice(-600), tone: 'warning', kind: 'error', who };
    case 'policy.decision': return p.decision === 'deny' ? { title: `Denied by policy: ${p.tool}`, detail: p.reason, meta: p.action, tone: 'danger', kind: 'error', who } : null;
    case 'approval.requested': return { title: `Approval requested: ${p.action}`, detail: p.reason, meta: `${p.risk} risk`, tone: 'warning', kind: 'approval', who };
    case 'approval.decided': return { title: `Approval ${p.status}`, meta: p.action, tone: p.status === 'approved' ? 'human' : 'warning', kind: 'approval', who };
    case 'process.started': return { title: `$ ${p.command}`, tone: 'muted', kind: 'activity', who };
    case 'process.exited': return { title: `${p.command}`, meta: p.timedOut ? 'timed out' : p.cancelled ? 'cancelled' : `exit ${p.exitCode} · ${fmtMs(p.durationMs)}`, tone: p.exitCode === 0 ? 'muted' : 'warning', kind: 'test', who };
    case 'workspace.worktree': return p.action === 'created'
      ? { title: 'Worktree created', detail: p.path, meta: p.branch, tone: 'muted', kind: 'activity', who }
      : { title: p.commit ? `Checkpoint ${String(p.commit).slice(0, 7)}` : 'No file changes to checkpoint', meta: p.files?.length ? `${p.files.length} file${p.files.length === 1 ? '' : 's'}` : undefined, tone: 'muted', kind: 'file', who };
    case 'check.result': return { title: `Check ${p.name}: ${resultWord(p.result)}`, detail: p.reason, meta: p.commit ? `@ ${String(p.commit).slice(0, 7)}` : undefined, tone: p.result === 'pass' ? 'success' : p.result === 'fail' ? 'danger' : 'warning', kind: p.result === 'pass' ? 'milestone' : 'test', who };
    case 'gate.result': return { title: p.summary, tone: p.verdict === 'verified' ? 'success' : p.verdict === 'failed' ? 'danger' : 'warning', kind: p.verdict === 'verified' ? 'milestone' : 'error', who };
    case 'mission.decision': return { title: p.decision === 'accept' ? 'Changes accepted' : 'Changes rejected', detail: p.note, tone: 'human', kind: 'decision', who };
    case 'operator.action': return { title: p.action === 'cloudflare.published' ? 'You published mission checkpoints to Cloudflare Artifacts' : p.action === 'cancel' ? 'You cancelled the mission' : `You cancelled task ${p.key}`, detail: p.action === 'cloudflare.published' ? p.remote : undefined, tone: 'human', kind: 'activity', who };
    case 'daemon.recovered': return { title: 'Recovered after a daemon restart', detail: `State was ${stateWord(p.state).toLowerCase()}. Lost attempts restart in fresh worktrees.`, tone: 'warning', kind: 'activity', who };
    case 'plan.planner': return { title: p.valid ? 'Model proposed a valid plan' : 'Model plan failed validation', detail: p.rationale, meta: p.inputTokens != null ? `${p.inputTokens + (p.outputTokens ?? 0)} tokens` : undefined, tone: p.valid ? 'muted' : 'warning', kind: 'decision', who };
    case 'integration.result': return p.ok
      ? { title: `Integrated ${(p.merged ?? []).join(', ')}`, meta: `${String(p.commit).slice(0, 7)} on ${p.branch}`, tone: 'success', kind: 'milestone', who }
      : { title: `Integration conflict in task ${p.task}`, detail: `${(p.conflicts ?? []).join('\n')}\n${p.message ?? ''}`.trim(), tone: 'danger', kind: 'error', who };
    case 'finding.reported': return { title: `Finding (${p.kind}, ${p.severity}): ${p.title}`, meta: `${p.file}${p.line ? `:${p.line}` : ''}`, detail: p.downgraded ? 'Downgraded to suspected: no failing reproduction from this review was referenced.' : undefined, tone: p.kind === 'confirmed' ? 'danger' : 'warning', kind: 'decision', who };
    case 'finding.updated': return { title: `You marked "${p.title}" ${p.to}`, tone: 'human', kind: 'decision', who };
    case 'delegation.requested': return { title: `Delegated ${p.childKey}: ${p.title}`, detail: p.reason, meta: `${roleName(p.role)} · depth ${p.depth}`, tone: 'accent', kind: 'delegation', who };
    case 'delegation.result': return { title: `Delegation ${p.childKey ?? p.title}: ${p.status}`, detail: p.reason ?? (p.conflicts ?? []).join('\n'), tone: ['done', 'merged'].includes(p.status) ? 'muted' : 'warning', kind: 'delegation', who };
    case 'budget.exceeded': return { title: 'Budget exceeded — mission stopped', detail: p.reason, tone: 'danger', kind: 'error', who };
    case 'context.built': return null;
    case 'browser.step': return p.phase === 'app'
      ? { title: `App started for browser checks`, meta: p.url, tone: 'muted', kind: 'activity', who }
      : { title: `Browser ${p.flow ? `${p.flow} · ` : ''}${p.action}${p.ok ? '' : ' failed'}`, detail: p.ok ? undefined : p.message, meta: p.url, tone: p.ok ? 'muted' : 'danger', kind: 'test', who };
    case 'deploy.event': return { title: p.phase === 'started' ? `Deploying ${String(p.revision).slice(0, 7)} to ${p.target}` : p.phase === 'live' ? `Live on ${p.target}` : `Deployment to ${p.target} failed`, detail: p.phase === 'failed' ? p.message : undefined, meta: p.url ?? p.provider, tone: p.phase === 'failed' ? 'danger' : p.phase === 'live' ? 'success' : 'accent', kind: 'milestone', who };
    case 'staging.check': return { title: p.verified ? 'Staging verified independently' : 'Staging verification failed', meta: `manifest ${String(p.manifestSha256).slice(0, 12)}`, tone: p.verified ? 'success' : 'danger', kind: p.verified ? 'milestone' : 'error', who };
    case 'rollback.result': return { title: p.attempted ? (p.ok ? `Rolled back to ${String(p.toRevision).slice(0, 7)}${p.revisionConfirmed ? ' (revision confirmed)' : ''}` : 'Rollback failed') : 'No rollback', detail: p.message ?? p.reason, tone: p.attempted && p.ok ? 'warning' : p.attempted ? 'danger' : 'muted', kind: 'activity', who };
    case 'desktop.session': return { title: `Desktop ${p.change}`, meta: `${p.display} · ${p.controller}`, detail: p.change === 'started' ? p.environment : undefined, tone: e.actor.kind === 'operator' ? 'human' : 'muted', kind: 'activity', who };
    case 'desktop.action': return { title: `Desktop ${p.action}${p.ok ? '' : ' refused'}`, detail: p.ok ? undefined : p.message, meta: p.args && Object.keys(p.args).length ? JSON.stringify(p.args) : undefined, tone: p.ok ? 'muted' : 'warning', kind: 'activity', who };
    case 'operator.terminal': return { title: `Terminal ${p.action}`, meta: p.worktree, detail: p.action === 'opened' ? `${p.writable ? 'Writable' : 'Read-only (an agent holds the worktree)'} · ${p.sandboxed ? 'sandboxed' : 'unsandboxed'}` : undefined, tone: 'human', kind: 'activity', who };
    case 'error': return { title: 'Error', detail: p.message, tone: 'danger', kind: 'error', who };
    default: return null;
  }
}

export function resultWord(r: string) {
  return ({ pass: 'passed', fail: 'failed', skipped: 'skipped', inconclusive: 'inconclusive', not_configured: 'not configured' } as Record<string, string>)[r] ?? r;
}
export function fmtMs(ms?: number | null) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });
export const ago = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
