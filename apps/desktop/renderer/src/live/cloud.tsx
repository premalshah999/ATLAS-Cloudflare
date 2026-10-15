import React, { useEffect, useState } from 'react';
import type { Mission, RuntimeHealth } from '@atlas/contracts';
import { Badge, Button, Field, Input } from '../ui/primitives';
import { call, type CloudPublication, type SettingsState } from './api';
import { toast } from './toast';

export function CloudSettings({ settings, onChange }: { settings: SettingsState; onChange(s: SettingsState): void }) {
  const [url, setUrl] = useState(settings.values['cloud.url']);
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { void call('deploy.secrets.list').then((s) => setSaved(s.some((t) => t.target === 'cloudflare' && t.names.includes('ATLAS_CLOUD_TOKEN')))).catch(() => {}); }, []);
  const save = async () => {
    try {
      onChange(await call('settings.set', { key: 'cloud.url', value: url.trim() }));
      if (token) { await call('deploy.secrets.set', { target: 'cloudflare', name: 'ATLAS_CLOUD_TOKEN', value: token.trim() }); setToken(''); setSaved(true); }
      toast({ tone: 'info', title: 'Cloudflare connection saved', body: 'Open a completed mission → Cloudflare to publish and verify its checkpoints.' });
    } catch (e) { toast({ tone: 'danger', title: 'Connection not saved', body: (e as Error).message }); }
  };
  return <section className="lv-section" data-testid="cloud-settings">
    <div className="at-label">Cloudflare Workers + Artifacts</div>
    <p className="at-muted lv-small">Keep agents local. Publish their checkpoint branches to a dedicated Artifacts repository, then verify every commit through your Worker. Source and committed history upload only when you choose Publish.</p>
    <Field label="Worker URL"><Input aria-label="Cloudflare Worker URL" placeholder="https://atlas-mission-control.your-account.workers.dev" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
    <Field label="Connection token" aside={saved ? <Badge tone="success">saved in OS credential store</Badge> : undefined}><Input type="password" autoComplete="off" aria-label="Cloudflare connection token" placeholder={saved ? 'Leave blank to keep the saved token' : 'The ATLAS_CLOUD_TOKEN secret configured on your Worker'} value={token} onChange={(e) => setToken(e.target.value)} /></Field>
    <Button onClick={() => void save()} disabled={!!token && token.trim().length < 32}>Save Cloudflare connection</Button>
    <p className="at-subtle lv-small">Deploy the included Worker with pnpm cloud:deploy. Setup: docs/CLOUDFLARE.md. The connection token is separate from your Cloudflare account API token and model keys.</p>
  </section>;
}

export function ModelSettings({ settings, health, onChange }: { settings: SettingsState; health: RuntimeHealth[]; onChange(s: SettingsState): void }) {
  const [model, setModel] = useState(settings.values['runtime.model']);
  const models = health.find((h) => h.runtime === 'pi')?.models ?? [];
  return <section className="lv-section">
    <div className="at-label">Model selection</div>
    <p className="at-muted lv-small">Add a provider key below, then choose a model for new Pi missions. Leave blank to use the first available model. A saved key still needs a live request to confirm access.</p>
    <Field label="Provider/model"><Input aria-label="Provider/model" list="atlas-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Automatic — first available model" /><datalist id="atlas-models">{models.map((m) => <option key={m} value={m} />)}</datalist></Field>
    <Button onClick={() => void call('settings.set', { key: 'runtime.model', value: model.trim() }).then(onChange).catch((e) => toast({ tone: 'danger', title: 'Model not saved', body: e.message }))}>Save model</Button>
  </section>;
}

export function CloudPanel({ mission }: { mission: Mission }) {
  const [publication, setPublication] = useState<CloudPublication | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void call('cloud.status', { missionId: mission.id }).then(setPublication).catch((e) => setError(e.message)); }, [mission.id]);
  const publish = async () => {
    if (!window.confirm('Upload this mission’s committed source and Git history to your configured Cloudflare Artifacts account? Your provider keys and uncommitted files are not included.')) return;
    setBusy(true); setError('');
    try { setPublication(await call('cloud.publish', { missionId: mission.id })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="lv-scroll" style={{ padding: 24 }} data-testid="cloud-panel">
    <div className="at-label">Mission checkpoints on Cloudflare Artifacts</div>
    <h2>Local agents. Shared, verifiable history.</h2>
    <p className="at-muted">ATLAS publishes the base, agent branches and integrated result into one mission repository. Your Worker independently reads the remote commit IDs before this view reports a match.</p>
    <Button variant="primary" onClick={() => void publish()} disabled={busy || mission.state !== 'completed' || mission.decision === 'rejected' || mission.archived}>{busy ? 'Publishing and verifying…' : publication ? 'Publish again' : 'Publish to Cloudflare'}</Button>
    <p className="at-subtle lv-small">Configure your Worker URL and connection token in Settings. Publication verifies remote storage; the Evidence tab records the tests and review of the code.</p>
    {error && <div role="alert" className="lv-callout">{error}</div>}
    {publication && <section className="lv-section">
      <Badge tone="success">All published commit IDs match</Badge>
      <p className="at-mono">{publication.name}</p>
      <p className="at-muted lv-small" style={{ overflowWrap: 'anywhere' }}>{publication.remote}</p>
      <p className="at-subtle lv-small">Last verified: {new Date(publication.checkedAt).toLocaleString()}</p>
      {publication.refs.map((r) => <div key={r.ref} className="lv-rt"><span className="at-mono">{r.ref.replace('refs/heads/', '')}</span><span className="at-muted at-mono lv-small">{r.actual}</span><Badge tone={r.matches ? 'success' : 'danger'}>{r.matches ? 'matches' : 'mismatch'}</Badge></div>)}
    </section>}
  </div>;
}
