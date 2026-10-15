// MCP connections (ADR 0018). The operator connects Model Context Protocol servers; agents reach their tools only
// through the governed mcp_call tool. Configuration is operator data, never repository content.
import { z } from 'zod';
import { AgentRole } from './domain';

export const MCP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Environment variable or HTTP header names whose values live in the OS credential store. */
const secretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);

export const McpServerConfig = z.object({
  name: z.string().regex(MCP_NAME, 'lowercase letters, digits and hyphens'),
  transport: z.enum(['stdio', 'http']),
  /** stdio: program and arguments, started inside the OS sandbox. */
  command: z.string().min(1).max(500).optional(),
  args: z.array(z.string().max(2000)).max(50).default([]),
  /** stdio: plain (non-secret) environment values. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(2000)).default({}),
  /** stdio: may the server reach the network (inside the sandbox)? */
  network: z.boolean().default(false),
  /** stdio: absolute folders the server may read (its own install, for example). Nothing else outside its home. */
  readPaths: z.array(z.string().min(2).max(1000).refine((p) => /^(\/|[A-Za-z]:[\\/])/.test(p), 'must be an absolute path')).max(10).default([]),
  /** http: streamable HTTP endpoint. https, or http on loopback only. */
  url: z.string().url().max(2000).optional(),
  /** Names of secret environment variables (stdio) or headers (http); values are in the credential store. */
  secrets: z.array(secretName).max(20).default([]),
  enabled: z.boolean().default(true),
  /** ask: every call waits for the operator's approval. allow: calls run without asking (trusted server). */
  approval: z.enum(['ask', 'allow']).default('ask'),
  /** Roles whose agents may call this server's tools. */
  roles: z.array(AgentRole).max(10).default(['coder', 'reviewer', 'tester']),
  /** Tools offered to agents; null offers every tool the server lists. */
  tools: z.array(z.string().min(1).max(128)).max(500).nullable().default(null),
}).strict().superRefine((c, ctx) => {
  if (c.transport === 'stdio' && !c.command) ctx.addIssue({ code: 'custom', message: 'A local (stdio) server needs a command', path: ['command'] });
  if (c.transport === 'http') {
    if (!c.url) { ctx.addIssue({ code: 'custom', message: 'A remote (HTTP) server needs a URL', path: ['url'] }); return; }
    const u = new URL(c.url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) ctx.addIssue({ code: 'custom', message: 'Use https (plain http only for localhost)', path: ['url'] });
    if (u.username || u.password) ctx.addIssue({ code: 'custom', message: 'Put credentials in a secret header, not in the URL', path: ['url'] });
  }
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** Variable that can supply an MCP secret when no OS credential store exists: ATLAS_MCP_SECRET_<SERVER>_<NAME>. */
export const mcpSecretEnv = (server: string, name: string) => `ATLAS_MCP_SECRET_${server}_${name}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

export interface McpToolInfo { name: string; description: string; inputSchema: Record<string, unknown> }

export interface McpServerView {
  config: McpServerConfig;
  /** Tools from the last successful connection test (cached; agents see only these). */
  tools: McpToolInfo[];
  toolsAt: string | null;
  /** Secret names that have a stored value. */
  secretsSet: string[];
  status: 'idle' | 'connected' | 'error';
  error: string | null;
}
