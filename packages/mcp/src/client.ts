// A small Model Context Protocol client (ADR 0018): JSON-RPC 2.0 over stdio (newline-delimited) or streamable HTTP.
// Only what ATLAS uses: initialize, tools/list, tools/call. The client advertises no capabilities, so a server may
// not sample through ATLAS's models, read roots or ask the operator questions; such requests get "method not found".
// Everything a server sends is untrusted data: sizes are bounded and nothing it says changes ATLAS's configuration.
import type { Readable, Writable } from 'node:stream';
import type { McpToolInfo } from '@atlas/contracts';

export const PROTOCOL_VERSION = '2025-06-18';
const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_TOOLS = 500;

export class McpError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

type Json = Record<string, unknown>;
interface Pending { resolve(v: Json): void; reject(e: Error): void; timer: NodeJS.Timeout }

/** A transport sends one JSON-RPC message and delivers incoming ones to `onMessage`. */
interface Transport {
  send(msg: Json, signal?: AbortSignal): Promise<void>;
  onMessage(fn: (msg: Json) => void): void;
  close(): Promise<void>;
}

/** stdio: one JSON object per line on stdin/stdout. */
export function stdioTransport(stdin: Writable, stdout: Readable): Transport {
  let handler: (m: Json) => void = () => {};
  let buf = '';
  stdout.on('data', (b: Buffer) => {
    buf += b.toString('utf8');
    if (buf.length > MAX_MESSAGE && !buf.includes('\n')) { buf = ''; return; }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m && typeof m === 'object') handler(m as Json); } catch { /* not JSON: a server logging to stdout */ }
    }
  });
  return {
    send: (msg) => new Promise((resolve, reject) => { stdin.write(`${JSON.stringify(msg)}\n`, (e) => (e ? reject(e) : resolve())); }),
    onMessage: (fn) => { handler = fn; },
    close: async () => { stdin.end(); },
  };
}

/** Streamable HTTP: each message is a POST; the reply is JSON or a server-sent event stream. */
export function httpTransport(url: string, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): Transport {
  let handler: (m: Json) => void = () => {};
  let session: string | null = null;
  let protocol: string | null = null;
  const deliver = (text: string) => {
    try {
      const m = JSON.parse(text);
      for (const x of Array.isArray(m) ? m : [m]) if (x && typeof x === 'object') handler(x as Json);
    } catch { /* ignored */ }
  };
  return {
    async send(msg, signal) {
      const h: Record<string, string> = { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (session) h['mcp-session-id'] = session;
      if (protocol) h['mcp-protocol-version'] = protocol;
      let res: Response;
      try { res = await fetchImpl(url, { method: 'POST', headers: h, body: JSON.stringify(msg), signal, redirect: 'error' }); }
      catch (e) { throw new McpError(`Cannot reach ${new URL(url).host}: ${(e as Error).message}`); }
      const sid = res.headers.get('mcp-session-id');
      if (sid) session = sid;
      if (msg.method === 'initialize') protocol = PROTOCOL_VERSION;
      if (res.status === 202 || res.status === 204) return;
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new McpError(`${new URL(url).host} answered ${res.status}${res.status === 401 || res.status === 403 ? ' (check the secret headers for this server)' : ''}: ${body}`);
      }
      const type = res.headers.get('content-type') ?? '';
      const reader = res.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      let text = '';
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MESSAGE) { await reader.cancel(); throw new McpError('Response exceeds 4 MB'); }
        text += dec.decode(value, { stream: true });
        if (type.includes('text/event-stream')) {
          // Events are separated by a blank line; each data line carries (part of) one JSON-RPC message.
          let sep: number;
          while ((sep = text.search(/\r?\n\r?\n/)) >= 0) {
            const event = text.slice(0, sep);
            text = text.slice(sep).replace(/^\r?\n\r?\n/, '');
            const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (data) deliver(data);
          }
        }
      }
      if (!type.includes('text/event-stream') && text.trim()) deliver(text);
    },
    onMessage: (fn) => { handler = fn; },
    async close() {
      if (!session) return;
      try { await fetchImpl(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session }, signal: AbortSignal.timeout(5000) }); } catch { /* best effort */ }
    },
  };
}

export interface CallResult { ok: boolean; text: string; truncated: boolean }

export class McpClient {
  private seq = 0;
  private pending = new Map<number, Pending>();
  serverInfo: { name: string; version: string } | null = null;

  constructor(private readonly t: Transport, private readonly timeoutMs = 60_000) {
    t.onMessage((m) => this.receive(m));
  }

  private receive(m: Json) {
    if (m.jsonrpc !== '2.0') return;
    // A request from the server (sampling, roots, elicitation): ATLAS offers none of these.
    if (typeof m.method === 'string' && m.id !== undefined) {
      void this.t.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Not supported by ATLAS' } }).catch(() => {});
      return;
    }
    if (typeof m.id !== 'number') return; // notifications (progress, logging, list_changed) are ignored
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error && typeof m.error === 'object') { const e = m.error as { message?: unknown; code?: unknown }; p.reject(new McpError(String(e.message ?? 'error').slice(0, 500), typeof e.code === 'number' ? e.code : undefined)); }
    else p.resolve((m.result ?? {}) as Json);
  }

  request(method: string, params: Json, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Json> {
    const id = ++this.seq;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new McpError(`${method} timed out after ${Math.round((opts.timeoutMs ?? this.timeoutMs) / 1000)} s`)); }, opts.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      opts.signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        void this.t.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } }).catch(() => {});
        reject(new McpError('cancelled'));
      }, { once: true });
      this.t.send({ jsonrpc: '2.0', id, method, params }, opts.signal).catch((e) => { if (this.pending.delete(id)) { clearTimeout(timer); reject(e); } });
    });
  }

  async initialize(version: string): Promise<void> {
    const r = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ATLAS', version } }, { timeoutMs: 120_000 });
    const info = (r.serverInfo ?? {}) as { name?: unknown; version?: unknown };
    this.serverInfo = { name: String(info.name ?? 'unknown').slice(0, 100), version: String(info.version ?? '').slice(0, 40) };
    await this.t.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      for (const t of (Array.isArray(r.tools) ? r.tools : []) as Json[]) {
        if (typeof t.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(t.name)) continue;
        out.push({ name: t.name, description: typeof t.description === 'string' ? t.description.slice(0, 2000) : '', inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? (t.inputSchema as Record<string, unknown>) : { type: 'object' } });
        if (out.length >= MAX_TOOLS) return out;
      }
      cursor = typeof r.nextCursor === 'string' ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** Call a tool. Text content is returned; other content kinds are summarized, never interpreted. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 120_000, maxChars = 20_000): Promise<CallResult> {
    const r = await this.request('tools/call', { name, arguments: args }, { signal, timeoutMs });
    const parts: string[] = [];
    for (const c of (Array.isArray(r.content) ? r.content : []) as Json[]) {
      if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else if (c.type === 'resource' && c.resource && typeof (c.resource as Json).text === 'string') parts.push(String((c.resource as Json).text));
      else parts.push(`[${String(c.type ?? 'unknown')} content omitted]`);
    }
    if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
    const text = parts.join('\n');
    return { ok: r.isError !== true, text: text.length > maxChars ? text.slice(0, maxChars) : text, truncated: text.length > maxChars };
  }

  async close() {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new McpError('connection closed')); this.pending.delete(id); }
    await this.t.close();
  }
}
