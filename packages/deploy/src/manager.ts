// Staging deployments (manual §30, §32). Two providers:
//  - local: the integrated commit is exported to an ATLAS-managed release directory and run in the sandbox.
//  - command: the project's own deploy CLI runs in the sandbox with the target's scoped secrets.
// Intent is persisted before any provider call so a crash can never cause a silent duplicate deployment.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { AtlasError, newId, nowIso, registerSecret, type AtlasConfig, type Deployment } from '@atlas/contracts';
import type { Repo } from '@atlas/storage';
import { run, sanitizedEnv, startProcess, type ProcessHandle, type SandboxSpec } from '@atlas/terminal';
import { freePort, waitReady } from '@atlas/browser';

export type DeployConfig = NonNullable<AtlasConfig['deploy']>;
export type IsolationMode = { mode: 'sandbox' | 'unsandboxed' | 'unavailable'; detail: string };

export interface DeployDeps {
  repo: Repo;
  dataDir: string;
  /** Scoped secrets for a target, injected only into that target's deploy/log/rollback commands. */
  secrets(target: string): Record<string, string>;
  isolation(): IsolationMode;
  log(msg: string, data?: Record<string, unknown>): void;
}

export interface DeployResult { ok: boolean; deployment: Deployment; message: string; output: string }

const fill = (argv: string[], vars: Record<string, string>) => argv.map((a) => a.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? ''));

export class DeployManager {
  private readonly procs = new Map<string, { handle: ProcessHandle; port: number }>();
  constructor(private readonly d: DeployDeps) {}

  private spec(root: string, network: boolean): SandboxSpec | undefined | null {
    const iso = this.d.isolation();
    if (iso.mode === 'unavailable') return null;
    if (iso.mode === 'unsandboxed') return undefined;
    return { root, writable: true, network, limits: { fileSizeBytes: 1024 ** 3, openFiles: 4096 } };
  }

  allowed(target: string): boolean {
    return this.d.repo.setting<string[]>('deploy.allowedTargets', []).includes(target);
  }

  /** Export a commit to a fresh directory (no .git): what is deployed is exactly that commit. */
  async exportRelease(repoDir: string, commit: string, dir: string) {
    mkdirSync(dir, { recursive: true });
    const tar = path.join(dir, '..', `${path.basename(dir)}.tar`);
    const a = await run({ command: 'git', args: ['-C', repoDir, '-c', 'core.hooksPath=/dev/null', 'archive', '--format=tar', '-o', tar, commit], cwd: repoDir, timeoutMs: 120_000 });
    if (a.exitCode !== 0) throw new AtlasError('deployment_fail', `git archive failed: ${a.output.slice(0, 300)}`);
    // Relative names only: GNU tar (Git for Windows) reads "C:\…" as host "C" (CI: "Cannot connect to C").
    const x = await run({ command: 'tar', args: ['-xf', path.join('..', path.basename(tar))], cwd: dir, timeoutMs: 120_000 });
    rmSync(tar, { force: true });
    if (x.exitCode !== 0) throw new AtlasError('deployment_fail', `extract failed: ${x.output.slice(0, 300)}`);
  }

  async deployStaging(req: { missionId: string | null; target: string; repoDir: string; commit: string; config: AtlasConfig; signal: AbortSignal; onOutput?: (t: string) => void }): Promise<DeployResult> {
    const cfg = req.config.deploy;
    if (!cfg) throw new AtlasError('invalid_request', 'No deploy section in atlas.config.json');
    if (cfg.target !== req.target) throw new AtlasError('invalid_request', `Target ${req.target} is not defined in atlas.config.json`);
    if (!this.allowed(req.target)) throw new AtlasError('policy_deny', `Target ${req.target} is not on the operator's allowlist`);
    const previous = this.d.repo.liveDeployment(req.target);
    const id = newId('dep');
    const dir = path.join(this.d.dataDir, 'releases', req.target.replace(/[^\w.-]/g, '_'), id);
    const now = nowIso();
    const dep: Deployment = { id, missionId: req.missionId, target: req.target, provider: cfg.provider, revision: req.commit, url: null, externalId: null, status: 'deploying', verified: false, releaseDir: dir, previousId: previous?.id ?? null, detail: null, createdAt: now, updatedAt: now };
    this.d.repo.insertDeployment(dep); // intent first (manual §13, §40)
    try {
      await this.exportRelease(req.repoDir, req.commit, dir);
      const r = cfg.provider === 'local' ? await this.deployLocal(dep, req.config) : await this.deployCommand(dep, cfg, req.signal, req.onOutput);
      if (!r.ok) { this.d.repo.updateDeployment(id, { status: 'failed', detail: r.message }); return { ...r, deployment: this.d.repo.deployment(id)! }; }
      if (previous) {
        this.d.repo.updateDeployment(previous.id, { status: 'superseded' });
        if (previous.provider === 'local') await this.stopLocal(previous.id);
      }
      this.d.repo.updateDeployment(id, { status: 'live', url: r.url, externalId: r.externalId, detail: r.message });
      return { ok: true, deployment: this.d.repo.deployment(id)!, message: r.message, output: r.output };
    } catch (e) {
      this.d.repo.updateDeployment(id, { status: 'failed', detail: (e as Error).message });
      return { ok: false, deployment: this.d.repo.deployment(id)!, message: (e as Error).message, output: '' };
    }
  }

  private async deployLocal(dep: Deployment, config: AtlasConfig): Promise<{ ok: boolean; url: string | null; externalId: string | null; message: string; output: string }> {
    if (!config.app) return { ok: false, url: null, externalId: null, message: 'Local staging needs an app section in atlas.config.json', output: '' };
    const started = await this.startLocal(dep, config.app, config.deploy!);
    return started.ok ? { ok: true, url: started.url, externalId: `local:${started.port}`, message: `Serving ${dep.revision.slice(0, 12)} at ${started.url}`, output: started.output } : { ok: false, url: null, externalId: null, message: started.message, output: started.output };
  }

  /** Start (or restart) a local deployment from its release directory. */
  async startLocal(dep: Deployment, app: NonNullable<AtlasConfig['app']>, cfg: DeployConfig): Promise<{ ok: true; url: string; port: number; output: string } | { ok: false; message: string; output: string }> {
    if (!dep.releaseDir || !existsSync(dep.releaseDir)) return { ok: false, message: 'Release directory is missing', output: '' };
    const spec = this.spec(dep.releaseDir, true);
    if (spec === null) return { ok: false, message: `No OS sandbox: ${this.d.isolation().detail}`, output: '' };
    const port = await freePort();
    const handle = startProcess({
      command: app.start[0], args: app.start.slice(1), cwd: dep.releaseDir, sandbox: spec,
      env: sanitizedEnv({ ...app.env, PORT: String(port), HOST: '127.0.0.1', ATLAS_REVISION: dep.revision, ATLAS_DEPLOYMENT_ID: dep.id, ATLAS_TARGET: dep.target, NODE_ENV: 'production' }),
    });
    if (handle.spawnError) return { ok: false, message: handle.spawnError, output: '' };
    const url = `http://127.0.0.1:${port}`;
    const ready = await waitReady(new URL(cfg.readyPath, url).toString(), cfg.readyTimeoutSec * 1000, undefined, () => !handle.exited());
    if (!ready.ok) { const output = handle.output(); await handle.stop(); return { ok: false, message: `Deployment not ready: ${ready.detail}`, output }; }
    this.procs.set(dep.id, { handle, port });
    return { ok: true, url, port, output: handle.output() };
  }

  async stopLocal(id: string) {
    const p = this.procs.get(id);
    if (!p) return;
    this.procs.delete(id);
    await p.handle.stop();
  }

  private async deployCommand(dep: Deployment, cfg: DeployConfig, signal: AbortSignal, onOutput?: (t: string) => void) {
    if (!cfg.command) return { ok: false, url: null, externalId: null, message: 'command provider needs deploy.command', output: '' };
    const spec = this.spec(dep.releaseDir!, true);
    if (spec === null) return { ok: false, url: null, externalId: null, message: `No OS sandbox: ${this.d.isolation().detail}`, output: '' };
    const secrets = this.d.secrets(dep.target);
    for (const v of Object.values(secrets)) registerSecret(v);
    const argv = fill(cfg.command, { revision: dep.revision, target: dep.target, deploymentId: dep.id });
    const r = await run({ command: argv[0], args: argv.slice(1), cwd: dep.releaseDir!, timeoutMs: 30 * 60_000, signal, sandbox: spec, env: sanitizedEnv({ ...secrets, ATLAS_REVISION: dep.revision, ATLAS_TARGET: dep.target, ATLAS_DEPLOYMENT_ID: dep.id }), onOutput: onOutput ? (_s, t) => onOutput(t) : undefined });
    if (r.exitCode !== 0) return { ok: false, url: null, externalId: null, message: r.spawnError ?? `Deploy command exited ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`, output: r.output };
    const url = cfg.urlPattern ? r.output.match(new RegExp(cfg.urlPattern))?.[1] ?? null : null;
    const externalId = cfg.idPattern ? r.output.match(new RegExp(cfg.idPattern))?.[1] ?? null : null;
    if (!url) return { ok: false, url: null, externalId, message: 'Deploy command succeeded but no deployment URL was found in its output (deploy.urlPattern)', output: r.output };
    return { ok: true, url, externalId, message: `Deployed ${dep.revision.slice(0, 12)} to ${url}${externalId ? ` (${externalId})` : ''}`, output: r.output };
  }

  async logs(dep: Deployment, cfg: DeployConfig | undefined, lines = 200): Promise<string> {
    if (dep.provider === 'local') return (this.procs.get(dep.id)?.handle.output() ?? '').split('\n').slice(-lines).join('\n');
    if (!cfg?.logsCommand || !dep.releaseDir) return '';
    const spec = this.spec(dep.releaseDir, true);
    if (spec === null) return '';
    const argv = fill(cfg.logsCommand, { id: dep.externalId ?? '', revision: dep.revision, target: dep.target });
    const r = await run({ command: argv[0], args: argv.slice(1), cwd: dep.releaseDir, timeoutMs: 60_000, sandbox: spec, env: sanitizedEnv(this.d.secrets(dep.target)) });
    return r.output.split('\n').slice(-lines).join('\n');
  }

  /**
   * Roll back a target to an earlier verified deployment. Reported as an attempted action with its
   * verified outcome (the deployed revision is re-read), never as a guaranteed fix (manual §32).
   */
  async rollback(target: string, config: AtlasConfig | null, toId?: string): Promise<{ ok: boolean; message: string; to: Deployment | null; revisionConfirmed: boolean | null }> {
    const live = this.d.repo.liveDeployment(target);
    const to = toId ? this.d.repo.deployment(toId) : this.d.repo.lastVerified(target, live?.id);
    if (!to || to.target !== target) return { ok: false, message: 'No earlier verified deployment to roll back to', to: null, revisionConfirmed: null };
    if (to.provider === 'local') {
      const app = config?.app;
      if (!app) return { ok: false, message: 'atlas.config.json app section is required to restart a local deployment', to, revisionConfirmed: null };
      if (live && live.provider === 'local') await this.stopLocal(live.id);
      const s = await this.startLocal(to, app, config!.deploy!);
      if (!s.ok) return { ok: false, message: s.message, to, revisionConfirmed: null };
      if (live) this.d.repo.updateDeployment(live.id, { status: 'rolled_back' });
      this.d.repo.updateDeployment(to.id, { status: 'live', url: s.url, externalId: `local:${s.port}` });
    } else {
      const cfg = config?.deploy;
      if (!cfg?.rollbackCommand) return { ok: false, message: 'No deploy.rollbackCommand configured', to, revisionConfirmed: null };
      const spec = this.spec(to.releaseDir!, true);
      if (spec === null) return { ok: false, message: 'No OS sandbox', to, revisionConfirmed: null };
      const argv = fill(cfg.rollbackCommand, { id: live?.externalId ?? '', previousId: to.externalId ?? '', revision: to.revision, target });
      const r = await run({ command: argv[0], args: argv.slice(1), cwd: to.releaseDir!, timeoutMs: 30 * 60_000, sandbox: spec, env: sanitizedEnv(this.d.secrets(target)) });
      if (r.exitCode !== 0) return { ok: false, message: `Rollback command exited ${r.exitCode}`, to, revisionConfirmed: null };
      if (live) this.d.repo.updateDeployment(live.id, { status: 'rolled_back' });
      this.d.repo.updateDeployment(to.id, { status: 'live' });
    }
    const now = this.d.repo.deployment(to.id)!;
    const confirmed = config?.deploy?.versionPath && now.url ? await readRevision(now.url, config.deploy.versionPath).then((v) => v.revision != null && matchesRevision(v.revision, to.revision)) : null;
    return { ok: true, message: `Rolled back ${target} to ${to.revision.slice(0, 12)} (${to.id})`, to: now, revisionConfirmed: confirmed };
  }

  /** After a daemon restart: unfinished deploys become 'unknown' (never redeployed silently); live local deployments are restarted. */
  async reconcile(configFor: (dep: Deployment) => AtlasConfig | null): Promise<{ restarted: string[]; unknown: string[] }> {
    const restarted: string[] = [], unknown: string[] = [];
    for (const dep of this.d.repo.deployments()) {
      if (dep.status === 'deploying') { this.d.repo.updateDeployment(dep.id, { status: 'unknown', detail: 'ATLAS stopped during this deployment; its state is unknown and it was not retried.' }); unknown.push(dep.id); continue; }
      if (dep.status === 'live' && dep.provider === 'local' && !this.procs.has(dep.id)) {
        const cfg = configFor(dep);
        if (!cfg?.app || !cfg.deploy) { this.d.repo.updateDeployment(dep.id, { status: 'stopped', detail: 'Could not restart after an ATLAS restart: configuration missing' }); continue; }
        const s = await this.startLocal(dep, cfg.app, cfg.deploy);
        if (s.ok) { this.d.repo.updateDeployment(dep.id, { url: s.url, externalId: `local:${s.port}` }); restarted.push(dep.id); }
        else this.d.repo.updateDeployment(dep.id, { status: 'stopped', detail: `Restart failed: ${s.message}` });
      }
    }
    return { restarted, unknown };
  }

  async shutdown() { for (const id of [...this.procs.keys()]) await this.stopLocal(id); }
}

export async function readRevision(url: string, versionPath: string): Promise<{ revision: string | null; raw: string; status: number | null }> {
  try {
    const r = await fetch(new URL(versionPath, url), { signal: AbortSignal.timeout(5000) });
    const raw = (await r.text()).slice(0, 2000);
    let revision: string | null = null;
    try { const j = JSON.parse(raw); revision = String(j.revision ?? j.commit ?? j.sha ?? j.version ?? '') || null; } catch { revision = raw.trim().split(/\s+/)[0] || null; }
    return { revision, raw, status: r.status };
  } catch (e) { return { revision: null, raw: (e as Error).message, status: null }; }
}

/** A reported revision matches only if it is the commit or an unambiguous prefix of at least 7 characters. */
export function matchesRevision(reported: string, commit: string): boolean {
  const r = reported.trim().toLowerCase();
  return r.length >= 7 && /^[0-9a-f]+$/.test(r) && commit.toLowerCase().startsWith(r);
}
