// Git plumbing for the team record, with the same protections as every ATLAS git call: no repository hooks,
// fsmonitor or external programs, an argument array, a sanitized environment, and no prompts.
import { spawn } from 'node:child_process';
import { sanitizedEnv } from '@atlas/terminal';

export interface GitOut { code: number | null; stdout: string; stderr: string; raw: Buffer }

const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'protocol.file.allow=user',
  // Transport programs come from git itself, never from repository config.
  '-c', 'remote.origin.uploadpack=git-upload-pack', '-c', 'remote.origin.receivepack=git-receive-pack'];

export function gitx(cwd: string, args: string[], o: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<GitOut> {
  return new Promise((resolve) => {
    const pass: Record<string, string> = {};
    // The operator's SSH agent, for an ssh origin. Never a token: an https origin uses the operator's git credential
    // helpers, or ATLAS's GitHub token through `env`.
    for (const k of ['SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'GIT_SSH']) if (process.env[k]) pass[k] = process.env[k]!;
    const child = spawn('git', [...SAFE, ...args], {
      cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizedEnv({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'ATLAS', GIT_AUTHOR_EMAIL: 'atlas@localhost', GIT_COMMITTER_NAME: 'ATLAS', GIT_COMMITTER_EMAIL: 'atlas@localhost', ...pass, ...(o.env ?? {}) }),
    });
    const chunks: Buffer[] = [];
    let stderr = '', done = false;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, o.timeoutMs ?? 60_000);
    child.stdout.on('data', (c: Buffer) => { chunks.push(c); });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { if (stderr.length < 64_000) stderr += c; });
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); const raw = Buffer.concat(chunks); resolve({ code, stdout: raw.toString('utf8'), stderr, raw }); };
    child.on('error', (e) => { stderr += e.message; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(o.input ?? '');
  });
}

export async function gitOk(cwd: string, args: string[], o: Parameters<typeof gitx>[2] = {}): Promise<string> {
  const r = await gitx(cwd, args, o);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout;
}
