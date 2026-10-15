// The search account pool (ADR 0030). The operator lists accounts per provider; each search goes to an account
// that is ready, in the operator's provider order. An account that is rate limited, out of its allowance or
// rejected rests until it can work again, and the search moves on to the next account, then the next provider.
// Usage is counted per account per day and month, so an account stops at the limit the operator set for it.
import { createHash } from 'node:crypto';
import type { AccountHealth, SearchAccount, SearchAccountView, SearchProvider, WebSearchArgs, WebSettings } from '@atlas/contracts';
import { callProvider, dayKey, monthKey, type CallOutcome, type FailureKind, type SearchResult } from './providers';

export interface AccountState {
  day: string; usedDay: number;
  month: string; usedMonth: number;
  /** Resting until (ms since epoch), and why. */
  until: number | null;
  reason: FailureKind | null;
  lastError: string | null;
  lastUsedAt: number | null;
  /** Hash of the key the state belongs to: a new key clears a rejection. */
  keyHash: string | null;
}
export interface PoolState { accounts: Record<string, AccountState>; cursor: Partial<Record<SearchProvider, number>> }

export interface PoolOptions {
  accounts(): SearchAccount[];
  settings(): WebSettings;
  key(accountId: string): string | undefined;
  load(): PoolState;
  save(s: PoolState): void;
  fetch?: typeof fetch;
  now?: () => number;
  /** At most this many requests for one search (across accounts and providers). */
  maxTries?: number;
}

export interface Attempt { accountId: string; label: string; provider: SearchProvider; outcome: 'ok' | FailureKind; detail: string }
export type SearchOutcome =
  | { ok: true; provider: SearchProvider; accountId: string; label: string; results: SearchResult[]; attempts: Attempt[]; ms: number }
  | { ok: false; message: string; attempts: Attempt[]; ms: number };

const hashKey = (k: string) => createHash('sha256').update(k).digest('hex').slice(0, 16);
const fresh = (): AccountState => ({ day: '', usedDay: 0, month: '', usedMonth: 0, until: null, reason: null, lastError: null, lastUsedAt: null, keyHash: null });

export class SearchPool {
  constructor(private readonly o: PoolOptions) {}

  private now() { return this.o.now?.() ?? Date.now(); }

  /** An account's state, with counters rolled over to the current day and month and stale rejections cleared. */
  private stateOf(s: PoolState, a: SearchAccount): AccountState {
    const st = { ...fresh(), ...s.accounts[a.id] };
    const now = this.now();
    const d = dayKey(a.provider, now);
    const m = monthKey(now);
    if (st.day !== d) { st.day = d; st.usedDay = 0; }
    if (st.month !== m) { st.month = m; st.usedMonth = 0; }
    const key = this.o.key(a.id);
    const kh = key ? hashKey(key) : null;
    if (kh && st.keyHash && kh !== st.keyHash) { st.until = null; st.reason = null; st.lastError = null; }
    st.keyHash = kh ?? st.keyHash;
    if (st.until !== null && st.until <= now) { st.until = null; if (st.reason !== 'rejected') st.reason = null; }
    return st;
  }

  health(a: SearchAccount, st: AccountState): AccountHealth {
    if (!a.enabled) return 'disabled';
    if (!this.o.key(a.id)) return 'no_key';
    if (st.reason === 'rejected') return 'rejected';
    if (st.until !== null && st.until > this.now()) return st.reason === 'quota' ? 'quota' : 'cooling';
    if ((a.dailyLimit && st.usedDay >= a.dailyLimit) || (a.monthlyLimit && st.usedMonth >= a.monthlyLimit)) return 'limit';
    return 'ready';
  }

  view(fromEnvironment: (id: string) => boolean): SearchAccountView[] {
    const s = this.o.load();
    return this.o.accounts().map((account) => {
      const st = this.stateOf(s, account);
      const health = this.health(account, st);
      return {
        account, fromEnvironment: fromEnvironment(account.id), keySet: !!this.o.key(account.id), health,
        until: st.until && st.until > this.now() ? new Date(st.until).toISOString() : null,
        lastError: st.lastError, lastUsedAt: st.lastUsedAt ? new Date(st.lastUsedAt).toISOString() : null,
        usedToday: st.usedDay, usedThisMonth: st.usedMonth,
      };
    });
  }

  /** Accounts of a provider in the order to try them now: ready ones, rotated or in list order. */
  private candidates(s: PoolState, provider: SearchProvider, strategy: WebSettings['strategy']): { account: SearchAccount; index: number }[] {
    const all = this.o.accounts().filter((a) => a.provider === provider);
    const start = strategy === 'rotate' ? (s.cursor[provider] ?? 0) % Math.max(1, all.length) : 0;
    const ordered = [...all.slice(start), ...all.slice(0, start)].map((account) => ({ account, index: all.indexOf(account) }));
    return ordered.filter(({ account }) => this.health(account, this.stateOf(s, account)) === 'ready');
  }

  /** Why no account of the configured providers could take a search, one line per account. */
  private unavailable(s: PoolState, providers: SearchProvider[]): string {
    const lines = this.o.accounts().filter((a) => providers.includes(a.provider)).map((a) => {
      const st = this.stateOf(s, a);
      const h = this.health(a, st);
      const when = st.until ? ` until ${new Date(st.until).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '';
      const why = { ready: 'ready', disabled: 'turned off', no_key: 'no key', rejected: `key rejected (${st.lastError ?? ''})`, cooling: `rate limited${when}`, quota: `out of searches${when}`, limit: 'reached the limit set for it' }[h];
      return `- ${a.label} (${a.provider}): ${why}`;
    });
    return lines.length ? lines.join('\n') : `- no accounts for ${providers.join(', ')}`;
  }

  async search(q: WebSearchArgs, signal: AbortSignal): Promise<SearchOutcome> {
    const t0 = this.now();
    const settings = this.o.settings();
    const providers = q.provider ? [q.provider] : settings.order;
    const attempts: Attempt[] = [];
    const maxTries = this.o.maxTries ?? 8;
    for (const provider of providers) {
      // Candidates are chosen once per provider; a failure marks the account and the loop moves on.
      for (const { account, index } of this.candidates(this.o.load(), provider, settings.strategy)) {
        if (attempts.length >= maxTries || signal.aborted) break;
        const key = this.o.key(account.id);
        if (!key) continue;
        const r: CallOutcome = await callProvider(account, key, q, signal, this.o.fetch, { now: () => this.now() });
        // Re-read: another search may have changed the state while this one waited.
        const s = this.o.load();
        const st = this.stateOf(s, account);
        st.lastUsedAt = this.now();
        if (r.ok) {
          st.usedDay++; st.usedMonth++; st.lastError = null; st.reason = null; st.until = null;
          s.accounts[account.id] = st;
          if (settings.strategy === 'rotate') s.cursor[provider] = index + 1;
          this.o.save(s);
          attempts.push({ accountId: account.id, label: account.label, provider, outcome: 'ok', detail: `${r.results.length} results` });
          return { ok: true, provider, accountId: account.id, label: account.label, results: r.results, attempts, ms: this.now() - t0 };
        }
        if (signal.aborted) { this.o.save(s); return { ok: false, message: 'Cancelled', attempts, ms: this.now() - t0 }; }
        attempts.push({ accountId: account.id, label: account.label, provider, outcome: r.kind, detail: r.message });
        if (r.kind === 'bad_request') {
          // The service refused the query itself: another account would refuse it too. The account is fine.
          st.lastError = r.message;
          s.accounts[account.id] = st;
          this.o.save(s);
          return { ok: false, message: `${provider} refused the query: ${r.message}`, attempts, ms: this.now() - t0 };
        }
        st.reason = r.kind; st.lastError = r.message;
        st.until = r.kind === 'rejected' ? null : r.until ?? this.now() + 30_000;
        s.accounts[account.id] = st;
        if (settings.strategy === 'rotate') s.cursor[provider] = index + 1;
        this.o.save(s);
      }
    }
    const s = this.o.load();
    const tried = attempts.length ? `Tried:\n${attempts.map((a) => `- ${a.label} (${a.provider}): ${a.outcome} — ${a.detail}`).join('\n')}\n` : '';
    return { ok: false, message: `No search account could answer.\n${tried}Accounts:\n${this.unavailable(s, providers)}`, attempts, ms: this.now() - t0 };
  }

  /** The operator's "Test": one small search with this account only, recorded like any other. */
  async test(accountId: string, signal: AbortSignal): Promise<{ ok: boolean; message: string }> {
    const account = this.o.accounts().find((a) => a.id === accountId);
    if (!account) return { ok: false, message: 'No such account' };
    const key = this.o.key(accountId);
    if (!key) return { ok: false, message: 'No key is stored for this account' };
    const r = await callProvider(account, key, { query: 'ATLAS connection test', maxResults: 1 }, signal, this.o.fetch, { now: () => this.now() });
    const s = this.o.load();
    const st = this.stateOf(s, account);
    st.lastUsedAt = this.now();
    if (r.ok) { st.usedDay++; st.usedMonth++; st.until = null; st.reason = null; st.lastError = null; }
    else if (r.kind !== 'bad_request') { st.reason = r.kind; st.lastError = r.message; st.until = r.kind === 'rejected' ? null : r.until ?? null; }
    else st.lastError = r.message;
    s.accounts[accountId] = st;
    this.o.save(s);
    return r.ok ? { ok: true, message: `Works: ${r.results.length ? `first result ${r.results[0].url}` : 'no results, but the key was accepted'}` } : { ok: false, message: `${r.kind === 'rejected' ? 'Key rejected' : r.kind === 'quota' ? 'Out of searches' : r.kind === 'rate' ? 'Rate limited' : 'Failed'}: ${r.message}` };
  }

  /** Clear an account's rest and error (the operator renewed its plan or fixed its key). Usage counts stay. */
  reset(accountId: string) {
    const s = this.o.load();
    const st = s.accounts[accountId];
    if (!st) return;
    s.accounts[accountId] = { ...st, until: null, reason: null, lastError: null };
    this.o.save(s);
  }

  forget(accountId: string) {
    const s = this.o.load();
    delete s.accounts[accountId];
    this.o.save(s);
  }
}

export const emptyPoolState = (): PoolState => ({ accounts: {}, cursor: {} });
