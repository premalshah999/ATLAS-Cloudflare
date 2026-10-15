// Manual §43: an idle ATLAS daemon makes no outbound network requests. Every socket, DNS lookup and
// fetch in this process is recorded while the daemon starts, answers the UI's idle-time queries and sits idle.
import dns from 'node:dns';
import net from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { tmpDir } from '../../../tests/helpers';
import { DaemonService } from '../src/service';

const attempts: string[] = [];
const restore: (() => void)[] = [];
const loopback = (h: unknown) => typeof h !== 'string' || h === '' || h === 'localhost' || /^127\.|^::1$|^\[::1\]$/.test(h);

beforeAll(() => {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    // net.connect() passes its normalized [options, callback] pair as the first argument.
    const o = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof o === 'object' && o ? (o.path ? `unix:${o.path}` : o.host) : typeof args[1] === 'string' ? args[1] : typeof o === 'string' ? `unix:${o}` : 'localhost';
    if (!String(host).startsWith('unix:') && !loopback(host)) attempts.push(`socket ${host}:${typeof o === 'object' ? o?.port : o}`);
    return (connect as any).apply(this, args);
  } as any;
  restore.push(() => { net.Socket.prototype.connect = connect; });
  for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6'] as const) {
    const orig = (dns as any)[fn];
    (dns as any)[fn] = (host: string, ...rest: any[]) => { if (!loopback(host)) attempts.push(`dns ${fn} ${host}`); return orig(host, ...rest); };
    restore.push(() => { (dns as any)[fn] = orig; });
  }
  const f = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => { const u = new URL(typeof input === 'string' ? input : input.url ?? String(input)); if (!loopback(u.hostname)) attempts.push(`fetch ${u.host}`); return f(input, init); }) as typeof fetch;
  restore.push(() => { globalThis.fetch = f; });
});
afterAll(() => { for (const r of restore) r(); });

it('the audit itself detects outbound attempts (control)', async () => {
  await fetch('http://atlas-audit-control.invalid/').catch(() => {});
  await new Promise((r) => dns.lookup('atlas-audit-control.invalid', () => r(null)));
  await new Promise((r) => { const s = net.connect({ host: '192.0.2.1', port: 9 }); s.on('error', r); s.setTimeout(200, () => { s.destroy(); r(null); }); });
  expect(attempts.some((a) => a.startsWith('fetch atlas-audit-control.invalid'))).toBe(true);
  expect(attempts.some((a) => a === 'dns lookup atlas-audit-control.invalid')).toBe(true);
  expect(attempts.some((a) => a.startsWith('socket 192.0.2.1'))).toBe(true);
  attempts.length = 0;
});

it('an idle daemon makes no outbound requests', async () => {
  const svc = new DaemonService({ dataDir: tmpDir('atlas-netaudit-'), version: 'audit' });
  await svc.start();
  // What the UI asks for while idle: app info, settings, runtimes (including Pi without keys), lists.
  for (const m of ['app.info', 'settings.get', 'runtime.health', 'workspace.list', 'credentials.list', 'deploy.secrets.list', 'desktop.list', 'roles.list'] as const) {
    await svc.handle(m, {}).catch(() => {});
  }
  await svc.handle('mission.list', {});
  await new Promise((r) => setTimeout(r, 3000));
  await svc.stop();
  expect(attempts).toEqual([]);
}, 30_000);
