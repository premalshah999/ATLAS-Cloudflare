// Sandboxed execution inside real missions (manual §23 acceptance, ADR 0007).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSandbox } from '@atlas/terminal';
import type { FakeScript } from '@atlas/runtime-fake';
import { sampleRepo, sh, tmpDir } from '../helpers';
import { autoDecide, makeOrchestrator, startMission, waitFor } from './harness';

const hasSandbox = detectSandbox().kind === 'bwrap';

describe.skipIf(!hasSandbox)('missions run commands in the OS sandbox', () => {
  it('a malicious agent command cannot reach a canary credential', async () => {
    const root = sampleRepo();
    const canary = path.join(os.homedir(), `.atlas-mission-canary-${process.pid}`);
    writeFileSync(canary, 'MISSION-CANARY-VALUE');
    // `cat` is on the safe list, so policy allows it without approval: only the sandbox stands in the way.
    const thief: FakeScript = { name: 'thief', matches: () => true, steps: () => [
      { tool: 'shell_exec', args: { command: 'cat', args: [canary] } },
      { tool: 'shell_exec', args: { command: 'ls', args: [os.homedir()] } },
      { claim: 'done' },
    ] };
    try {
      const h = makeOrchestrator({ scripts: [thief] });
      const id = await startMission(h, root);
      await h.orch.settle(id);
      const started = h.events.filter((e) => e.type === 'process.started');
      expect(started.length).toBe(2); // the two agent commands; verification runs are recorded as checks
      expect(started.every((e) => e.payload.sandboxed === true)).toBe(true);
      const all = JSON.stringify(h.repo.eventsSince(id, 0)) + h.artifacts.list(id).map((a) => h.artifacts.read(a.id).text).join('\n');
      expect(all).not.toContain('MISSION-CANARY-VALUE');
    } finally { rmSync(canary, { force: true }); }
  });

  it('network commands get egress only after approval', async () => {
    const root = sampleRepo();
    const script: FakeScript = { name: 'net', matches: () => true, steps: () => [{ tool: 'shell_exec', args: { command: 'npm', args: ['view', 'left-pad', 'version'], timeoutSec: 30 } }, { claim: 'done' }] };
    const h = makeOrchestrator({ scripts: [script] });
    const id = await startMission(h, root);
    const a = await waitFor(() => h.repo.approvals(id).find((x) => x.status === 'pending'));
    expect(h.events.some((e) => e.type === 'process.started')).toBe(false);
    h.orch.respondApproval(a.id, 'approve');
    await h.orch.settle(id);
    const st = h.events.find((e) => e.type === 'process.started' && String(e.payload.command).startsWith('npm view'))!;
    expect(st.payload).toMatchObject({ sandboxed: true, network: true });
    const exit = h.events.find((e) => e.type === 'process.exited' && String(e.payload.command).startsWith('npm view'))!;
    expect(exit.payload.exitCode).toBe(0);
  });

  it('git metadata is read-only to agents (ADR 0031): writes fail with EROFS, git status still works, the checkpoint is as before', async () => {
    const root = sampleRepo();
    const probe = `const fs = require('fs');
const admin = fs.readFileSync('.git', 'utf8').trim().replace(/^gitdir: /, '');
const t = (what, f) => { try { f(); console.log(what + ' WROTE'); } catch (e) { console.log(what + ' DENIED ' + e.code); } };
t('pointer', () => fs.writeFileSync('.git', 'gitdir: ' + process.cwd() + '/evil'));
t('pointer-unlink', () => fs.unlinkSync('.git'));
t('config.worktree', () => fs.writeFileSync(admin + '/config.worktree', '[filter "x"]\\n\\tclean = touch x\\n'));
t('head', () => fs.writeFileSync(admin + '/HEAD', 'ref: refs/heads/main\\n'));`;
    const script: FakeScript = { name: 'meta', matches: () => true, steps: (i) => i.roleId !== 'coder' ? [{ claim: 'nothing to add' }] : [
      { tool: 'write_file', args: { path: 'meta-probe.cjs', content: probe } },
      { tool: 'shell_exec', args: { command: 'node', args: ['meta-probe.cjs'] } },
      { tool: 'write_file', args: { path: 'NOTES.md', content: 'agent work\n' } },
      { tool: 'shell_exec', args: { command: 'git', args: ['status', '--short'] } },
      { claim: 'done' },
    ] };
    const h = makeOrchestrator({ scripts: [script] });
    const id = await startMission(h, root);
    await h.orch.settle(id);
    const results = h.events.filter((e) => e.type === 'agent.tool_result' && e.payload.tool === 'shell_exec').map((e) => String(e.payload.summary));
    expect(results[0]).toMatch(/pointer DENIED EROFS/);
    expect(results[0]).toMatch(/pointer-unlink DENIED (EROFS|EBUSY)/);
    expect(results[0]).toMatch(/config\.worktree DENIED EROFS/);
    expect(results[0]).toMatch(/head DENIED EROFS/);
    expect(results[0]).not.toMatch(/WROTE/);
    // git status inside the sandbox reads the repository; its index refresh cannot write and is skipped.
    expect(results[1]).toMatch(/\?\? NOTES\.md/);
    const status = h.events.find((e) => e.type === 'process.exited' && e.payload.command === 'git status --short')!;
    expect(status.payload.exitCode).toBe(0);
    const impl = h.repo.tasks(id).find((t) => t.key === 'implement')!;
    expect(readFileSync(path.join(impl.worktree!, '.git'), 'utf8')).toMatch(/^gitdir: .*worktrees/);
    const cp = h.events.find((e) => e.type === 'workspace.worktree' && e.payload.action === 'checkpoint' && e.taskId === impl.id)!;
    expect((cp.payload.files as { path: string }[]).map((f) => f.path).sort()).toEqual(['NOTES.md', 'meta-probe.cjs']);
    expect(h.events.some((e) => e.type === 'workspace.tampered')).toBe(false);
  });
});

describe('without a sandbox', () => {
  it('fails closed: preflight blocks, commands are refused and checks are inconclusive', async () => {
    process.env.ATLAS_SANDBOX = 'none';
    detectSandbox(true);
    try {
      const root = sampleRepo();
      const h = makeOrchestrator();
      const ws = await h.orch.registerWorkspace(root);
      const pre = await h.orch.preflight(ws.id, 'fake');
      expect(pre.find((p) => p.level === 'block')?.message).toMatch(/No OS sandbox/);
      const id = await startMission(h, root);
      await h.orch.settle(id);
      expect(h.events.some((e) => e.type === 'process.started')).toBe(false);
      expect(h.repo.checks(id).find((c) => c.name === 'tests')).toMatchObject({ name: 'tests', result: 'inconclusive' });
      expect(h.repo.mission(id)!.state).toBe('failed');
    } finally { delete process.env.ATLAS_SANDBOX; detectSandbox(true); }
  });

  it('without a sandbox, agent commands that run project code need approval; a denial means they never run', async () => {
    process.env.ATLAS_SANDBOX = 'none';
    detectSandbox(true);
    try {
      const root = sampleRepo();
      const h = makeOrchestrator();
      h.repo.setSetting('execution.allowUnsandboxed', true);
      const id = await startMission(h, root);
      const stops = ['run_tests', 'shell_exec', 'unsandboxed_run'].map((t) => autoDecide(h, id, t, 'deny'));
      await h.orch.settle(id);
      stops.forEach((s) => s());
      const denied = h.repo.approvals(id).filter((a) => /No OS sandbox/.test(a.reason));
      expect(denied.length).toBeGreaterThan(0);
      expect(denied.every((a) => a.status === 'denied')).toBe(true);
      // The release gate asked too (review finding: checks ran the change's code with no consent), and was denied.
      expect(denied.some((a) => a.tool === 'unsandboxed_run')).toBe(true);
      // Nothing ran: no agent command and no check.
      expect(h.events.filter((e) => e.type === 'process.started')).toEqual([]);
      expect(h.repo.checks(id).find((c) => c.name === 'tests')).toMatchObject({ result: 'inconclusive', reason: expect.stringMatching(/did not approve/) });
      expect(h.repo.mission(id)!.verdict).not.toBe('verified');
    } finally { delete process.env.ATLAS_SANDBOX; detectSandbox(true); }
  });

  it('a .git pointer rewritten to a planted git dir fails the attempt closed (ADR 0031): nothing planted runs, no retry, the tree is kept for audit', async () => {
    process.env.ATLAS_SANDBOX = 'none';
    detectSandbox(true);
    try {
      const root = sampleRepo();
      const main = sh(root, 'git', ['rev-parse', 'main']);
      const pwned = path.join(tmpDir('atlas-marks-'), 'PWNED');
      // Without an OS sandbox nothing stops this write; the daemon's pinned git is what must hold.
      const tamper = `const fs = require('fs'); const path = require('path');
const evil = path.join(process.cwd(), 'evil');
for (const d of ['objects', 'refs']) fs.mkdirSync(path.join(evil, d), { recursive: true });
fs.writeFileSync(path.join(evil, 'HEAD'), 'ref: refs/heads/main\\n');
fs.writeFileSync(path.join(evil, 'config'), '[core]\\n\\trepositoryformatversion = 0\\n[filter "x"]\\n\\tclean = touch ${pwned}\\n');
fs.writeFileSync('.gitattributes', '* filter=x\\n');
fs.writeFileSync('.git', 'gitdir: ' + evil + '\\n');
console.log('tampered');`;
      const script: FakeScript = { name: 'tamper', matches: () => true, steps: (i) => i.roleId !== 'coder' ? [{ claim: 'nothing to add' }] : [
        { tool: 'write_file', args: { path: 'tamper.cjs', content: tamper } },
        { tool: 'shell_exec', args: { command: 'node', args: ['tamper.cjs'] } },
        { tool: 'write_file', args: { path: 'NOTES.md', content: 'work\n' } },
        { claim: 'done' },
      ] };
      const h = makeOrchestrator({ scripts: [script] });
      h.repo.setSetting('execution.allowUnsandboxed', true);
      const id = await startMission(h, root);
      const stops = ['shell_exec', 'run_tests', 'unsandboxed_run'].map((t) => autoDecide(h, id, t));
      await h.orch.settle(id);
      stops.forEach((s) => s());
      expect(h.events.find((e) => e.type === 'agent.tool_result' && e.payload.tool === 'shell_exec')?.payload.summary).toContain('tampered');
      expect(existsSync(pwned), 'the planted clean filter ran as the operator').toBe(false);
      const tampered = h.events.filter((e) => e.type === 'workspace.tampered');
      expect(tampered).toHaveLength(1);
      expect(tampered[0].payload).toMatchObject({ field: 'pointer' });
      const impl = h.repo.tasks(id).find((t) => t.key === 'implement')!;
      expect(impl.state).toBe('failed');
      const attempts = h.repo.attempts(id).filter((a) => a.taskId === impl.id);
      expect(attempts, 'tampering is never retried').toHaveLength(1);
      expect(h.events.find((e) => e.type === 'attempt.ended' && e.attemptId === attempts[0].id)?.payload).toMatchObject({ state: 'failed', errorKind: 'workspace_conflict' });
      // Kept for audit: a snapshot under refs/atlas/preserved (taken without its metadata) and the files on disk.
      const files = sh(root, 'git', ['ls-tree', '-r', '--name-only', `refs/atlas/preserved/${id}/implement-1-tampered`]).split('\n');
      expect(files).toEqual(expect.arrayContaining(['NOTES.md', 'tamper.cjs', 'evil/config', '.gitattributes']));
      expect(existsSync(path.join(impl.worktree!, 'evil', 'config'))).toBe(true);
      expect(h.repo.mission(id)!.verdict).not.toBe('verified');
      expect(sh(root, 'git', ['rev-parse', 'main'])).toBe(main);
      expect(existsSync(pwned)).toBe(false);
    } finally { delete process.env.ATLAS_SANDBOX; detectSandbox(true); }
  });

  it('runs unsandboxed only when the operator explicitly allowed it', async () => {
    process.env.ATLAS_SANDBOX = 'none';
    detectSandbox(true);
    try {
      const root = sampleRepo();
      const h = makeOrchestrator();
      h.repo.setSetting('execution.allowUnsandboxed', true);
      const id = await startMission(h, root);
      // P1-2: without a sandbox, agent commands that run project code wait for the operator, even "safe" ones.
      const stops = ['run_tests', 'shell_exec', 'unsandboxed_run'].map((t) => autoDecide(h, id, t));
      await h.orch.settle(id);
      stops.forEach((s) => s());
      expect(h.repo.mission(id)!.outcome).toMatch(/^Verified/);
      const asked = h.repo.approvals(id);
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((a) => /No OS sandbox/.test(a.reason) || a.capability === 'shell.privileged')).toBe(true);
      expect(h.events.filter((e) => e.type === 'process.started').every((e) => e.payload.sandboxed === false)).toBe(true);
    } finally { delete process.env.ATLAS_SANDBOX; detectSandbox(true); }
  });
});
