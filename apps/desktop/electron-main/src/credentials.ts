// Provider credentials (manual §24, E2): encrypted with the OS credential store via safeStorage.
// Values never reach the renderer; only "configured: yes/no" does.
import { app, safeStorage } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_ENV, SERVICE_ENV } from '@atlas/contracts';

/** Model provider keys and service tokens (GitHub, ADR 0015), each with the variable that can supply it instead. */
const ALL_ENV: Record<string, string> = { ...PROVIDER_ENV, ...SERVICE_ENV };

const file = () => path.join(app.getPath('userData'), 'credentials.json');

/**
 * The GitHub CLI's sign-in, used when no GitHub token is stored or exported: `gh auth token` prints the token gh
 * already keeps in the OS keychain. Read on demand, never written anywhere by ATLAS. Off with ATLAS_NO_GH_CLI=1.
 */
let ghCache: { at: number; token: string | null } | null = null;
function ghCliToken(): string | null {
  if (process.env.ATLAS_NO_GH_CLI === '1') return null;
  if (ghCache && Date.now() - ghCache.at < 60_000) return ghCache.token;
  let token: string | null = null;
  for (const gh of [path.join(os.homedir(), '.local/bin/gh'), '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
    if (!existsSync(gh)) continue;
    try { const t = execFileSync(gh, ['auth', 'token'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (/^[A-Za-z0-9_]{20,255}$/.test(t)) { token = t; break; } } catch { /* not signed in */ }
  }
  ghCache = { at: Date.now(), token };
  return token;
}

function load(): Record<string, string> {
  if (!existsSync(file())) return {};
  try { return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, string>; } catch { return {}; }
}
function save(data: Record<string, string>) {
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file());
}

export const credentials = {
  available: () => safeStorage.isEncryptionAvailable(),
  /** Decrypted keys from the store, plus any provider variables exported in the launching shell. */
  keys(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [provider, env] of Object.entries(ALL_ENV)) if (process.env[env]) out[provider] = process.env[env]!;
    if (!safeStorage.isEncryptionAvailable()) return out;
    for (const [provider, enc] of Object.entries(load())) {
      try { out[provider] = safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { /* unreadable entry: ignored */ }
    }
    if (!out.github) { const t = ghCliToken(); if (t) out.github = t; }
    return out;
  },
  list() {
    const stored = load();
    return Object.entries(ALL_ENV).map(([provider, env]) => {
      if (provider === 'github' && !(provider in stored) && !process.env[env] && ghCliToken()) return { provider, stored: false, fromEnvironment: true, env: 'GitHub CLI sign-in' };
      return { provider, stored: provider in stored, fromEnvironment: !!process.env[env], env };
    });
  },
  set(provider: string, key: string) {
    if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('No OS credential store is available. Export the provider variable before launching ATLAS instead.'), { kind: 'secrets' });
    const data = load();
    data[provider] = safeStorage.encryptString(key).toString('base64');
    save(data);
  },
  remove(provider: string) {
    const data = load();
    delete data[provider];
    save(data);
  },
};

/**
 * Named secrets grouped by owner (a deploy target, an MCP server), encrypted per value with the OS credential store.
 * Names are listed; values never leave main except to the daemon. One file per kind, so a deploy target can never
 * be named to receive an MCP server's secrets.
 */
function secretStore(fileName: string, what: string) {
  const file = () => path.join(app.getPath('userData'), fileName);
  const read = (): Record<string, Record<string, string>> => {
    if (!existsSync(file())) return {};
    try { return JSON.parse(readFileSync(file(), 'utf8')); } catch { return {}; }
  };
  const write = (d: Record<string, Record<string, string>>) => {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    renameSync(tmp, file());
  };
  return {
    list: () => Object.entries(read()).map(([target, vars]) => ({ target, names: Object.keys(vars).sort() })),
    set(target: string, name: string, value: string) {
      if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error(`No OS credential store is available; ${what} cannot be stored safely.`), { kind: 'secrets' });
      const d = read();
      (d[target] ??= {})[name] = safeStorage.encryptString(value).toString('base64');
      write(d);
    },
    remove(target: string, name: string) {
      const d = read();
      if (d[target]) { delete d[target][name]; if (!Object.keys(d[target]).length) delete d[target]; }
      write(d);
    },
    /** Drop every secret of one owner (an MCP server that was removed). */
    removeAll(target: string) { const d = read(); delete d[target]; write(d); },
    decrypted(): Record<string, Record<string, string>> {
      if (!safeStorage.isEncryptionAvailable()) return {};
      const out: Record<string, Record<string, string>> = {};
      for (const [t, vars] of Object.entries(read())) for (const [k, v] of Object.entries(vars)) {
        try { (out[t] ??= {})[k] = safeStorage.decryptString(Buffer.from(v, 'base64')); } catch { /* unreadable */ }
      }
      return out;
    },
  };
}

/** Deploy-target secrets (manual §24). */
export const deploySecrets = secretStore('deploy-secrets.json', 'deploy secrets');
/** MCP server secrets: environment variables and headers (ADR 0018). */
export const mcpSecrets = secretStore('mcp-secrets.json', 'MCP server secrets');
/** Search account keys (ADR 0030): one "key" per account id. */
export const webKeys = secretStore('web-keys.json', 'search account keys');
/** Account id → key, as the daemon takes them. */
export const webKeyValues = (): Record<string, string> => Object.fromEntries(Object.entries(webKeys.decrypted()).flatMap(([id, v]) => (v.key ? [[id, v.key]] : [])));
