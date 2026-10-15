// Search providers (ADR 0030): one request shape and one answer shape per provider, and what each failure means for
// the account that made the request. Nothing here keeps state; the pool decides what to do with an outcome.
import type { SearchAccount, SearchProvider, WebSearchArgs } from '@atlas/contracts';

export interface SearchResult { title: string; url: string; snippet: string; published?: string }

/**
 * What a failed request says about the account:
 * - rate: too many requests just now; rest briefly, try another account.
 * - quota: the plan's allowance is used up; rest until it renews.
 * - rejected: the key is invalid, revoked or not allowed; rest until the operator changes it.
 * - error: the service or the network failed; rest briefly.
 * - bad_request: the query itself was refused; another account would refuse it too.
 */
export type FailureKind = 'rate' | 'quota' | 'rejected' | 'error' | 'bad_request';
export type CallOutcome =
  | { ok: true; results: SearchResult[] }
  | { ok: false; kind: FailureKind; message: string; /** When the account may be used again, ms since epoch. */ until?: number };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface ProviderRequest { url: string; init: RequestInit }

const FRESHNESS = { brave: { day: 'pd', week: 'pw', month: 'pm', year: 'py' }, google: { day: 'd1', week: 'w1', month: 'm1', year: 'y1' } } as const;

export function buildRequest(account: SearchAccount, key: string, q: WebSearchArgs): ProviderRequest {
  switch (account.provider) {
    case 'tavily':
      return {
        url: 'https://api.tavily.com/search',
        init: {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query: q.query, max_results: q.maxResults, search_depth: 'basic', topic: 'general', ...(q.recency ? { time_range: q.recency } : {}), ...(q.site ? { include_domains: [q.site] } : {}) }),
        },
      };
    case 'brave': {
      const u = new URL('https://api.search.brave.com/res/v1/web/search');
      u.searchParams.set('q', q.site ? `${q.query} site:${q.site}` : q.query);
      u.searchParams.set('count', String(q.maxResults));
      if (q.recency) u.searchParams.set('freshness', FRESHNESS.brave[q.recency]);
      return { url: u.toString(), init: { method: 'GET', headers: { 'X-Subscription-Token': key, Accept: 'application/json' } } };
    }
    case 'google': {
      const u = new URL('https://www.googleapis.com/customsearch/v1');
      u.searchParams.set('key', key);
      u.searchParams.set('cx', account.engine ?? '');
      u.searchParams.set('q', q.query);
      u.searchParams.set('num', String(Math.min(10, q.maxResults)));
      if (q.recency) u.searchParams.set('dateRestrict', FRESHNESS.google[q.recency]);
      if (q.site) { u.searchParams.set('siteSearch', q.site); u.searchParams.set('siteSearchFilter', 'i'); }
      return { url: u.toString(), init: { method: 'GET', headers: { Accept: 'application/json' } } };
    }
  }
}

const strip = (s: unknown) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export function parseResults(provider: SearchProvider, body: unknown, max: number): SearchResult[] {
  const b = (body ?? {}) as Record<string, any>;
  const rows: SearchResult[] =
    provider === 'tavily' ? (Array.isArray(b.results) ? b.results : []).map((r: any) => ({ title: strip(r.title), url: String(r.url ?? ''), snippet: strip(r.content).slice(0, 600), ...(r.published_date ? { published: String(r.published_date) } : {}) }))
    : provider === 'brave' ? (Array.isArray(b.web?.results) ? b.web.results : []).map((r: any) => ({ title: strip(r.title), url: String(r.url ?? ''), snippet: strip(r.description).slice(0, 600), ...(r.page_age || r.age ? { published: String(r.page_age ?? r.age) } : {}) }))
    : (Array.isArray(b.items) ? b.items : []).map((r: any) => ({ title: strip(r.title), url: String(r.link ?? ''), snippet: strip(r.snippet).slice(0, 600) }));
  return rows.filter((r) => /^https?:\/\//i.test(r.url)).slice(0, max);
}

/** Seconds from a Retry-After header (seconds or an HTTP date), as ms; null when absent. */
function retryAfter(h: Headers, now: number): number | null {
  const v = h.get('retry-after');
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/** Start of the next day in Google's quota time zone (Pacific), ms since epoch. */
export function nextPacificMidnight(now: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  const wall = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)])) as Record<string, number>;
    return { year: p.year, month: p.month, day: p.day, asUtc: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) };
  };
  const w = wall(now);
  const offset = (t: number) => wall(t).asUtc - Math.floor(t / 1000) * 1000;
  let guess = Date.UTC(w.year, w.month - 1, w.day + 1) - offset(now);
  guess = Date.UTC(w.year, w.month - 1, w.day + 1) - offset(guess);
  return guess;
}

/** The day an account's daily allowance counts in: Pacific for Google, UTC otherwise. */
export function dayKey(provider: SearchProvider, now: number): string {
  if (provider !== 'google') return new Date(now).toISOString().slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
export const monthKey = (now: number) => new Date(now).toISOString().slice(0, 7);

/** Read what a non-2xx answer means. `text` is the response body (JSON or not). */
export function classify(provider: SearchProvider, status: number, headers: Headers, text: string, now = Date.now()): Extract<CallOutcome, { ok: false }> {
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const detail = strip(body?.error?.message ?? body?.detail?.error ?? body?.detail ?? body?.error?.detail ?? body?.message ?? text).slice(0, 300) || `HTTP ${status}`;
  const msg = `${status}: ${detail}`;
  const ra = retryAfter(headers, now);
  if (status >= 500) return { ok: false, kind: 'error', message: msg, until: now + (ra ?? 30_000) };
  switch (provider) {
    case 'tavily':
      if (status === 401 || status === 403) return { ok: false, kind: 'rejected', message: msg };
      if (status === 429) return { ok: false, kind: 'rate', message: msg, until: now + (ra ?? MINUTE) };
      // 432: the plan's allowance is used up; 433: the pay-as-you-go limit. Re-checked daily: a plan renews on
      // its own billing day, which the API does not say.
      if (status === 432 || status === 433) return { ok: false, kind: 'quota', message: msg, until: now + DAY };
      break;
    case 'brave': {
      if (status === 401 || status === 403) return { ok: false, kind: 'rejected', message: msg };
      if (status === 422 && /token/i.test(text)) return { ok: false, kind: 'rejected', message: msg };
      if (status === 402) return { ok: false, kind: 'quota', message: msg, until: now + DAY };
      if (status === 429) {
        // "1, 15000": one value per window (per second, per month); Reset gives seconds until each window renews.
        const remaining = (headers.get('x-ratelimit-remaining') ?? '').split(',').map((s) => Number(s.trim()));
        const reset = (headers.get('x-ratelimit-reset') ?? '').split(',').map((s) => Number(s.trim()));
        if (remaining.length > 1 && remaining[remaining.length - 1] === 0) {
          const secs = reset[reset.length - 1];
          return { ok: false, kind: 'quota', message: msg, until: now + (Number.isFinite(secs) && secs > 0 ? secs * 1000 : DAY) };
        }
        const secs = reset[0];
        return { ok: false, kind: 'rate', message: msg, until: now + (ra ?? (Number.isFinite(secs) && secs > 0 ? secs * 1000 : 2000)) };
      }
      break;
    }
    case 'google': {
      const reasons = ((body?.error?.errors ?? []) as { reason?: string }[]).map((e) => e.reason ?? '').concat((body?.error?.details ?? []).map((d: { reason?: string }) => d.reason ?? ''));
      const daily = reasons.some((r) => /dailyLimitExceeded|quotaExceeded|RATE_LIMIT_EXCEEDED/i.test(r)) || /per day|quota/i.test(detail);
      if (status === 429 || reasons.some((r) => /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded/.test(r))) {
        return daily ? { ok: false, kind: 'quota', message: msg, until: nextPacificMidnight(now) } : { ok: false, kind: 'rate', message: msg, until: now + (ra ?? MINUTE) };
      }
      if (status === 400 && (reasons.some((r) => /keyInvalid|API_KEY_INVALID/i.test(r)) || /API key not valid/i.test(detail))) return { ok: false, kind: 'rejected', message: msg };
      if (status === 401 || status === 403) return { ok: false, kind: 'rejected', message: msg };
      break;
    }
  }
  if (status === 429) return { ok: false, kind: 'rate', message: msg, until: now + (ra ?? MINUTE) };
  return { ok: false, kind: 'bad_request', message: msg };
}

/** One request with one account. Never throws: network failures and timeouts are `error` outcomes. */
export async function callProvider(account: SearchAccount, key: string, q: WebSearchArgs, signal: AbortSignal, fetchFn: typeof fetch = fetch, opts: { timeoutMs?: number; now?: () => number } = {}): Promise<CallOutcome> {
  const req = buildRequest(account, key, q);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const now = (opts.now ?? Date.now)();
  let res: Response;
  try {
    res = await fetchFn(req.url, { ...req.init, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), redirect: 'error' });
  } catch (e) {
    if (signal.aborted) return { ok: false, kind: 'error', message: 'cancelled', until: now };
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    return { ok: false, kind: 'error', message: `${(e as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}${cause ? ` (${cause})` : ''}`, until: now + 30_000 };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) return classify(account.provider, res.status, res.headers, text, now);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { ok: false, kind: 'error', message: `${res.status}: the answer was not JSON`, until: now + 30_000 }; }
  return { ok: true, results: parseResults(account.provider, body, q.maxResults) };
}
