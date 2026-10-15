// A minimal GitHub REST API for offline tests of the pull request / CI loop (ADR 0015). It records every request
// with its Authorization header, so tests can check where the token went.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeCheck { id: number; name: string; status: string; conclusion: string | null; title?: string; annotations?: { path: string; start_line: number; annotation_level: string; message: string }[]; log?: string }

export class FakeGitHub {
  readonly requests: { method: string; path: string; auth: string | undefined }[] = [];
  readonly pulls: { number: number; head: string; base: string; title: string; body: string; state: string; sha: string }[] = [];
  readonly checks = new Map<string, FakeCheck[]>();
  heads = new Map<string, string>();
  private server!: Server;
  url = '';

  async start() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url!, 'http://x');
        this.requests.push({ method: req.method!, path: u.pathname + u.search, auth: req.headers.authorization });
        const send = (code: number, data: unknown, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
        let m: RegExpExecArray | null;
        if (req.headers.authorization !== 'Bearer ghp_test_token_123456') return send(401, { message: 'Bad credentials' });
        if (req.method === 'GET' && /^\/repos\/acme\/app$/.test(u.pathname)) return send(200, { default_branch: 'main' });
        if (req.method === 'GET' && u.pathname === '/repos/acme/app/pulls') {
          const head = u.searchParams.get('head')!.replace(/^acme:/, '');
          return send(200, this.pulls.filter((p) => p.head === head && p.state === 'open').map((p) => ({ number: p.number, html_url: `https://github.com/acme/app/pull/${p.number}`, state: p.state, head: { sha: this.heads.get(p.head) ?? p.sha } })));
        }
        if (req.method === 'POST' && u.pathname === '/repos/acme/app/pulls') {
          const b = JSON.parse(body) as { title: string; head: string; base: string; body: string };
          if (this.pulls.some((p) => p.head === b.head && p.state === 'open')) return send(422, { message: 'A pull request already exists' });
          const pr = { number: 40 + this.pulls.length + 1, head: b.head, base: b.base, title: b.title, body: b.body, state: 'open', sha: this.heads.get(b.head) ?? '' };
          this.pulls.push(pr);
          return send(201, { number: pr.number, html_url: `https://github.com/acme/app/pull/${pr.number}`, state: 'open', head: { sha: pr.sha } });
        }
        if (req.method === 'GET' && (m = /^\/repos\/acme\/app\/commits\/([0-9a-f]+)\/check-runs$/.exec(u.pathname))) {
          return send(200, { check_runs: (this.checks.get(m[1]) ?? []).map((c) => ({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, html_url: `https://github.com/acme/app/runs/${c.id}`, output: { title: c.title ?? null, summary: null } })) });
        }
        if (req.method === 'GET' && /^\/repos\/acme\/app\/commits\/[0-9a-f]+\/status$/.test(u.pathname)) return send(200, { statuses: [] });
        const all = [...this.checks.values()].flat();
        if (req.method === 'GET' && (m = /^\/repos\/acme\/app\/check-runs\/(\d+)\/annotations$/.exec(u.pathname))) return send(200, all.find((c) => c.id === Number(m![1]))?.annotations ?? []);
        if (req.method === 'GET' && (m = /^\/repos\/acme\/app\/actions\/jobs\/(\d+)\/logs$/.exec(u.pathname))) {
          const c = all.find((x) => x.id === Number(m![1]));
          return c?.log ? send(200, c.log, 'text/plain') : send(404, { message: 'Not Found' });
        }
        send(404, { message: 'Not Found' });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  close() { return new Promise<void>((r) => this.server.close(() => r())); }
}
