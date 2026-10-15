// The governed tool surface (manual §21–22). Every agent tool call: validate args → policy → (approval) → executor.
// A denied call returns before any executor is touched.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AtlasError, newId, redact, type AgentRole, type Approval, type ApprovalMode, type ToolInvoker, type ToolResult, type ToolSpec } from '@atlas/contracts';
import { evaluate, approvalUsable } from '@atlas/policy';
import { run, sanitizedEnv, type RunResult, type SandboxSpec } from '@atlas/terminal';
import { git, resolveInside } from '@atlas/workspace';
import type { Repo, ArtifactStore } from '@atlas/storage';
import { detectRecipes } from './verification';
import { FindingArgs } from './findings';

export const TOOL_SPECS: ToolSpec[] = [
  { name: 'read_file', description: 'Read a UTF-8 text file in the worktree (max 200 KB).', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the worktree root' } }, required: ['path'], additionalProperties: false } },
  { name: 'list_files', description: 'List entries of a directory in the worktree.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory relative to the worktree root; "." for the root' } }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', description: 'Create or overwrite a text file in the worktree.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'shell_exec', description: 'Run one program with an argument array (no shell). Privileged commands need human approval.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Executable, e.g. "npm"' }, args: { type: 'array', items: { type: 'string' } }, timeoutSec: { type: 'number' } }, required: ['command', 'args'], additionalProperties: false } },
  { name: 'git_status', description: 'Show git status and the diff summary of the worktree.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'run_tests', description: "Run the project's configured test command and return its output and exit code.", parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'view_diff', description: 'Show the diff of the worktree (committed and uncommitted) against the mission base commit.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Optional: limit to one path' } }, additionalProperties: false } },
  {
    name: 'report_finding',
    description: 'Record a review finding. Use kind "confirmed" only with reproducedBy set to the artifact id of a failing run_tests/shell_exec result from this review.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['file', 'severity', 'kind', 'title', 'observation', 'evidence'],
      properties: {
        file: { type: 'string' }, line: { type: 'integer' }, endLine: { type: 'integer' },
        severity: { type: 'string', enum: ['high', 'medium', 'low', 'info'] }, kind: { type: 'string', enum: ['confirmed', 'suspected', 'informational'] },
        title: { type: 'string' }, observation: { type: 'string' }, evidence: { type: 'string' }, recommendation: { type: 'string' },
        reproducedBy: { type: 'string', description: 'Artifact id (art_…) printed with a failing command result' }, confidence: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_action',
    description: 'Drive the project app in an isolated browser. One step per call: goto {path}, click {selector|text|role+name}, fill {selector,value}, select {selector,value}, press {key}, expectText {text,selector?}, expectNoText, expectUrl {path}, expectVisible {selector}, screenshot {name}, wait {ms}. The app is started from your worktree on first use.',
    parameters: { type: 'object', additionalProperties: false, required: ['step'], properties: { step: { type: 'object', description: 'e.g. {"action":"goto","path":"/"}' } } },
  },
  {
    name: 'desktop_action',
    description: 'Control the isolated virtual desktop. One action per call: screenshot, click {x,y,button?}, type {text}, key {keys}, scroll {dx,dy}, windows, focus {windowId}, launch {app}, waitFor {windowTitle, timeoutMs}.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string' }, text: { type: 'string' }, keys: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' }, windowId: { type: 'string' }, app: { type: 'string' }, windowTitle: { type: 'string' }, timeoutMs: { type: 'number' } } },
  },
  {
    name: 'inspect_logs',
    description: 'Read recent logs of the current staging deployment.',
    parameters: { type: 'object', additionalProperties: false, properties: { lines: { type: 'integer' } } },
  },
  {
    name: 'delegate',
    description: 'Hand a well-scoped, independent piece of work to a subagent. Blocks until it finishes; its change is merged into your worktree and its summary returned. Subject to depth, count and token budgets.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['role', 'title', 'reason', 'acceptance'],
      properties: { role: { type: 'string', enum: ['coder', 'tester', 'reviewer'] }, title: { type: 'string' }, reason: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } } },
    },
  },
];

const ARGS: Record<string, z.ZodTypeAny> = {
  read_file: z.object({ path: z.string().min(1) }).strict(),
  list_files: z.object({ path: z.string().min(1).default('.') }).strict(),
  write_file: z.object({ path: z.string().min(1), content: z.string().max(2_000_000) }).strict(),
  shell_exec: z.object({ command: z.string().min(1).max(200), args: z.array(z.string().max(4000)).max(200), timeoutSec: z.number().int().min(1).max(1800).optional() }).strict(),
  git_status: z.object({}).strict(),
  run_tests: z.object({}).strict(),
  view_diff: z.object({ path: z.string().min(1).optional() }).strict(),
  report_finding: FindingArgs,
  browser_action: z.object({ step: z.record(z.unknown()) }).strict(),
  desktop_action: z.object({ action: z.string().min(1).max(40) }).passthrough(),
  inspect_logs: z.object({ lines: z.number().int().min(1).max(2000).optional() }).strict(),
  delegate: z.object({ role: z.enum(['coder', 'tester', 'reviewer']), title: z.string().min(3).max(200), reason: z.string().min(3).max(2000), acceptance: z.array(z.string().min(1).max(500)).min(1).max(10) }).strict(),
};

/** Executors are injectable so tests can prove a denied call never reaches one. */
export interface Executors {
  readFile(abs: string): string;
  listDir(abs: string): string[];
  writeFile(abs: string, content: string): void;
  exec(o: { command: string; args: string[]; cwd: string; timeoutMs: number; signal: AbortSignal; sandbox?: SandboxSpec; onStart(pid: number): void; onOutput(s: 'stdout' | 'stderr', t: string): void }): Promise<RunResult>;
}

export const realExecutors: Executors = {
  readFile: (abs) => {
    const st = statSync(abs);
    if (!st.isFile()) throw new AtlasError('invalid_request', 'Not a file');
    if (st.size > 200 * 1024) return readFileSync(abs, 'utf8').slice(0, 200 * 1024) + '\n… [truncated at 200 KB]';
    return readFileSync(abs, 'utf8');
  },
  listDir: (abs) => readdirSync(abs, { withFileTypes: true }).filter((d) => d.name !== '.git').map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort(),
  writeFile: (abs, content) => { mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, content, 'utf8'); },
  exec: (o) => run({ ...o, env: sanitizedEnv() }),
};

/** How untrusted commands are isolated for this task (manual §23, ADR 0007). */
export type Isolation =
  | { mode: 'sandbox'; readOnly: string[]; readWrite: string[] }
  | { mode: 'unsandboxed' }
  | { mode: 'unavailable'; detail: string };

export interface GateContext {
  isolation: Isolation;
  missionId: string;
  taskId: string;
  attemptId: string;
  role: AgentRole;
  mode: ApprovalMode;
  cwd: string;
  permitted: string[];
  approvalTtlMs: number;
  /** Resolves when the operator decides; the orchestrator owns the waiter registry. */
  awaitApproval(a: Approval, signal: AbortSignal): Promise<Approval>;
  /** Mission base commit, for view_diff. */
  base: string;
  /** Record a finding; returns the text shown to the agent. */
  onFinding?(args: FindingArgs, failingRuns: ReadonlySet<string>): string;
  /** Tools provided by service packages (browser, desktop, deploy), created lazily per attempt. */
  extra?: Record<string, { invoke(args: unknown, signal: AbortSignal): Promise<ToolResult> }>;
  /** Run a delegated subtask to completion. */
  delegate?(args: { role: 'coder' | 'tester' | 'reviewer'; title: string; reason: string; acceptance: string[] }, signal: AbortSignal): Promise<ToolResult>;
}

export class ToolGate implements ToolInvoker {
  readonly specs: ToolSpec[];
  /** Artifacts of process runs in this attempt that exited non-zero: the only valid reproductions. */
  private readonly failingRuns = new Set<string>();
  constructor(private readonly ctx: GateContext, private readonly repo: Repo, private readonly artifacts: ArtifactStore, private readonly ex: Executors = realExecutors) {
    this.specs = TOOL_SPECS.filter((s) => ctx.permitted.includes(s.name));
  }

  private emit(type: 'policy.decision' | 'approval.requested' | 'approval.decided' | 'process.started' | 'process.output' | 'process.exited' | 'artifact.created', payload: Record<string, unknown>, artifactIds: string[] = []) {
    const { missionId, taskId, attemptId, role } = this.ctx;
    return this.repo.append({ missionId, taskId, attemptId, type, actor: { kind: 'system', component: 'toolgate' }, payload: { ...payload, role }, artifactIds });
  }

  private fail(error: ToolResult['error'], output: string): ToolResult { return { ok: false, output, exitCode: null, artifactIds: [], error }; }

  async invoke(name: string, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    if (!this.ctx.permitted.includes(name) || !ARGS[name]) {
      this.emit('policy.decision', { tool: name, decision: 'deny', reason: `Tool "${name}" is not permitted for this task` });
      return this.fail('unknown_tool', `Tool "${name}" is not available for this task.`);
    }
    const parsed = ARGS[name].safeParse(rawArgs ?? {});
    if (!parsed.success) return this.fail('invalid_args', `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const args = parsed.data as Record<string, any>;

    const decision = evaluate({ role: this.ctx.role, tool: name, args, mode: this.ctx.mode });
    const action = describe(name, args);
    this.emit('policy.decision', { tool: name, action, decision: decision.decision, capability: decision.capability, risk: decision.risk, reason: decision.reason });
    if (decision.decision === 'deny') return this.fail('policy_denied', `Denied by policy: ${decision.reason}`);

    if (decision.decision === 'ask') {
      const now = Date.now();
      const approval: Approval = {
        id: newId('apr'), missionId: this.ctx.missionId, taskId: this.ctx.taskId, agentRole: this.ctx.role, tool: name,
        capability: decision.capability ?? 'unknown', action, environment: `Isolated worktree · ${this.ctx.cwd}`,
        resources: resourcesOf(name, args), reason: decision.reason, risk: decision.risk, scope: 'once', status: 'pending',
        requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ctx.approvalTtlMs).toISOString(), decidedAt: null, decidedBy: null,
      };
      this.repo.insertApproval(approval);
      this.emit('approval.requested', { approvalId: approval.id, tool: name, action, risk: approval.risk, reason: approval.reason, expiresAt: approval.expiresAt });
      const decided = await this.ctx.awaitApproval(approval, signal);
      const usable = approvalUsable(decided);
      if (!usable.ok) return this.fail(decided.status === 'expired' ? 'approval_expired' : 'approval_denied', `Not executed: ${usable.reason}.`);
    }

    try {
      return await this.execute(name, args, signal, !!decision.network);
    } catch (e) {
      if (e instanceof AtlasError && e.kind === 'policy_deny') {
        this.emit('policy.decision', { tool: name, action, decision: 'deny', reason: e.message });
        return this.fail('path_escape', e.message);
      }
      return this.fail('process_failed', redact((e as Error).message));
    }
  }

  private async execute(name: string, a: Record<string, any>, signal: AbortSignal, network: boolean): Promise<ToolResult> {
    const cwd = this.ctx.cwd;
    switch (name) {
      case 'read_file': return ok(this.ex.readFile(resolveInside(cwd, a.path)));
      case 'list_files': return ok(this.ex.listDir(resolveInside(cwd, a.path === '.' ? '.' : a.path)).join('\n') || '(empty)');
      case 'write_file': {
        const abs = resolveInside(cwd, a.path, { forWrite: true });
        this.ex.writeFile(abs, a.content);
        return ok(`Wrote ${a.path} (${Buffer.byteLength(a.content)} bytes)`);
      }
      case 'git_status': {
        const st = await git(cwd, ['status', '--short']);
        const diff = await git(cwd, ['diff', '--stat']);
        return ok(`${st.out || '(clean)'}\n${diff.out}`.trim());
      }
      case 'shell_exec': return this.process(a.command, a.args, (a.timeoutSec ?? 300) * 1000, signal, 'shell', network);
      case 'view_diff': {
        const args = ['diff', '--no-color', '--no-ext-diff', this.ctx.base, ...(a.path ? ['--', a.path] : [])];
        const d = await git(cwd, args);
        const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
        const text = d.out || '(no differences against the mission base)';
        return ok(`${text.length > 60_000 ? `${text.slice(0, 60_000)}\n… [truncated]` : text}${untracked.out ? `\n\nUntracked files:\n${untracked.out}` : ''}`);
      }
      case 'report_finding': {
        if (!this.ctx.onFinding) return this.fail('unknown_tool', 'Findings are not recorded for this task.');
        return ok(this.ctx.onFinding(a as FindingArgs, this.failingRuns));
      }
      case 'browser_action': case 'desktop_action': case 'inspect_logs': {
        const t = this.ctx.extra?.[name];
        if (!t) return this.fail('unknown_tool', `${name} is not available in this environment.`);
        return t.invoke(a, signal);
      }
      case 'delegate': {
        if (!this.ctx.delegate) return this.fail('unknown_tool', 'Delegation is not available for this task.');
        return this.ctx.delegate(a as { role: 'coder' | 'tester' | 'reviewer'; title: string; reason: string; acceptance: string[] }, signal);
      }
      case 'run_tests': {
        const r = detectRecipes(cwd).find((x) => x.name === 'tests');
        if (!r) return { ok: false, output: 'No test command is configured for this project (package.json "test" script not found).', exitCode: null, artifactIds: [], error: null };
        return this.process(r.command, r.args, r.timeoutMs, signal, 'tests', false);
      }
    }
    return this.fail('unknown_tool', name);
  }

  private async process(command: string, args: string[], timeoutMs: number, signal: AbortSignal, label: string, network: boolean): Promise<ToolResult> {
    const cmd = [command, ...args].join(' ');
    const iso = this.ctx.isolation;
    if (iso.mode === 'unavailable') {
      this.emit('policy.decision', { tool: label, action: redact(cmd), decision: 'deny', reason: `No OS sandbox: ${iso.detail}` });
      return { ok: false, output: `Not executed: no OS sandbox is available (${iso.detail}). The operator can install one or explicitly allow unsandboxed execution in Settings.`, exitCode: null, artifactIds: [], error: 'sandbox_unavailable' };
    }
    const sandbox: SandboxSpec | undefined = iso.mode === 'sandbox'
      ? { root: this.ctx.cwd, writable: this.ctx.mode !== 'plan_only', network, readOnly: iso.readOnly, readWrite: iso.readWrite, limits: { cpuSeconds: 1800, fileSizeBytes: 1024 ** 3, openFiles: 4096 } }
      : undefined;
    let pid = 0;
    let buf = '';
    let flushAt = 0;
    const flush = () => { if (buf) { this.emit('process.output', { pid, text: buf }); buf = ''; } };
    const r = await this.ex.exec({
      command, args, cwd: this.ctx.cwd, timeoutMs, signal, sandbox,
      onStart: (p) => { pid = p; this.emit('process.started', { pid, command: redact(cmd), cwd: this.ctx.cwd, label, sandboxed: !!sandbox, network: sandbox ? network : true }); },
      onOutput: (_s, t) => { buf += t; if (buf.length > 4000 || Date.now() - flushAt > 250) { flushAt = Date.now(); flush(); } },
    });
    flush();
    const log = this.artifacts.put({ missionId: this.ctx.missionId, taskId: this.ctx.taskId, kind: 'log', name: `${label}: ${cmd}`.slice(0, 120), content: `$ ${cmd}\n${r.output}\n[exit ${r.exitCode ?? 'none'}${r.timedOut ? ', timed out' : ''}${r.cancelled ? ', cancelled' : ''} · ${r.durationMs} ms]` });
    this.emit('process.exited', { pid, command: redact(cmd), exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs, timedOut: r.timedOut, cancelled: r.cancelled, spawnError: r.spawnError }, [log.id]);
    if (r.exitCode !== 0 && !r.spawnError) this.failingRuns.add(log.id);
    const tail = r.output.length > 12_000 ? `… [${r.output.length - 12_000} earlier characters omitted]\n${r.output.slice(-12_000)}` : r.output;
    const status = r.spawnError ? `Failed to start: ${r.spawnError}` : r.timedOut ? 'Timed out' : r.cancelled ? 'Cancelled' : `Exit code ${r.exitCode}`;
    return { ok: r.exitCode === 0, output: `${tail}\n${status} · log ${log.id}`, exitCode: r.exitCode, artifactIds: [log.id], error: r.timedOut ? 'timeout' : r.cancelled ? 'cancelled' : r.exitCode === 0 ? null : 'process_failed' };
  }
}

function ok(output: string): ToolResult { return { ok: true, output, exitCode: null, artifactIds: [], error: null }; }

export function describe(tool: string, a: Record<string, any>): string {
  switch (tool) {
    case 'shell_exec': return redact([a.command, ...(a.args ?? [])].join(' '));
    case 'read_file': case 'list_files': case 'write_file': return a.path;
    case 'run_tests': return 'project test command';
    default: return tool;
  }
}
function resourcesOf(tool: string, a: Record<string, any>): string[] {
  if (tool === 'write_file') return [a.path];
  if (tool === 'shell_exec') return ['worktree files', ...(['curl', 'wget', 'npm', 'pnpm', 'yarn', 'git'].includes(a.command) ? ['network'] : [])];
  return [];
}
