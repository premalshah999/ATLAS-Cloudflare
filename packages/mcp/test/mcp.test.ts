// ADR 0018: MCP connections. A fake server (test/fake-server.cjs) stands in for real ones, over stdio inside the OS
// sandbox and over streamable HTTP (plain JSON and server-sent events).
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { McpServerConfig, registerSecret, type McpToolInfo } from '@atlas/contracts';
import { detectSandbox } from '@atlas/terminal';
import { McpManager } from '../src';
import { tmpDir } from '../../../tests/helpers';

const SERVER = path.join(__dirname, 'fake-server.cjs');
const sandboxed = detectSandbox().kind !== 'none';

function manager(servers: unknown[], secrets: Record<string, Record<string, string>> = {}) {
  const cache = new Map<string, { tools: McpToolInfo[]; at: string }>();
  const configs = servers.map((s) => McpServerConfig.parse(s));
  const m = new McpManager({
    dataDir: tmpDir('atlas-mcp-'), version: 'test', servers: () => configs, secrets: (n) => secrets[n] ?? {},
    toolCache: { get: (n) => cache.get(n) ?? null, set: (n, tools) => cache.set(n, { tools, at: new Date().toISOString() }) },
    allowUnsandboxed: () => false,
  });
  managers.push(m);
  return { m, configs };
}
const managers: McpManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.closeAll())); });
const ac = () => new AbortController().signal;
const local = (over: Record<string, unknown> = {}) => ({ name: 'fake', transport: 'stdio', command: process.execPath, args: [SERVER], readPaths: [path.dirname(SERVER)], ...over });

describe('MCP configuration (ADR 0018)', () => {
  it('rejects unsafe or incomplete server definitions', () => {
    const bad = [
      { name: 'Bad Name', transport: 'stdio', command: 'x' },
      { name: 'a', transport: 'stdio' },
      { name: 'a', transport: 'http', url: 'http://example.com/mcp' },
      { name: 'a', transport: 'http', url: 'https://user:pw@example.com/mcp' },
      { name: 'a', transport: 'http' },
    ];
    for (const b of bad) expect(McpServerConfig.safeParse(b).success, JSON.stringify(b)).toBe(false);
    expect(McpServerConfig.safeParse({ name: 'ok', transport: 'http', url: 'http://localhost:3000/mcp' }).success).toBe(true);
    expect(McpServerConfig.parse({ name: 'ok', transport: 'http', url: 'https://mcp.example.com/mcp' }).approval).toBe('ask');
  });
});

describe.skipIf(!sandboxed)('MCP over stdio, inside the OS sandbox', () => {
  it('lists tools, calls them, and indexes only offered tools for allowed roles', async () => {
    const { m } = manager([local({ tools: ['echo', 'fail'], roles: ['coder'] })]);
    const tools = await m.test('fake');
    expect(tools.map((t) => t.name)).toContain('leak');
    expect(m.status('fake').status).toBe('connected');
    const r = await m.call('fake', 'echo', { text: 'hello' }, ac());
    expect(r).toMatchObject({ ok: true, text: 'hello' });
    expect((await m.call('fake', 'fail', {}, ac())).ok).toBe(false);
    expect(m.index('coder')).toContain('- echo {text: string}');
    expect(m.index('coder')).not.toContain('leak');
    expect(m.index('reviewer')).toBe('');
    expect(m.permits('reviewer')).toBe(false);
  });

  it('denies unknown servers, disabled servers, other roles and tools outside the allowlist', async () => {
    const { m } = manager([local({ tools: ['echo'] }), local({ name: 'off', enabled: false })]);
    await m.test('fake');
    expect(m.check('coder', 'fake', 'echo')).toEqual({ ok: true, approval: 'ask' });
    expect(m.check('coder', 'fake', 'leak')).toMatchObject({ ok: false });
    expect(m.check('browser_qa', 'fake', 'echo')).toMatchObject({ ok: false, reason: expect.stringMatching(/may not use/) });
    expect(m.check('coder', 'off', 'echo')).toMatchObject({ ok: false, reason: expect.stringMatching(/disabled/) });
    expect(m.check('coder', 'nope', 'echo')).toMatchObject({ ok: false });
  });

  it('runs the server sandboxed: no home directory, no network unless enabled, secrets only by name', async () => {
    const canary = path.join(os.homedir(), `.atlas-mcp-canary-${process.pid}`);
    writeFileSync(canary, 'MCP-CANARY');
    const secret = 'sk-mcp-secret-value-123456';
    registerSecret(secret);
    try {
      const { m } = manager([local({ secrets: ['SECRET_TOKEN'] })], { fake: { SECRET_TOKEN: secret } });
      await m.test('fake');
      expect((await m.call('fake', 'read', { path: canary }, ac())).text).toMatch(/^DENIED/);
      expect((await m.call('fake', 'net', {}, ac())).text).toMatch(/NET-DOWN/);
      expect((await m.call('fake', 'env', { name: 'SECRET_TOKEN' }, ac())).text).toBe('SET');
      expect((await m.call('fake', 'env', { name: 'ANTHROPIC_API_KEY' }, ac())).text).toBe('UNSET');
      const leaked = await m.call('fake', 'leak', {}, ac());
      expect(leaked.text).not.toContain(secret);
    } finally { rmSync(canary, { force: true }); }
  });

  it('refuses to start without its secrets, and reports a server that dies before answering', async () => {
    const { m } = manager([local({ secrets: ['SECRET_TOKEN'] }), local({ name: 'crash', env: { FAKE_MCP_CRASH: '1' } })]);
    await expect(m.test('fake')).rejects.toThrow(/needs a value for SECRET_TOKEN/);
    const t0 = Date.now();
    await expect(m.test('crash')).rejects.toThrow(/exited before answering: boom: missing configuration/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(m.status('crash')).toMatchObject({ status: 'error' });
  });

  it('answers server-initiated requests with "not supported" and truncates large results', async () => {
    const { m } = manager([local()]);
    await m.test('fake');
    expect((await m.call('fake', 'ask', {}, ac())).text).toBe('refused -32601');
    const big = await m.call('fake', 'big', {}, ac());
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBe(20_000);
  });

  it('closing kills the server process', async () => {
    const { m } = manager([local()]);
    await m.test('fake');
    await m.closeAll();
    expect(m.status('fake').status).toBe('idle');
  });
});

async function freePort(): Promise<number> {
  return new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
}
const servers: ChildProcess[] = [];
afterAll(() => { for (const s of servers) s.kill(); });
async function httpServer(sse: boolean) {
  const port = await freePort();
  const p = spawn(process.execPath, [SERVER, '--http', String(port), ...(sse ? ['--sse'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(p);
  await new Promise((r) => p.stdout!.once('data', r));
  return `http://127.0.0.1:${port}/mcp`;
}

describe('MCP over streamable HTTP', () => {
  for (const sse of [false, true]) {
    it(`initializes with a session, sends the secret header, calls tools (${sse ? 'event stream' : 'JSON'} replies)`, async () => {
      const url = await httpServer(sse);
      const { m } = manager([{ name: 'remote', transport: 'http', url, secrets: ['authorization'] }], { remote: { authorization: 'Bearer good-token' } });
      const tools = await m.test('remote');
      expect(tools.length).toBe(8);
      expect(await m.call('remote', 'echo', { text: 'over http' }, ac())).toMatchObject({ ok: true, text: 'over http' });
    });
  }

  it('reports a rejected token without leaking it, and never retries silently', async () => {
    const url = await httpServer(false);
    registerSecret('Bearer wrong-token-abcdef');
    const { m } = manager([{ name: 'remote', transport: 'http', url, secrets: ['authorization'] }], { remote: { authorization: 'Bearer wrong-token-abcdef' } });
    const err = await m.test('remote').catch((e: Error) => e);
    expect(String(err)).toMatch(/401.*secret headers/);
    expect(String(err)).not.toContain('wrong-token');
  });
});
