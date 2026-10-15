// Manual §23 acceptance on every platform's sandbox (bubblewrap, macOS Seatbelt, Windows AppContainer):
// a malicious command cannot read a canary credential or a protected path, cannot write outside its root,
// has no network unless granted, and dies with its whole tree on cancellation. Probes are Node scripts so the
// same assertions run everywhere; on failure the sandboxed output is part of the message.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSandbox, isAlive, run, sanitizedEnv } from '../src';
import { sampleRepo, tmpDir } from '../../../tests/helpers';

const info = detectSandbox();
const d = info.kind !== 'none' ? describe : describe.skip;

/** Run a Node probe script inside the sandbox rooted at `root`. */
async function probe(root: string, js: string, o: { network?: boolean; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}) {
  writeFileSync(path.join(root, 'probe.cjs'), js);
  return run({ command: 'node', args: ['probe.cjs'], cwd: root, timeoutMs: o.timeoutMs ?? 30_000, signal: o.signal, env: sanitizedEnv(o.env ?? {}), sandbox: { root, writable: true, network: !!o.network } });
}
/** A node -e script that tries to listen on \\<parts joined by \>pid and prints `<tag> ok` or `<tag> <code>` and the path. */
const pipeProbe = (tag: string, parts: string[]) =>
  `const b = String.fromCharCode(92); const p = b + b + ${JSON.stringify(parts)}.join(b) + process.pid; const s = require('net').createServer(); s.on('error', (e) => { console.log('${tag}', e.code, p); process.exit(0); }); s.listen(p, () => { console.log('${tag} ok', p); s.close(); });`;
const tryRead = (p: string) => `try { console.log('READ ' + require('fs').readFileSync(${JSON.stringify(p)}, 'utf8')); } catch (e) { console.log('DENIED ' + e.code); }`;

d(`OS sandbox (${info.kind})`, () => {
  it('runs a trivial command', async () => {
    const r = await probe(tmpDir(), "console.log('alive', process.platform)");
    expect(r.spawnError, r.output).toBeNull();
    expect(r.output, r.output).toContain('alive');
    expect(r.exitCode, r.output).toBe(0);
  });

  it('hides canary credentials in the home directory and in other directories', async () => {
    const root = tmpDir();
    const outside = tmpDir();
    writeFileSync(path.join(outside, 'canary.txt'), 'CANARY-SECRET');
    const homeCanary = path.join(os.homedir(), `.atlas-canary-${process.pid}`);
    writeFileSync(homeCanary, 'HOME-CANARY');
    try {
      const r = await probe(root, [tryRead(path.join(outside, 'canary.txt')), tryRead(homeCanary), "console.log('HOME=' + require('os').homedir())"].join('\n'));
      expect(r.output, r.output).not.toContain('CANARY-SECRET');
      expect(r.output, r.output).not.toContain('HOME-CANARY');
      expect(r.output.match(/DENIED/g)?.length, r.output).toBe(2);
      expect(r.output, r.output).not.toContain(`HOME=${os.homedir()}\n`);
    } finally { rmSync(homeCanary, { force: true }); }
  });

  it('does not inherit credentials from the environment', async () => {
    process.env.ANTHROPIC_API_KEY_TEST_CANARY = 'sk-ant-canary-env';
    try {
      const r = await probe(tmpDir(), 'console.log(JSON.stringify(process.env))');
      expect(r.output).not.toContain('sk-ant-canary-env');
    } finally { delete process.env.ANTHROPIC_API_KEY_TEST_CANARY; }
  });

  it('writes only inside its root', async () => {
    const root = tmpDir();
    const outside = tmpDir();
    const sys = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', `atlas-escape-${process.pid}.txt`) : '/usr/atlas-escape.txt';
    const r = await probe(root, `const fs = require('fs');
fs.writeFileSync('inside.txt', 'ok');
for (const p of [${JSON.stringify(path.join(outside, 'escape.txt'))}, ${JSON.stringify(sys)}]) { try { fs.writeFileSync(p, 'bad'); console.log('WROTE ' + p); } catch (e) { console.log('DENIED ' + e.code); } }
console.log('done');`);
    expect(existsSync(path.join(root, 'inside.txt')), r.output).toBe(true);
    expect(existsSync(path.join(outside, 'escape.txt')), r.output).toBe(false);
    expect(r.output, r.output).not.toContain('WROTE');
    expect(r.output, r.output).toContain('done');
  });

  it('has no network unless granted', async () => {
    const js = "require('net').connect(53, '1.1.1.1').on('connect', () => { console.log('NET-UP'); process.exit(0); }).on('error', (e) => { console.log('NET-DOWN ' + e.code); process.exit(0); }); setTimeout(() => { console.log('NET-DOWN timeout'); process.exit(0); }, 5000);";
    const off = await probe(tmpDir(), js);
    expect(off.output, off.output).toMatch(/NET-DOWN/);
  });

  // CI hang (two loaded Linux runs): bwrap killed during namespace setup left its sandboxed child (own session)
  // alive, holding our pipes, so run() never resolved. Under 4 busy cores this hung 118 of 150 times before the fix.
  it.skipIf(info.kind !== 'bwrap')('cancelling during sandbox setup never hangs and leaves nothing running', async () => {
    const root = tmpDir();
    const marker = `atlas-early-kill-${process.pid}`;
    for (let i = 0; i < 30; i++) {
      const ac = new AbortController();
      const p = run({ command: 'node', args: ['-e', 'setInterval(()=>{},1000)', marker], cwd: root, timeoutMs: 60_000, signal: ac.signal, env: sanitizedEnv(), sandbox: { root, writable: true, network: false }, onStart: () => setTimeout(() => ac.abort(), i % 10) });
      const r = await Promise.race([p.then(() => 'ok'), new Promise((res) => setTimeout(() => res('hang'), 10_000))]);
      expect(r, `iteration ${i}`).toBe('ok');
    }
    await new Promise((r) => setTimeout(r, 2000));
    const alive = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { return readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(marker); } catch { return false; } });
    expect(alive).toEqual([]);
  }, 300_000);

  it.skipIf(process.platform !== 'linux')('cannot see host processes (Linux PID namespace)', async () => {
    const r = await probe(tmpDir(), "console.log(require('fs').readdirSync('/proc').filter((x) => /^\\d+$/.test(x)).length)");
    expect(Number(r.output.trim()), r.output).toBeLessThan(10);
  });

  // Windows bisection for package-manager shims: cmd.exe itself, then the npm.cmd shim, inside the AppContainer.
  it.skipIf(process.platform !== 'win32')('windows: cmd.exe and the npm shim run inside the AppContainer', async () => {
    const root = tmpDir();
    const sb = { root, writable: true, network: false };
    const nodeDir = path.dirname(process.execPath);
    const steps: [string, string, string[]][] = [
      ['env', 'cmd.exe', ['/d', '/c', 'echo CMD-OK & cd']],
      ['list node dir', 'cmd.exe', ['/d', '/c', 'dir', '/b', nodeDir]],
      ['node by path', path.join(nodeDir, 'node.exe'), ['--version']],
      ['node reads a file in its dir', path.join(nodeDir, 'node.exe'), ['-e', `require('fs').readdirSync(${JSON.stringify(nodeDir)}); console.log('READ-OK')`]],
      // Child processes from inside the container: piped stdio needs a named pipe (libuv), inherited stdio does not.
      ['child, stdio pipe', path.join(nodeDir, 'node.exe'), ['-e', "const r = require('child_process').spawnSync(process.execPath, ['-e', 'console.log(1)'], { stdio: 'pipe' }); console.log('PIPE', r.status, r.error && r.error.code, String(r.stdout || '').trim())"]],
      ['child, stdio ignore', path.join(nodeDir, 'node.exe'), ['-e', "const t = Date.now(); const r = require('child_process').spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore', timeout: 5000 }); console.log('IGNORE', r.status, r.error && r.error.code, Date.now() - t, 'ms')"]],
      ['child, stdio inherit', path.join(nodeDir, 'node.exe'), ['-e', "const r = require('child_process').spawnSync(process.execPath, ['-e', 'console.log(2)'], { stdio: 'inherit' }); console.log('INHERIT', r.status, r.error && r.error.code)"]],
      // Pipe names are built with fromCharCode(92): an escaped backslash in this string nested in node -e was wrong once
      // (CI run 38127174519 probed "\\.pipeatlas-probe", not a pipe).
      ['named pipe server', path.join(nodeDir, 'node.exe'), ['-e', pipeProbe('NAMEDPIPE', ['.', 'pipe', 'atlas-probe-'])]],
      // AppContainers may create pipes only under LOCAL\ (their own namespace); libuv names its stdio pipes \\.\pipe\uv\….
      ['named pipe server, LOCAL namespace', path.join(nodeDir, 'node.exe'), ['-e', pipeProbe('LOCALPIPE', ['.', 'pipe', 'LOCAL', 'atlas-probe-'])]],
      ['npm', 'npm', ['--version']],
    ];
    const report: string[] = [];
    let last = '';
    for (const [label, cmd, args] of steps) {
      // Short per-step limit, printed at once: a hang in one step must not hide the others (CI run 38122950551).
      const t0 = Date.now();
      const r = await run({ command: cmd, args, cwd: root, timeoutMs: 8_000, sandbox: sb });
      last = r.output;
      const line = `--- ${label}: exit ${r.exitCode} ${r.spawnError ?? ''} ${r.timedOut ? 'TIMED OUT ' : ''}(${Date.now() - t0} ms)\n${r.output.trim()}`;
      report.push(line);
      console.log(`[bisect] ${line}`);
    }
    const { execFileSync } = await import('node:child_process');
    const win = await import('../src/win/appcontainer');
    let acl = '';
    try { acl = execFileSync('icacls', [nodeDir], { encoding: 'utf8' }); } catch (e) { acl = String(e); }
    report.push(`--- toolchain capability ${win.toolchainCapabilitySid()}\n--- icacls ${nodeDir}\n${acl}\n--- grant failures\n${win.grantFailures.join('\n') || '(none)'}`);
    expect(last, report.join('\n')).toMatch(/\d+\.\d+\.\d+/);
    // Always print the report: the child-process lines are the evidence for the next Windows step.
    console.log(report.join('\n'));
  }, 180_000);

  it('runs a real project test suite inside the sandbox', async () => {
    const repo = sampleRepo();
    const r = await run({ command: 'npm', args: ['test'], cwd: repo, timeoutMs: 120_000, sandbox: { root: repo, writable: true, network: false } });
    expect(r.output, r.output).toMatch(/[#ℹ] fail 5/);
    expect(r.exitCode, r.output).toBe(1);
  });

  it('cancellation kills every process inside the sandbox', async () => {
    const root = tmpDir();
    const ac = new AbortController();
    const pidFile = path.join(root, 'pids.txt');
    const tag = `atlas-sb-${process.pid}-${Date.now()}`;
    const p = probe(root, `const { spawn } = require('child_process');
const kids = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '${tag}'], { stdio: 'ignore' }));
require('fs').writeFileSync('pids.txt', [process.pid, ...kids.map((k) => k.pid)].join(','));
setInterval(() => {}, 1000);`, { signal: ac.signal, timeoutMs: 60_000 });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const pids = readFileSync(pidFile, 'utf8').split(',').map(Number);
    expect(pids.length).toBe(3);
    ac.abort();
    const r = await p;
    expect(r.cancelled).toBe(true);
    if (process.platform === 'linux') {
      // PIDs inside bubblewrap are namespaced; find the children on the host by their unique tag instead.
      const { execFileSync } = await import('node:child_process');
      const count = () => { try { return execFileSync('pgrep', ['-f', `setInterval.*${tag}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).filter((pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0].endsWith('node'); } catch { return false; } }).length; } catch { return 0; } };
      for (let i = 0; i < 60 && count() > 0; i++) await new Promise((res) => setTimeout(res, 50));
      expect(count()).toBe(0);
    } else {
      let alive = pids;
      for (let i = 0; i < 60 && alive.length; i++) { await new Promise((res) => setTimeout(res, 50)); alive = pids.filter((x) => isAlive(x)); }
      expect(alive).toEqual([]);
    }
  });

  // ADR 0031. Windows has no deny-write ACE for these yet (documented TODO); the daemon's pinned git covers it there.
  it.skipIf(process.platform === 'win32')('protected paths stay read-only inside the writable root: the .git pointer and the admin dir', async () => {
    const root = tmpDir();
    const admin = tmpDir('atlas-admin-');
    writeFileSync(path.join(root, '.git'), `gitdir: ${admin}\n`);
    writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/atlas/t\n');
    writeFileSync(path.join(root, 'probe.cjs'), `const fs = require('fs');
const t = (what, f) => { try { f(); console.log(what + ' WROTE'); } catch (e) { console.log(what + ' DENIED ' + e.code); } };
t('pointer', () => fs.writeFileSync('.git', 'gitdir: /tmp/evil'));
t('pointer-rename', () => fs.renameSync('.git', 'moved'));
t('pointer-unlink', () => fs.unlinkSync('.git'));
t('config.worktree', () => fs.writeFileSync(${JSON.stringify(path.join(admin, 'config.worktree'))}, '[filter "x"]'));
t('head', () => fs.writeFileSync(${JSON.stringify(path.join(admin, 'HEAD'))}, 'ref: refs/heads/main'));
t('work', () => fs.writeFileSync('work.txt', 'ok'));`);
    const r = await run({ command: 'node', args: ['probe.cjs'], cwd: root, timeoutMs: 30_000, env: sanitizedEnv(), sandbox: { root, writable: true, network: false, readOnly: [admin], protect: [path.join(root, '.git'), admin] } });
    expect(r.exitCode, r.output).toBe(0);
    const denied = info.kind === 'bwrap' ? /DENIED (EROFS|EBUSY)/ : /DENIED (EPERM|EACCES)/;
    for (const what of ['pointer', 'pointer-rename', 'pointer-unlink', 'config.worktree', 'head']) expect(r.output, r.output).toMatch(new RegExp(`^${what} ${denied.source}`, 'm'));
    expect(r.output, r.output).toContain('work WROTE');
    expect(readFileSync(path.join(root, '.git'), 'utf8')).toBe(`gitdir: ${admin}\n`);
    expect(existsSync(path.join(admin, 'config.worktree'))).toBe(false);
    if (info.kind === 'bwrap') expect(r.output).toMatch(/^pointer DENIED EROFS/m);
  });

  it('fails closed when the sandbox is disabled', async () => {
    process.env.ATLAS_SANDBOX = 'none';
    detectSandbox(true);
    try {
      const r = await probe(tmpDir(), "console.log('should-not-run')");
      expect(r.spawnError).toMatch(/No OS sandbox/);
      expect(r.output).toBe('');
    } finally { delete process.env.ATLAS_SANDBOX; detectSandbox(true); }
  });
});

it('reports sandbox availability for this platform', () => {
  const expected = { linux: ['bwrap', 'none'], darwin: ['sandbox-exec', 'none'], win32: ['windows-account', 'appcontainer', 'none'] }[process.platform as 'linux'] ?? ['none'];
  expect(expected).toContain(info.kind);
  // CI runs on machines where the sandbox must work; a silent fallback to "none" would hide a regression.
  if (process.env.CI) expect(info.kind, info.detail).not.toBe('none');
  // Windows CI sets up the sandbox accounts first (ADR 0020): a silent fall back to the AppContainer is a regression.
  if (process.env.ATLAS_EXPECT_WINDOWS_ACCOUNTS) expect(info.kind, info.detail).toBe('windows-account');
  mkdirSync(tmpDir(), { recursive: true });
});

// Windows (P0-4 review finding 6): the helper's Job Object must not outlive the daemon. `--parent` names the
// process to watch; when it dies, by a crash or otherwise, everything in the job is terminated.
it.skipIf(process.platform !== 'win32')('windows: the sandbox helper ends its job when the daemon dies', async () => {
  const { spawn } = await import('node:child_process');
  const { ensureHelper } = await import('../src/win/appcontainer');
  const fakeDaemon = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const helper = spawn(ensureHelper(), ['run', '-', '--parent', String(fakeDaemon.pid), '--cmdline', `"${process.execPath}" -e "setInterval(()=>{},1000)"`], { stdio: 'ignore' });
  const exited = new Promise<number | null>((r) => helper.on('exit', (c) => r(c)));
  await new Promise((r) => setTimeout(r, 1500));
  expect(helper.exitCode).toBeNull(); // still running while the daemon lives
  fakeDaemon.kill('SIGKILL');
  const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 10_000))]);
  expect(code).toBe(137);
}, 30_000);
