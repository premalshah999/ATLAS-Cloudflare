// Web access for agents (ADR 0030): turn the web on per role, add search accounts at Tavily, Brave and Google (several
// per provider, used in turn or one after another), see each account's state and usage, and choose which sites
// agents may open without asking. Keys go to the OS credential store through Electron main; this screen never sees
// a stored key.
import React, { useEffect, useState } from 'react';
import { newId, SEARCH_PROVIDERS, type AgentRole, type SearchAccount, type SearchAccountView, type SearchProvider, type WebSettings, type WebView } from '@atlas/contracts';
import { Badge, Button, Check, Field, Input, Seg, Status, Toggle } from '../ui/primitives';
import { call } from './api';
import { roleName } from './format';
import { toast } from './toast';

const WEB_ROLES: AgentRole[] = ['coder', 'reviewer', 'tester', 'security_reviewer'];
const PROVIDERS = Object.keys(SEARCH_PROVIDERS) as SearchProvider[];

const HEALTH: Record<SearchAccountView['health'], { s: string; text: string }> = {
  ready: { s: 'done', text: 'Ready' },
  cooling: { s: 'warning', text: 'Rate limited' },
  quota: { s: 'warning', text: 'Out of searches' },
  limit: { s: 'paused', text: 'At your limit' },
  rejected: { s: 'failed', text: 'Key rejected' },
  no_key: { s: 'failed', text: 'No key' },
  disabled: { s: 'paused', text: 'Off' },
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type Draft = { provider: SearchProvider; label: string; key: string; engine: string; dailyLimit: string; monthlyLimit: string };
const EMPTY: Draft = { provider: 'tavily', label: '', key: '', engine: '', dailyLimit: '', monthlyLimit: '' };

export function WebSection() {
  const [view, setView] = useState<WebView | null>(null);
  const [adding, setAdding] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<{ account: SearchAccount; key: string; dailyLimit: string; monthlyLimit: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sites, setSites] = useState('');
  const run = async <T extends WebView>(label: string, f: () => Promise<T>, after?: (v: T) => void) => {
    setBusy(label);
    try { const v = await f(); setView(v); after?.(v); } catch (e) { toast({ tone: 'danger', title: 'Web access not updated', body: (e as Error).message }); } finally { setBusy(null); }
  };
  useEffect(() => { void call('web.view').then((v) => { setView(v); setSites(v.settings.allowedSites.join('\n')); }).catch(() => {}); }, []);
  if (!view) return null;
  const s = view.settings;
  const save = (patch: Partial<WebSettings>) => run('settings', () => call('web.settings.save', { settings: { ...s, ...patch } }));
  const move = (p: SearchProvider, d: -1 | 1) => {
    const order = [...s.order];
    const i = order.indexOf(p);
    const j = i + d;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    void save({ order });
  };
  const byProvider = (p: SearchProvider) => view.accounts.filter((a) => a.account.provider === p);

  return (
    <section className="lv-section" data-testid="web-settings">
      <div className="at-label">Web access</div>
      <p className="at-muted lv-small">Let agents search the web, read pages and use a browser on the open web. Searches go through your accounts at Tavily, Brave or Google; add several per provider and ATLAS moves to the next one when an account is rate limited or out of searches. Pages are read from public addresses only, never your local network. Agents open what they found by searching, and the sites you list below, without asking; any other site needs your approval. The browser only reads unless you allow form submissions.</p>
      <div className="at-row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span data-testid="web-enabled"><Toggle on={s.enabled} onChange={(v) => void save({ enabled: v })} label="Agents may use the web" /></span>
        <span className="lv-small">Agents may use the web</span>
        <Badge tone={view.searchReady ? 'success' : 'outline'}>{view.searchReady ? 'search ready' : 'no search account ready'}</Badge>
        {!view.browser && <Badge tone="outline" title="Install a Chromium (or set ATLAS_CHROMIUM_PATH) for web_browse">no browser: reading pages only</Badge>}
      </div>
      {s.enabled && (
        <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
          <Field label="Roles with web access">
            <div className="at-row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {WEB_ROLES.map((r) => (
                <span key={r} className="at-row lv-small" style={{ gap: 6 }} data-testid={`web-role-${r}`}>
                  <Check on={s.roles.includes(r)} onChange={(v) => void save({ roles: v ? [...s.roles, r] : s.roles.filter((x) => x !== r) })} label={roleName(r)} />
                  <span>{roleName(r)}</span>
                </span>
              ))}
            </div>
          </Field>
          <Field label="Several accounts of a provider" help={s.strategy === 'rotate' ? 'Each search goes to the next account in turn, spreading the load.' : 'Use the first account until it is out of searches, then the next.'}>
            <Seg items={[{ id: 'rotate' as const, label: 'Take turns' }, { id: 'fill' as const, label: 'One after another' }]} value={s.strategy} onChange={(v) => void save({ strategy: v })} />
          </Field>
          <Field label="Sites agents may open without asking" help="One host per line: docs.python.org, or *.mozilla.org for a site and its subdomains." aside={<Button size="sm" data-testid="web-sites-save" disabled={sites.trim() === s.allowedSites.join('\n')} onClick={() => void save({ allowedSites: sites.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean) })}>Save sites</Button>}>
            <textarea className="lv-textarea at-mono" data-testid="web-sites" rows={3} value={sites} onChange={(e) => setSites(e.target.value)} placeholder={'developer.mozilla.org\n*.python.org'} />
          </Field>
          <span className="at-row lv-small" style={{ gap: 6 }} data-testid="web-allow-submit">
            <Check on={s.allowSubmit} onChange={(v) => void save({ allowSubmit: v })} label="Allow form submissions" />
            <span>Let the agent browser submit forms and send other non-GET requests (off: it only reads)</span>
          </span>
        </div>
      )}

      <div className="at-label" style={{ marginTop: 6 }}>Search accounts</div>
      <p className="at-subtle lv-small">Use accounts you are entitled to: a provider's terms may limit how many free accounts one person may hold. Set a daily or monthly limit to keep an account inside its plan.</p>
      {s.order.map((p, i) => (
        <div key={p} data-testid={`web-provider-${p}`} style={{ marginBottom: 10 }}>
          <div className="at-row" style={{ gap: 8, marginBottom: 6 }}>
            <b className="lv-small">{i + 1}. {SEARCH_PROVIDERS[p].title}</b>
            <span className="at-subtle lv-small">{byProvider(p).length} account{byProvider(p).length === 1 ? '' : 's'}</span>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(p, -1)} aria-label={`Try ${SEARCH_PROVIDERS[p].title} earlier`}>↑</Button>
            <Button size="sm" variant="ghost" disabled={i === s.order.length - 1} onClick={() => move(p, 1)} aria-label={`Try ${SEARCH_PROVIDERS[p].title} later`}>↓</Button>
          </div>
          {p === 'google' && <p className="at-subtle lv-small" style={{ marginTop: 0 }}>Google no longer takes new customers for the Custom Search JSON API and has announced its end on 1 January 2027; existing keys work until then.</p>}
          {byProvider(p).map((a) => {
            const h = HEALTH[a.health];
            const acc = a.account;
            return (
              <div key={acc.id} className="lv-card" data-testid="web-account" data-provider={p} data-health={a.health} style={{ marginBottom: 6 }}>
                <div className="at-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Status s={h.s} label={<b>{acc.label}</b>} />
                  <Badge tone={a.health === 'ready' ? 'success' : a.health === 'rejected' || a.health === 'no_key' ? 'danger' : 'outline'}>{h.text}{a.until ? ` until ${when(a.until)}` : ''}</Badge>
                  {a.fromEnvironment && <Badge tone="outline">from the environment</Badge>}
                  <span className="at-subtle lv-small" data-testid="web-account-usage">{a.usedToday} today{acc.dailyLimit ? ` of ${acc.dailyLimit}` : ''} · {a.usedThisMonth} this month{acc.monthlyLimit ? ` of ${acc.monthlyLimit}` : ''}</span>
                  <span style={{ flex: 1 }} />
                  {!a.fromEnvironment && <Toggle on={acc.enabled} onChange={(v) => void run('toggle', () => call('web.account.save', { account: { ...acc, enabled: v } }))} label="Enabled" />}
                </div>
                {a.lastError && a.health !== 'ready' && <div className="lv-small" style={{ color: 'var(--text-2)', marginTop: 4 }} data-testid="web-account-error">{a.lastError}</div>}
                <div className="at-row" style={{ gap: 8, marginTop: 8 }}>
                  <Button size="sm" data-testid="web-account-test" disabled={!!busy || !a.keySet} title="Runs one real search with this account" onClick={() => void run(`test:${acc.id}`, () => call('web.account.test', { id: acc.id }), (v) => toast({ tone: v.test.ok ? 'success' : 'danger', title: `${acc.label}: ${v.test.ok ? 'works' : 'did not work'}`, body: v.test.message }))}>{busy === `test:${acc.id}` ? 'Testing…' : 'Test'}</Button>
                  {(a.health === 'cooling' || a.health === 'quota' || a.health === 'rejected') && <Button size="sm" variant="ghost" data-testid="web-account-reset" onClick={() => void run('reset', () => call('web.account.reset', { id: acc.id }))}>Use again now</Button>}
                  {!a.fromEnvironment && <Button size="sm" variant="ghost" onClick={() => setEditing({ account: acc, key: '', dailyLimit: acc.dailyLimit ? String(acc.dailyLimit) : '', monthlyLimit: acc.monthlyLimit ? String(acc.monthlyLimit) : '' })}>Edit</Button>}
                  {!a.fromEnvironment && <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Remove the account ${acc.label} and its stored key?`)) void run('remove', () => call('web.account.remove', { id: acc.id })); }}>Remove</Button>}
                </div>
                {editing?.account.id === acc.id && (
                  <div style={{ display: 'grid', gap: 8, marginTop: 8 }} data-testid="web-account-edit">
                    <Field label="Label"><Input value={editing.account.label} onChange={(e) => setEditing({ ...editing, account: { ...editing.account, label: e.target.value } })} maxLength={60} /></Field>
                    <Field label="New key" help="Leave empty to keep the stored key."><Input type="password" autoComplete="off" spellCheck={false} value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value })} placeholder="•••••••• saved" /></Field>
                    <Limits daily={editing.dailyLimit} monthly={editing.monthlyLimit} onChange={(dl, ml) => setEditing({ ...editing, dailyLimit: dl, monthlyLimit: ml })} />
                    <div className="at-row" style={{ gap: 8 }}>
                      <Button size="sm" variant="primary" disabled={!editing.account.label.trim()} onClick={() => void run('edit', () => call('web.account.save', { account: withLimits({ ...editing.account, label: editing.account.label.trim() }, editing.dailyLimit, editing.monthlyLimit), ...(editing.key.trim() ? { key: editing.key.trim() } : {}) }), () => setEditing(null))}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {!adding && <Button size="sm" data-testid="web-add-account" onClick={() => setAdding({ ...EMPTY, label: `${SEARCH_PROVIDERS.tavily.title} ${byProvider('tavily').length + 1}` })}>Add search account</Button>}
      {adding && <AccountForm draft={adding} setDraft={setAdding} count={(p) => byProvider(p).length} busy={!!busy} onCancel={() => setAdding(null)} onSave={(account, key) => void run('add', () => call('web.account.save', { account, key }), () => setAdding(null))} />}
    </section>
  );
}

function withLimits(a: SearchAccount, daily: string, monthly: string): SearchAccount {
  const { dailyLimit: _d, monthlyLimit: _m, ...rest } = a;
  return { ...rest, ...(Number(daily) > 0 ? { dailyLimit: Math.floor(Number(daily)) } : {}), ...(Number(monthly) > 0 ? { monthlyLimit: Math.floor(Number(monthly)) } : {}) };
}

function Limits({ daily, monthly, onChange }: { daily: string; monthly: string; onChange: (daily: string, monthly: string) => void }) {
  return (
    <div className="at-row" style={{ gap: 8 }}>
      <Field label="Daily limit" help="Optional"><Input data-testid="web-form-daily" inputMode="numeric" value={daily} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''), monthly)} placeholder="none" /></Field>
      <Field label="Monthly limit" help="Optional"><Input data-testid="web-form-monthly" inputMode="numeric" value={monthly} onChange={(e) => onChange(daily, e.target.value.replace(/\D/g, ''))} placeholder="none" /></Field>
    </div>
  );
}

function AccountForm({ draft: d, setDraft, count, busy, onCancel, onSave }: { draft: Draft; setDraft: (d: Draft) => void; count: (p: SearchProvider) => number; busy: boolean; onCancel: () => void; onSave: (a: SearchAccount, key: string) => void }) {
  const p = SEARCH_PROVIDERS[d.provider];
  const problem = !d.label.trim() ? 'A label is required.' : d.key.trim().length < 8 ? 'Paste the API key.' : p.needsEngine && !d.engine.trim() ? 'Google needs the search engine id (cx).' : null;
  return (
    <div className="lv-card" data-testid="web-form" style={{ display: 'grid', gap: 8 }}>
      <Field label="Provider">
        <Seg items={PROVIDERS.map((id) => ({ id, label: SEARCH_PROVIDERS[id].title }))} value={d.provider} onChange={(v) => setDraft({ ...d, provider: v, label: `${SEARCH_PROVIDERS[v].title} ${count(v) + 1}` })} />
      </Field>
      <Field label="Label" help="To tell your accounts apart, e.g. Trial 2 or Work."><Input data-testid="web-form-label" value={d.label} onChange={(e) => setDraft({ ...d, label: e.target.value })} maxLength={60} /></Field>
      <Field label="API key" help={`Encrypted with the OS credential store. Without one, export ${p.env}${p.engineEnv ? ` and ${p.engineEnv}` : ''} before launching ATLAS.`}>
        <Input data-testid="web-form-key" type="password" autoComplete="off" spellCheck={false} value={d.key} onChange={(e) => setDraft({ ...d, key: e.target.value })} placeholder={p.keyHint} />
      </Field>
      {p.needsEngine && <Field label="Search engine id (cx)" help="From programmablesearchengine.google.com."><Input data-testid="web-form-engine" value={d.engine} onChange={(e) => setDraft({ ...d, engine: e.target.value })} /></Field>}
      <Limits daily={d.dailyLimit} monthly={d.monthlyLimit} onChange={(dl, ml) => setDraft({ ...d, dailyLimit: dl, monthlyLimit: ml })} />
      {problem && <div className="at-subtle lv-small">{problem}</div>}
      <div className="at-row" style={{ gap: 8 }}>
        <Button variant="primary" data-testid="web-form-save" disabled={!!problem || busy} onClick={() => onSave(withLimits({ id: newId('wa'), provider: d.provider, label: d.label.trim(), enabled: true, ...(p.needsEngine ? { engine: d.engine.trim() } : {}) }, d.dailyLimit, d.monthlyLimit), d.key.trim())}>Save account</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
