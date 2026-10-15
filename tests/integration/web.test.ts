// Web access for agents (ADR 0030), end to end through the gate with the scripted runtime: a search that fails over
// from an account out of searches to the next one, reading a page the search found without asking, an unknown site
// that needs a person (denied here, so nothing is fetched), a query carrying a secret that never leaves, and a real
// Chromium on the open web that reads by snapshot and refuses form posts and navigation to unknown sites.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forTask, SAMPLE_FIX } from '@atlas/runtime-fake';
import { resolveBrowser } from '@atlas/browser';
import { registerSecret, SearchAccount, WebSettings } from '@atlas/contracts';
import { emptyPoolState, isPublicAddress, WebService, type PoolState } from '@atlas/web';
import { sampleRepo } from '../helpers';
import { explainChecks, makeOrchestrator, startMission, waitFor } from './harness';

const SECRET = 'tvly-leaky-secret-123456';
let server: http.Server;
let port = 0;
const posts: string[] = [];
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.headers.host} ${req.url}`);
    if (req.method === 'POST') { posts.push(req.url ?? ''); res.end('posted'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/guide') {
      res.end(`<!doctype html><html><head><title>Slug guide</title></head><body><main><h1>Slugs</h1><p>Lowercase, and replace every run of other characters with one hyphen.</p>
        <a href="http://localhost:${port}/elsewhere">Elsewhere</a> <a href="/guide#top">Top</a>
        <form method="post" action="/subscribe"><input name="email" aria-label="Email"><button>Send</button></form></main></body></html>`);
      return;
    }
    res.end('<p>other page</p>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => { server.close(); });

describe.skipIf(!resolveBrowser().path)('web access for agents (ADR 0030)', () => {
  it('searches with failover, reads what it found, asks for unknown sites, keeps secrets in, and browses read-only', async () => {
    registerSecret(SECRET);
    const guide = `http://127.0.0.1:${port}/guide`;
    const providerCalls: string[] = [];
    const fakeTavily = (async (_url: string, init: RequestInit) => {
      const key = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
      providerCalls.push(key);
      if (key === 'tvly-first') return new Response('{"detail":{"error":"This request exceeds your plan\'s set usage limit."}}', { status: 432 });
      return new Response(JSON.stringify({ results: [{ title: 'Slug guide', url: guide, content: 'How to make slugs' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    let pool: PoolState = emptyPoolState();
    const accounts = [SearchAccount.parse({ id: 'wa_first', provider: 'tavily', label: 'Trial 1' }), SearchAccount.parse({ id: 'wa_second', provider: 'tavily', label: 'Trial 2' })];
    const keys: Record<string, string> = { wa_first: 'tvly-first', wa_second: 'tvly-second' };
    const web = new WebService({
      settings: () => WebSettings.parse({ enabled: true, strategy: 'fill' }), accounts: () => accounts, key: (id) => keys[id],
      load: () => structuredClone(pool), save: (s) => { pool = structuredClone(s); }, fetch: fakeTavily,
      // The fixture is on loopback, which the default filter refuses; this test admits loopback only.
      allowed: (ip) => ip === '127.0.0.1' || ip === '::1' || isPublicAddress(ip),
    });

    const h = makeOrchestrator({
      web,
      scripts: [forTask('implement', [
        { tool: 'web_search', args: { query: 'url slug rules' } },
        { tool: 'web_fetch', args: { url: guide } },
        { tool: 'web_fetch', args: { url: `http://localhost:${port}/private-notes` } },
        { tool: 'web_search', args: { query: `does ${SECRET} work` } },
        { tool: 'web_browse', args: { step: { action: 'open', url: guide } } },
        { tool: 'web_browse', args: { step: { action: 'fill', selector: 'input[name=email]', value: 'me@example.com' } } },
        { tool: 'web_browse', args: { step: { action: 'click', text: 'Send' } } },
        { tool: 'web_browse', args: { step: { action: 'click', text: 'Elsewhere' } } },
        { tool: 'web_browse', args: { step: { action: 'text' } } },
        { tool: 'write_file', args: { path: 'src/slugify.js', content: SAMPLE_FIX } },
        { claim: 'Fixed slugify following the guide I found.' },
      ])],
    });
    const id = await startMission(h, sampleRepo());
    // The unknown site: a person decides, and sees which site.
    const a = await waitFor(() => h.repo.approvals(id).find((x) => x.status === 'pending'), 60_000);
    expect(a).toMatchObject({ tool: 'web_fetch', capability: 'web.fetch', action: `read http://localhost:${port}/private-notes`, resources: ['the open web: localhost'] });
    h.orch.respondApproval(a.id, 'deny');
    await h.orch.settle(id);
    expect(h.repo.mission(id)!.verdict, explainChecks(h, id)).toBe('verified');

    const results = (tool: string) => h.events.filter((e) => e.type === 'agent.tool_result' && e.payload.tool === tool).map((e) => ({ ok: e.payload.ok, text: String(e.payload.summary) }));
    const [search, leak] = results('web_search');
    // Trial 1 is out of searches: the search moved on to Trial 2, and Trial 1 now rests.
    expect(search.ok).toBe(true);
    expect(search.text).toContain(`<web-search query="url slug rules" provider="tavily">\n1. Slug guide\n   ${guide}\n   How to make slugs\n</web-search>`);
    expect(pool.accounts.wa_first).toMatchObject({ reason: 'quota', usedDay: 0 });
    expect(pool.accounts.wa_second).toMatchObject({ usedDay: 1 });
    const searched = h.events.find((e) => e.type === 'web.searched' && e.payload.ok)!;
    expect(searched.payload).toMatchObject({ provider: 'tavily', account: 'Trial 2', results: 1, attempts: ['Trial 1 (tavily): quota — 432: This request exceeds your plan\'s set usage limit.', 'Trial 2 (tavily): ok'] });
    // The secret never reached a provider.
    expect(leak).toMatchObject({ ok: false });
    expect(leak.text).toMatch(/Denied by policy: The request contains a secret/);
    expect(providerCalls).toEqual(['tvly-first', 'tvly-second']);

    const [read, unknown] = results('web_fetch');
    expect(read.ok).toBe(true);
    expect(read.text).toContain(`<web-page url="${guide}" title="Slug guide">\n# Slugs\n\nLowercase, and replace every run of other characters with one hyphen.`);
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown.text).toMatch(/Not executed: Operator denied/);
    expect(hits.some((x) => x.includes('/private-notes'))).toBe(false);

    const browse = results('web_browse');
    expect(browse[0].ok).toBe(true);
    expect(browse[0].text).toMatch(/GET http:\/\/127\.0\.0\.1:\d+\/guide → 200/);
    expect(browse[0].text).toMatch(/heading\[1\] "Slugs" \[ref=e\d+\]/);
    expect(browse[0].text).toMatch(/button "Send" \[ref=e\d+\]/);
    // Reading only: the form post is refused before it leaves the browser.
    expect(browse[2].text).toMatch(/Blocked: POST http:\/\/127\.0\.0\.1:\d+\/subscribe: POST requests are off/);
    expect(posts).toEqual([]);
    // A link to a site the task does not know is not followed.
    expect(browse[3].text).toMatch(/Blocked: GET http:\/\/localhost:\d+\/elsewhere: localhost is not a known site; open it with web_browse/);
    expect(hits.some((x) => x.includes('/elsewhere'))).toBe(false);
    expect(browse[4].text).toMatch(/Lowercase, and replace every run/);

    // The agent was told about its web tools; every call is in the record.
    const ctx = h.events.find((e) => e.type === 'attempt.started' && (e.payload.tools as string[]).includes('web_search'))!;
    expect(ctx.payload.tools).toEqual(expect.arrayContaining(['web_search', 'web_fetch', 'web_browse']));
    expect(h.events.filter((e) => e.type === 'web.browsed').length).toBe(5);
    expect(h.events.find((e) => e.type === 'web.fetched' && e.payload.ok)!.payload).toMatchObject({ url: guide, status: 200 });
  }, 120_000);

  it('with web access off, no web tool is offered and a call is refused', async () => {
    const web = new WebService({ settings: () => WebSettings.parse({}), accounts: () => [], key: () => undefined, load: emptyPoolState, save: () => {} });
    const h = makeOrchestrator({ web, scripts: [forTask('implement', [{ tool: 'web_fetch', args: { url: 'https://example.com/' } }, { tool: 'write_file', args: { path: 'src/slugify.js', content: SAMPLE_FIX } }, { claim: 'done' }])] });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    const started = h.events.find((e) => e.type === 'attempt.started')!;
    expect((started.payload.tools as string[]).filter((t) => t.startsWith('web_'))).toEqual([]);
    const r = h.events.find((e) => e.type === 'agent.tool_result' && e.payload.tool === 'web_fetch')!;
    expect(r.payload).toMatchObject({ ok: false });
    expect(String(r.payload.summary)).toMatch(/not available for this task/);
  }, 60_000);
});
