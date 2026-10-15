// MCP server entries in each harness's format (ADR 0019). Secret values are never written: secrets become
// references to environment variables, which the operator exports for that tool.
import { mcpSecretEnv, type McpServerConfig } from '@atlas/contracts';
import type { McpFormat } from './targets';

type Json = Record<string, unknown>;

/** Claude Code `.mcp.json` entry: `${VAR}` is expanded by Claude Code. */
export function claudeEntry(c: McpServerConfig): Json {
  const ref = (n: string) => `\${${mcpSecretEnv(c.name, n)}}`;
  if (c.transport === 'http') return { type: 'http', url: c.url, ...(c.secrets.length ? { headers: Object.fromEntries(c.secrets.map((n) => [n, ref(n)])) } : {}) };
  const env = { ...c.env, ...Object.fromEntries(c.secrets.map((n) => [n, ref(n)])) };
  return { type: 'stdio', command: c.command, args: c.args, ...(Object.keys(env).length ? { env } : {}) };
}

/** OpenCode `opencode.json` `mcp` entry: `{env:VAR}` is substituted by OpenCode. */
export function opencodeEntry(c: McpServerConfig): Json {
  const ref = (n: string) => `{env:${mcpSecretEnv(c.name, n)}}`;
  if (c.transport === 'http') return { type: 'remote', url: c.url, enabled: true, oauth: false, ...(c.secrets.length ? { headers: Object.fromEntries(c.secrets.map((n) => [n, ref(n)])) } : {}) };
  const environment = { ...c.env, ...Object.fromEntries(c.secrets.map((n) => [n, ref(n)])) };
  return { type: 'local', command: [c.command, ...c.args], enabled: true, ...(Object.keys(environment).length ? { environment } : {}) };
}

const tomlString = (s: string) => JSON.stringify(s);
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));
const inlineTable = (o: Record<string, string>) => `{ ${Object.entries(o).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(', ')} }`;

/**
 * Codex `config.toml` table. Remote secrets use `env_http_headers` (header → variable holding its value). A local
 * server's secrets use `env_vars`, which forwards a variable of the same name from Codex's own environment.
 */
export function codexTable(c: McpServerConfig): string {
  const lines = [`[mcp_servers.${tomlKey(c.name)}]`];
  if (c.transport === 'http') {
    lines.push(`url = ${tomlString(c.url!)}`);
    if (c.secrets.length) lines.push(`env_http_headers = ${inlineTable(Object.fromEntries(c.secrets.map((n) => [n, mcpSecretEnv(c.name, n)])))}`);
  } else {
    lines.push(`command = ${tomlString(c.command!)}`);
    if (c.args.length) lines.push(`args = [${c.args.map(tomlString).join(', ')}]`);
    if (Object.keys(c.env).length) lines.push(`env = ${inlineTable(c.env)}`);
    if (c.secrets.length) lines.push(`env_vars = [${c.secrets.map(tomlString).join(', ')}]`);
  }
  return lines.join('\n');
}

export const BLOCK_BEGIN = '# >>> ATLAS managed MCP servers: edits inside this block are overwritten by ATLAS sync >>>';
export const BLOCK_END = '# <<< ATLAS managed MCP servers <<<';

/** The managed block of a config.toml: its text and where it sits. */
export function findBlock(text: string): { start: number; end: number; body: string } | null {
  const s = text.indexOf(BLOCK_BEGIN);
  if (s < 0) return null;
  const e = text.indexOf(BLOCK_END, s);
  if (e < 0) return null;
  return { start: s, end: e + BLOCK_END.length, body: text.slice(s + BLOCK_BEGIN.length, e).trim() };
}

/** Names of [mcp_servers.x] tables in a TOML text (outside ATLAS's block when the block is removed first). */
export function tomlServerNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)) out.push(m[1] ?? m[2]);
  return out;
}

/* ------------------------------------------------------------------ reading other tools' servers (import) */

export interface ForeignServer { name: string; config: Json | null; secretNames: string[]; problem: string | null }

const SECRETISH = /key|token|secret|pass|auth|cred|cookie|session/i;
const isRef = (v: string) => /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$|^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(v.trim());

/**
 * Convert a harness entry into an ATLAS server definition without copying credentials: header values and any
 * environment value that is a reference, or whose name looks secret, become secret names the operator fills in.
 */
function toAtlas(name: string, kind: 'stdio' | 'http', o: { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }): ForeignServer {
  const n = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';
  if (kind === 'http') {
    if (!o.url) return { name: n, config: null, secretNames: [], problem: 'no url' };
    const secrets = Object.keys(o.headers ?? {});
    return { name: n, config: { name: n, transport: 'http', url: o.url, secrets }, secretNames: secrets, problem: null };
  }
  if (!o.command) return { name: n, config: null, secretNames: [], problem: 'no command' };
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  for (const [k, v] of Object.entries(o.env ?? {})) { if (isRef(String(v)) || SECRETISH.test(k)) secrets.push(k); else env[k] = String(v); }
  return { name: n, config: { name: n, transport: 'stdio', command: o.command, args: o.args ?? [], env, secrets }, secretNames: secrets, problem: null };
}

const strMap = (v: unknown): Record<string, string> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Json).filter(([, x]) => typeof x === 'string')) as Record<string, string> : undefined);
const strArr = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

export function readForeign(format: McpFormat, text: string): ForeignServer[] {
  if (format === 'codex-toml') return readCodex(text);
  let obj: Json;
  try { obj = JSON.parse(text) as Json; } catch { return [{ name: '(file)', config: null, secretNames: [], problem: 'not plain JSON (comments are not read)' }]; }
  const servers = (format === 'claude-json' ? obj.mcpServers : obj.mcp) as Record<string, Json> | undefined;
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers).map(([name, e]) => {
    if (!e || typeof e !== 'object') return { name, config: null, secretNames: [], problem: 'not an object' };
    if (format === 'claude-json') {
      const http = e.type === 'http' || e.type === 'sse' || (!e.command && typeof e.url === 'string');
      if (e.type === 'sse') return { name, config: null, secretNames: [], problem: 'SSE transport is not supported; use streamable HTTP' };
      return toAtlas(name, http ? 'http' : 'stdio', { command: e.command as string, args: strArr(e.args), env: strMap(e.env), url: e.url as string, headers: strMap(e.headers) });
    }
    const cmd = strArr(e.command) ?? [];
    return e.type === 'remote'
      ? toAtlas(name, 'http', { url: e.url as string, headers: strMap(e.headers) })
      : toAtlas(name, 'stdio', { command: cmd[0], args: cmd.slice(1), env: strMap(e.environment) });
  });
}

/** A small TOML subset: [mcp_servers.x] tables with string, string-array and inline string-table values. */
function readCodex(text: string): ForeignServer[] {
  const out: ForeignServer[] = [];
  let cur: { name: string; fields: Json } | null = null;
  const flush = () => {
    if (!cur) return;
    const f = cur.fields;
    const headers = { ...(strMap(f.http_headers) ?? {}), ...(strMap(f.env_http_headers) ?? {}) };
    if (typeof f.bearer_token_env_var === 'string') headers.Authorization = `\${${f.bearer_token_env_var}}`;
    const env = { ...(strMap(f.env) ?? {}) };
    for (const v of strArr(f.env_vars) ?? []) env[v] = `\${${v}}`;
    out.push(typeof f.url === 'string' ? toAtlas(cur.name, 'http', { url: f.url, headers }) : toAtlas(cur.name, 'stdio', { command: f.command as string, args: strArr(f.args), env }));
    cur = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const table = /^\[(.+)\]$/.exec(line);
    if (table) {
      flush();
      const m = /^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/.exec(table[1].trim());
      cur = m ? { name: m[1] ?? m[2], fields: {} } : null;
      continue;
    }
    if (!cur) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const v = parseValue(kv[2]);
    if (v !== undefined) cur.fields[kv[1]] = v;
  }
  flush();
  return out;
}

function parseValue(v: string): unknown {
  const s = v.trim();
  try {
    if (s.startsWith('"')) return JSON.parse(s);
    if (s.startsWith("'")) return s.slice(1, s.lastIndexOf("'"));
    if (s.startsWith('[')) return JSON.parse(s.replace(/'([^']*)'/g, (_m, x) => JSON.stringify(x)).replace(/,\s*\]$/, ']'));
    if (s.startsWith('{')) {
      const o: Record<string, string> = {};
      for (const m of s.slice(1, -1).matchAll(/\s*("?)([A-Za-z0-9_.-]+)\1\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) o[m[2]] = m[3].startsWith('"') ? JSON.parse(m[3]) : m[3].slice(1, -1);
      return o;
    }
  } catch { return undefined; }
  return undefined;
}

export const entryFor = (f: McpFormat) => (f === 'claude-json' ? claudeEntry : opencodeEntry);
