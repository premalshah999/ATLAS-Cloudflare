// The control plane (manual §5, E1): storage, orchestration and runtimes in one supervised process.
// It receives already-validated intents from Electron main and re-validates them before acting.
import path from 'node:path';
import { publishMission, workerUrl, type Publication } from '@atlas/cloudflare';
import { mkdirSync, readFileSync } from 'node:fs';
import { AtlasError, InternalRequests, KEY_CHECKS, McpServerConfig, SearchAccount, WebSettings, mcpSecretEnv, parseRequest, PROVIDER_ENV, registerSecret, type AtlasEvent, type McpServerView, type McpToolInfo, type Method } from '@atlas/contracts';
import { McpManager } from '@atlas/mcp';
import { emptyPoolState, environmentAccounts, WebService, type AddressFilter, type PoolState } from '@atlas/web';
import { apply as syncApply, foreignServers, locations as syncLocations, plan as syncPlan, type SyncState, type Target as SyncTarget } from '@atlas/sync';
import { ArtifactStore, openDb, Repo, schemaVersion, type Db } from '@atlas/storage';
import { GitHubForge, Orchestrator, ROLES, suiteHash, type Skill } from '@atlas/orchestrator';
import { ROLE_GRANTS } from '@atlas/policy';
import { FakeRuntime, sampleDesktopScript, samplePlanner, sampleSlugifyScript, sampleRegressionScript, sampleUiScript } from '@atlas/runtime-fake';
import { PiRuntime, PI_PINNED } from '@atlas/runtime-pi';
import { detectSandbox, reapJournaled, removeWindowsAccounts, setProcessJournal, setupWindowsAccounts, windowsAccounts } from '@atlas/terminal';
import { applicationStage, createBrowserTool, resolveBrowser, visualStage } from '@atlas/browser';
import { DeployManager, stagingStage } from '@atlas/deploy';
import { createDesktopTool, DesktopManager, desktopSupport } from '@atlas/desktop-control';
import { loadConfig } from '@atlas/workspace';
import { createLogger, type Logger } from './log';
import { TeamHub } from './team';
import { LiveBrowserManager } from './liveBrowser';
import { cleanup as hygieneCleanup, CLEANABLE, report as hygieneReport, type Category, type CleanupResult, type HygieneInput } from './hygiene';
import { rotateLog } from './log';
import { git, gitHardening } from '@atlas/workspace';
import { lockDataDir } from './lock';

export interface ServiceOptions {
  dataDir: string; skillsDir?: string; version: string; apiKeys?: Record<string, string>; model?: string; deploySecrets?: Record<string, Record<string, string>>;
  /** MCP server secrets (ADR 0018): server → name → value. */
  mcpSecrets?: Record<string, Record<string, string>>;
  /** MCP secrets exported as ATLAS_MCP_SECRET_<SERVER>_<NAME> (no credential store). Stored values win. */
  mcpEnvSecrets?: Record<string, string>;
  /** GitHub token for publishing pull requests and reading CI (ADR 0015). */
  githubToken?: string;
  /** GitHub API base, for GitHub-compatible test servers. Default https://api.github.com. */
  githubApi?: string;
  /** Search account keys from the credential store (ADR 0030): account id → key. */
  webKeys?: Record<string, string>;
  /** TAVILY_API_KEY, BRAVE_API_KEY, GOOGLE_API_KEY and GOOGLE_CSE_ID from the launching shell. */
  webEnv?: Record<string, string | undefined>;
  /** Tests: the fetch used for search providers, and the addresses web tools may reach. */
  webFetch?: typeof fetch;
  webAllowed?: AddressFilter;
}

export class DaemonService {
  readonly repo: Repo;
  readonly artifacts: ArtifactStore;
  readonly orch: Orchestrator;
  readonly log: Logger;
  private readonly db: Db;
  private pi: PiRuntime;
  private readonly fake = new FakeRuntime([sampleRegressionScript, sampleUiScript, sampleSlugifyScript, sampleDesktopScript], 350, samplePlanner);
  private keys: Record<string, string>;
  private deploySecrets: Record<string, Record<string, string>>;
  private mcpSecrets: Record<string, Record<string, string>>;
  readonly mcp: McpManager;
  private webKeys: Record<string, string>;
  private readonly webEnv: ReturnType<typeof environmentAccounts>;
  readonly web: WebService;
  private githubToken: string | null;
  readonly deploy: DeployManager;
  readonly desktop: DesktopManager;
  readonly team: TeamHub;
  /** The operator's real-time browser (Browser screen); never reachable by agents. */
  readonly liveBrowser: LiveBrowserManager;

  constructor(private readonly o: ServiceOptions) {
    mkdirSync(o.dataDir, { recursive: true });
    this.log = createLogger(path.join(o.dataDir, 'logs'));
    this.db = openDb(path.join(o.dataDir, 'atlas.db'));
    this.repo = new Repo(this.db);
    this.liveBrowser = new LiveBrowserManager({ repo: this.repo });
    // Every process the executor starts is journaled until it exits, so a crash cannot leave orphans (P0-4).
    setProcessJournal(this.repo.processJournal());
    this.artifacts = new ArtifactStore(this.db, path.join(o.dataDir, 'artifacts'));
    this.keys = { ...(o.apiKeys ?? {}) };
    for (const k of Object.values(this.keys)) registerSecret(k);
    this.pi = this.makePi();
    this.deploySecrets = o.deploySecrets ?? {};
    this.mcpSecrets = o.mcpSecrets ?? {};
    for (const t of Object.values(this.mcpSecrets)) for (const v of Object.values(t)) registerSecret(v);
    for (const v of Object.values(o.mcpEnvSecrets ?? {})) registerSecret(v);
    this.mcp = new McpManager({
      dataDir: o.dataDir, version: o.version, servers: () => this.mcpServers(), secrets: (n) => this.mcpSecretValues(n),
      toolCache: {
        get: (n) => this.repo.setting<Record<string, { tools: McpToolInfo[]; at: string }>>('mcp.tools', {})[n] ?? null,
        set: (n, tools) => this.repo.setSetting('mcp.tools', { ...this.repo.setting<Record<string, unknown>>('mcp.tools', {}), [n]: { tools, at: new Date().toISOString() } }),
      },
      allowUnsandboxed: () => this.repo.setting('execution.allowUnsandboxed', false),
      log: (m, d) => this.log.info(m, d),
    });
    this.webKeys = { ...(o.webKeys ?? {}) };
    this.webEnv = environmentAccounts(o.webEnv ?? {});
    for (const v of [...Object.values(this.webKeys), ...Object.values(this.webEnv.keys)]) registerSecret(v);
    this.web = new WebService({
      settings: () => this.webSettings(),
      accounts: () => [...this.webAccounts(), ...this.webEnv.accounts],
      key: (id) => this.webKeys[id] ?? this.webEnv.keys[id],
      fromEnvironment: (id) => id in this.webEnv.keys,
      load: () => this.repo.setting<PoolState>('web.pool', emptyPoolState()),
      save: (s) => this.repo.setSetting('web.pool', s),
      fetch: o.webFetch, allowed: o.webAllowed,
    });
    this.githubToken = o.githubToken || null;
    if (this.githubToken) registerSecret(this.githubToken);
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
    this.orch = new Orchestrator({ repo: this.repo, artifacts: this.artifacts, runtimes: { fake: this.fake, pi: this.pi }, worktreeDir: path.join(o.dataDir, 'worktrees'), factsDir: path.join(o.dataDir, 'facts'), skillDirs: { bundled: o.skillsDir, operator: path.join(o.dataDir, 'skills') },
      forge: () => this.forge(),
      mcp: this.mcp,
      web: this.web,
      publishGate: (m, files) => this.team.gate(m, files),
      stages: [applicationStage(), visualStage(), stagingStage(this.deploy)],
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
    this.team = new TeamHub({ repo: this.repo, orch: this.orch, log: this.log, forge: () => this.forge() });
  }

  private forge() { return this.githubToken ? new GitHubForge({ token: this.githubToken, apiBase: this.o.githubApi }) : null; }

  /** Web access settings (ADR 0030); invalid stored values fall back to the defaults (web access off). */
  private webSettings(): WebSettings {
    const r = WebSettings.safeParse(this.repo.setting<unknown>('web.settings', {}));
    return r.success ? r.data : WebSettings.parse({});
  }
  private webAccounts(): SearchAccount[] {
    return this.repo.setting<unknown[]>('web.accounts', []).flatMap((a) => { const r = SearchAccount.safeParse(a); return r.success ? [r.data] : []; });
  }

  /** Operator-configured MCP servers (settings); entries that no longer validate are skipped, never guessed. */
  private mcpServers(): McpServerConfig[] {
    return this.repo.setting<unknown[]>('mcp.servers', []).flatMap((s) => { const r = McpServerConfig.safeParse(s); return r.success ? [r.data] : []; });
  }

  /** A server's secrets: stored in the credential store, else exported in the launching shell. */
  private mcpSecretValues(server: string): Record<string, string> {
    const c = this.mcpServers().find((s) => s.name === server);
    const out: Record<string, string> = {};
    for (const n of c?.secrets ?? []) { const v = this.mcpSecrets[server]?.[n] ?? this.o.mcpEnvSecrets?.[mcpSecretEnv(server, n)]; if (v) out[n] = v; }
    return out;
  }

  private mcpView(): McpServerView[] {
    const cache = this.repo.setting<Record<string, { tools: McpToolInfo[]; at: string }>>('mcp.tools', {});
    return this.mcpServers().map((config) => ({ config, tools: cache[config.name]?.tools ?? [], toolsAt: cache[config.name]?.at ?? null, secretsSet: Object.keys(this.mcpSecretValues(config.name)), ...this.mcp.status(config.name) }));
  }

  /** A harness sync target (ADR 0019). Project scope writes into the workspace's repository. */
  private syncTarget(p: { harness: SyncTarget['harness']; scope: SyncTarget['scope']; workspaceId?: string }): SyncTarget {
    if (p.scope === 'user') return { harness: p.harness, scope: 'user' };
    const w = p.workspaceId ? this.repo.workspace(p.workspaceId) : null;
    if (!w?.isGit) throw new AtlasError('invalid_request', 'Choose a repository for project scope');
    return { harness: p.harness, scope: 'project', projectRoot: w.root };
  }

  /** What ATLAS syncs: enabled trusted skills, enabled MCP servers. */
  private syncInput() {
    const off = new Set(this.repo.setting<string[]>('skills.disabled', []));
    return { skills: this.orch.skills.trusted().skills.filter((s) => !off.has(s.name)), mcp: this.mcpServers() };
  }

  /** Free read-only check of a configured key at the provider's official API. Never logs or returns the key. */
  private async testKey(provider: string): Promise<{ provider: string; ok: boolean; status: number | null; detail: string }> {
    const check = KEY_CHECKS[provider];
    const key = this.keys[provider];
    if (!key) return { provider, ok: false, status: null, detail: 'No key is configured for this provider. Paste one and save it first.' };
    if (!check) return { provider, ok: true, status: null, detail: 'Key is configured. This provider has no free check; a mission confirms it on first use.' };
    const headers: Record<string, string> = check.auth === 'bearer' ? { Authorization: `Bearer ${key}` } : check.auth === 'x-api-key' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'x-goog-api-key': key };
    const get = (url: string) => fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    try {
      const r = await get(check.url);
      if (r.status === 401 || r.status === 403) return { provider, ok: false, status: r.status, detail: `The provider rejected this key (HTTP ${r.status}). Create a new key and save it again.` };
      if (r.status === 429) return { provider, ok: false, status: r.status, detail: 'The key is valid but rate-limited right now (HTTP 429). Try again shortly.' };
      if (r.status >= 500) return { provider, ok: false, status: r.status, detail: `The provider is unavailable (HTTP ${r.status}). The key may be fine; try again shortly.` };
      if (!r.ok) return { provider, ok: false, status: r.status, detail: `Unexpected response from the provider (HTTP ${r.status}).` };
      let models = 0;
      try { const body = await r.json() as { data?: unknown[]; models?: unknown[] }; models = (body.data ?? body.models ?? []).length; } catch { /* key endpoints without a model list */ }
      if (check.balance) {
        const b = await get(check.balance);
        if (b.ok) {
          const body = await b.json() as { is_available?: boolean; balance_infos?: { currency: string; total_balance: string }[] };
          const bal = (body.balance_infos ?? []).map((x) => `${x.total_balance} ${x.currency}`).join(', ');
          if (body.is_available === false) return { provider, ok: false, status: 402, detail: `The key is valid but the account has no usable balance${bal ? ` (${bal})` : ''}. Top up at platform.deepseek.com, then retry.` };
          return { provider, ok: true, status: r.status, detail: `Key accepted by the official API${models ? ` · ${models} models` : ''}${bal ? ` · balance ${bal}` : ''}.` };
        }
      }
      return { provider, ok: true, status: r.status, detail: `Key accepted by the official API${models ? ` · ${models} models` : ''}.` };
    } catch (e) {
      return { provider, ok: false, status: null, detail: `Could not reach the provider: ${(e as Error).name === 'TimeoutError' ? 'timed out after 15 s' : (e as Error).message}.` };
    }
  }

  private makePi() {
    return new PiRuntime({ agentDir: path.join(this.o.dataDir, 'pi'), apiKeys: this.keys, model: this.o.model });
  }

  onEvent(fn: (e: AtlasEvent) => void) { return this.repo.onEvent(fn); }
  private terminalSink: (sessionId: string, data?: string, exit?: number | null, seq?: number) => void = () => {};
  onTerminal(fn: (sessionId: string, data?: string, exit?: number | null, seq?: number) => void) { this.terminalSink = fn; }
  private retentionTimer: NodeJS.Timeout | null = null;
  private ciTimer: NodeJS.Timeout | null = null;
  private hygieneTimer: NodeJS.Timeout | null = null;

  private unlock: () => void = () => {};

  async start() {
    // Before touching any process: a second daemon on this data directory must not reap the first one's work.
    this.unlock = lockDataDir(this.o.dataDir);
    // Reap processes a crashed predecessor left running, before anything new starts (identity-checked).
    const reaped = reapJournaled(this.repo.processJournal());
    if (reaped.killed.length || reaped.stale) this.log.warn('reaped orphaned processes', { killed: reaped.killed, stale: reaped.stale });
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
    // CI of published pull requests, until it finishes (for a day after publishing). Network only with a token.
    this.ciTimer = setInterval(() => void this.orch.pollCi().catch(() => {}), 60_000);
    this.ciTimer.unref();
    this.team.start();
    // Session hygiene (ADR 0025): logs rotate as they grow; derived caches are cleared on start and every 30 minutes.
    void this.autoCleanup();
    this.hygieneTimer = setInterval(() => void this.autoCleanup(), 30 * 60_000);
    this.hygieneTimer.unref();
    this.log.info('daemon started', { schema: schemaVersion(this.db), github: !!this.githubToken, ...recovered });
    return recovered;
  }

  private record(missionId: string, taskId: string | null, type: 'desktop.session' | 'desktop.action', by: 'agent' | 'operator' | 'system', payload: Record<string, unknown>) {
    if (!this.repo.mission(missionId)) return;
    const task = taskId ? this.repo.task(taskId) : null;
    const actor = by === 'operator' ? { kind: 'operator' as const } : by === 'agent' && task ? { kind: 'agent' as const, role: task.role, taskId: task.id } : { kind: 'system' as const, component: 'desktop' };
    this.repo.append({ missionId, taskId, attemptId: null, type, actor, payload, artifactIds: [] });
  }

  private exportKeysView() { return { own: this.orch.exportKeyId(), trusted: this.repo.setting<string[]>('export.trustedKeys', []) }; }

  private skillsView(workspaceId?: string) {
    const off = new Set(this.repo.setting<string[]>('skills.disabled', []));
    const usage = this.repo.skillUsage();
    const view = (s: Skill) => ({ name: s.name, description: s.description, roles: s.roles, version: s.version, source: s.source, hash: s.hash, files: s.files, enabled: !off.has(s.name), triggers: s.triggers, tools: s.tools, ...(s.origin ? { origin: s.origin } : {}), ...(usage[s.name] && (s.source === 'bundled' || s.source === 'operator') ? { usage: usage[s.name] } : {}) });
    const t = this.orch.skills.trusted();
    const w = workspaceId ? this.repo.workspace(workspaceId) : null;
    const r = w?.isGit ? this.orch.skills.inRepository(w.root) : { skills: [], errors: [] };
    const x = this.orch.skills.inHarnesses(undefined, w?.isGit ? w.root : undefined);
    return { trusted: t.skills.map(view), repository: r.skills.map(view), external: x.skills.map(view), errors: [...t.errors, ...r.errors, ...x.errors] };
  }

  private readSkill(p: { name: string; source: 'trusted' | 'repository' | 'external'; workspaceId?: string; path?: string; hash?: string }) {
    const rel = p.path ?? 'SKILL.md';
    if (p.source === 'external') {
      const w = p.workspaceId ? this.repo.workspace(p.workspaceId) : null;
      const s = this.orch.skills.inHarnesses(undefined, w?.isGit ? w.root : undefined).skills.find((x) => x.name === p.name && (!p.hash || x.hash === p.hash));
      if (!s || !s.files.includes(rel)) throw new AtlasError('invalid_request', 'Unknown skill file');
      return { text: readFileSync(path.join(s.dir, rel), 'utf8'), hash: s.hash };
    }
    if (p.source === 'trusted') {
      const s = this.orch.skills.trusted().skills.find((x) => x.name === p.name);
      if (!s || !s.files.includes(rel)) throw new AtlasError('invalid_request', 'Unknown skill file');
      return { text: readFileSync(path.join(s.dir, rel), 'utf8'), hash: s.hash };
    }
    const w = p.workspaceId ? this.repo.workspace(p.workspaceId) : null;
    const s = w?.isGit ? this.orch.skills.inRepository(w.root).skills.find((x) => x.name === p.name) : undefined;
    if (!s || !s.files.includes(rel)) throw new AtlasError('invalid_request', 'Unknown skill file');
    return { text: readFileSync(path.join(s.dir, rel), 'utf8'), hash: s.hash };
  }

  private acceptanceView(workspaceId: string) {
    const s = this.orch.acceptance.get(workspaceId);
    return s ? { ...s, hash: suiteHash(s) } : null;
  }

  private configForDeployment(dir: string | null) { return dir ? loadConfig(dir).config : null; }

  async stop() {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.ciTimer) clearInterval(this.ciTimer);
    this.team.stop();
    if (this.hygieneTimer) clearInterval(this.hygieneTimer);
    await this.liveBrowser.shutdown();
    await this.desktop.shutdown();
    await this.deploy.shutdown();
    await this.orch.shutdown();
    await this.mcp.closeAll();
    setProcessJournal(null);
    this.unlock();
    this.db.close();
  }

  /** Internal methods come only from Electron main; renderer methods are re-validated here. */
  async handle(method: string, payload: unknown): Promise<unknown> {
    if (method in InternalRequests) return this.internal(method as keyof typeof InternalRequests, payload);
    const { params } = parseRequest(method, payload);
    const p = params as any;
    switch (method as Method) {
      case 'app.info': return { version: this.o.version, schema: schemaVersion(this.db), pi: PI_PINNED, platform: process.platform, node: process.versions.node, sandbox: detectSandbox(), browser: resolveBrowser(), git: await gitHardening() };
      case 'workspace.list': return this.repo.workspaces();
      case 'workspace.refresh': return this.orch.refreshWorkspace(p.workspaceId);
      case 'workspace.preflight': return this.orch.preflight(p.workspaceId, p.runtime);
      case 'mission.create': {
        if (!p.item) return this.orch.createMission(p);
        // Taking on a team item: claim it first (refused when someone else has it), then share the mission with it.
        await this.team.write(p.workspaceId, 'item.claim', { item: p.item });
        const m = this.orch.createMission(p);
        await this.team.shareMission(m.id, { item: p.item });
        return m;
      }
      case 'maintenance.report': return this.maintenanceView();
      case 'maintenance.cleanup': {
        const r = await this.cleanup(p.categories ?? CLEANABLE, false);
        return { ...this.maintenanceView(), result: r };
      }
      case 'pipeline.get': return this.orch.pipeline.settings(p.workspaceId);
      case 'pipeline.set': { const r = this.orch.pipeline.setSettings(p.workspaceId, p.settings); this.log.warn('pipeline settings changed', { workspaceId: p.workspaceId, ...r }); return r; }
      case 'team.get': return this.team.view(p.workspaceId);
      case 'team.sync': await this.team.sync(p.workspaceId); return this.team.view(p.workspaceId);
      case 'team.create': await this.team.create(p.workspaceId, p); return this.team.view(p.workspaceId);
      case 'team.join': await this.team.join(p.workspaceId, p); return this.team.view(p.workspaceId);
      case 'team.invite': { const r = await this.team.invite(p.workspaceId, p); return { code: r.code, view: await this.team.view(p.workspaceId) }; }
      case 'team.member.add': await this.team.write(p.workspaceId, 'member.add', { keyId: p.keyId, role: p.role, teams: p.teams }); return this.team.view(p.workspaceId);
      case 'team.member.update': await this.team.write(p.workspaceId, 'member.update', { keyId: p.keyId, name: p.name, role: p.role, teams: p.teams }); return this.team.view(p.workspaceId);
      case 'team.member.remove': await this.team.write(p.workspaceId, 'member.remove', { keyId: p.keyId }); return this.team.view(p.workspaceId);
      case 'team.team.save': await this.team.write(p.workspaceId, 'team.upsert', p.team); return this.team.view(p.workspaceId);
      case 'team.team.remove': await this.team.write(p.workspaceId, 'team.remove', { slug: p.slug }); return this.team.view(p.workspaceId);
      case 'team.item.create': await this.team.write(p.workspaceId, 'item.create', p.item); return this.team.view(p.workspaceId);
      case 'team.item.update': { const { workspaceId, ...b } = p; await this.team.write(workspaceId, 'item.update', b); return this.team.view(workspaceId); }
      case 'team.item.claim': await this.team.write(p.workspaceId, 'item.claim', { item: p.item }); return this.team.view(p.workspaceId);
      case 'team.mission.share': { await this.team.shareMission(p.missionId, p); return this.team.view(this.repo.mission(p.missionId)!.workspaceId); }
      case 'team.mission.patch': return { patch: await this.team.patch(p.workspaceId, p.missionId) };
      case 'team.review': await this.team.write(p.workspaceId, 'review', { missionId: p.missionId, commit: p.commit, verdict: p.verdict, note: p.note }); return this.team.view(p.workspaceId);
      case 'team.plan.approve': await this.team.approvePlan(p.workspaceId, p.missionId); return this.team.view(p.workspaceId);
      case 'team.comment': await this.team.write(p.workspaceId, 'comment', { item: p.item, missionId: p.missionId, text: p.text }); return this.team.view(p.workspaceId);
      case 'team.settings': this.team.setSettings(p.workspaceId, p.settings); return this.team.view(p.workspaceId);
      case 'mission.delete': await this.orch.deleteMission(p.missionId); this.log.info('mission deleted', { missionId: p.missionId }); return { deleted: p.missionId };
      case 'mission.reverify': return this.orch.reverify(p.missionId);
      case 'finding.update': return this.orch.updateFinding(p.findingId, p.status);
      case 'workspace.facts.get': return { text: this.orch.facts(p.workspaceId) ?? '' };
      case 'workspace.facts.set': this.orch.setFacts(p.workspaceId, p.text); return { text: p.text };
      case 'workspace.acceptance.get': return this.acceptanceView(p.workspaceId);
      case 'workspace.acceptance.set': this.orch.acceptance.set(p.workspaceId, p); return this.acceptanceView(p.workspaceId);
      case 'workspace.acceptance.remove': this.orch.acceptance.remove(p.workspaceId); return this.acceptanceView(p.workspaceId);
      case 'skills.list': return this.skillsView(p.workspaceId);
      case 'skills.read': return this.readSkill(p);
      case 'skills.import': {
        const w = p.workspaceId ? this.repo.workspace(p.workspaceId) : null;
        if (p.from === 'repository' && !w?.isGit) throw new AtlasError('invalid_request', 'Unknown workspace');
        const s = p.from === 'repository' ? this.orch.skills.importFromRepository(w!.root, p.name, p.hash) : this.orch.skills.importFromHarness(p.name, p.hash, undefined, w?.isGit ? w.root : undefined);
        this.log.info('skill imported', { name: s.name, hash: s.hash, from: p.from === 'repository' ? w!.root : 'another tool' });
        return this.skillsView(p.workspaceId);
      }
      case 'skills.save': {
        const s = this.orch.skills.saveOperator({ name: p.name, description: p.description, roles: p.roles, triggers: p.triggers }, p.body);
        this.log.info('skill saved', { name: s.name, hash: s.hash });
        return this.skillsView();
      }
      case 'skills.setEnabled': {
        const off = new Set(this.repo.setting<string[]>('skills.disabled', []));
        if (p.enabled) off.delete(p.name); else off.add(p.name);
        this.repo.setSetting('skills.disabled', [...off].sort());
        return this.skillsView();
      }
      case 'sync.preview': {
        const t = this.syncTarget(p);
        const pl = syncPlan(t, this.syncInput(), this.repo.setting<SyncState>('sync.state', {}), { skills: p.skills, mcp: p.mcp });
        const loc = syncLocations(t);
        return { id: pl.id, changes: pl.changes, notes: pl.notes, locations: { skills: p.skills ? loc.skills : null, mcp: p.mcp ? loc.mcp?.file ?? null : null } };
      }
      case 'sync.apply': {
        const t = this.syncTarget(p);
        const r = syncApply(t, this.syncInput(), this.repo.setting<SyncState>('sync.state', {}), p.id, { skills: p.skills, mcp: p.mcp });
        this.repo.setSetting('sync.state', r.state);
        const at = new Date().toISOString();
        this.repo.setSetting('sync.last', { ...this.repo.setting<Record<string, unknown>>('sync.last', {}), [`${p.harness}:${p.scope}`]: { at, changes: r.changes.length } });
        this.log.warn('harness sync applied', { harness: p.harness, scope: p.scope, changes: r.changes.map((c) => `${c.action} ${c.kind} ${c.name}`) });
        return { changes: r.changes, at };
      }
      case 'sync.foreign': return foreignServers(this.syncTarget(p), this.repo.setting<SyncState>('sync.state', {}));
      case 'skills.remove': this.orch.skills.removeOperator(p.name); return this.skillsView();
      case 'export.keys': return this.exportKeysView();
      case 'export.trust': this.repo.setSetting('export.trustedKeys', [...new Set([...this.repo.setting<string[]>('export.trustedKeys', []), p.keyId])]); return this.exportKeysView();
      case 'export.untrust': this.repo.setSetting('export.trustedKeys', this.repo.setting<string[]>('export.trustedKeys', []).filter((k) => k !== p.keyId)); return this.exportKeysView();
      case 'terminal.open': return this.orch.openTerminal(p.missionId, p.target, { cols: p.cols, rows: p.rows }, { onData: (id, t, seq) => this.terminalSink(id, t, undefined, seq), onExit: (id, c) => this.terminalSink(id, undefined, c) });
      case 'terminal.input': this.orch.terminalInput(p.sessionId, p.data); return null;
      case 'terminal.close': await this.orch.closeTerminal(p.sessionId); return null;
      case 'terminal.list': return this.orch.listTerminals(p.missionId);
      case 'terminal.attach': return this.orch.attachTerminal(p.sessionId);
      case 'terminal.resize': return this.orch.resizeTerminal(p.sessionId, p.cols, p.rows);
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
      case 'mission.restore': return this.orch.restore(p.missionId);
      case 'mission.forge': return this.orch.forgeView(p.missionId);
      case 'mission.publish': return this.orch.publish(p.missionId, p.base);
      case 'mission.ciRefresh': return this.orch.ciRefresh(p.missionId);
      case 'mission.fixCi': return this.orch.fixCi(p.missionId);
      case 'mission.approveDefinition': return this.orch.approveDefinitionChange(p.missionId, p.hash);
      case 'task.cancel': return this.orch.cancelTask(p.taskId);
      case 'task.direct': return this.orch.directAgent(p.taskId, p.text);
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
      case 'models.list': return this.pi.models();
      case 'credentials.test': return this.testKey(p.provider);
      case 'web.view': return this.web.view();
      case 'web.settings.save': {
        this.repo.setSetting('web.settings', p.settings);
        this.log.warn('web settings saved', { enabled: p.settings.enabled, roles: p.settings.roles, order: p.settings.order, strategy: p.settings.strategy, allowedSites: p.settings.allowedSites.length, allowSubmit: p.settings.allowSubmit });
        return this.web.view();
      }
      case 'web.account.save': {
        if (p.account.id in this.webEnv.keys) throw new AtlasError('invalid_request', 'This account comes from the environment; change it where ATLAS is launched');
        // The key itself is stored by Electron main in the OS credential store; it never reaches this database.
        const others = this.webAccounts().filter((a) => a.id !== p.account.id);
        this.repo.setSetting('web.accounts', [...others, p.account]);
        this.log.warn('search account saved', { id: p.account.id, provider: p.account.provider, enabled: p.account.enabled });
        return this.web.view();
      }
      case 'web.account.remove': {
        this.repo.setSetting('web.accounts', this.webAccounts().filter((a) => a.id !== p.id));
        this.web.pool.forget(p.id);
        delete this.webKeys[p.id];
        this.log.warn('search account removed', { id: p.id });
        return this.web.view();
      }
      case 'web.account.test': {
        const test = await this.web.pool.test(p.id, AbortSignal.timeout(20_000));
        return { ...this.web.view(), test };
      }
      case 'web.account.reset': this.web.pool.reset(p.id); return this.web.view();
      case 'browser.live.open': return this.liveBrowser.open(p);
      case 'browser.live.frame': return this.liveBrowser.frame(p.sessionId);
      case 'browser.live.input': { const { sessionId, ...input } = p; return this.liveBrowser.input(sessionId, input); }
      case 'browser.live.close': return this.liveBrowser.close(p.sessionId);
      case 'browser.live.urls': return this.liveBrowser.urls();
      case 'mcp.list': return this.mcpView();
      case 'mcp.save': {
        const others = this.mcpServers().filter((s) => s.name !== p.server.name);
        this.repo.setSetting('mcp.servers', [...others, p.server].sort((a, b) => a.name.localeCompare(b.name)));
        await this.mcp.disconnect(p.server.name);
        this.log.warn('mcp server saved', { name: p.server.name, transport: p.server.transport, approval: p.server.approval, roles: p.server.roles });
        return this.mcpView();
      }
      case 'mcp.remove': {
        await this.mcp.disconnect(p.name);
        this.repo.setSetting('mcp.servers', this.mcpServers().filter((s) => s.name !== p.name));
        const cache = { ...this.repo.setting<Record<string, unknown>>('mcp.tools', {}) };
        delete cache[p.name];
        this.repo.setSetting('mcp.tools', cache);
        this.log.warn('mcp server removed', { name: p.name });
        return this.mcpView();
      }
      case 'mcp.test': {
        try { await this.mcp.test(p.name); } catch { /* the error is part of the view */ }
        return this.mcpView();
      }
      case 'settings.get': return { values: this.settingValues(), sandbox: detectSandbox(true), windowsAccounts: this.windowsAccountsView() };
      case 'sandbox.windows.setup': {
        const info = setupWindowsAccounts();
        this.log.warn('windows sandbox accounts set up', { offline: info.offline.name, network: info.network.name, firewall: info.firewall });
        return { values: this.settingValues(), sandbox: detectSandbox(true), windowsAccounts: this.windowsAccountsView() };
      }
      case 'sandbox.windows.remove': {
        removeWindowsAccounts();
        this.log.warn('windows sandbox accounts removed');
        return { values: this.settingValues(), sandbox: detectSandbox(true), windowsAccounts: this.windowsAccountsView() };
      }
      case 'settings.set': {
        if (p.key === 'cloud.url' && p.value) workerUrl(p.value);
        this.repo.setSetting(p.key, p.value);
        this.log.warn('setting changed', { key: p.key, value: p.value });
        return { values: this.settingValues(), sandbox: detectSandbox(), windowsAccounts: this.windowsAccountsView() };
      }
      default: throw new AtlasError('invalid_request', `${method} is handled by the desktop shell`);
    }
  }

  /** What hygiene may and may not touch, from the live state of missions and attempts. */
  private hygieneInput(): HygieneInput {
    const missions = this.repo.missions();
    const live = missions.filter((m) => !m.archived && !m.decision);
    const resuming = new Set(this.repo.missionsInState(['planning', 'running', 'verifying']).map((m) => m.id));
    const keep = new Set<string>();
    for (const m of live) for (const a of this.repo.attempts(m.id)) if (['starting', 'running'].includes(a.state) || (a.state === 'lost' && resuming.has(m.id))) keep.add(a.id);
    return { dataDir: this.o.dataDir, liveMissions: live.map((m) => ({ id: m.id, baseCommit: m.baseCommit })), keepAttempts: keep, knownMissions: new Set(missions.map((m) => m.id)) };
  }

  private maintenanceView() {
    return { rows: hygieneReport(this.hygieneInput()), auto: this.repo.setting('maintenance.auto', true), last: this.repo.setting<CleanupResult | null>('maintenance.last', null) };
  }

  private async cleanup(categories: Category[], automatic: boolean): Promise<CleanupResult> {
    if (this.log.file && categories.includes('logs')) rotateLog(this.log.file);
    const r = hygieneCleanup(this.hygieneInput(), categories, () => { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }, automatic);
    // Removed worktree folders leave stale registrations in their repositories: let git forget them.
    if (r.removed.worktrees) for (const w of this.repo.workspaces()) if (w.isGit) await git(w.root, ['worktree', 'prune']).catch(() => null);
    this.repo.setSetting('maintenance.last', r);
    this.log.info('cleanup', { ...r });
    return r;
  }

  private async autoCleanup() {
    try {
      if (!this.repo.setting('maintenance.auto', true)) return;
      const rows = hygieneReport(this.hygieneInput());
      const reclaimable = rows.reduce((a, x) => a + x.reclaimable, 0);
      // Small amounts are not worth the I/O; caches above 64 MB, or any rotated logs, are cleared.
      if (reclaimable > 64 * 1024 * 1024 || rows.some((x) => x.category === 'logs' && x.reclaimable > 0)) await this.cleanup(CLEANABLE, true);
    } catch (e) { this.log.warn('automatic cleanup failed', { error: (e as Error).message }); }
  }

  private windowsAccountsView() {
    if (process.platform !== 'win32') return null;
    const a = windowsAccounts();
    return a ? { set: true, offline: a.offline.name, network: a.network.name, firewall: a.firewall } : { set: false };
  }

  private settingValues() {
    return {
      'execution.allowUnsandboxed': this.repo.setting('execution.allowUnsandboxed', false), 'retention.days': this.repo.setting('retention.days', 0),
      'deploy.allowedTargets': this.repo.setting<string[]>('deploy.allowedTargets', []), 'deploy.autoRollback': this.repo.setting('deploy.autoRollback', true),
      'desktop.enabled': this.repo.setting('desktop.enabled', false),
      'cloud.url': this.repo.setting('cloud.url', ''),
      'models.default': this.repo.setting<string | null>('models.default', null), 'models.fast': this.repo.setting<string | null>('models.fast', null), 'models.strong': this.repo.setting<string | null>('models.strong', null),
      'security.gate': this.repo.setting<'blocking' | 'advisory'>('security.gate', 'blocking'), 'security.aiReview': this.repo.setting('security.aiReview', true),
      'maintenance.auto': this.repo.setting('maintenance.auto', true),
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
      // Service tokens are kept apart from model keys: the GitHub token never reaches a runtime.
      this.githubToken = (params.keys as Record<string, string>).github || null;
      if (this.githubToken) registerSecret(this.githubToken);
      this.pi = this.makePi();
      this.orch.setRuntime('pi', this.pi);
      if (params.mcpSecrets) {
        this.mcpSecrets = params.mcpSecrets;
        for (const t of Object.values(this.mcpSecrets)) for (const v of Object.values(t)) registerSecret(v);
      }
      if (params.webKeys) {
        this.webKeys = params.webKeys;
        for (const v of Object.values(this.webKeys)) registerSecret(v);
      }
      if (params.deploySecrets) {
        this.deploySecrets = params.deploySecrets;
        for (const t of Object.values(this.deploySecrets)) for (const v of Object.values(t)) registerSecret(v);
      }
      return { providers: Object.keys(this.keys), deployTargets: Object.keys(this.deploySecrets), github: !!this.githubToken };
    }
    throw new AtlasError('invalid_request', 'unknown internal method');
  }

  snapshot(missionId: string) {
    const mission = this.repo.mission(missionId);
    if (!mission) throw new AtlasError('invalid_request', 'Unknown mission');
    // Called after every event the UI sees: two indexed lookups, never the whole log.
    const lastSeq = this.repo.lastSeq(missionId);
    const lastState = this.repo.lastEvent(missionId, 'mission.state');
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
      lastSeq,
      // The mission state the event log records (what a replay of the log yields).
      replayed: lastSeq ? (lastState ? (lastState.payload.to as string) : 'draft') : null,
    };
  }
}
