// Web access for agents (ADR 0030): search through the operator's accounts at Tavily, Brave and Google, reading pages
// as text, and a read-only browser on the open web. Accounts are operator data; their keys live in the OS credential
// store and never reach an agent, a model or the renderer.
import { z } from 'zod';
import { AgentRole } from './domain';

export const SearchProvider = z.enum(['tavily', 'brave', 'google']);
export type SearchProvider = z.infer<typeof SearchProvider>;

export const SEARCH_PROVIDERS: Record<SearchProvider, { title: string; keyHint: string; needsEngine: boolean; env: string; engineEnv?: string }> = {
  tavily: { title: 'Tavily', keyHint: 'tvly-…', needsEngine: false, env: 'TAVILY_API_KEY' },
  brave: { title: 'Brave Search', keyHint: 'subscription token', needsEngine: false, env: 'BRAVE_API_KEY' },
  google: { title: 'Google Programmable Search', keyHint: 'API key (AIza…)', needsEngine: true, env: 'GOOGLE_API_KEY', engineEnv: 'GOOGLE_CSE_ID' },
};

export const WEB_ACCOUNT_ID = /^wa_[A-Za-z0-9]{2,32}$/;

/** One account at a search provider. The key is stored separately, under the account's id. */
export const SearchAccount = z.object({
  id: z.string().regex(WEB_ACCOUNT_ID),
  provider: SearchProvider,
  label: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
  /** Google: the Programmable Search Engine id (cx). Not a secret. */
  engine: z.string().trim().min(1).max(200).optional(),
  /** Stop using the account after this many successful searches per day or month (its plan's allowance). */
  dailyLimit: z.number().int().min(1).max(1_000_000).optional(),
  monthlyLimit: z.number().int().min(1).max(100_000_000).optional(),
}).strict().superRefine((a, ctx) => {
  if (a.provider === 'google' && !a.engine) ctx.addIssue({ code: 'custom', message: 'A Google account needs its search engine id (cx)', path: ['engine'] });
});
export type SearchAccount = z.infer<typeof SearchAccount>;

export const WebSettings = z.object({
  /** Agents may use the web at all. Off by default: an operator turns it on. */
  enabled: z.boolean().default(false),
  /** Roles offered the web tools. */
  roles: z.array(AgentRole).max(10).default(['coder', 'reviewer', 'tester', 'security_reviewer']),
  /** Providers in the order they are tried. */
  order: z.array(SearchProvider).max(3).default(['tavily', 'brave', 'google']),
  /**
   * How a provider's accounts share the work. rotate: each search goes to the next account in turn. fill: use the
   * first account until it is out of searches, then the next.
   */
  strategy: z.enum(['rotate', 'fill']).default('rotate'),
  /** Sites agents may open without asking (host names; "*.example.com" includes subdomains). */
  allowedSites: z.array(z.string().trim().toLowerCase().regex(/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/, 'a host name like docs.python.org or *.mozilla.org')).max(200).default([]),
  /** The agent browser may send forms and other non-GET requests on the open web. Off: browsing only reads. */
  allowSubmit: z.boolean().default(false),
}).strict();
export type WebSettings = z.infer<typeof WebSettings>;

export type AccountHealth = 'ready' | 'cooling' | 'limit' | 'quota' | 'rejected' | 'no_key' | 'disabled';

export interface SearchAccountView {
  account: SearchAccount;
  /** From the environment rather than Settings (TAVILY_API_KEY …); cannot be edited here. */
  fromEnvironment: boolean;
  keySet: boolean;
  health: AccountHealth;
  /** Until when the account rests (rate limited, out of quota), ISO. */
  until: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  usedToday: number;
  usedThisMonth: number;
}

export interface WebView {
  settings: WebSettings;
  accounts: SearchAccountView[];
  /** Searches are possible now: web access on and at least one account ready or resting briefly. */
  searchReady: boolean;
  /** A Chromium for the agent browser was found. */
  browser: boolean;
}

/** Arguments of web_search. */
export const WebSearchArgs = z.object({
  query: z.string().trim().min(1).max(400),
  maxResults: z.number().int().min(1).max(10).default(5),
  recency: z.enum(['day', 'week', 'month', 'year']).optional(),
  /** Only results from this site (a host name). */
  site: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/).optional(),
  /** Use this provider only. */
  provider: SearchProvider.optional(),
}).strict();
export type WebSearchArgs = z.infer<typeof WebSearchArgs>;

export const WebFetchArgs = z.object({
  url: z.string().trim().url().max(2000),
  /** Character offset into the page text, to read on through a long page. */
  offset: z.number().int().min(0).max(5_000_000).default(0),
}).strict();
export type WebFetchArgs = z.infer<typeof WebFetchArgs>;

const ref = z.string().regex(/^e\d{1,5}$/, 'a ref from the latest snapshot, like e12');
const sel = z.string().max(500);
/** One step of web_browse: open a URL, then read and act on the page as with browser_action. */
export const WebBrowseStep = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), url: z.string().trim().url().max(2000) }).strict(),
  z.object({ action: z.literal('snapshot'), selector: sel.optional() }).strict(),
  z.object({ action: z.literal('text'), selector: sel.optional(), offset: z.number().int().min(0).max(5_000_000).default(0) }).strict(),
  z.object({ action: z.literal('click'), ref: ref.optional(), selector: sel.optional(), text: sel.optional() }).strict(),
  z.object({ action: z.literal('fill'), ref: ref.optional(), selector: sel.optional(), value: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('select'), ref: ref.optional(), selector: sel.optional(), value: z.string().max(500) }).strict(),
  z.object({ action: z.literal('check'), ref: ref.optional(), selector: sel.optional(), checked: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal('hover'), ref: ref.optional(), selector: sel.optional() }).strict(),
  z.object({ action: z.literal('press'), key: z.string().min(1).max(40), selector: sel.optional() }).strict(),
  z.object({ action: z.literal('scroll'), dy: z.number().int().min(-20_000).max(20_000).default(800) }).strict(),
  z.object({ action: z.literal('back') }).strict(),
  z.object({ action: z.literal('screenshot'), name: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('wait'), ms: z.number().int().min(0).max(10_000) }).strict(),
]).superRefine((s, ctx) => {
  if (['fill', 'select', 'check', 'hover'].includes(s.action) && !('ref' in s && s.ref) && !('selector' in s && s.selector)) ctx.addIssue({ code: 'custom', message: `${s.action} needs a ref or a selector` });
});
export type WebBrowseStep = z.infer<typeof WebBrowseStep>;
export const WebBrowseArgs = z.object({ step: WebBrowseStep }).strict();

/** Host of a URL, lowercase, without a trailing dot; null when it does not parse. */
export function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, ''); } catch { return null; }
}

/** Whether `host` is one of `sites` ("docs.python.org", or "*.mozilla.org" for it and its subdomains). */
export function siteAllowed(host: string, sites: readonly string[]): boolean {
  const h = host.toLowerCase();
  return sites.some((s) => (s.startsWith('*.') ? h === s.slice(2) || h.endsWith(s.slice(1)) : h === s));
}
