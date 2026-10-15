/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS fixture run by plain node */
// A minimal MCP server for tests (stdio, or HTTP with --http PORT). Tools:
//   echo {text}           → the text back
//   env {name}            → whether the variable is set (never its value)
//   read {path}           → file contents or the error code (sandbox probe)
//   net {}                → whether an outbound TCP connection succeeds (sandbox probe)
//   leak {}               → returns the value of SECRET_TOKEN (to prove ATLAS redacts it)
//   big {}                → 100 000 characters
//   ask {}                → sends a sampling request to the client first, reports the client's answer
//   fail {}               → isError result
const fs = require('fs');
const net = require('net');
const http = require('http');

const TOOLS = ['echo', 'env', 'read', 'net', 'leak', 'big', 'ask', 'fail'].map((name) => ({
  name, description: `${name} tool`, inputSchema: { type: 'object', properties: name === 'echo' ? { text: { type: 'string' } } : name === 'env' || name === 'read' ? { [name === 'env' ? 'name' : 'path']: { type: 'string' } } : {}, required: name === 'echo' ? ['text'] : [] },
}));

let pendingAsk = null;
async function handle(msg, send) {
  if (msg.id !== undefined && !msg.method) { if (pendingAsk) { pendingAsk(msg); pendingAsk = null; } return; }
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize': return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } });
    case 'notifications/initialized': return;
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const a = msg.params.arguments || {};
      const text = (t) => reply({ content: [{ type: 'text', text: t }] });
      switch (msg.params.name) {
        case 'echo': return text(String(a.text));
        case 'env': return text(process.env[a.name] ? 'SET' : 'UNSET');
        case 'read': try { return text('READ ' + fs.readFileSync(a.path, 'utf8')); } catch (e) { return text('DENIED ' + e.code); }
        case 'net': {
          const s = net.connect(53, '1.1.1.1');
          const t = setTimeout(() => { s.destroy(); text('NET-DOWN timeout'); }, 3000);
          s.on('connect', () => { clearTimeout(t); s.destroy(); text('NET-UP'); });
          s.on('error', (e) => { clearTimeout(t); text('NET-DOWN ' + e.code); });
          return;
        }
        case 'leak': return text(`token=${process.env.SECRET_TOKEN}`);
        case 'big': return text('x'.repeat(100000));
        case 'ask': {
          pendingAsk = (answer) => text(answer.error ? `refused ${answer.error.code}` : 'answered');
          return send({ jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage', params: { messages: [] } });
        }
        case 'fail': return reply({ content: [{ type: 'text', text: 'it broke' }], isError: true });
      }
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } });
    }
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
}

const httpIdx = process.argv.indexOf('--http');
if (httpIdx < 0) {
  if (process.env.FAKE_MCP_CRASH) { console.error('boom: missing configuration'); process.exit(3); }
  let buf = '';
  process.stdin.on('data', (b) => {
    buf += b;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line), (m) => process.stdout.write(JSON.stringify(m) + '\n')); }
  });
  console.log('fake MCP server ready (a log line on stdout that is not JSON)');
} else {
  const sse = process.argv.includes('--sse');
  const seen = [];
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (b) => { body += b; });
    req.on('end', () => {
      seen.push({ method: req.method, auth: req.headers.authorization || null, session: req.headers['mcp-session-id'] || null });
      if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
      if (req.headers.authorization !== 'Bearer good-token') { res.writeHead(401); return res.end('unauthorized'); }
      const msg = JSON.parse(body);
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== 'sess-1') { res.writeHead(400); return res.end('no session'); }
      const out = [];
      handle(msg, (m) => out.push(m)).then(() => setTimeout(() => {
        const headers = { 'mcp-session-id': 'sess-1' };
        if (sse) { res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' }); for (const m of out) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`); res.end(); }
        else { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify(out[0] ?? {})); }
      }, 10));
    });
  }).listen(Number(process.argv[httpIdx + 1]), '127.0.0.1', () => console.log('listening'));
  process.on('SIGTERM', () => { console.log(JSON.stringify(seen)); process.exit(0); });
}
