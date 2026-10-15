// Daemon entry. Runs as an Electron utility process (parentPort) or a Node child process (process.send).
import { installCrashGuards, once } from './guards';
import { PROVIDER_ENV, SERVICE_ENV, type DaemonInbound, type DaemonOutbound } from '@atlas/contracts';
import { DaemonService } from './service';

type Port = { send(m: DaemonOutbound): void; on(fn: (m: DaemonInbound) => void): void };

function port(): Port {
  const pp = (process as any).parentPort;
  if (pp) return { send: (m) => pp.postMessage(m), on: (fn) => pp.on('message', (e: { data: DaemonInbound }) => fn(e.data)) };
  if (process.send) return { send: (m) => process.send!(m), on: (fn) => process.on('message', (m) => fn(m as DaemonInbound)) };
  throw new Error('daemon must be started by the ATLAS shell');
}

async function main() {
  const dataDir = process.env.ATLAS_DATA_DIR;
  if (!dataDir) throw new Error('ATLAS_DATA_DIR is required');
  const apiKeys: Record<string, string> = {};
  for (const [provider, env] of Object.entries(PROVIDER_ENV)) {
    const v = process.env[env];
    if (v) apiKeys[provider] = v;
  }
  for (const env of new Set(Object.values(PROVIDER_ENV))) delete process.env[env];
  // From the desktop shell: one key per provider, even where providers share a variable (ADR 0017).
  if (process.env.ATLAS_PROVIDER_KEYS) {
    try { for (const [provider, key] of Object.entries(JSON.parse(process.env.ATLAS_PROVIDER_KEYS) as Record<string, string>)) if (PROVIDER_ENV[provider] && typeof key === 'string') apiKeys[provider] = key; } catch { /* ignored */ }
    delete process.env.ATLAS_PROVIDER_KEYS;
  }
  const githubToken = process.env[SERVICE_ENV.github] || undefined;
  delete process.env[SERVICE_ENV.github];
  let deploySecrets: Record<string, Record<string, string>> = {};
  if (process.env.ATLAS_DEPLOY_SECRETS) { try { deploySecrets = JSON.parse(process.env.ATLAS_DEPLOY_SECRETS); } catch { /* ignored */ } delete process.env.ATLAS_DEPLOY_SECRETS; }
  let mcpSecrets: Record<string, Record<string, string>> = {};
  if (process.env.ATLAS_MCP_SECRETS) { try { mcpSecrets = JSON.parse(process.env.ATLAS_MCP_SECRETS); } catch { /* ignored */ } delete process.env.ATLAS_MCP_SECRETS; }
  const mcpEnvSecrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('ATLAS_MCP_SECRET_') && v) { mcpEnvSecrets[k] = v; delete process.env[k]; }
  let webKeys: Record<string, string> = {};
  if (process.env.ATLAS_WEB_KEYS) { try { webKeys = JSON.parse(process.env.ATLAS_WEB_KEYS); } catch { /* ignored */ } delete process.env.ATLAS_WEB_KEYS; }
  const webEnv: Record<string, string | undefined> = {};
  for (const k of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CSE_ID']) { webEnv[k] = process.env[k]; delete process.env[k]; }
  // Tests only: send search provider requests to a fake provider on loopback instead of the real services.
  const testBase = process.env.ATLAS_WEB_TEST_BASE;
  const webFetch = testBase && /^http:\/\/127\.0\.0\.1:\d+$/.test(testBase)
    ? ((url: string | URL | Request, init?: RequestInit) => { const u = new URL(String(url)); return fetch(`${testBase}/${u.hostname}${u.pathname}${u.search}`, init); }) as typeof fetch
    : undefined;
  const svc = new DaemonService({ dataDir, skillsDir: process.env.ATLAS_SKILLS_DIR, version: process.env.ATLAS_VERSION ?? '0.0.0', apiKeys, model: process.env.ATLAS_MODEL || undefined, deploySecrets, mcpSecrets, mcpEnvSecrets, githubToken, githubApi: process.env.ATLAS_GITHUB_API || undefined, webKeys, webEnv, webFetch });
  const io = port();
  installCrashGuards(svc.log);
  svc.onEvent((event) => io.send({ kind: 'event', event }));
  svc.onTerminal((sessionId, data, exit, seq) => io.send({ kind: 'terminal', sessionId, ...(data !== undefined ? { data, seq } : {}), ...(exit !== undefined ? { exit } : {}) }));
  io.on(async (msg) => {
    if (!msg || msg.kind !== 'req' || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    try {
      const data = await svc.handle(msg.method, msg.params);
      io.send({ kind: 'res', id: msg.id, ok: true, data: JSON.parse(JSON.stringify(data ?? null)) });
    } catch (e) {
      const err = e as Error & { kind?: string; issues?: unknown };
      const kind = err.kind ?? (err.name === 'ZodError' ? 'invalid_request' : 'internal');
      svc.log.warn('request failed', { method: msg.method, kind, message: err.message });
      // The shell may be gone (it is restarting us); a reply that cannot be delivered is not a second failure.
      try { io.send({ kind: 'res', id: msg.id, ok: false, error: { kind, message: kind === 'invalid_request' && err.name === 'ZodError' ? 'Malformed request' : err.message } }); } catch { /* channel closed */ }
    }
  });
  const recovered = await svc.start();
  io.send({ kind: 'ready', pid: process.pid, recovered });
  const stop = once(async () => { await svc.stop().catch(() => {}); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  process.stderr.write(`ATLAS daemon failed to start: ${(e as Error).stack}\n`);
  process.exit(1);
});
