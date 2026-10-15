// The control plane (manual §5, E1): storage, orchestration and runtimes in one supervised process.
// It receives already-validated intents from Electron main and re-validates them before acting.
import path from 'node:path';
import { publishMission, workerUrl, type Publication } from '@atlas/cloudflare';
import { mkdirSync } from 'node:fs';
import { AtlasError, InternalRequests, parseRequest, PROVIDER_ENV, registerSecret, type AtlasEvent, type Method } from '@atlas/contracts';
import { ArtifactStore, openDb, Repo, schemaVersion, type Db } from '@atlas/storage';
import { Orchestrator, replay, ROLES } from '@atlas/orchestrator';
import { ROLE_GRANTS } from '@atlas/policy';
import { FakeRuntime, sampleDesktopScript, samplePlanner, sampleSlugifyScript, sampleRegressionScript } from '@atlas/runtime-fake';
import { PiRuntime, PI_PINNED } from '@atlas/runtime-pi';
import { detectSandbox } from '@atlas/terminal';
import { applicationStage, createBrowserTool, resolveBrowser } from '@atlas/browser';
import { DeployManager, stagingStage } from '@atlas/deploy';
import { createDesktopTool, DesktopManager, desktopSupport } from '@atlas/desktop-control';
import { loadConfig } from '@atlas/workspace';
import { createLogger, type Logger } from './log';

export interface ServiceOptions { dataDir: string; version: string; apiKeys?: Record<string, string>; model?: string; deploySecrets?: Record<string, Record<string, string>> }

export class DaemonService {
  readonly repo: Repo;
  readonly artifacts: ArtifactStore;
  readonly orch: Orchestrator;
  readonly log: Logger;
  private readonly db: Db;
  private pi: PiRuntime;
  private readonly fake = new FakeRuntime([sampleRegressionScript, sampleSlugifyScript, sampleDesktopScript], 350, samplePlanner);
  private keys: Record<string, string>;
  private deploySecrets: Record<string, Record<string, string>>;
  readonly deploy: DeployManager;
  readonly desktop: DesktopManager;

  constructor(private readonly o: ServiceOptions) {
    mkdirSync(o.dataDir, { recursive: true });
    this.log = createLogger(path.join(o.dataDir, 'logs'));
    this.db = openDb(path.join(o.dataDir, 'atlas.db'));
    this.repo = new Repo(this.db);
    this.artifacts = new ArtifactStore(this.db, path.join(o.dataDir, 'artifacts'));
    this.keys = { ...(o.apiKeys ?? {}) };
    for (const k of Object.values(this.keys)) registerSecret(k);
    this.pi = this.makePi();
    this.deploySecrets = o.deploySecrets ?? {};
    for (const t of Object.values(this.deploySecrets)) for (const v of Object.values(t)) registerSecret(v);
    this.deploy = new DeployManager({
      repo: this.repo, dataDir: o.dataDir, secrets: (target) => ({ ...(this.deploySecrets[target] ?? {}) }),
      isolation: () => { const sb = detectSandbox(); return sb.kind !== 'none' ? { mode: 'sandbox', detail: sb.detail } : this.repo.setting('execution.allowUnsandboxed', false) ? { mode: 'unsandboxed', detail: sb.detail } : { mode: 'unavailable', detail: sb.detail }; },
      log: (m, d) => this.log.info(m, d),
    });
    // Desktop sessions are recorded in the owning mission's event log (manual §27: every takeover is audited).
    this.desktop = new DesktopManager({
      session: (i, change, by) => this.record(i.missionId, i.taskId, 'desktop.session', by, { sessionId: i.id, change, controller: i.controller, display: i.display, environment: i.environment, size: `${i.width}x${i.height}`, inputs: i.inputs }),
      operatorInput: (i, a, ok, message) => this.record(i.missionId, i.taskId, 'desktop.action', 'operator', { sessionId: i.id, action: a.action, args: a.action === 'type' ? { chars: a.text.length } : a, ok, message, controller: i.controller, by: 'operator' }),
    });
    this.orch = new Orchestrator({ repo: this.repo, artifacts: this.artifacts, runtimes: { fake: this.fake, pi: this.pi }, worktreeDir: path.join(o.dataDir, 'worktrees'), factsDir: path.join(o.dataDir, 'facts'),
      stages: [applicationStage(), stagingStage(this.deploy)],
      toolFactories: {
        browser_action: (c) => createBrowserTool({ worktree: c.worktree, sandbox: c.sandbox, putScreenshot: (n, png) => c.putArtifact({ kind: 'screenshot', name: n, bytes: png }).id, emit: (p, ids) => c.emit('browser.step', p, ids) }),
        desktop_action: (c) => createDesktopTool({
          manager: this.desktop, missionId: c.missionId, taskId: c.taskId, worktree: c.worktree,
          sandbox: detectSandbox().kind !== 'none' ? { root: c.worktree, writable: false, network: false } : this.repo.setting('execution.allowUnsandboxed', false) ? 'unsandboxed' : null,
          enabled: () => this.repo.setting('desktop.enabled', false), requestApproval: c.requestApproval,
          putScreenshot: (n, png) => c.putArtifact({ kind: 'screenshot', name: n, bytes: png }).id, emit: (t, p, ids) => c.emit(t, p, ids),
        }),
        inspect_logs: (c) => ({
          invoke: async (args) => {
            const m = this.repo.mission(c.missionId);
            const live = m?.targetEnvironment ? this.repo.liveDeployment(m.targetEnvironment) : null;
            if (!live) return { ok: false, output: 'No live staging deployment for this mission\'s target.', exitCode: null, artifactIds: [], error: 'process_failed' };
            const lines = (args as { lines?: number }).lines ?? 200;
            const text = await this.deploy.logs(live, loadConfig(c.worktree).config?.deploy, lines);
            return { ok: true, output: text || '(no log output)', exitCode: null, artifactIds: [], error: null };
          },
          dispose: async () => {},
        }),
      },
    });
  }

  private makePi() {
    return new PiRuntime({ agentDir: path.join(this.o.dataDir, 'pi'), apiKeys: this.keys, model: this.repo.setting<string>('runtime.model', '') || this.o.model });
  }

  onEvent(fn: (e: AtlasEvent) => void) { return this.repo.onEvent(fn); }
  private terminalSink: (sessionId: string, data?: string, exit?: number | null) => void = () => {};
  onTerminal(fn: (sessionId: string, data?: string, exit?: number | null) => void) { this.terminalSink = fn; }
  private retentionTimer: NodeJS.Timeout | null = null;

  async start() {
    const recovered = await this.orch.recover();
    // Bring back live local staging deployments; never retry a deployment that was interrupted (manual §40).
    const rec = await this.deploy.reconcile((dep) => this.configForDeployment(dep.releaseDir));
    if (rec.restarted.length || rec.unknown.length) this.log.info('deployments reconciled', rec);
    // Retention (manual §39): purge decided missions older than the configured number of days.
    const purge = async () => {
      const days = this.repo.setting('retention.days', 0);
      const removed = await this.orch.purgeOlderThan(days).catch(() => []);
      if (removed.length) this.log.info('retention purge', { days, removed });
    };
    void purge();
    this.retentionTimer = setInterval(() => void purge(), 6 * 3600_000);
    this.retentionTimer.unref();
    this.log.info('daemon started', { schema: schemaVersion(this.db), ...recovered });
    return recovered;
  }

  private record(missionId: string, taskId: string | null, type: 'desktop.session' | 'desktop.action', by: 'agent' | 'operator' | 'system', payload: Record<string, unknown>) {
    if (!this.repo.mission(missionId)) return;
    const task = taskId ? this.repo.task(taskId) : null;
    const actor = by === 'operator' ? { kind: 'operator' as const } : by === 'agent' && task ? { kind: 'agent' as const, role: task.role, taskId: task.id } : { kind: 'system' as const, component: 'desktop' };
    this.repo.append({ missionId, taskId, attemptId: null, type, actor, payload, artifactIds: [] });
  }

  private configForDeployment(dir: string | null) { return dir ? loadConfig(dir).config : null; }

  async stop() {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    await this.desktop.shutdown();
    await this.deploy.shutdown();
    await this.orch.shutdown();
    this.db.close();
  }

  /** Internal methods come only from Electron main; renderer methods are re-validated here. */
  async handle(method: string, payload: unknown): Promise<unknown> {
    if (method in InternalRequests) return this.internal(method as keyof typeof InternalRequests, payload);
    const { params } = parseRequest(method, payload);
    const p = params as any;
    switch (method as Method) {
      case 'app.info': return { version: this.o.version, schema: schemaVersion(this.db), pi: PI_PINNED, platform: process.platform, node: process.versions.node, sandbox: detectSandbox(), browser: resolveBrowser() };
      case 'workspace.list': return this.repo.workspaces();
      case 'workspace.refresh': return this.orch.refreshWorkspace(p.workspaceId);
      case 'workspace.preflight': return this.orch.preflight(p.workspaceId, p.runtime);
      case 'mission.create': return this.orch.createMission(p);
      case 'mission.delete': await this.orch.deleteMission(p.missionId); this.log.info('mission deleted', { missionId: p.missionId }); return { deleted: p.missionId };
      case 'mission.reverify': return this.orch.reverify(p.missionId);
      case 'finding.update': return this.orch.updateFinding(p.findingId, p.status);
      case 'workspace.facts.get': return { text: this.orch.facts(p.workspaceId) ?? '' };
      case 'workspace.facts.set': this.orch.setFacts(p.workspaceId, p.text); return { text: p.text };
      case 'terminal.open': return this.orch.openTerminal(p.missionId, p.target, { cols: p.cols, rows: p.rows }, { onData: (id, t) => this.terminalSink(id, t), onExit: (id, c) => this.terminalSink(id, undefined, c) });
      case 'terminal.input': this.orch.terminalInput(p.sessionId, p.data); return null;
      case 'terminal.close': await this.orch.closeTerminal(p.sessionId); return null;
      case 'deployment.list': return this.repo.deployments({ target: p.target });
      case 'deployment.rollback': {
        const d = this.repo.deployment(p.deploymentId);
        if (!d) throw new AtlasError('invalid_request', 'Unknown deployment');
        const r = await this.deploy.rollback(d.target, this.configForDeployment(d.releaseDir), d.id);
        this.log.warn('operator rollback', { target: d.target, to: d.id, ok: r.ok, confirmed: r.revisionConfirmed });
        return r;
      }
      case 'deploy.targets': {
        const w = this.repo.workspace(p.workspaceId);
        const cfg = w ? loadConfig(w.root).config?.deploy : undefined;
        const allowed = this.repo.setting<string[]>('deploy.allowedTargets', []);
        return cfg ? [{ target: cfg.target, provider: cfg.provider, allowed: allowed.includes(cfg.target), live: this.repo.liveDeployment(cfg.target) }] : [];
      }
      case 'mission.list': return this.repo.missions(p.workspaceId).map((m) => ({ ...m, tasks: this.repo.tasks(m.id).map((t) => ({ key: t.key, state: t.state })), pendingApprovals: this.repo.approvals(m.id).filter((a) => a.status === 'pending').length }));
      case 'mission.get': return this.snapshot(p.missionId);
      case 'mission.plan': return this.orch.plan(p.missionId);
      case 'mission.approvePlan': return this.orch.approvePlan(p.missionId);
      case 'mission.cancel': return this.orch.cancelMission(p.missionId);
      case 'mission.decide': return this.orch.decide(p.missionId, p.decision);
      case 'task.cancel': return this.orch.cancelTask(p.taskId);
      case 'roles.list': return Object.values(ROLES).map((r) => ({ id: r.id, version: r.version, title: r.title, tools: r.tools, writes: r.writes, modelPreference: r.modelPreference, budget: r.budget, capabilities: ROLE_GRANTS[r.id], instructions: r.instructions }));
      case 'desktop.list': return { support: desktopSupport(), enabled: this.repo.setting('desktop.enabled', false), sessions: this.desktop.list() };
      case 'desktop.control': {
        const info = await this.desktop.control(p.sessionId, p.op);
        this.log.warn('desktop control', { session: p.sessionId, op: p.op });
        return info;
      }
      case 'desktop.input': return this.desktop.operatorInput(p.sessionId, p.input);
      case 'desktop.frame': return this.desktop.frame(p.sessionId);
      case 'approval.respond': return this.orch.respondApproval(p.approvalId, p.decision);
      case 'events.since': return this.repo.eventsSince(p.missionId, p.afterSeq);
      case 'artifact.read': {
        const art = this.artifacts.get(p.artifactId);
        if (art?.kind === 'screenshot') {
          // Images go to the renderer as base64 and are shown with a data: URL, never interpreted as markup.
          const b = this.artifacts.readBytes(p.artifactId);
          return { artifact: b.artifact, intact: b.intact, truncated: false, text: '', base64: b.bytes.length <= 8_000_000 ? b.bytes.toString('base64') : null };
        }
        const r = this.artifacts.read(p.artifactId);
        const max = 400_000;
        return { artifact: r.artifact, intact: r.intact, truncated: r.text.length > max, text: r.text.slice(0, max) };
      }
      case 'cloud.status': return this.repo.setting<Publication | null>(`cloud.publication.${p.missionId}`, null);
      case 'cloud.publish': {
        const m = this.repo.mission(p.missionId);
        if (!m || m.archived || m.state !== 'completed' || m.decision === 'rejected' || !m.baseCommit) throw new AtlasError('invalid_request', 'Publish a completed, non-rejected local mission.');
        const workspace = this.repo.workspace(m.workspaceId);
        if (!workspace) throw new AtlasError('invalid_request', 'Workspace unavailable');
        const result = await publishMission({ root: workspace.root, missionId: m.id, baseCommit: m.baseCommit, url: this.repo.setting('cloud.url', ''), secret: this.deploySecrets.cloudflare?.ATLAS_CLOUD_TOKEN ?? '' });
        this.repo.setSetting(`cloud.publication.${m.id}`, result);
        this.repo.append({ missionId: m.id, taskId: null, attemptId: null, type: 'operator.action', actor: { kind: 'operator' }, payload: { action: 'cloudflare.published', ...result }, artifactIds: [] });
        return result;
      }
      case 'runtime.health': return Promise.all([this.fake.health(), this.pi.health()]);
      case 'settings.get': return { values: this.settingValues(), sandbox: detectSandbox(true) };
      case 'settings.set': {
        if (p.key === 'cloud.url' && p.value) workerUrl(p.value);
        this.repo.setSetting(p.key, p.value);
        if (p.key === 'runtime.model') { this.pi = this.makePi(); this.orch.setRuntime('pi', this.pi); }
        this.log.warn('setting changed', { key: p.key, value: p.value });
        return { values: this.settingValues(), sandbox: detectSandbox() };
      }
      default: throw new AtlasError('invalid_request', `${method} is handled by the desktop shell`);
    }
  }

  private settingValues() {
    return {
      'execution.allowUnsandboxed': this.repo.setting('execution.allowUnsandboxed', false), 'retention.days': this.repo.setting('retention.days', 0),
      'deploy.allowedTargets': this.repo.setting<string[]>('deploy.allowedTargets', []), 'deploy.autoRollback': this.repo.setting('deploy.autoRollback', true),
      'desktop.enabled': this.repo.setting('desktop.enabled', false),
      'cloud.url': this.repo.setting('cloud.url', ''),
      'runtime.model': this.repo.setting('runtime.model', ''),
    };
  }

  private async internal(method: keyof typeof InternalRequests, payload: unknown) {
    const params = InternalRequests[method].parse(payload) as any;
    if (method === 'workspace.register') return this.orch.registerWorkspace(params.path);
    if (method === 'mission.exportTo') return this.orch.exportMission(params.missionId, params.path);
    if (method === 'mission.importFrom') return this.orch.importMission(params.path);
    if (method === 'credentials.apply') {
      this.keys = {};
      for (const [provider, key] of Object.entries(params.keys as Record<string, string>)) if (PROVIDER_ENV[provider]) { this.keys[provider] = key; registerSecret(key); }
      this.pi = this.makePi();
      this.orch.setRuntime('pi', this.pi);
      if (params.deploySecrets) {
        this.deploySecrets = params.deploySecrets;
        for (const t of Object.values(this.deploySecrets)) for (const v of Object.values(t)) registerSecret(v);
      }
      return { providers: Object.keys(this.keys), deployTargets: Object.keys(this.deploySecrets) };
    }
    throw new AtlasError('invalid_request', 'unknown internal method');
  }

  snapshot(missionId: string) {
    const mission = this.repo.mission(missionId);
    if (!mission) throw new AtlasError('invalid_request', 'Unknown mission');
    const events = this.repo.eventsSince(missionId, 0, 1);
    const all = this.repo.eventsSince(missionId, 0, 100_000);
    return {
      mission,
      workspace: this.repo.workspace(mission.workspaceId),
      plan: this.repo.plan(missionId),
      tasks: this.repo.tasks(missionId),
      attempts: this.repo.attempts(missionId),
      approvals: this.repo.approvals(missionId),
      checks: this.repo.checks(missionId),
      findings: this.repo.findings(missionId),
      budget: this.orch.budgetReport(missionId),
      artifacts: this.artifacts.list(missionId),
      lastSeq: all.length ? all[all.length - 1].seq : 0,
      replayed: events.length ? replay(all).mission : null,
    };
  }
}
