// Context packaging (manual §17). Each attempt gets a bundle built from recorded sources, stored as an
// artifact with the versions it came from. Retrieved text never overrides policy: it is presented as data.
import { createHash } from 'node:crypto';
import { git } from '@atlas/workspace';

export interface ContextSource { kind: string; ref: string; sha256: string }
export interface ContextBundle { text: string; sources: ContextSource[] }

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} characters omitted]` : s);

export async function repoMap(worktree: string, maxFiles = 400): Promise<string> {
  const r = await git(worktree, ['ls-files']);
  const files = r.code === 0 ? r.out.split('\n').filter(Boolean) : [];
  const shown = files.slice(0, maxFiles);
  return `${shown.join('\n')}${files.length > maxFiles ? `\n… ${files.length - maxFiles} more files` : ''}`;
}

export async function buildContext(input: {
  worktree: string;
  base: string;
  role: string;
  objective: string;
  constraints: string;
  task: { key: string; title: string; acceptance: string[] };
  planSummary: string;
  facts: string | null;
  decisions: string[];
  includeDiff: boolean;
  /** Index of reviewed skills (names and descriptions) the agent may load. */
  skills?: string;
  /** Index of MCP tools the agent may call (ADR 0018). */
  mcp?: string;
  /** How to use the web tools (ADR 0030). */
  web?: string;
  /** Overview of the code graph, when it is already built (never waited for). */
  graph?: string;
}): Promise<ContextBundle> {
  const sources: ContextSource[] = [];
  const parts: string[] = [];
  const add = (kind: string, ref: string, title: string, body: string) => {
    if (!body.trim()) return;
    sources.push({ kind, ref, sha256: sha(body) });
    parts.push(`## ${title}\n${body}`);
  };
  add('objective', 'mission', 'Objective', input.objective);
  add('constraints', 'mission', 'Constraints', input.constraints);
  add('task', input.task.key, `Task ${input.task.key}: ${input.task.title}`, input.task.acceptance.map((a) => `- ${a}`).join('\n'));
  add('plan', 'approved-plan', 'Approved plan', input.planSummary);
  if (input.facts) add('facts', 'project-facts', 'Project facts (maintained by the operator)', cap(input.facts, 8000));
  if (input.skills) add('skills', 'skill-library', 'Skills (reviewed procedures you can load)', input.skills);
  if (input.mcp) add('mcp', 'mcp-servers', 'MCP tools (external services)', input.mcp);
  if (input.web) add('web', 'web-access', 'The web', input.web);
  if (input.decisions.length) add('decisions', 'event-log', 'Recent decisions', input.decisions.slice(-12).join('\n'));
  if (input.graph) add('code-graph', `${input.base.slice(0, 12)}`, 'Code graph (query details with code_graph)', input.graph);
  add('repo-map', `${input.base.slice(0, 12)}`, 'Repository files', await repoMap(input.worktree));
  if (input.includeDiff) {
    const stat = await git(input.worktree, ['diff', '--stat', input.base]);
    const diff = await git(input.worktree, ['diff', '--no-color', '--no-ext-diff', input.base]);
    add('diff', input.base.slice(0, 12), 'Changes under review (diff against the mission base)', cap(`${stat.out}\n\n${diff.out}`, 60_000));
  }
  return { text: parts.join('\n\n'), sources };
}
