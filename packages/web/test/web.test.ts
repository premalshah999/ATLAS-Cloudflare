// Web access (ADR 0030): provider requests and answers, what each failure means for an account, the account pool's
// rotation and failover, the address guard, HTML to text, and fetching pages. No network: providers are faked and
// pages come from a loopback server that only a test filter admits.
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SearchAccount, WebSettings, type SearchProvider } from '@atlas/contracts';
import { buildRequest, classify, emptyPoolState, environmentAccounts, fetchPage, htmlToText, isPublicAddress, nextPacificMidnight, parseResults, SearchPool, urlProblem, WebService, type PoolState } from '../src';

const acct = (id: string, provider: SearchProvider, extra: Partial<SearchAccount> = {}) => SearchAccount.parse({ id: `wa_${id}`, provider, label: id, ...(provider === 'google' ? { engine: 'cx123' } : {}), ...extra });
const q = (query: string, extra = {}) => ({ query, maxResults: 5, ...extra });
const H = (h: Record<string, string> = {}) => new Headers(h);

describe('provider requests and answers', () => {
  it('builds each provider\'s request with the key where that provider expects it', () => {
    const t = buildRequest(acct('t1', 'tavily'), 'tvly-KEY', q('vitest mock timers', { recency: 'week', site: 'vitest.dev' }));
    expect(t.url).toBe('https://api.tavily.com/search');
    expect((t.init.headers as Record<string, string>).Authorization).toBe('Bearer tvly-KEY');
    expect(JSON.parse(String(t.init.body))).toEqual({ query: 'vitest mock timers', max_results: 5, search_depth: 'basic', topic: 'general', time_range: 'week', include_domains: ['vitest.dev'] });

    const b = buildRequest(acct('b1', 'brave'), 'BSA-KEY', q('vitest mock timers', { recency: 'day', site: 'vitest.dev' }));
    const bu = new URL(b.url);
    expect(bu.origin + bu.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(bu.searchParams.get('q')).toBe('vitest mock timers site:vitest.dev');
    expect(bu.searchParams.get('freshness')).toBe('pd');
    expect((b.init.headers as Record<string, string>)['X-Subscription-Token']).toBe('BSA-KEY');

    const g = new URL(buildRequest(acct('g1', 'google'), 'AIzaKEY', q('vitest', { recency: 'month', site: 'vitest.dev' })).url);
    expect(g.origin + g.pathname).toBe('https://www.googleapis.com/customsearch/v1');
    expect(Object.fromEntries(g.searchParams)).toEqual({ key: 'AIzaKEY', cx: 'cx123', q: 'vitest', num: '5', dateRestrict: 'm1', siteSearch: 'vitest.dev', siteSearchFilter: 'i' });
  });

  it('reads each provider\'s results into one shape, dropping markup and non-web links', () => {
    expect(parseResults('tavily', { results: [{ title: 'A', url: 'https://a.dev/x', content: 'about <b>a</b>', published_date: '2026-01-02' }, { title: 'bad', url: 'javascript:alert(1)', content: '' }] }, 5))
      .toEqual([{ title: 'A', url: 'https://a.dev/x', snippet: 'about a', published: '2026-01-02' }]);
    expect(parseResults('brave', { web: { results: [{ title: 'B &amp; C', url: 'https://b.dev', description: 'the <strong>best</strong>' }] } }, 5))
      .toEqual([{ title: 'B & C', url: 'https://b.dev', snippet: 'the best' }]);
    expect(parseResults('google', { items: [{ title: 'G', link: 'https://g.dev', snippet: 'g' }, { title: 'H', link: 'https://h.dev', snippet: 'h' }] }, 1))
      .toEqual([{ title: 'G', url: 'https://g.dev', snippet: 'g' }]);
    expect(parseResults('google', {}, 5)).toEqual([]);
  });
});

describe('what a failure means for the account', () => {
  const now = Date.UTC(2026, 9, 14, 12, 0, 0);
  it('Tavily: 429 rests briefly, 432 and 433 are an allowance used up, 401 a rejected key, 400 the query', () => {
    expect(classify('tavily', 429, H({ 'retry-after': '7' }), '{"detail":{"error":"slow down"}}', now)).toMatchObject({ kind: 'rate', until: now + 7000, message: '429: slow down' });
    expect(classify('tavily', 432, H(), '{"detail":{"error":"This request exceeds your plan\'s set usage limit."}}', now)).toMatchObject({ kind: 'quota', until: now + 86_400_000 });
    expect(classify('tavily', 433, H(), '{}', now).kind).toBe('quota');
    expect(classify('tavily', 401, H(), '{"detail":{"error":"Unauthorized: missing or invalid API key."}}', now)).toMatchObject({ kind: 'rejected' });
    expect(classify('tavily', 400, H(), '{"detail":{"error":"Query is too long."}}', now)).toMatchObject({ kind: 'bad_request' });
    expect(classify('tavily', 503, H(), 'down', now)).toMatchObject({ kind: 'error', until: now + 30_000 });
  });

  it('Brave: a per-second limit rests a second; the month used up rests until the month renews', () => {
    expect(classify('brave', 429, H({ 'x-ratelimit-remaining': '0, 1200', 'x-ratelimit-reset': '1, 1419704' }), '{}', now)).toMatchObject({ kind: 'rate', until: now + 1000 });
    expect(classify('brave', 429, H({ 'x-ratelimit-remaining': '1, 0', 'x-ratelimit-reset': '1, 1419704' }), '{}', now)).toMatchObject({ kind: 'quota', until: now + 1_419_704_000 });
    expect(classify('brave', 422, H(), '{"error":{"code":"SUBSCRIPTION_TOKEN_INVALID","detail":"The provided subscription token is invalid."}}', now)).toMatchObject({ kind: 'rejected' });
    expect(classify('brave', 422, H(), '{"error":{"code":"VALIDATION","detail":"count must be <= 20"}}', now)).toMatchObject({ kind: 'bad_request' });
  });

  it('Google: the daily quota rests until midnight Pacific; an invalid key is rejected', () => {
    const quota = '{"error":{"code":429,"message":"Quota exceeded for quota metric \'Queries\' and limit \'Queries per day\' of service \'customsearch.googleapis.com\'","status":"RESOURCE_EXHAUSTED","details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}';
    const r = classify('google', 429, H(), quota, now);
    expect(r).toMatchObject({ kind: 'quota', until: nextPacificMidnight(now) });
    // 12:00 UTC on 14 October 2026 is 05:00 PDT; the Pacific day ends at 07:00 UTC on the 15th.
    expect(new Date(nextPacificMidnight(now)).toISOString()).toBe('2026-10-15T07:00:00.000Z');
    expect(new Date(nextPacificMidnight(Date.UTC(2026, 0, 10, 20))).toISOString()).toBe('2026-01-11T08:00:00.000Z');
    expect(classify('google', 400, H(), '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","errors":[{"reason":"badRequest"}],"details":[{"reason":"API_KEY_INVALID"}]}}', now).kind).toBe('rejected');
    expect(classify('google', 403, H(), '{"error":{"code":403,"message":"Custom Search JSON API has not been used in project 1 before or it is disabled.","errors":[{"reason":"accessNotConfigured"}]}}', now).kind).toBe('rejected');
    expect(classify('google', 400, H(), '{"error":{"code":400,"message":"Invalid value","errors":[{"reason":"invalid"}]}}', now).kind).toBe('bad_request');
  });
});

/** A fake provider endpoint: answers per key from a script, and records which key each request used. */
function fakeFetch(script: Record<string, (n: number) => { status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const counts: Record<string, number> = {};
  const keyOf = (url: string, init: RequestInit) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    return h.Authorization?.replace('Bearer ', '') ?? h['X-Subscription-Token'] ?? new URL(url).searchParams.get('key') ?? '?';
  };
  const fn = (async (url: string, init: RequestInit) => {
    const key = keyOf(String(url), init);
    calls.push(key);
    counts[key] = (counts[key] ?? 0) + 1;
    const r = script[key]?.(counts[key]) ?? { status: 401, body: { detail: { error: 'unknown key' } } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const tavilyOk = (url: string) => () => ({ status: 200, body: { results: [{ title: url, url, content: 'x' }] } });

function pool(accounts: SearchAccount[], keys: Record<string, string>, f: typeof fetch, settings: Partial<WebSettings> = {}, clock = { t: Date.UTC(2026, 9, 14, 12) }) {
  let state: PoolState = emptyPoolState();
  const p = new SearchPool({
    accounts: () => accounts, settings: () => WebSettings.parse({ enabled: true, ...settings }), key: (id) => keys[id],
    load: () => structuredClone(state), save: (s) => { state = structuredClone(s); }, fetch: f, now: () => clock.t,
  });
  return { p, state: () => state, clock };
}
const signal = () => new AbortController().signal;

describe('the search account pool', () => {
  it('rotates searches across a provider\'s accounts', async () => {
    const f = fakeFetch({ k1: tavilyOk('https://one.dev'), k2: tavilyOk('https://two.dev'), k3: tavilyOk('https://three.dev') });
    const { p, state } = pool([acct('a1', 'tavily'), acct('a2', 'tavily'), acct('a3', 'tavily')], { wa_a1: 'k1', wa_a2: 'k2', wa_a3: 'k3' }, f.fn);
    for (let i = 0; i < 4; i++) expect((await p.search(q('x'), signal())).ok).toBe(true);
    expect(f.calls).toEqual(['k1', 'k2', 'k3', 'k1']);
    expect(state().accounts.wa_a1).toMatchObject({ usedDay: 2, usedMonth: 2 });
  });

  it('fills the first account before using the next when the operator chose fill', async () => {
    const f = fakeFetch({ k1: tavilyOk('https://one.dev'), k2: tavilyOk('https://two.dev') });
    const { p } = pool([acct('a1', 'tavily'), acct('a2', 'tavily')], { wa_a1: 'k1', wa_a2: 'k2' }, f.fn, { strategy: 'fill' });
    for (let i = 0; i < 3; i++) await p.search(q('x'), signal());
    expect(f.calls).toEqual(['k1', 'k1', 'k1']);
  });

  it('moves past an account that is out of searches, rests it, and uses it again once its allowance renews', async () => {
    const f = fakeFetch({ k1: (n) => (n === 1 ? { status: 432, body: { detail: { error: 'usage limit' } } } : tavilyOk('https://one.dev')()), k2: tavilyOk('https://two.dev') });
    const { p, state, clock } = pool([acct('a1', 'tavily'), acct('a2', 'tavily')], { wa_a1: 'k1', wa_a2: 'k2' }, f.fn, { strategy: 'fill' });
    const r = await p.search(q('x'), signal());
    expect(r).toMatchObject({ ok: true, accountId: 'wa_a2', attempts: [{ accountId: 'wa_a1', outcome: 'quota' }, { accountId: 'wa_a2', outcome: 'ok' }] });
    expect(state().accounts.wa_a1).toMatchObject({ reason: 'quota', usedDay: 0 });
    await p.search(q('y'), signal());
    expect(f.calls).toEqual(['k1', 'k2', 'k2']); // a1 rests
    expect(p.view(() => false).find((v) => v.account.id === 'wa_a1')).toMatchObject({ health: 'quota' });
    clock.t += 86_400_000 + 1;
    await p.search(q('z'), signal());
    expect(f.calls.at(-1)).toBe('k1');
  });

  it('falls over to the next provider in the operator\'s order when a provider has no account that can answer', async () => {
    const f = fakeFetch({
      k1: () => ({ status: 429, body: {}, headers: { 'retry-after': '30' } }),
      bk: () => ({ status: 200, body: { web: { results: [{ title: 'b', url: 'https://brave.dev', description: 'b' }] } } }),
    });
    const { p } = pool([acct('a1', 'tavily'), acct('b1', 'brave')], { wa_a1: 'k1', wa_b1: 'bk' }, f.fn, { order: ['tavily', 'brave'] });
    const r = await p.search(q('x'), signal());
    expect(r).toMatchObject({ ok: true, provider: 'brave', results: [{ url: 'https://brave.dev' }] });
    expect(r.attempts.map((a) => a.outcome)).toEqual(['rate', 'ok']);
    // provider pins one provider: the rested Tavily account is not used, so nothing answers.
    const pinned = await p.search(q('x', { provider: 'tavily' }), signal());
    expect(pinned.ok).toBe(false);
    if (!pinned.ok) expect(pinned.message).toMatch(/a1 \(tavily\): rate limited until/);
  });

  it('a rejected key rests until the key changes; a refused query does not burn through the other accounts', async () => {
    const keys: Record<string, string> = { wa_a1: 'bad', wa_a2: 'k2' };
    const f = fakeFetch({ k2: (n) => (n === 2 ? { status: 400, body: { detail: { error: 'Query is too long.' } } } : tavilyOk('https://two.dev')()), good: tavilyOk('https://one.dev') });
    const { p } = pool([acct('a1', 'tavily'), acct('a2', 'tavily')], keys, f.fn, { strategy: 'fill' });
    expect((await p.search(q('x'), signal())).ok).toBe(true);
    expect(p.view(() => false)[0]).toMatchObject({ health: 'rejected' });
    const refused = await p.search(q('x'), signal());
    expect(refused).toMatchObject({ ok: false, attempts: [{ accountId: 'wa_a2', outcome: 'bad_request' }] });
    expect(f.calls).toEqual(['bad', 'k2', 'k2']);
    keys.wa_a1 = 'good';
    expect(p.view(() => false)[0]).toMatchObject({ health: 'ready' });
    await p.search(q('y'), signal());
    expect(f.calls.at(-1)).toBe('good');
  });

  it('stops using an account at the daily limit the operator set, and skips accounts without a key or turned off', async () => {
    const f = fakeFetch({ k1: tavilyOk('https://one.dev'), k3: tavilyOk('https://three.dev') });
    const { p } = pool([acct('a1', 'tavily', { dailyLimit: 2 }), acct('a2', 'tavily'), acct('a3', 'tavily', { enabled: false })], { wa_a1: 'k1', wa_a3: 'k3' }, f.fn, { strategy: 'fill' });
    expect((await p.search(q('1'), signal())).ok).toBe(true);
    expect((await p.search(q('2'), signal())).ok).toBe(true);
    const third = await p.search(q('3'), signal());
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.message).toMatch(/a1 \(tavily\): reached the limit set for it\n- a2 \(tavily\): no key\n- a3 \(tavily\): turned off/);
    expect(f.calls).toEqual(['k1', 'k1']);
    expect(p.view(() => false).map((v) => v.health)).toEqual(['limit', 'no_key', 'disabled']);
  });

  it('a network failure rests the account briefly and tries the next one; reset clears a rest', async () => {
    let fail = true;
    const f = (async (url: string, init: RequestInit) => {
      if (fail && (init.headers as Record<string, string>).Authorization === 'Bearer k1') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://ok.dev', content: '' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { p } = pool([acct('a1', 'tavily'), acct('a2', 'tavily')], { wa_a1: 'k1', wa_a2: 'k2' }, f, { strategy: 'fill' });
    const r = await p.search(q('x'), signal());
    expect(r).toMatchObject({ ok: true, accountId: 'wa_a2', attempts: [{ outcome: 'error', detail: 'network error (ECONNRESET)' }, { outcome: 'ok' }] });
    expect(p.view(() => false)[0].health).toBe('cooling');
    p.reset('wa_a1');
    fail = false;
    expect(p.view(() => false)[0].health).toBe('ready');
  });

  it('accounts from the environment: a Google key needs its engine id', () => {
    const e = environmentAccounts({ TAVILY_API_KEY: 'tvly-1', BRAVE_SEARCH_API_KEY: 'b-1', GOOGLE_API_KEY: 'AIza-1' });
    expect(e.accounts.map((a) => a.id)).toEqual(['wa_envtavily', 'wa_envbrave']);
    expect(environmentAccounts({ GOOGLE_API_KEY: 'AIza-1', GOOGLE_CSE_ID: 'cx' }).accounts[0]).toMatchObject({ id: 'wa_envgoogle', engine: 'cx' });
    // Several keys in one variable: one account each, in order.
    const many = environmentAccounts({ TAVILY_API_KEY: 'tvly-1, tvly-2,tvly-3', GOOGLE_API_KEY: 'g1,g2', GOOGLE_CSE_ID: 'cx1,cx2' });
    expect(many.accounts.map((a) => [a.id, a.label, a.engine])).toEqual([['wa_envtavily', 'Tavily (environment 1)', undefined], ['wa_envtavily2', 'Tavily (environment 2)', undefined], ['wa_envtavily3', 'Tavily (environment 3)', undefined], ['wa_envgoogle', 'Google Programmable Search (environment 1)', 'cx1'], ['wa_envgoogle2', 'Google Programmable Search (environment 2)', 'cx2']]);
    expect(many.keys).toMatchObject({ wa_envtavily2: 'tvly-2', wa_envgoogle2: 'g2' });
  });

  it('offers no web tool until the operator turns web access on, and web_search only with an account', () => {
    let settings = WebSettings.parse({});
    const accounts: SearchAccount[] = [];
    const svc = new WebService({ settings: () => settings, accounts: () => accounts, key: () => 'k', load: emptyPoolState, save: () => {}, browserAvailable: () => true });
    expect(svc.tools('coder')).toEqual([]);
    settings = WebSettings.parse({ enabled: true });
    expect(svc.tools('coder')).toEqual(['web_fetch', 'web_browse']);
    expect(svc.tools('browser_qa')).toEqual([]);
    accounts.push(acct('a1', 'brave'));
    expect(svc.tools('reviewer')).toEqual(['web_search', 'web_fetch', 'web_browse']);
    expect(svc.index('coder')).toMatch(/web_search .*Brave Search/);
    expect(svc.index('coder')).toMatch(/Browsing only reads/);
  });
});

describe('where the web tools may connect', () => {
  it('admits public addresses only', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
      '::1', '::', 'fe80::1', 'fd00::1', 'fc00::abcd', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2001:db8::1']) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('refuses local names, private literals in any spelling, other schemes and credentials', () => {
    expect(urlProblem('http://localhost:3000/')).toMatch(/local name/);
    expect(urlProblem('http://printer.local/')).toMatch(/local name/);
    expect(urlProblem('http://intranet/')).toMatch(/local name/);
    expect(urlProblem('http://2130706433/')).toMatch(/127\.0\.0\.1 is not a public/);
    expect(urlProblem('http://0x7f.1/')).toMatch(/not a public/);
    expect(urlProblem('http://[::1]:8080/')).toMatch(/not a public/);
    expect(urlProblem('http://169.254.169.254/latest/meta-data/')).toMatch(/not a public/);
    expect(urlProblem('file:///etc/passwd')).toMatch(/only http and https/);
    expect(urlProblem('https://user:pw@example.com/')).toMatch(/credentials/);
    expect(urlProblem('https://docs.python.org/3/')).toBeNull();
  });
});

describe('pages as text', () => {
  it('keeps headings, paragraphs, lists, links, code and table cells; drops scripts, styles and navigation', () => {
    const html = `<!doctype html><html><head><title>fs | Node.js</title><style>p{}</style><script>alert('x')</script></head><body>
      <nav><a href="/">Home</a></nav>
      <main><h1>File system</h1><p>The <code>node:fs</code> module &amp; friends.</p>
      <ul><li>readFile</li><li><a href="/api/fs.html#writefile">writeFile</a></li></ul>
      <pre><code>import { readFile } from 'node:fs/promises';
const s = await readFile('a.txt', 'utf8');</code></pre>
      <table><tr><th>Flag</th><th>Meaning</th></tr><tr><td>r</td><td>read</td></tr></table>
      <p>${'Long enough to count as the main content. '.repeat(8)}</p></main>
      <footer>© 2026</footer></body></html>`;
    const r = htmlToText(html, 'https://nodejs.org/api/fs.html');
    expect(r.title).toBe('fs | Node.js');
    expect(r.text).toContain('# File system');
    expect(r.text).toContain('The `node:fs` module & friends.');
    expect(r.text).toContain('- readFile\n- [writeFile](https://nodejs.org/api/fs.html#writefile)');
    expect(r.text).toContain("```\nimport { readFile } from 'node:fs/promises';\nconst s = await readFile('a.txt', 'utf8');\n```");
    expect(r.text).toMatch(/\| Flag \| \| Meaning \|/);
    expect(r.text).not.toMatch(/alert|p\{\}|Home|© 2026/);
  });
});

describe('web_fetch', () => {
  let server: http.Server;
  let base = '';
  const loopback = (ip: string) => ip === '127.0.0.1' || isPublicAddress(ip);
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = req.url ?? '/';
      if (u === '/doc') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' }); res.end(gzipSync('<html><head><title>Doc</title></head><body><h2>Hello</h2><p>café</p></body></html>')); return; }
      if (u === '/hop') { res.writeHead(302, { location: '/doc' }); res.end(); return; }
      if (u === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
      if (u === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
      if (u === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(200_000)); return; }
      if (u === '/bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.alloc(10)); return; }
      if (u === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"a":1}'); return; }
      res.writeHead(404, { 'content-type': 'text/html' }); res.end('<p>missing</p>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });

  it('by default refuses the loopback page outright: nothing connects', async () => {
    const r = await fetchPage(`${base}/doc`, { signal: signal() });
    expect(r).toMatchObject({ ok: false, status: null, error: expect.stringMatching(/^Refused: 127\.0\.0\.1 is not a public internet address/) });
  });

  it('reads a page through a redirect, decompressed and decoded, as text', async () => {
    const r = await fetchPage(`${base}/hop`, { signal: signal(), allowed: loopback });
    expect(r).toMatchObject({ ok: true, status: 200, url: `${base}/doc`, title: 'Doc', redirects: [`302 → ${base}/doc`] });
    expect(r.text).toBe('## Hello\n\ncafé');
  });

  it('checks every redirect hop: a redirect into a private address is refused', async () => {
    const r = await fetchPage(`${base}/to-metadata`, { signal: signal(), allowed: loopback });
    expect(r).toMatchObject({ ok: false, error: 'Refused: 169.254.169.254 is not a public internet address' });
    expect((await fetchPage(`${base}/loop`, { signal: signal(), allowed: loopback })).error).toMatch(/Too many redirects/);
  });

  it('caps the size, refuses binary content, passes JSON through, and reports HTTP errors with their text', async () => {
    const big = await fetchPage(`${base}/big`, { signal: signal(), allowed: loopback, maxBytes: 50_000 });
    expect(big.text).toMatch(/^x{50000}\n… \[page cut at 49 KB\]$/);
    expect(await fetchPage(`${base}/bin`, { signal: signal(), allowed: loopback })).toMatchObject({ ok: false, error: 'Not a text page (application/octet-stream, 10 bytes)' });
    expect((await fetchPage(`${base}/json`, { signal: signal(), allowed: loopback })).text).toBe('{"a":1}');
    expect(await fetchPage(`${base}/nope`, { signal: signal(), allowed: loopback })).toMatchObject({ ok: false, status: 404, text: 'missing', error: 'HTTP 404' });
  });
});
