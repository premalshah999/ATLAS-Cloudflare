// Export, import, deletion and retention (manual §38, §39, §43).
// Export format: JSONL, one record per line, versioned, redacted, ending with a trailer whose hash covers
// every previous line so truncation or edits are detected on import.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { AtlasError, newId, nowIso, redact, redactDeep, type Artifact, type AtlasEvent, type Mission } from '@atlas/contracts';
import type { ArtifactStore, Repo } from '@atlas/storage';
import { verifySignature, type ExportKeys } from './signing';
import { deleteRefs, git, removeWorktree } from '@atlas/workspace';

export const EXPORT_VERSION = 1;
const TEXT_KINDS = new Set(['log', 'patch', 'transcript', 'test_report', 'plan', 'evidence', 'context', 'manifest']);

export function exportMission(repo: Repo, artifacts: ArtifactStore, missionId: string, file: string, keys?: ExportKeys): { records: number; sha256: string; keyId: string | null } {
  const m = repo.mission(missionId);
  if (!m) throw new AtlasError('invalid_request', 'Unknown mission');
  const w = repo.workspace(m.workspaceId);
  const lines: string[] = [];
  const push = (r: Record<string, unknown>) => lines.push(JSON.stringify(redactDeep(r)));
  push({ type: 'atlas-export', version: EXPORT_VERSION, exportedAt: nowIso(), missionId });
  push({ type: 'mission', data: m });
  if (w) push({ type: 'workspace', data: { id: w.id, name: w.name } });
  const plan = repo.plan(missionId);
  if (plan) push({ type: 'plan', data: plan });
  for (const t of repo.tasks(missionId)) push({ type: 'task', data: t });
  for (const a of repo.attempts(missionId)) push({ type: 'attempt', data: a });
  for (const a of repo.approvals(missionId)) push({ type: 'approval', data: a });
  for (const c of repo.checks(missionId)) push({ type: 'check', data: c });
  for (const f of repo.findings(missionId)) push({ type: 'finding', data: f });
  // Page through the whole log: an export is evidence and is never cut short.
  for (let after = 0; ;) {
    const page = repo.eventsSince(missionId, after, 5000);
    for (const e of page) push({ type: 'event', data: e });
    if (page.length < 5000) break;
    after = page[page.length - 1].seq;
  }
  for (const a of artifacts.list(missionId)) {
    const { bytes, intact } = artifacts.readBytes(a.id);
    // Text artifacts are already redacted at write time; redact again in case patterns improved since.
    const text = TEXT_KINDS.has(a.kind);
    const content = text ? redact(bytes.toString('utf8')) : bytes.toString('base64');
    const sha256 = createHash('sha256').update(text ? Buffer.from(content, 'utf8') : bytes).digest('hex');
    // `intact` (checked against the checksum recorded at write time) travels with the record and is covered by the
    // trailer hash, so re-hashing for export can never vouch for evidence that was altered on disk.
    lines.push(JSON.stringify({ type: 'artifact', data: { ...a, sha256, size: text ? Buffer.byteLength(content) : bytes.length }, recordedSha256: a.sha256, encoding: text ? 'utf8' : 'base64', intact, content }));
  }
  const sha256 = createHash('sha256').update(lines.join('\n')).digest('hex');
  // The signature covers the trailer hash, which covers every record: who produced this export, not just "unchanged".
  const signature = keys ? keys.sign(sha256) : undefined;
  lines.push(JSON.stringify({ type: 'end', records: lines.length, sha256, ...(signature ? { signature } : {}) }));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return { records: lines.length, sha256, keyId: signature?.keyId ?? null };
}

export interface Provenance { signed: boolean; keyId: string | null; trusted: boolean; own: boolean }

/** Import an export as a read-only archived mission. Verifies the trailer hash and every artifact checksum. */
export function importMission(repo: Repo, artifacts: ArtifactStore, file: string, trust: (keyId: string) => { trusted: boolean; own: boolean } = () => ({ trusted: false, own: false })): { mission: Mission; provenance: Provenance } {
  if (!existsSync(file)) throw new AtlasError('invalid_request', 'Export file not found');
  const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const records = raw.map((l, i) => { try { return JSON.parse(l) as Record<string, any>; } catch { throw new AtlasError('invalid_request', `Line ${i + 1} is not valid JSON`); } });
  const head = records[0];
  if (head?.type !== 'atlas-export') throw new AtlasError('invalid_request', 'Not an ATLAS export');
  if (head.version !== EXPORT_VERSION) throw new AtlasError('invalid_request', `Unsupported export version ${head.version}`);
  const end = records[records.length - 1];
  if (end?.type !== 'end') throw new AtlasError('invalid_request', 'Export is truncated (no trailer)');
  const sha = createHash('sha256').update(raw.slice(0, -1).join('\n')).digest('hex');
  if (sha !== end.sha256) throw new AtlasError('invalid_request', 'Export failed its integrity check (contents changed or truncated)');
  let provenance: Provenance = { signed: false, keyId: null, trusted: false, own: false };
  if (end.signature !== undefined) {
    if (!verifySignature(end.sha256, end.signature)) throw new AtlasError('invalid_request', 'Export signature is invalid: it was changed after it was signed');
    provenance = { signed: true, keyId: end.signature.keyId, ...trust(end.signature.keyId) };
  }
  // Phase 8 finding: an artifact tampered on disk before export was re-hashed and imported elsewhere as intact.
  const failed = records.filter((r) => r.type === 'artifact' && r.intact !== true);
  if (failed.length) throw new AtlasError('invalid_request', `Export contains ${failed.length} artifact(s) that failed their checksum before export (${failed.slice(0, 3).map((r) => r.data?.name ?? r.data?.id).join(', ')}); refusing to import evidence that cannot be trusted`);
  const m = records.find((r) => r.type === 'mission')!.data as Mission;
  if (repo.mission(m.id)) throw new AtlasError('invalid_request', `Mission ${m.id} already exists here`);
  const wsRec = records.find((r) => r.type === 'workspace')?.data as { id: string; name: string } | undefined;
  let workspaceId = wsRec?.id ?? newId('ws');
  if (!repo.workspace(workspaceId)) {
    const now = nowIso();
    const w = repo.upsertWorkspace({ id: workspaceId, name: `${wsRec?.name ?? 'imported'} (archive)`, root: `archive:${workspaceId}`, isGit: false, branch: null, head: null, dirty: 0, createdAt: now, updatedAt: now });
    workspaceId = w.id;
  }
  repo.insertMission({ ...m, workspaceId, archived: true });
  const planRec = records.find((r) => r.type === 'plan')?.data;
  if (planRec) repo.insertPlan(m.id, planRec.plan, planRec.status);
  const tasks = records.filter((r) => r.type === 'task').map((r) => r.data);
  for (const t of tasks) repo.insertTask({ ...t, parentTaskId: null });
  for (const r of records) {
    if (r.type === 'attempt') repo.insertAttempt(r.data);
    else if (r.type === 'approval') repo.insertApproval(r.data);
    else if (r.type === 'check') repo.insertCheck(r.data);
    else if (r.type === 'finding') repo.insertFinding(r.data);
    else if (r.type === 'event') repo.insertRawEvent(r.data as AtlasEvent);
    else if (r.type === 'artifact') artifacts.restore(r.data as Artifact, Buffer.from(r.content, r.encoding === 'base64' ? 'base64' : 'utf8'));
  }
  repo.setArchived(m.id);
  return { mission: repo.mission(m.id)!, provenance };
}

/** Delete a finished mission: worktrees, task branches, artifacts and rows. A branch the operator accepted is theirs and stays. */
export async function deleteMission(repo: Repo, artifacts: ArtifactStore, missionId: string, worktreeDir: string): Promise<void> {
  const m = repo.mission(missionId);
  if (!m) throw new AtlasError('invalid_request', 'Unknown mission');
  if (['planning', 'running', 'verifying'].includes(m.state)) throw new AtlasError('invalid_request', 'Cancel the mission before deleting it');
  const w = repo.workspace(m.workspaceId);
  if (w?.isGit && !m.archived) {
    for (const t of repo.tasks(missionId)) {
      if (t.worktree) await removeWorktree(w.root, t.worktree, t.branch).catch(() => {});
      // Worktrees of earlier (lost or failed) attempts, too: they are not referenced by the task row any more.
      for (const a of repo.attempts(missionId).filter((x) => x.taskId === t.id)) {
        const dir = `${worktreeDir}/${m.id}/${t.key}-${a.number}`;
        if (dir !== t.worktree) await removeWorktree(w.root, dir, `atlas/${m.id}/${t.key}-${a.number}`).catch(() => {});
      }
    }
    if (m.integrationBranch) await removeWorktree(w.root, `${worktreeDir}/${m.id}/integration`, m.decision === 'accepted' ? null : m.integrationBranch).catch(() => {});
    await git(w.root, ['update-ref', '-d', `refs/atlas/rejected/${m.id}`]).catch(() => {});
    await git(w.root, ['update-ref', '-d', `refs/atlas/forge/${m.id}`]).catch(() => {});
    // Deleting a mission is the operator's explicit request to drop its preserved work too.
    await deleteRefs(w.root, `refs/atlas/preserved/${m.id}/`).catch(() => 0);
  }
  artifacts.removeFiles(missionId);
  repo.deleteMission(missionId);
}
