// ADR 0016 experiment (Windows only, operator-approved): which restricted-token configuration lets Node's piped child
// processes work while keeping the sandbox properties ATLAS needs? Each variant runs one probe and the results are
// printed as a table. This test asserts nothing about the outcome; it gathers the evidence for the decision, and the
// chosen mode must then pass the full sandbox suite before ATLAS uses it.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as win from '../src/win/appcontainer';
import { tmpDir } from '../../../tests/helpers';

const PROBE = String.raw`
const fs = require('fs'), net = require('net'), cp = require('child_process');
const [home, outside, pub, otherRoot] = process.argv.slice(2);
const out = {};
const tryDo = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = 'ERR ' + (e.code || e.message); } };
tryDo('readHome', () => 'READ ' + fs.readFileSync(home, 'utf8'));
tryDo('readOutside', () => 'READ ' + fs.readFileSync(outside + '/canary.txt', 'utf8'));
tryDo('readOtherTask', () => 'READ ' + fs.readFileSync(otherRoot + '/secret.txt', 'utf8'));
tryDo('writeRoot', () => { fs.writeFileSync('w.txt', 'x'); return 'WROTE'; });
tryDo('writeOutside', () => { fs.writeFileSync(outside + '/x.txt', 'x'); return 'WROTE'; });
tryDo('writePublic', () => { fs.writeFileSync(pub, 'x'); fs.unlinkSync(pub); return 'WROTE'; });
tryDo('childPipe', () => { const r = cp.spawnSync(process.execPath, ['-e', 'console.log(7)'], { stdio: 'pipe', timeout: 5000 }); return r.error ? 'ERR ' + r.error.code : 'exit ' + r.status + ' out ' + String(r.stdout).trim(); });
tryDo('childIgnore', () => { const r = cp.spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore', timeout: 5000 }); return r.error ? 'ERR ' + r.error.code : 'exit ' + r.status; });
const b = String.fromCharCode(92);
const pipeName = b + b + '.' + b + 'pipe' + b + 'atlas-r-' + process.pid;
const s = net.createServer();
s.on('error', (e) => { out.globalPipe = 'ERR ' + e.code; netTest(); });
s.listen(pipeName, () => { out.globalPipe = 'ok'; s.close(); netTest(); });
function netTest() {
  const c = net.connect({ host: '140.82.112.3', port: 443 });
  const t = setTimeout(() => { out.network = 'timeout'; c.destroy(); done(); }, 4000);
  c.on('connect', () => { clearTimeout(t); out.network = 'CONNECTED'; c.destroy(); done(); });
  c.on('error', (e) => { clearTimeout(t); out.network = 'ERR ' + e.code; done(); });
}
function done() { console.log('RESULT ' + JSON.stringify(out)); process.exit(0); }
`;

describe.skipIf(process.platform !== 'win32')('ADR 0016: restricted-token variants (diagnostic)', () => {
  it('reports pipes, network and file access per variant', () => {
    const helper = win.ensureHelper();
    const root = tmpDir();
    const outside = tmpDir();
    writeFileSync(path.join(outside, 'canary.txt'), 'CANARY-SECRET');
    const homeCanary = path.join(os.homedir(), `.atlas-rcanary-${process.pid}`);
    writeFileSync(homeCanary, 'HOME-CANARY');
    writeFileSync(path.join(root, 'probe.cjs'), PROBE);
    const logon = execFileSync(helper, ['logonsid'], { encoding: 'utf8' }).trim();
    // Round 1 (CI run 38156630914): every variant with the capability SID S-1-15-3-… in its restricting list failed
    // in CreateRestrictedToken with error 87. Round 2 uses a plain per-root SID in the resource-manager authority
    // (S-1-9-…) and keeps one capability-SID variant to confirm the cause.
    const custom = `S-1-9-1-${[1, 2, 3, 4].map((i) => (process.pid * 7919 + i * 104729) % 4294967295).join('-')}`;
    const capSid = win.capabilitySid(`atlasRoot.${process.pid}`);
    // The root: writable for the logon SID (normal check) and this sandbox's own SID (restricting check), low label.
    // icacls only takes SIDs it can map to a name (round 2 refused S-1-9-…); Set-Acl takes any SecurityIdentifier.
    const grantAny = (target: string, sid: string, rights: string, inherit: boolean) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$a = Get-Acl -LiteralPath '${target}'; $r = New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.SecurityIdentifier]'${sid}', '${rights}', '${inherit ? 'ContainerInherit,ObjectInherit' : 'None'}', 'None', 'Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath '${target}' -AclObject $a`], { stdio: 'pipe' });
    for (const sid of [logon, custom, capSid]) grantAny(root, sid, 'Modify', true);
    // Another task's root, granted like ours but to a different own SID: a sandbox must not read it.
    const otherRoot = tmpDir();
    writeFileSync(path.join(otherRoot, 'secret.txt'), 'OTHER-TASK');
    const otherSid = custom.replace(/-(\d+)$/, (_m, n) => `-${Number(n) + 1}`);
    for (const sid of [logon, otherSid]) grantAny(otherRoot, sid, 'Modify', true);
    execFileSync('icacls', [root, '/setintegritylevel', '(OI)(CI)low', '/C', '/Q'], { stdio: 'pipe' });
    // Round 1, variant E: Node started under the restricted token, then failed realpath (lstat EPERM) on an ancestor
    // in the user profile. Read-attributes only (no listing, not inherited) on each ancestor lets it resolve paths.
    for (const sid of [logon, custom]) {
      for (let d = path.dirname(root); path.dirname(d) !== d; d = path.dirname(d)) grantAny(d, sid, 'ReadAttributes', false);
    }
    const pub = path.join(process.env.PUBLIC ?? 'C:\\Users\\Public', `atlas-r-${process.pid}.txt`);
    // Round 3 (CI run 38158723502): C and D could not start Node (no Everyone in the restricting list); G confirmed
    // capability SIDs are rejected as restricting SIDs. H drops the logon SID, which every task's root is granted,
    // so the restricting check can only pass through the task's own SID.
    const variants: [string, string, boolean][] = [
      ['H everyone+users+authusers+own (no logon), low', `everyone,users,authusers,${custom}`, true],
      ['A everyone+users+authusers+logon+own, low', `everyone,users,authusers,logon,${custom}`, true],
      ['B everyone+users+authusers+logon+own, medium', `everyone,users,authusers,logon,${custom}`, false],
      ['C users+logon+own, low', `users,logon,${custom}`, true],
      ['D logon+restricted+own, low', `logon,restricted,${custom}`, true],
      ['E no restricting SIDs, low', '', true],
      ['F everyone+users+logon (no own SID), low', 'everyone,users,logon', true],
      ['G capability SID only, low (round-1 cause?)', capSid, true],
    ];
    const report: string[] = [`logon SID ${logon}; own SID ${custom}`];
    try {
      for (const [label, sids, low] of variants) {
        const cmdline = `${win.quoteArg(process.execPath)} probe.cjs ${win.quoteArg(homeCanary)} ${win.quoteArg(outside)} ${win.quoteArg(pub)} ${win.quoteArg(otherRoot)}`;
        const r = spawnSync(helper, ['run', '-', '--restricted', sids || ',', ...(low ? ['--low'] : []), '--cmdline', cmdline], { cwd: root, encoding: 'utf8', timeout: 40_000 });
        const line = (r.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT ')) ?? '';
        report.push(`--- ${label}: exit ${r.status}${r.error ? ' ' + (r.error as NodeJS.ErrnoException).code : ''}\n${line || `(no result) stdout: ${(r.stdout ?? '').slice(0, 300)} stderr: ${(r.stderr ?? '').slice(0, 300)}`}`);
      }
      // Round 4 (CI run 38161018218): piped children still failed with EPERM after the default-DACL change. The helper
      // replays libuv's Win32 steps under the restricted token and prints each result.
      // The helper lives in the user's profile, which the restricted token cannot read: run a copy inside the root.
      const ptExe = path.join(root, 'pt.exe');
      copyFileSync(helper, ptExe);
      for (const [label, sids] of [['A', `everyone,users,authusers,logon,${custom}`], ['H', `everyone,users,authusers,${custom}`]] as const) {
        const r = spawnSync(helper, ['run', '-', '--restricted', sids, '--low', '--cmdline', `${win.quoteArg(ptExe)} pipetest`], { cwd: root, encoding: 'utf8', timeout: 30_000 });
        report.push(`--- pipetest ${label}: exit ${r.status}\n${(r.stdout ?? '').trim()}\n${(r.stderr ?? '').trim().slice(0, 300)}`);
      }
    } finally {
      rmSync(homeCanary, { force: true });
    }
    console.log(`[restricted]\n${report.join('\n')}`);
    expect(report.length).toBe(variants.length + 3);
  }, 300_000);
});
