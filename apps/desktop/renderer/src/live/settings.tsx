// Settings & models (manual §24, §43): runtime health, provider credentials, versions and provenance.
import React, { useEffect, useState } from 'react';
import { PROVIDERS, type ModelInfo, type RuntimeHealth } from '@atlas/contracts';
import { Badge, Button, Field, Input, KV, Status, Toggle } from '../ui/primitives';
import { call, type Maintenance, type AppInfo, type Credentials, type DesktopState, type RoleInfo, type SettingsState } from './api';
import { CloudSettings } from './cloud';
import { roleName } from './format';
import { toast } from './toast';
import { ModelSelect } from './models';
import { McpSection } from './mcp';
import { WebSection } from './web';
import { SkillsSection } from './skills';
import { SyncSection } from './sync';

const NAMES: Record<string, string> = { ...Object.fromEntries(PROVIDERS.map((p) => [p.id, p.label])), github: 'GitHub' };
type Provider = string;

export function Settings() {
  const [health, setHealth] = useState<RuntimeHealth[] | null>(null);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [confirmUnsafe, setConfirmUnsafe] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [adding, setAdding] = useState('');
  const load = () => {
    void call('runtime.health').then(setHealth).catch(() => {});
    void call('credentials.list').then(setCreds).catch(() => {});
    void call('app.info').then(setInfo).catch(() => {});
    void call('settings.get').then(setSettings).catch(() => {});
    void call('models.list').then(setModels).catch(() => setModels([]));
  };
  const setUnsandboxed = async (value: boolean) => {
    try { setSettings(await call('settings.set', { key: 'execution.allowUnsandboxed', value })); setConfirmUnsafe(false); }
    catch (e) { toast({ tone: 'danger', title: 'Setting not saved', body: (e as Error).message }); }
  };
  useEffect(load, []);
  const save = async (provider: Provider) => {
    try { setCreds(await call('credentials.set', { provider, key: draft[provider] ?? '' })); setDraft((d) => ({ ...d, [provider]: '' })); toast({ tone: 'info', title: `${NAMES[provider]} key saved`, body: 'Encrypted with the OS credential store. It is never shown again or sent to the interface.' }); load(); void test(provider); }
    catch (e) { toast({ tone: 'danger', title: 'Key not saved', body: (e as Error).message }); }
  };
  const [testing, setTesting] = useState('');
  const [tested, setTested] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const test = async (provider: Provider) => {
    setTesting(provider);
    try { const r = await call('credentials.test', { provider }); setTested((t) => ({ ...t, [provider]: r })); }
    catch (e) { setTested((t) => ({ ...t, [provider]: { ok: false, detail: (e as Error).message } })); }
    finally { setTesting(''); }
  };
  const remove = async (provider: Provider) => {
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
                <Status s={settings.sandbox.kind === 'none' ? 'failed' : 'done'} label={settings.sandbox.kind === 'bwrap' ? 'Sandboxed · bubblewrap' : settings.sandbox.kind === 'sandbox-exec' ? 'Sandboxed · macOS Seatbelt' : settings.sandbox.kind === 'windows-account' ? 'Sandboxed · Windows sandbox account' : settings.sandbox.kind === 'appcontainer' ? 'Partly sandboxed · Windows AppContainer' : 'No OS sandbox'} />
                <span className="at-muted lv-small">
                  {settings.sandbox.kind === 'none'
                    ? settings.sandbox.detail
                    : settings.sandbox.kind === 'sandbox-exec' ? 'macOS Seatbelt restricts home-directory reads, writes and network access. Unlike Linux bubblewrap, it does not provide a private process namespace.' : 'Agent commands and checks run with no access to your home directory, other projects or credentials, no network unless you approve a network command, and their own process namespace.'}
                </span>
              </div>
            )}
            {settings?.windowsAccounts && <WindowsAccounts settings={settings} onChange={setSettings} />}
          {settings?.sandbox.kind === 'none' && (
              <div className="lv-callout" style={{ marginTop: 0 }}>
                <div style={{ flex: 1 }}>
                  <b>Allow unsandboxed execution.</b> Verification checks would run repository scripts as your user, and could read your files and credentials. Agent commands that run project code (tests, scripts, node) would each ask for your approval first. Only enable this for repositories you fully trust.
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
          {settings && <SecuritySection settings={settings} onChange={setSettings} />}
          {settings && <StorageSection settings={settings} onChange={setSettings} />}
          {settings && <DesktopSection settings={settings} onChange={setSettings} />}
          {settings && <DeploySection settings={settings} onChange={setSettings} />}
          {settings && <RetentionSection settings={settings} onChange={setSettings} />}
          <RolesSection />
          {settings && <CloudSettings settings={settings} onChange={setSettings} />}
          <SkillsSection />
          <McpSection />
          <WebSection />
          <SyncSection />
          <ExportKeysSection />
          <section className="lv-section" data-testid="providers">
            <div className="at-label">Model providers</div>
            <p className="at-muted lv-small">Pi reaches {PROVIDERS.length} providers with an API key. Keys are encrypted with the operating system credential store and passed only to the agent runtime process. They are redacted from every log, event and artifact.{creds && !creds.available ? ' No credential store is available on this system: export the variable before launching ATLAS instead.' : ''}</p>
            {creds?.providers.filter((p) => p.provider !== 'github' && (p.stored || p.fromEnvironment || adding === p.provider)).map((p) => (
              <Field key={p.provider} label={NAMES[p.provider] ?? p.provider} aside={p.stored ? <Badge tone="success">saved</Badge> : p.fromEnvironment ? <Badge tone="outline">from {p.env}</Badge> : <Badge tone="outline">not set</Badge>}>
                <div className="at-row" style={{ gap: 8 }}>
                  <Input data-testid={`key-${p.provider}`} type="password" autoComplete="off" spellCheck={false} placeholder={p.stored ? '•••••••• saved' : `Paste a ${NAMES[p.provider] ?? p.provider} API key`} value={draft[p.provider] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [p.provider]: e.target.value }))} style={{ flex: 1 }} disabled={!creds.available} />
                  <Button data-testid={`key-${p.provider}-save`} disabled={!creds.available || (draft[p.provider] ?? '').trim().length < 8} onClick={() => void save(p.provider).then(() => setAdding(''))}>Save</Button>
                  {(p.stored || p.fromEnvironment) && <Button variant="ghost" data-testid={`key-${p.provider}-test`} disabled={testing === p.provider} onClick={() => void test(p.provider)}>{testing === p.provider ? 'Testing…' : 'Test'}</Button>}
                  {p.stored && <Button variant="ghost" onClick={() => void remove(p.provider)}>Remove</Button>}
                </div>
                {tested[p.provider] && <p role="status" data-testid={`key-${p.provider}-result`} className={`lv-small ${tested[p.provider].ok ? 'at-muted' : 'lv-callout'}`}>{tested[p.provider].ok ? '✓ ' : '✕ '}{tested[p.provider].detail}</p>}
              </Field>
            ))}
            {creds && (
              <Field label="Add a provider" help={(() => { const info = PROVIDERS.find((x) => x.id === adding); return info ? <>Key variable {info.env}{info.keyUrl ? <> · create one at {info.keyUrl}</> : null}</> : 'Choose a provider, then paste its key above.'; })()}>
                <select className="lv-native-select" data-testid="provider-add" value={adding} onChange={(e) => setAdding(e.target.value)}>
                  <option value="">Choose a provider…</option>
                  {PROVIDERS.filter((x) => !creds.providers.find((c) => c.provider === x.id && (c.stored || c.fromEnvironment))).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </select>
              </Field>
            )}
          </section>
          {settings && <ModelsSection settings={settings} models={models} onChange={setSettings} />}
          <section className="lv-section" data-testid="github-settings">
            <div className="at-label">GitHub</div>
            <p className="at-muted lv-small">Lets you open a pull request for an accepted, verified mission and read its CI results. ATLAS pushes only when you click Publish, never force-pushes, and never gives this token to an agent. A fine-grained token needs Contents and Pull requests (read and write), and Checks and Actions (read) on the repositories you publish to.</p>
            {creds?.providers.filter((p) => p.provider === 'github').map((p) => (
              <Field key={p.provider} label="Token" aside={p.stored ? <Badge tone="success">saved</Badge> : p.fromEnvironment ? <Badge tone="outline">from {p.env}</Badge> : <Badge tone="outline">not set</Badge>}>
                <div className="at-row" style={{ gap: 8 }}>
                  <Input data-testid="github-token" type="password" autoComplete="off" spellCheck={false} placeholder={p.stored ? '•••••••• saved' : 'Paste a GitHub token'} value={draft.github ?? ''} onChange={(e) => setDraft((d) => ({ ...d, github: e.target.value }))} style={{ flex: 1 }} disabled={!creds.available} />
                  <Button data-testid="github-token-save" disabled={!creds.available || (draft.github ?? '').trim().length < 8} onClick={() => void save('github')}>Save</Button>
                  {p.stored && <Button variant="ghost" onClick={() => void remove('github')}>Remove</Button>}
                </div>
              </Field>
            ))}
          </section>
          <section className="lv-section">
            <div className="at-label">About</div>
            {info && <KV col={150} rows={[
              ['ATLAS', info.version], ['Electron', info.electron], ['Chromium', info.chrome], ['Daemon Node', info.node], ['Database schema', `v${info.schema}`],
              ['Pi runtime', `${info.pi.package}@${info.pi.version}`], ['Pi source', `${info.pi.repository} @ ${info.pi.gitHead.slice(0, 12)} · ${info.pi.license}`],
              ...(info.git ? [['Git', `${info.git.version} · ${info.git.mode === 'attr-source' ? 'worktree attributes ignored (GIT_ATTR_SOURCE)' : 'attribute drivers disabled by name (git before 2.40)'}`] as [string, string]] : []),
              ['Network', 'No telemetry. Outbound traffic only to model providers you configure, and to GitHub when you publish or read CI, and to your Cloudflare Worker when you publish to Artifacts.'],
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

const TIERS: { key: 'models.default' | 'models.fast' | 'models.strong'; label: string; help: string }[] = [
  { key: 'models.default', label: 'Default model', help: 'Coder, tester, browser QA, desktop operator, deployment verifier.' },
  { key: 'models.strong', label: 'Strong model', help: 'Planner and reviewer. Falls back to the default model.' },
  { key: 'models.fast', label: 'Fast model', help: 'Roles that ask for speed. Falls back to the default model.' },
];

/**
 * Windows sandbox accounts (ADR 0020): two standard local accounts, created only here, with the operator's
 * administrator consent; visible in Windows like any other account; removed here too.
 */
function WindowsAccounts({ settings, onChange }: { settings: SettingsState; onChange: OnSettings }) {
  const a = settings.windowsAccounts!;
  const [busy, setBusy] = useState(false);
  const act = async (method: 'sandbox.windows.setup' | 'sandbox.windows.remove') => {
    setBusy(true);
    try { onChange(await call(method)); } catch (e) { toast({ tone: 'danger', title: 'Windows sandbox not changed', body: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <div className="lv-callout" data-testid="windows-accounts" style={{ marginTop: 0 }}>
      <div style={{ flex: 1 }}>
        <b>Windows sandbox accounts.</b> Agent commands and checks run as a separate standard Windows account that cannot read your profile, other projects or credentials, and can write only where ATLAS allows. A Windows Firewall rule blocks its network; approved network commands use a second account. Setting up creates two local accounts ({a.offline ?? 'atlas-sbx'} and {a.network ?? 'atlas-sbx-net'}) and the firewall rule, and Windows asks you for administrator consent.
        <div className="at-row" style={{ gap: 8, marginTop: 8 }}>
          {a.set ? <>
            <Badge tone="success">set up</Badge>
            {!a.firewall && <Badge tone="danger">network not enforced: firewall rule missing</Badge>}
            <Button size="sm" disabled={busy} onClick={() => void act('sandbox.windows.setup')}>Repair</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm('Delete both ATLAS sandbox accounts and the firewall rule? Windows will ask for administrator consent.')) void act('sandbox.windows.remove'); }}>Remove</Button>
          </> : <Button size="sm" variant="primary" disabled={busy} onClick={() => void act('sandbox.windows.setup')}>{busy ? 'Waiting for Windows…' : 'Set up sandbox accounts'}</Button>}
        </div>
      </div>
    </div>
  );
}

function ModelsSection({ settings, models, onChange }: { settings: SettingsState; models: ModelInfo[]; onChange: OnSettings }) {
  return (
    <section className="lv-section" data-testid="models">
      <div className="at-label">Models</div>
      <p className="at-muted lv-small">{models.length ? `${models.length} models from ${new Set(models.map((m) => m.provider)).size} configured provider(s).` : 'Add a provider key to choose models.'} A mission can override these when you create it. Each attempt records the model it used.</p>
      {TIERS.map((t) => (
        <Field key={t.key} label={t.label} help={t.help}>
          <ModelSelect testId={`model-${t.key.split('.')[1]}`} models={models} value={settings.values[t.key]} empty={t.key === 'models.default' ? 'First available model' : 'Same as default'} onChange={(value) => void saveSetting({ key: t.key, value }, onChange)} />
        </Field>
      ))}
    </section>
  );
}

const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

/** Storage and cleanup (ADR 0025): derived caches and logs are cleared; evidence never is. */
function StorageSection({ settings, onChange }: { settings: SettingsState; onChange: OnSettings }) {
  const [m, setM] = useState<Maintenance | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void call('maintenance.report').then(setM).catch(() => {}); }, []);
  const reclaimable = m?.rows.reduce((a, r) => a + r.reclaimable, 0) ?? 0;
  const clean = async () => {
    setBusy(true);
    try { const r = await call('maintenance.cleanup', {}); setM(r); toast({ tone: 'info', title: `Freed ${bytes(r.result.freed)}`, body: Object.entries(r.result.removed).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'Nothing needed clearing.' }); }
    catch (e) { toast({ tone: 'danger', title: 'Cleanup failed', body: (e as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <section className="lv-section" data-testid="storage-settings">
      <div className="at-label">Storage and cleanup</div>
      <span className="at-muted lv-small">ATLAS clears what nothing needs any more: rotated logs, code-graph caches, saved conversations of finished attempts, worktrees of deleted missions, and the database's write-ahead log. Evidence (events, artifacts, the audit trail) is never cleared here; the retention setting below decides that.</span>
      {m && (
        <table className="lv-table lv-small" data-testid="storage-table">
          <tbody>{m.rows.map((r) => (
            <tr key={r.category} data-category={r.category}><td>{r.label}</td><td className="at-mono">{bytes(r.bytes)}</td><td className="at-subtle">{r.reclaimable ? `${bytes(r.reclaimable)} can be cleared` : r.note}</td></tr>
          ))}</tbody>
        </table>
      )}
      <div className="at-row" style={{ gap: 8 }}>
        <Button size="sm" disabled={busy || !m} data-testid="cleanup-now" onClick={() => void clean()}>{busy ? 'Clearing…' : `Clean up now${reclaimable ? ` (${bytes(reclaimable)})` : ''}`}</Button>
        {m?.last && <span className="at-subtle lv-small" data-testid="cleanup-last">Last {m.last.automatic ? 'automatic ' : ''}cleanup {new Date(m.last.at).toLocaleString()}: freed {bytes(m.last.freed)}</span>}
      </div>
      <label className="lv-toggle-row"><Toggle on={settings.values['maintenance.auto']} onChange={(v) => void saveSetting({ key: 'maintenance.auto', value: v }, onChange)} label="Clean up automatically" /><span>Clean up automatically (at start and every 30 minutes, when there is something worth clearing)</span></label>
    </section>
  );
}

/** The security engineer (ADR 0023): ATLAS's scan at the gate, and the AI security review in every plan. */
function SecuritySection({ settings, onChange }: { settings: SettingsState; onChange: OnSettings }) {
  const blocking = settings.values['security.gate'] !== 'advisory';
  return (
    <section className="lv-section" data-testid="security-settings">
      <div className="at-label">Security engineer</div>
      <span className="at-muted lv-small">Every integrated change is scanned before release: committed secrets, injection-prone code (shell, SQL, eval, HTML), disabled TLS checks, new dependencies and install scripts, look-alike package names, and CI workflows a pull request could abuse. A security engineer agent also reviews each change the way an attacker would read it, in parallel with the reviewer.</span>
      <label className="lv-toggle-row"><Toggle on={blocking} onChange={(v) => void saveSetting({ key: 'security.gate', value: v ? 'blocking' : 'advisory' }, onChange)} label="Block release on high and medium scan results" /><span>Block release on high and medium scan results until fixed or dismissed {blocking ? '' : '(advisory: results are recorded, nothing blocks)'}</span></label>
      <label className="lv-toggle-row"><Toggle on={settings.values['security.aiReview']} onChange={(v) => void saveSetting({ key: 'security.aiReview', value: v }, onChange)} label="Add a security engineer review to every plan" /><span>Add a security engineer review to every plan (uses the strong model)</span></label>
    </section>
  );
}

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

/** Signed evidence exports: this installation's key id, and the other installations whose exports are trusted. */
function ExportKeysSection() {
  const [keys, setKeys] = useState<{ own: string; trusted: string[] } | null>(null);
  const [add, setAdd] = useState('');
  useEffect(() => { void call('export.keys').then(setKeys).catch(() => {}); }, []);
  return (
    <section className="lv-section" data-testid="export-keys">
      <div className="at-label">Evidence exports</div>
      <p className="at-muted lv-small" style={{ margin: 0 }}>Exports are signed with this installation's key. An import shows who signed it; only keys listed here (and this installation's own) count as trusted.</p>
      {keys && <KV rows={[['This installation', <span key="k" className="at-mono" data-testid="own-key">{keys.own}</span>]]} />}
      {keys?.trusted.map((k) => (
        <div key={k} className="at-row" style={{ gap: 8 }}><span className="at-mono lv-small">{k}</span><Button size="sm" variant="ghost" onClick={() => void call('export.untrust', { keyId: k }).then(setKeys)}>Remove</Button></div>
      ))}
      <div className="at-row" style={{ gap: 6 }}>
        <Input value={add} onChange={(e) => setAdd(e.target.value.trim())} placeholder="Key id of another installation (32 hex characters)" aria-label="Trusted key id" />
        <Button size="sm" disabled={!/^[0-9a-f]{32}$/.test(add)} onClick={() => void call('export.trust', { keyId: add }).then((r) => { setKeys(r); setAdd(''); })}>Trust key</Button>
      </div>
    </section>
  );
}
