// Plain-language rendering of audit events. Words carry the meaning; color only reinforces it.
import type { AtlasEvent } from '@atlas/contracts';

export type Tone = 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'human';
export interface Row { title: string; detail?: string; meta?: string; tone: Tone; kind: 'activity' | 'decision' | 'file' | 'error' | 'approval' | 'milestone' | 'test' | 'delegation'; who: string }

const ROLE_MARK: Record<string, string> = { coder: 'CO', tester: 'TE', reviewer: 'RV', orchestrator: 'OR', browser_qa: 'QA', desktop_operator: 'DK', deployment_verifier: 'DV', security_reviewer: 'SE' };
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
export const markOf = (e: AtlasEvent) => e.actor.kind === 'operator' ? 'YOU' : e.actor.kind === 'agent' ? ROLE_MARK[e.actor.role] ?? 'AG' : e.actor.kind === 'teammate' ? initials(e.actor.name) : e.actor.component === 'pipeline' ? 'PL' : e.actor.component === 'security-scan' ? 'SE' : 'AT';
/** Who did it, in words: you, an agent role, a teammate by name, the pipeline, or ATLAS. */
export const actorName = (a: AtlasEvent['actor']) => a.kind === 'operator' ? 'You' : a.kind === 'agent' ? roleName(a.role) : a.kind === 'teammate' ? a.name : a.component === 'pipeline' ? 'Pipeline' : a.component === 'team-runner' ? 'Team runner' : a.component === 'security-scan' ? 'Security scan' : 'ATLAS';
export const roleName = (r: string) => ({ coder: 'Coder', tester: 'Tester', reviewer: 'Reviewer', orchestrator: 'Orchestrator', browser_qa: 'Browser QA', desktop_operator: 'Desktop operator', deployment_verifier: 'Deployment verifier', security_reviewer: 'Security engineer' } as Record<string, string>)[r] ?? r;
export const roleMark = (r: string) => ROLE_MARK[r] ?? r.slice(0, 2).toUpperCase();

const STATE_WORD: Record<string, string> = {
  draft: 'Draft', planning: 'Planning', awaiting_approval: 'Awaiting plan approval', running: 'Running', verifying: 'Verifying', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  queued: 'Queued', blocked: 'Blocked', ready: 'Ready', reviewing: 'Reviewing', done: 'Done',
};
export const stateWord = (s: string) => STATE_WORD[s] ?? s;

const DOT: Record<string, string> = { running: 'running', verifying: 'running', planning: 'running', awaiting_approval: 'waiting', completed: 'done', failed: 'failed', cancelled: 'idle', draft: 'idle' };
/**
 * How a mission's status is shown everywhere. A finished mission is described by its gate verdict, so an
 * unverified result is never presented like a verified one.
 */
export function missionStatus(m: { state: string; verdict?: string | null }): { dot: string; word: string } {
  if (m.state === 'completed' && m.verdict === 'verified') return { dot: 'done', word: 'Verified' };
  if (m.state === 'completed' && m.verdict === 'unverified') return { dot: 'warning', word: 'Unverified' };
  if (m.state === 'failed' && m.verdict === 'failed') return { dot: 'failed', word: 'Failed verification' };
  return { dot: DOT[m.state] ?? 'idle', word: stateWord(m.state) };
}

function argText(tool: string, a: Record<string, unknown>) {
  if (tool === 'shell_exec') return [a.command, ...((a.args as string[]) ?? [])].join(' ');
  if (typeof a.path === 'string') return a.path;
  return '';
}

/** Returns null for events that belong to other panes (process output) or add no information. */
export function describeEvent(e: AtlasEvent): Row | null {
  const p = e.payload as Record<string, any>;
  const who = actorName(e.actor);
  switch (e.type) {
    case 'mission.created': return { title: 'Mission created', detail: p.goal, meta: `${p.runtime} runtime`, tone: 'human', kind: 'activity', who };
    case 'mission.state': return { title: `Mission ${stateWord(p.to).toLowerCase()}`, detail: p.reason, tone: p.to === 'failed' ? 'danger' : p.to === 'completed' ? 'success' : 'muted', kind: p.to === 'failed' ? 'error' : 'activity', who };
    case 'plan.proposed': return { title: `Plan v${p.version} proposed`, detail: p.summary, meta: `${p.tasks?.length ?? 0} task${p.tasks?.length === 1 ? '' : 's'}`, tone: 'accent', kind: 'decision', who };
    case 'plan.rejected': return { title: 'Plan rejected by validation', detail: (p.issues ?? []).map((i: any) => i.message).join('\n'), tone: 'danger', kind: 'error', who };
    case 'plan.approved': return { title: `Plan v${p.version} approved`, meta: `base ${String(p.baseCommit).slice(0, 7)}`, tone: 'human', kind: 'decision', who };
    case 'task.state': return p.from === null ? null : { title: `Task ${p.key}: ${stateWord(p.to).toLowerCase()}`, detail: p.reason ?? p.errorKind, tone: p.to === 'failed' ? 'danger' : 'muted', kind: p.to === 'failed' ? 'error' : 'activity', who };
    case 'attempt.started': return { title: `${roleName(p.role)} started attempt ${p.number}`, detail: p.resumedFrom ? `Continues attempt ${(p.resumedFrom as { number: number }).number} after a restart · ${p.branch}` : `Isolated worktree on ${p.branch}`, meta: p.model ? `${p.roleVersion} · ${p.model}` : p.roleVersion, tone: 'muted', kind: 'delegation', who };
    case 'attempt.ended': return p.state === 'succeeded' ? null : { title: `Attempt ${p.number} ${p.state}`, detail: p.message, tone: p.state === 'lost' ? 'warning' : 'danger', kind: 'error', who };
    case 'attempt.stalled': return { title: 'No signal', detail: `No events from this attempt for ${Math.round(Number(p.silentForMs) / 1000)} s. It is still running.`, tone: 'warning', kind: 'error', who };
    case 'agent.message': return p.claim
      ? { title: 'Agent summary — a claim, not evidence', detail: p.text, tone: 'muted', kind: 'decision', who }
      : { title: p.text, tone: 'muted', kind: 'activity', who };
    case 'agent.tool_call': return { title: `${p.tool}`, meta: argText(p.tool, p.args ?? {}), tone: 'muted', kind: p.tool === 'write_file' ? 'file' : p.tool === 'run_tests' ? 'test' : 'activity', who };
    case 'agent.tool_result': return p.ok ? null : { title: `${p.tool} did not succeed`, detail: String(p.summary ?? '').slice(-600), tone: 'warning', kind: 'error', who };
    case 'policy.decision': return p.decision === 'deny' ? { title: `Denied by policy: ${p.tool}`, detail: p.reason, meta: p.action, tone: 'danger', kind: 'error', who } : null;
    case 'approval.requested': return { title: `Approval requested: ${p.action}`, detail: p.reason, meta: `${p.risk} risk`, tone: 'warning', kind: 'approval', who };
    case 'approval.decided': return { title: `Approval ${p.status}`, meta: p.action, tone: p.status === 'approved' ? 'human' : 'warning', kind: 'approval', who };
    case 'process.started': return p.background
      ? { title: `Background ${p.background} · ${p.name}: $ ${p.command}`, meta: p.network ? 'serves on loopback' : 'running', tone: 'muted', kind: 'activity', who }
      : { title: `$ ${p.command}`, tone: 'muted', kind: 'activity', who };
    case 'process.exited': return p.background
      ? { title: `Background ${p.background}: ${p.command}`, meta: `${p.stopped ? 'stopped' : `exit ${p.exitCode}`} · ${fmtMs(p.durationMs)}`, tone: p.stopped || p.exitCode === 0 ? 'muted' : 'warning', kind: 'activity', who }
      : { title: `${p.command}`, meta: p.timedOut ? 'timed out' : p.cancelled ? 'cancelled' : `exit ${p.exitCode} · ${fmtMs(p.durationMs)}`, tone: p.exitCode === 0 ? 'muted' : 'warning', kind: 'test', who };
    case 'workspace.worktree': return p.action === 'created'
      ? { title: 'Worktree created', detail: p.path, meta: p.branch, tone: 'muted', kind: 'activity', who }
      : { title: p.commit ? `Checkpoint ${String(p.commit).slice(0, 7)}` : 'No file changes to checkpoint', meta: p.files?.length ? `${p.files.length} file${p.files.length === 1 ? '' : 's'}` : undefined, tone: 'muted', kind: 'file', who };
    case 'workspace.tampered': return { title: 'Worktree git metadata was tampered with', detail: `${p.detail ?? ''}\nATLAS ran no git there and stopped the attempt. The worktree is kept for audit.`.trim(), meta: p.field, tone: 'danger', kind: 'error', who };
    case 'check.result': return { title: `Check ${p.name}: ${resultWord(p.result)}`, detail: p.reason, meta: p.commit ? `@ ${String(p.commit).slice(0, 7)}` : undefined, tone: p.result === 'pass' ? 'success' : p.result === 'fail' ? 'danger' : 'warning', kind: p.result === 'pass' ? 'milestone' : 'test', who };
    case 'gate.result': return { title: p.summary, tone: p.verdict === 'verified' ? 'success' : p.verdict === 'failed' ? 'danger' : 'warning', kind: p.verdict === 'verified' ? 'milestone' : 'error', who };
    case 'mission.decision': return { title: p.decision === 'accept' ? 'Changes accepted' : p.decision === 'restore' ? 'Rejected change restored' : 'Changes rejected', detail: p.note, tone: 'human', kind: 'decision', who };
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
    case 'forge.published': return { title: `${p.created ? 'Opened' : 'Updated'} pull request #${p.number}`, meta: `${p.branch} @ ${String(p.headSha).slice(0, 7)}`, tone: 'accent', kind: 'milestone', who };
    case 'forge.ci': return { title: p.state === 'success' ? `CI passed on #${p.number}` : p.state === 'failure' ? `CI failed on #${p.number}` : p.state === 'pending' ? `CI running on #${p.number}` : `No CI reported on #${p.number}`, detail: p.state === 'failure' ? (p.checks ?? []).filter((c: any) => c.conclusion && !['success', 'neutral', 'skipped'].includes(c.conclusion)).map((c: any) => c.name).join(', ') : undefined, tone: p.state === 'success' ? 'success' : p.state === 'failure' ? 'danger' : 'muted', kind: p.state === 'failure' ? 'error' : 'milestone', who };
    case 'pipeline.step': return { title: p.text, tone: p.ok ? (p.step === 'ready' ? 'success' : 'accent') : 'warning', kind: p.ok ? 'milestone' : 'decision', who };
    case 'team.shared': return { title: 'Shared with the team', detail: [p.teams?.length ? `Review requested from ${p.teams.join(', ')}` : '', p.item ? 'Linked to a team item' : ''].filter(Boolean).join(' · ') || undefined, tone: 'human', kind: 'activity', who };
    case 'team.review': return { title: p.verdict === 'approve' ? `${who} approved${p.current ? '' : ' an earlier commit'}` : `${who} asked for changes`, detail: p.note || undefined, meta: `@ ${String(p.commit).slice(0, 7)}`, tone: p.verdict === 'approve' ? 'success' : 'warning', kind: 'decision', who };
    case 'context.compacted': return p.ok
      ? { title: `Context compacted${p.tokensBefore ? `: ${Math.round(p.tokensBefore / 1000)}k → ${p.tokensAfter ? `${Math.round(p.tokensAfter / 1000)}k` : 'less'} tokens` : ''}`, detail: 'Older conversation was summarized to stay within the model\'s window. Exact records stay in mission memory and the code graph.', meta: p.reason, tone: 'muted', kind: 'activity', who }
      : { title: 'Context compaction failed', detail: p.detail, meta: p.reason, tone: 'warning', kind: 'error', who };
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

/** Tasks whose attempt has produced nothing since the watchdog flagged it (evolution P1-6): shown as "No signal". */
export function stalledTasks(events: readonly AtlasEvent[]): Set<string> {
  const last = new Map<string, AtlasEvent>();
  for (const e of events) if (e.attemptId) last.set(e.attemptId, e);
  const out = new Set<string>();
  for (const e of last.values()) if (e.type === 'attempt.stalled' && e.taskId) out.add(e.taskId);
  return out;
}
