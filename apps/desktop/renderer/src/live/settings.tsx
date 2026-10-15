// Settings & models (manual §24, §43): runtime health, provider credentials, versions and provenance.
import React, { useEffect, useState } from 'react';
import type { RuntimeHealth, ProviderId } from '@atlas/contracts';
import { Badge, Button, Field, Input, KV, Status, Toggle } from '../ui/primitives';
import { call, type AppInfo, type Credentials, type DesktopState, type RoleInfo, type SettingsState } from './api';
import { CloudSettings, ModelSettings } from './cloud';
import { roleName } from './format';
import { toast } from './toast';

const NAMES: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google Gemini', openrouter: 'OpenRouter', deepseek: 'DeepSeek', xai: 'xAI', groq: 'Groq', mistral: 'Mistral', cerebras: 'Cerebras' };

export function Settings() {
  const [health, setHealth] = useState<RuntimeHealth[] | null>(null);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [confirmUnsafe, setConfirmUnsafe] = useState(false);
  const load = () => {
    void call('runtime.health').then(setHealth).catch(() => {});
    void call('credentials.list').then(setCreds).catch(() => {});
    void call('app.info').then(setInfo).catch(() => {});
    void call('settings.get').then(setSettings).catch(() => {});
  };
  const setUnsandboxed = async (value: boolean) => {
    try { setSettings(await call('settings.set', { key: 'execution.allowUnsandboxed', value })); setConfirmUnsafe(false); }
    catch (e) { toast({ tone: 'danger', title: 'Setting not saved', body: (e as Error).message }); }
  };
  useEffect(load, []);
  const save = async (provider: ProviderId) => {
    try { setCreds(await call('credentials.set', { provider, key: draft[provider] ?? '' })); setDraft((d) => ({ ...d, [provider]: '' })); toast({ tone: 'info', title: `${NAMES[provider]} key saved`, body: 'Encrypted with the OS credential store. It is never shown again or sent to the interface.' }); load(); }
    catch (e) { toast({ tone: 'danger', title: 'Key not saved', body: (e as Error).message }); }
  };
  const remove = async (provider: ProviderId) => {
    try { setCreds(await call('credentials.remove', { provider })); toast({ tone: 'info', title: `${NAMES[provider]} key removed` }); load(); }
    catch (e) { toast({ tone: 'danger', title: 'Key not removed', body: (e as Error).message }); }
  };
  return (
    <div className="at-screen lv-page" data-testid="settings">
      <div className="at-pagehead"><span className="heading">Settings</span></div>
      <div className="lv-scroll">
        <div className="lv-narrow">
          <section className="lv-section">
            <div className="at-label">Agent runtimes</div>
            {(health ?? []).map((h) => (
              <div key={h.runtime} className="lv-rt" data-testid={`runtime-${h.runtime}`}>
                <Status s={h.ok ? 'done' : 'warning'} label={h.runtime === 'pi' ? `Pi ${h.version}` : 'Scripted runtime'} />
                <span className="at-muted lv-small">{h.detail}</span>
              </div>
            ))}
            {!health && <div className="at-subtle lv-small">Checking…</div>}
          </section>
          <section className="lv-section" data-testid="isolation">
            <div className="at-label">Execution isolation</div>
            {settings && (
              <div className="lv-rt">
                <Status s={settings.sandbox.kind === 'none' ? 'failed' : 'done'} label={settings.sandbox.kind === 'bwrap' ? 'Sandboxed · bubblewrap' : settings.sandbox.kind === 'sandbox-exec' ? 'Sandboxed · macOS Seatbelt' : 'No OS sandbox'} />
                <span className="at-muted lv-small">
                  {settings.sandbox.kind === 'none'
                    ? settings.sandbox.detail
                    : settings.sandbox.kind === 'sandbox-exec' ? 'macOS Seatbelt restricts home-directory reads, writes and network access. Unlike Linux bubblewrap, it does not provide a private process namespace.' : 'Agent commands and checks run with no access to your home directory, other projects or credentials, no network unless you approve a network command, and their own process namespace.'}
                </span>
              </div>
            )}
            {settings?.sandbox.kind === 'none' && (
              <div className="lv-callout" style={{ marginTop: 0 }}>
                <div style={{ flex: 1 }}>
                  <b>Allow unsandboxed execution.</b> Repository scripts and approved commands would run as your user and could read your files and credentials. Only enable this for repositories you fully trust.
                  <div className="at-row" style={{ gap: 8, marginTop: 8 }}>
                    {settings.values['execution.allowUnsandboxed']
                      ? <><Badge tone="danger">unsandboxed execution allowed</Badge><Button size="sm" onClick={() => void setUnsandboxed(false)}>Turn off</Button></>
                      : confirmUnsafe
                        ? <><Button size="sm" variant="danger-fill" onClick={() => void setUnsandboxed(true)}>I understand, allow it</Button><Button size="sm" variant="ghost" onClick={() => setConfirmUnsafe(false)}>Cancel</Button></>
                        : <Toggle on={false} onChange={() => setConfirmUnsafe(true)} label="Allow unsandboxed execution" />}
                  </div>
                </div>
              </div>
            )}
          </section>
          {settings && <DesktopSection settings={settings} onChange={setSettings} />}
          {settings && <DeploySection settings={settings} onChange={setSettings} />}
          {settings && <RetentionSection settings={settings} onChange={setSettings} />}
          <RolesSection />
          {settings && <CloudSettings settings={settings} onChange={setSettings} />}
          {settings && <ModelSettings settings={settings} health={health ?? []} onChange={(s) => { setSettings(s); load(); }} />}
          <section className="lv-section">
            <div className="at-label">Model provider keys</div>
            <p className="at-muted lv-small">Keys are encrypted with the operating system credential store and passed only to the agent runtime process. They are redacted from every log, event and artifact.{creds && !creds.available ? ' No credential store is available on this system: export the variable before launching ATLAS instead.' : ''}</p>
            {creds?.providers.map((p) => (
              <Field key={p.provider} label={NAMES[p.provider]} aside={p.stored ? <Badge tone="success">saved</Badge> : p.fromEnvironment ? <Badge tone="outline">from {p.env}</Badge> : <Badge tone="outline">not set</Badge>}>
                <div className="at-row" style={{ gap: 8 }}>
                  <Input type="password" autoComplete="off" spellCheck={false} placeholder={p.stored ? '•••••••• saved' : `Paste a ${NAMES[p.provider]} API key`} value={draft[p.provider] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [p.provider]: e.target.value }))} style={{ flex: 1 }} disabled={!creds.available} />
                  <Button disabled={!creds.available || (draft[p.provider] ?? '').trim().length < 8} onClick={() => void save(p.provider as any)}>Save</Button>
                  {p.stored && <Button variant="ghost" onClick={() => void remove(p.provider as any)}>Remove</Button>}
                </div>
              </Field>
            ))}
          </section>
          <section className="lv-section">
            <div className="at-label">About</div>
            {info && <KV col={150} rows={[
              ['ATLAS', info.version], ['Electron', info.electron], ['Chromium', info.chrome], ['Daemon Node', info.node], ['Database schema', `v${info.schema}`],
              ['Pi runtime', `${info.pi.package}@${info.pi.version}`], ['Pi source', `${info.pi.repository} @ ${info.pi.gitHead.slice(0, 12)} · ${info.pi.license}`],
              ['Network', 'No telemetry. Model requests, approved network commands, and explicit Cloudflare publication.'],
            ]} />}
          </section>
        </div>
      </div>
    </div>
  );
}

type OnSettings = (s: SettingsState) => void;
const saveSetting = async (body: Parameters<typeof call<'settings.set'>>[1], onChange: OnSettings) => {
  try { onChange(await call('settings.set', body)); } catch (e) { toast({ tone: 'danger', title: 'Setting not saved', body: (e as Error).message }); }
};

function DesktopSection({ settings, onChange }: { settings: SettingsState; onChange: OnSettings }) {
  const [d, setD] = useState<DesktopState | null>(null);
  useEffect(() => { void call('desktop.list').then(setD).catch(() => {}); }, [settings.values['desktop.enabled']]);
  const on = settings.values['desktop.enabled'];
  return (
    <section className="lv-section" data-testid="desktop-settings">
      <div className="at-label">Desktop control</div>
      <div className="lv-rt">
        <Status s={!d ? 'draft' : !d.support.ok ? 'failed' : on ? 'done' : 'idle'} label={!d ? 'Checking…' : !d.support.ok ? 'Unavailable on this system' : on ? 'Enabled · virtual displays only' : 'Off'} />
        <span className="at-muted lv-small">{d?.support.ok === false ? d.support.detail : 'A desktop operator agent gets a new, empty virtual display for one attempt. Your own desktop is never captured or controlled. Every session still needs your approval, and you can take over, pause or stop it at any time.'}</span>
      </div>
      <label className="lv-toggle-row"><Toggle on={on} onChange={(v) => void saveSetting({ key: 'desktop.enabled', value: v }, onChange)} label="Allow desktop operator agents to request a virtual desktop" /><span>Allow desktop operator agents to request a virtual desktop</span></label>
      {d && d.sessions.length > 0 && <div className="at-subtle lv-small">{d.sessions.length} session(s) running: {d.sessions.map((x) => `${x.display} (${x.controller})`).join(', ')}</div>}
    </section>
  );
}

function DeploySection({ settings, onChange }: { settings: SettingsState; onChange: OnSettings }) {
  const allowed = settings.values['deploy.allowedTargets'];
  const [draft, setDraft] = useState('');
  const [secrets, setSecrets] = useState<{ target: string; names: string[] }[]>([]);
  const [sec, setSec] = useState({ target: '', name: '', value: '' });
  useEffect(() => { void call('deploy.secrets.list').then(setSecrets).catch(() => {}); }, []);
  const setAllowed = (v: string[]) => void saveSetting({ key: 'deploy.allowedTargets', value: v }, onChange);
  return (
    <section className="lv-section" data-testid="deploy-settings">
      <div className="at-label">Deployments</div>
      <p className="at-muted lv-small" style={{ margin: 0 }}>Missions can deploy only to staging targets defined in the project's atlas.config.json <b>and</b> listed here. Each deployment still needs your approval. Production is never available.</p>
      <Field label="Allowed staging targets">
        <div className="at-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {allowed.length === 0 && <span className="at-subtle lv-small">None. Nothing can be deployed.</span>}
          {allowed.map((t) => <span key={t} className="at-chip at-mono">{t} <button type="button" className="lv-link" aria-label={`Remove ${t}`} onClick={() => setAllowed(allowed.filter((x) => x !== t))}>×</button></span>)}
        </div>
        <form className="at-row" style={{ gap: 6, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (t && !allowed.includes(t)) setAllowed([...allowed, t]); setDraft(''); }}>
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Target name, e.g. local-staging" style={{ width: 240 }} data-testid="allow-target" />
          <Button type="submit" disabled={!draft.trim()}>Allow target</Button>
        </form>
      </Field>
      <label className="lv-toggle-row"><Toggle on={settings.values['deploy.autoRollback']} onChange={(v) => void saveSetting({ key: 'deploy.autoRollback', value: v }, onChange)} label="Roll back automatically when staging verification fails" /><span>Roll back automatically when staging verification fails</span></label>
      <Field label="Deploy secrets" help="Injected only into the deploy command for that target, encrypted with the OS credential store, redacted everywhere. Names are shown; values never are.">
        {secrets.map((t) => (
          <div key={t.target} className="at-row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="at-mono lv-small">{t.target}</span>
            {t.names.map((n) => <span key={n} className="at-chip at-mono">{n} <button type="button" className="lv-link" aria-label={`Remove ${n}`} onClick={() => void call('deploy.secrets.remove', { target: t.target, name: n }).then(setSecrets).catch(() => {})}>×</button></span>)}
          </div>
        ))}
        <form className="at-row" style={{ gap: 6, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); void call('deploy.secrets.set', sec).then((r) => { setSecrets(r); setSec({ target: sec.target, name: '', value: '' }); toast({ tone: 'info', title: 'Secret saved', body: `${sec.name} for ${sec.target}` }); }).catch((err) => toast({ tone: 'danger', title: 'Secret not saved', body: (err as Error).message })); }}>
          <Input value={sec.target} onChange={(e) => setSec({ ...sec, target: e.target.value })} placeholder="target" style={{ width: 140 }} />
          <Input value={sec.name} onChange={(e) => setSec({ ...sec, name: e.target.value.toUpperCase() })} placeholder="NAME" style={{ width: 160 }} />
          <Input type="password" autoComplete="off" value={sec.value} onChange={(e) => setSec({ ...sec, value: e.target.value })} placeholder="value" style={{ flex: 1 }} />
          <Button type="submit" disabled={!sec.target || !/^[A-Z_][A-Z0-9_]*$/.test(sec.name) || !sec.value}>Save</Button>
        </form>
      </Field>
    </section>
  );
}

function RetentionSection({ settings, onChange }: { settings: SettingsState; onChange: OnSettings }) {
  const [days, setDays] = useState(String(settings.values['retention.days']));
  return (
    <section className="lv-section">
      <div className="at-label">Data retention</div>
      <p className="at-muted lv-small" style={{ margin: 0 }}>Decided missions older than this are deleted with their events, artifacts and worktrees (accepted branches are kept in your repository). 0 keeps everything. Export a mission first to keep its audit log.</p>
      <form className="at-row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void saveSetting({ key: 'retention.days', value: Math.max(0, Math.min(3650, Math.round(Number(days) || 0))) }, onChange); }}>
        <Input type="number" min={0} max={3650} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 120 }} />
        <span className="at-subtle lv-small">days</span>
        <Button type="submit">Save</Button>
        <span className="at-subtle lv-small">Current: {settings.values['retention.days'] || 'keep forever'}</span>
      </form>
    </section>
  );
}

function RolesSection() {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { void call('roles.list').then(setRoles).catch(() => {}); }, []);
  return (
    <section className="lv-section" data-testid="roles">
      <div className="at-label">Agent roles</div>
      <p className="at-muted lv-small" style={{ margin: 0 }}>Versioned role definitions. Tools bound what a plan may give a role; capabilities are what policy grants. Neither instructions nor a plan can widen them.</p>
      {roles.map((r) => (
        <div key={r.id} className="lv-rt">
          <div className="at-row" style={{ gap: 8 }}>
            <span className="body-strong">{roleName(r.id)}</span><span className="at-mono at-subtle lv-small">{r.version}</span>
            {r.writes && <Badge tone="outline">writes code</Badge>}
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Instructions'}</Button>
          </div>
          <div className="at-row" style={{ gap: 4, flexWrap: 'wrap' }}>{r.tools.map((t) => <span key={t} className="at-chip at-mono">{t}</span>)}</div>
          <span className="at-subtle lv-small">Capabilities: {r.capabilities.join(', ') || 'none'} · per attempt ≤ {r.budget.maxToolCalls} tool calls, {r.budget.maxTokens.toLocaleString()} tokens, {Math.round(r.budget.wallClockMs / 60000)} min · model: {r.modelPreference}</span>
          {open === r.id && <pre className="lv-proc-body" style={{ maxHeight: 240, whiteSpace: 'pre-wrap' }}>{r.instructions}</pre>}
        </div>
      ))}
    </section>
  );
}
