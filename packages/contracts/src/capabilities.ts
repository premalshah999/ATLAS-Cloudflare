// Capabilities and tools (manual §21–22). Unknown capabilities are denied by default.
import { z } from 'zod';

export const Capability = z.enum([
  'fs.read', 'fs.write', 'shell.safe', 'shell.privileged', 'browser.navigate', 'desktop.input',
  'deploy.staging', 'deploy.production', 'secrets.use', 'agent.delegate', 'mcp.call',
  // The open web through ATLAS (ADR 0030): search, read a page, browse.
  'web.search', 'web.fetch', 'web.browse',
]);
export type Capability = z.infer<typeof Capability>;

export const ToolName = z.enum(['read_file', 'list_files', 'write_file', 'shell_exec', 'git_status', 'run_tests', 'view_diff', 'report_finding', 'delegate', 'browser_action', 'desktop_action', 'staging_deploy', 'inspect_logs', 'mcp_call', 'security_scan', 'mission_memory', 'code_graph', 'process_start', 'process_read', 'process_stop', 'process_list', 'web_search', 'web_fetch', 'web_browse']);
export type ToolName = z.infer<typeof ToolName>;

export type Risk = 'low' | 'elevated' | 'high';

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  /** Text returned to the agent. */
  output: string;
  exitCode: number | null;
  artifactIds: string[];
  error: ToolErrorKind | null;
}

export const ToolErrorKind = z.enum(['policy_denied', 'approval_denied', 'approval_expired', 'invalid_args', 'path_escape', 'timeout', 'process_failed', 'cancelled', 'unknown_tool', 'sandbox_unavailable']);
export type ToolErrorKind = z.infer<typeof ToolErrorKind>;
