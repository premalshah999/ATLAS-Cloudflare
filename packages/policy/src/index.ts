// Policy engine (manual §21–23). Deterministic code decides; prompts and role Markdown cannot elevate rights.
import type { AgentRole, ApprovalMode, Approval, Capability, Risk } from '@atlas/contracts';

export type Decision = 'allow' | 'deny' | 'ask';

export interface PolicyDecision {
  decision: Decision;
  capability: Capability | null;
  risk: Risk;
  reason: string;
  /** The command needs network egress; the sandbox grants it only after an approval. */
  network?: boolean;
}

/** Capabilities granted per role. Anything absent is denied. */
export const ROLE_GRANTS: Record<AgentRole, readonly Capability[]> = {
  orchestrator: ['fs.read', 'agent.delegate'],
  coder: ['fs.read', 'fs.write', 'shell.safe', 'shell.privileged', 'agent.delegate', 'mcp.call', 'web.search', 'web.fetch', 'web.browse'],
  reviewer: ['fs.read', 'shell.safe', 'mcp.call', 'web.search', 'web.fetch', 'web.browse'],
  tester: ['fs.read', 'shell.safe', 'mcp.call', 'web.search', 'web.fetch', 'web.browse'],
  browser_qa: ['fs.read', 'browser.navigate'],
  desktop_operator: ['fs.read', 'desktop.input'],
  deployment_verifier: ['fs.read', 'browser.navigate'],
  security_reviewer: ['fs.read', 'shell.safe', 'web.search', 'web.fetch', 'web.browse'],
};

/**
 * Capabilities no agent may hold, whatever the role says. Staging deploys run only as an operator-approved
 * release stage; desktop input is granted to desktop_operator but the session itself needs the operator's
 * opt-in setting plus a single-use approval (enforced by the desktop service).
 */
const NEVER: ReadonlySet<Capability> = new Set(['deploy.production', 'secrets.use', 'deploy.staging']);

export interface ShellClass {
  capability: 'shell.safe' | 'shell.privileged' | null; risk: Risk; reason: string;
  /** Needs network egress inside the sandbox (granted only with approval). */ network?: boolean;
  /** Runs code from the project (scripts, test files, local tools): arbitrary code as the user when unsandboxed. */ runsProjectCode?: boolean;
}

const SAFE_EXEC = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'echo', 'pwd', 'diff', 'sort', 'uniq', 'tsc', 'node', 'true', 'false', 'test']);
const DENY_EXEC = new Set(['sudo', 'su', 'doas', 'mkfs', 'dd', 'shutdown', 'reboot', 'launchctl', 'systemctl', 'security', 'osascript',
  // Windows privilege, credential and system tools.
  'runas', 'reg', 'regedit', 'sc', 'schtasks', 'icacls', 'takeown', 'cmdkey', 'netsh', 'bcdedit', 'diskpart', 'format', 'wmic', 'vssadmin', 'checknetisolation']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'pwsh', 'powershell', 'cmd', 'wsl', 'wscript', 'cscript', 'mshta', 'rundll32']);
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat', 'ftp', 'telnet', 'bitsadmin', 'certutil', 'invoke-webrequest']);
const SAFE_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'branch', 'blame', 'grep']);
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/**
 * Arguments that turn a safe-listed program into one that executes another program or writes a file
 * (evolution backlog P1-1; the deny-by-default argument idea follows limboo's read-only classifier).
 * The sandbox stays the boundary; these keep the approval contract honest.
 */
const EXEC_ARGS: Record<string, RegExp[]> = {
  find: [/^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/],
  rg: [/^--pre(=|$)/, /^--pre-glob(=|$)/, /^(-z|--search-zip)$/],
  sort: [/^--compress-program(=|$)/, /^(-o|--output)(=|$)|^-o./],
  node: [/^(-r|--require|--import|--loader|--experimental-loader)(=|$)/],
  diff: [/^--to-file(=|$)/],
  tsc: [/^--(outFile|outDir|declarationDir)(=|$)/],
};
/**
 * GNU getopt_long and git's option parser accept any unambiguous prefix of a long option (`sort --compress-p=x`,
 * `git grep --open-files=x`). A long option is dangerous when it is a prefix of a dangerous name, even if it might
 * also abbreviate a harmless one (final audit finding).
 */
const LONG_DANGER: Record<string, string[]> = {
  sort: ['compress-program', 'output'],
  rg: ['pre', 'pre-glob', 'search-zip'],
  diff: ['to-file'],
  node: ['require', 'import', 'loader', 'experimental-loader'],
  tsc: ['outfile', 'outdir', 'declarationdir'],
  git: ['output', 'open-files-in-pager', 'ext-diff', 'textconv', 'exec', 'upload-pack', 'receive-pack', 'config-env', 'run'],
  'git-branch': ['delete', 'move', 'copy', 'force', 'set-upstream-to', 'unset-upstream', 'edit-description', 'track', 'no-track', 'create-reflog'],
};
export function abbreviatesDanger(prog: string, arg: string): boolean {
  if (!arg.startsWith('--') || arg === '--') return false;
  const name = arg.slice(2).split('=')[0].toLowerCase();
  return !!name && (LONG_DANGER[prog] ?? []).some((d) => d.startsWith(name));
}
const GIT_EXEC_ARG = /^(--output(=|$)|-O|--open-files-in-pager(=|$)|--ext-diff$|--textconv$|--exec(=|$)|--upload-pack(=|$)|--receive-pack(=|$)|--config-env(=|$)|--run(=|$)|-x$)/;
const GIT_BRANCH_WRITE = new Set(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '--track', '-t', '--no-track', '--create-reflog']);
const PKG_OVERRIDE = /^--(script-shell|userconfig|globalconfig|prefix|node-options|shell|config)(=|$)/;
const SAFE_PKG = new Set(['test', 't', 'run', 'exec', 'ls', 'list', 'why', 'outdated']);
/** Absolute paths of system program directories, which are not writable by agents. */
const SYSTEM_DIR = /^(\/usr\/(local\/)?s?bin\/|\/s?bin\/|[A-Za-z]:\\Windows\\System32\\)[^\\/]+$/i;
/** Safe-listed programs that execute project files (node runs them, tsc loads the project's compiler and config). */
const PROJECT_CODE_EXEC = new Set(['node', 'tsc']);

/** Classify a command given as an argument array. Never parses a shell string. */
export function classifyCommand(command: string, args: readonly string[]): ShellClass {
  // Windows: `npm.cmd`, `git.exe` and `C:\\…\\node.exe` are classified like `npm`, `git` and `node`.
  const exe = command.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  if (!exe || /[;&|`$<>]/.test(command)) return { capability: null, risk: 'high', reason: 'Executable name contains shell metacharacters' };
  if (DENY_EXEC.has(exe)) return { capability: null, risk: 'high', reason: `${exe} is never permitted for agents` };
  // `./ls`, `script/test`, `tools\\ls.cmd`: a path runs whatever file is there (an agent can write it), so the
  // safe list, which names system programs, never applies to it (P1-2 review finding).
  if (/[\\/]/.test(command) && !SYSTEM_DIR.test(command)) return { capability: 'shell.privileged', risk: 'elevated', reason: `${command} is a file path, not a system program`, runsProjectCode: true };
  if (SHELLS.has(exe)) return { capability: 'shell.privileged', risk: 'high', reason: 'Spawning a shell runs arbitrary code' };
  if (NETWORK.has(exe)) return { capability: 'shell.privileged', risk: 'elevated', reason: 'Command reaches the network', network: true };
  if (exe === 'rm' || exe === 'mv' || exe === 'chmod' || exe === 'chown' || exe === 'ln') {
    const recursive = args.some((a) => /^-[a-zA-Z]*[rRf]/.test(a));
    return { capability: 'shell.privileged', risk: recursive ? 'high' : 'elevated', reason: 'Command deletes, moves or changes permissions of files' };
  }
  if (exe === 'git') {
    const subIdx = args.findIndex((a) => !a.startsWith('-'));
    const sub = subIdx >= 0 ? args[subIdx] : '';
    // Options before the subcommand (-c key=value, --exec-path, --git-dir, -p/--paginate…) can make any git
    // command run a program, so a "read-only" subcommand is only safe without them.
    if (subIdx > 0 || (subIdx < 0 && args.length)) return { capability: 'shell.privileged', risk: 'elevated', reason: 'git global options can configure programs to run' };
    const rest = args.slice(subIdx + 1);
    const danger = rest.find((a) => GIT_EXEC_ARG.test(a) || abbreviatesDanger('git', a));
    if (SAFE_GIT.has(sub) && danger) return { capability: 'shell.privileged', risk: 'elevated', reason: `git ${sub} ${danger.split('=')[0]} can run a program or write a file` };
    if (sub === 'branch' && rest.some((a) => !a.startsWith('-') || GIT_BRANCH_WRITE.has(a.split('=')[0]) || abbreviatesDanger('git-branch', a))) return { capability: 'shell.privileged', risk: 'elevated', reason: 'git branch with these arguments creates, renames or deletes branches' };
    if (SAFE_GIT.has(sub)) return { capability: 'shell.safe', risk: 'low', reason: `git ${sub} is read-only` };
    return { capability: 'shell.privileged', risk: sub === 'push' || sub === 'reset' || sub === 'clean' ? 'high' : 'elevated', reason: `git ${sub || '(none)'} changes repository state`, network: ['push', 'fetch', 'pull', 'clone', 'ls-remote', 'submodule'].includes(sub) };
  }
  if (PKG.has(exe) || exe === 'npx') {
    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    // `exec` runs any binary (including a shell); config overrides can swap the script shell or npm config.
    const override = args.find((a) => PKG_OVERRIDE.test(a));
    if (override) return { capability: 'shell.privileged', risk: 'elevated', reason: `${exe} ${override.split('=')[0]} changes which programs run` };
    if (exe !== 'npx' && sub === 'exec') return { capability: 'shell.privileged', risk: 'elevated', reason: `${exe} exec runs an arbitrary program` };
    // Every package-manager command loads project configuration that can run code (yarnPath/plugins in .yarnrc*,
    // .pnpmfile.cjs, bunfig preload), even `ls` or `why`: all of them count as project code.
    if (exe !== 'npx' && SAFE_PKG.has(sub)) return { capability: 'shell.safe', risk: 'low', reason: ['ls', 'list', 'why', 'outdated'].includes(sub) ? `${exe} ${sub} reads the dependency tree (loads project configuration)` : `${exe} ${sub} runs a project script`, runsProjectCode: true };
    if (exe === 'npx' && ['vitest', 'jest', 'tsc', 'eslint', 'prettier', 'mocha'].includes(sub)) return { capability: 'shell.safe', risk: 'low', reason: `npx ${sub} runs a local dev tool`, runsProjectCode: true };
    return { capability: 'shell.privileged', risk: 'elevated', reason: `${exe} ${sub || ''} may install packages or run install scripts`.replace(/\s+/g, ' '), network: true };
  }
  if (exe === 'node' && args.some((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print')) {
    return { capability: 'shell.privileged', risk: 'elevated', reason: 'Inline code evaluation' };
  }
  if (SAFE_EXEC.has(exe)) {
    const danger = args.find((a) => (EXEC_ARGS[exe] ?? []).some((re) => re.test(a)) || abbreviatesDanger(exe, a));
    if (danger) return { capability: 'shell.privileged', risk: 'elevated', reason: `${exe} ${danger.split('=')[0]} can run a program or write outside the expected output` };
    return { capability: 'shell.safe', risk: 'low', reason: `${exe} is on the safe list`, runsProjectCode: PROJECT_CODE_EXEC.has(exe) };
  }
  return { capability: 'shell.privileged', risk: 'elevated', reason: `${exe} is not on the safe list` };
}

/** Interpreters that run a program given on standard input when no script file is named (or `-` is). */
const STDIN_INTERPRETERS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'php', 'tsx', 'ts-node']);
export function readsProgramFromStdin(command: string, args: readonly string[]): boolean {
  const exe = command.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (!STDIN_INTERPRETERS.has(exe)) return false;
  const positional = args.filter((a) => !a.startsWith('-') || a === '-');
  return positional.length === 0 || positional[0] === '-' || positional[0] === '/dev/stdin';
}

export const TOOL_CAPABILITY: Record<string, Capability | 'shell'> = {
  read_file: 'fs.read',
  list_files: 'fs.read',
  git_status: 'fs.read',
  write_file: 'fs.write',
  shell_exec: 'shell',
  // Background processes (ADR 0026): starting one is a command like shell_exec; reading, listing and stopping the
  // task's own processes run nothing new.
  process_start: 'shell',
  process_read: 'fs.read',
  process_list: 'fs.read',
  process_stop: 'shell.safe',
  run_tests: 'shell.safe',
  view_diff: 'fs.read',
  report_finding: 'fs.read',
  delegate: 'agent.delegate',
  browser_action: 'browser.navigate',
  desktop_action: 'desktop.input',
  staging_deploy: 'deploy.staging',
  inspect_logs: 'fs.read',
  // ATLAS's deterministic scanner over the worktree's change: reads only (ADR 0023).
  security_scan: 'fs.read',
  // ATLAS's own records of the mission, and its code graph of the repository (ADR 0024): read-only.
  mission_memory: 'fs.read',
  code_graph: 'fs.read',
  // Reviewed procedures from ATLAS's own skill library: read-only text, never repository content.
  load_skill: 'fs.read',
  read_skill_file: 'fs.read',
  // Tools of the operator's MCP servers (ADR 0018); which server and tool is checked before this.
  mcp_call: 'mcp.call',
  // The open web (ADR 0030): offered only when the operator turned web access on for the role.
  web_search: 'web.search',
  web_fetch: 'web.fetch',
  web_browse: 'web.browse',
};

export interface EvaluateInput {
  role: AgentRole;
  tool: string;
  args: Record<string, unknown>;
  mode: ApprovalMode;
  /**
   * Whether the command runs inside an OS sandbox. Without one (the operator's explicit opt-in), "safe" commands that
   * run project code are arbitrary code as the user, so they need approval (evolution P1-2).
   */
  sandboxed: boolean;
  /** mcp_call: the server's approval policy, once the server, role and tool were checked (ADR 0018). */
  mcpApproval?: 'ask' | 'allow';
  /**
   * web_fetch and web_browse: whether the site is already known to this task (found by its searches, on the
   * operator's allowed sites, or approved before). Unknown sites need a person (ADR 0030).
   */
  webKnown?: boolean;
  /** web_search, web_fetch, web_browse: the query or URL contains a value registered as a secret. */
  webLeak?: boolean;
}

/** Evaluate a proposed tool call before execution, independent of any prompt. Unknown ⇒ deny. */
export function evaluate({ role, tool, args, mode, sandboxed, mcpApproval, webKnown, webLeak }: EvaluateInput): PolicyDecision {
  const mapped = TOOL_CAPABILITY[tool];
  if (!mapped) return { decision: 'deny', capability: null, risk: 'high', reason: `Unknown tool "${tool}"` };

  let capability: Capability;
  let risk: Risk = 'low';
  let why = '';
  let network = false;
  let projectCode = tool === 'run_tests';
  if (mapped === 'shell') {
    const command = typeof args.command === 'string' ? args.command : '';
    const argv = Array.isArray(args.args) ? args.args.map(String) : [];
    if (!command) return { decision: 'deny', capability: null, risk: 'high', reason: `${tool} requires a command` };
    const c = classifyCommand(command, argv);
    if (!c.capability) return { decision: 'deny', capability: null, risk: c.risk, reason: c.reason };
    capability = c.capability; risk = c.risk; why = c.reason; network = !!c.network; projectCode = !!c.runsProjectCode;
    // A program read from standard input is inline code, like `node -e`: it needs a person (ADR 0026 review).
    if (typeof args.stdin === 'string' && readsProgramFromStdin(command, argv) && capability === 'shell.safe') {
      capability = 'shell.privileged'; risk = 'elevated'; why = 'Runs code passed on standard input';
    }
    // A served process gets the network so loopback reaches it; that is egress too, so a person approves it.
    if (tool === 'process_start' && args.serve === true) {
      network = true;
      if (capability === 'shell.safe') { capability = 'shell.privileged'; risk = 'elevated'; }
      why = `${why}; serving on loopback gives it network access`;
    }
  } else {
    capability = mapped;
    if (capability === 'fs.write') risk = 'low';
  }

  if (NEVER.has(capability)) return { decision: 'deny', capability, risk: 'high', reason: `${capability} is disabled in this release` };
  if (!ROLE_GRANTS[role].includes(capability)) return { decision: 'deny', capability, risk, reason: `Role ${role} does not hold ${capability}` };

  if (capability === 'mcp.call') {
    if (!mcpApproval) return { decision: 'deny', capability, risk: 'high', reason: 'No MCP server offers this tool to this role' };
    // An MCP tool can change things outside ATLAS; the gate cannot know which ones do. Plan-only missions always ask.
    if (mcpApproval === 'allow' && mode !== 'plan_only') return { decision: 'allow', capability, risk: 'elevated', reason: 'The operator trusts this MCP server' };
    return { decision: 'ask', capability, risk: 'elevated', reason: mode === 'plan_only' ? 'Plan-only mission: calls to external services need approval' : 'Calls an external service the operator connected' };
  }
  if (capability === 'web.search' || capability === 'web.fetch' || capability === 'web.browse') {
    // A query or URL is data leaving the machine: one that carries a known secret never goes out.
    if (webLeak) return { decision: 'deny', capability, risk: 'high', reason: 'The request contains a secret; it would leave the machine' };
    if (capability === 'web.search') return { decision: 'allow', capability, risk: 'low', reason: 'Searches through the operator\'s search accounts' };
    if (webKnown === false) return { decision: 'ask', capability, risk: 'elevated', reason: 'Opens a site that is not in this task\'s search results or the operator\'s allowed sites' };
    return { decision: 'allow', capability, risk: 'low', reason: 'Reads a site this task found or the operator allows' };
  }
  if (mode === 'plan_only' && (capability === 'fs.write' || capability === 'shell.privileged')) {
    return { decision: 'deny', capability, risk, reason: 'Mission runs in plan-only mode: no writes or privileged commands' };
  }
  if (capability === 'shell.privileged') return { decision: 'ask', capability, risk, reason: why || 'Privileged command', network };
  if (!sandboxed && projectCode) return { decision: 'ask', capability, risk: 'elevated', reason: `No OS sandbox: ${why || 'the project test command'} runs project code as your user` };
  if (capability === 'fs.write' && mode === 'ask_all_writes') return { decision: 'ask', capability, risk, reason: 'Approval mode requires approval for every write' };
  return { decision: 'allow', capability, risk, reason: why || `${capability} granted to ${role}` };
}

/** An approval is usable only once, only while pending-then-approved, and only before it expires. */
export function approvalUsable(a: Pick<Approval, 'status' | 'expiresAt'>, now = new Date()): { ok: boolean; reason: string } {
  if (a.status === 'denied') return { ok: false, reason: 'Operator denied the request' };
  if (a.status === 'expired' || new Date(a.expiresAt) <= now) return { ok: false, reason: 'Approval expired before a decision' };
  if (a.status !== 'approved') return { ok: false, reason: 'Approval is still pending' };
  return { ok: true, reason: 'Approved once by operator' };
}
