// MCP servers (ADR 0018): connect remote (streamable HTTP) or local (stdio, sandboxed) servers, store their secrets in
// the OS credential store, choose which roles and tools agents get, and whether each call needs approval.
import React, { useEffect, useState } from 'react';
import { mcpSecretEnv, type AgentRole, type McpServerConfig, type McpServerView } from '@atlas/contracts';
import { Badge, Button, Check, Field, Input, Seg, Status, Toggle } from '../ui/primitives';
import { call } from './api';
import { roleName } from './format';
import { toast } from './toast';

/** A checkbox with visible, clickable text (Check itself renders only the box). */
function LabeledCheck({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <span className="at-row lv-small" style={{ gap: 6, cursor: 'pointer' }}><Check on={on} onChange={onChange} label={label} /><span onClick={() => onChange(!on)}>{label}</span></span>;
}

/** Fired when another panel changed the MCP server list. */
export const MCP_CHANGED = 'atlas:mcp-changed';

const ROLES: AgentRole[] = ['coder', 'reviewer', 'tester', 'browser_qa', 'deployment_verifier'];
type Draft = { name: string; transport: 'stdio' | 'http'; url: string; command: string; args: string; env: string; readPaths: string; network: boolean; secrets: string; approval: 'ask' | 'allow'; roles: AgentRole[] };
const EMPTY: Draft = { name: '', transport: 'http', url: '', command: '', args: '', env: '', readPaths: '', network: false, secrets: '', approval: 'ask', roles: ['coder', 'reviewer', 'tester'] };

/** Starting points for well-known servers; every field stays editable. */
const TEMPLATES: { id: string; label: string; draft: Partial<Draft> }[] = [
  { id: 'http', label: 'Remote (HTTP)', draft: { transport: 'http' } },
  { id: 'stdio', label: 'Local command', draft: { transport: 'stdio', command: 'npx', args: '-y\n<package>' } },
  { id: 'github', label: 'GitHub', draft: { name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', secrets: 'Authorization' } },
  { id: 'context7', label: 'Context7 docs', draft: { name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp', approval: 'allow' } },
];

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
function toConfig(d: Draft, prev?: McpServerConfig): McpServerConfig {
  const env = Object.fromEntries(lines(d.env).map((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1)] : [l, '']; }));
  return {
    name: d.name.trim(), transport: d.transport, approval: d.approval, roles: d.roles, enabled: prev?.enabled ?? true, tools: prev?.tools ?? null,
    secrets: d.secrets.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
    ...(d.transport === 'http' ? { url: d.url.trim(), args: [], env: {}, network: false, readPaths: [] } : { command: d.command.trim(), args: lines(d.args), env, network: d.network, readPaths: lines(d.readPaths) }),
  };
}
function toDraft(c: McpServerConfig): Draft {
  return { name: c.name, transport: c.transport, url: c.url ?? '', command: c.command ?? '', args: c.args.join('\n'), env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join('\n'), readPaths: c.readPaths.join('\n'), network: c.network, secrets: c.secrets.join(', '), approval: c.approval, roles: c.roles };
}

export function McpSection() {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [editing, setEditing] = useState<{ draft: Draft; prev?: McpServerConfig } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const run = async (label: string, f: () => Promise<McpServerView[]>) => {
    setBusy(label);
    try { setServers(await f()); } catch (e) { toast({ tone: 'danger', title: 'MCP server not updated', body: (e as Error).message }); } finally { setBusy(null); }
  };
  useEffect(() => {
    const load = () => void call('mcp.list').then(setServers).catch(() => {});
    load();
    // Servers added elsewhere (Sync → bring into ATLAS) show up here at once.
    window.addEventListener(MCP_CHANGED, load);
    return () => window.removeEventListener(MCP_CHANGED, load);
  }, []);
  const save = (cfg: McpServerConfig) => run('save', () => call('mcp.save', { server: cfg }));

  return (
    <section className="lv-section" data-testid="mcp-servers">
      <div className="at-label">MCP servers</div>
      <p className="at-muted lv-small">Connect Model Context Protocol servers to give agents their tools. Agents reach them only through the governed <code>mcp_call</code> tool. Each call is checked against the roles and tools you allow here. It also asks for your approval unless you trust the server. Local servers run in the OS sandbox with a private home folder, and get no network unless you enable it. Nothing connects until you test a server or an agent calls it.</p>
      {servers.map((s) => {
        const c = s.config;
        const missing = c.secrets.filter((n) => !s.secretsSet.includes(n));
        return (
          <div key={c.name} className="lv-card" data-testid={`mcp-${c.name}`} style={{ marginBottom: 10 }}>
            <div className="at-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Status s={!c.enabled ? 'paused' : s.status === 'error' ? 'failed' : s.tools.length ? 'done' : 'warning'} label={<b>{c.name}</b>} />
              <Badge tone="outline">{c.transport === 'http' ? new URL(c.url!).host : `local · ${c.command}`}</Badge>
              <Badge tone={c.approval === 'allow' ? 'warning' : 'outline'}>{c.approval === 'allow' ? 'trusted: runs without asking' : 'asks before each call'}</Badge>
              {c.transport === 'stdio' && <Badge tone={c.network ? 'warning' : 'outline'}>{c.network ? 'network on' : 'no network'}</Badge>}
              <span className="at-subtle lv-small">{s.tools.length ? `${c.tools ? c.tools.length : s.tools.length} of ${s.tools.length} tools offered` : 'tools not listed yet'} · {c.roles.map(roleName).join(', ')}</span>
              <span style={{ flex: 1 }} />
              <Toggle on={c.enabled} onChange={(v) => void save({ ...c, enabled: v })} label="Enabled" />
            </div>
            {s.error && <div className="lv-small" style={{ color: 'var(--danger)', marginTop: 6 }} data-testid={`mcp-${c.name}-error`}>{s.error}</div>}
            {c.secrets.map((n) => (
              <Field key={n} label={`${n}${c.transport === 'http' ? ' (header)' : ' (environment)'}`} help={`Encrypted with the OS credential store. Without one, export ${mcpSecretEnv(c.name, n)} before launching ATLAS.`} aside={s.secretsSet.includes(n) ? <Badge tone="success">set</Badge> : <Badge tone="outline">not set</Badge>}>
                <div className="at-row" style={{ gap: 8 }}>
                  <Input data-testid={`mcp-${c.name}-secret-${n}`} type="password" autoComplete="off" spellCheck={false} placeholder={s.secretsSet.includes(n) ? '•••••••• saved' : n.toLowerCase() === 'authorization' ? 'Bearer …' : 'Value'} value={secretDraft[`${c.name}/${n}`] ?? ''} onChange={(e) => setSecretDraft((d) => ({ ...d, [`${c.name}/${n}`]: e.target.value }))} style={{ flex: 1 }} />
                  <Button disabled={!(secretDraft[`${c.name}/${n}`] ?? '').trim()} onClick={() => void run('secret', async () => { const v = await call('mcp.secret.set', { server: c.name, name: n, value: secretDraft[`${c.name}/${n}`] }); setSecretDraft((d) => ({ ...d, [`${c.name}/${n}`]: '' })); return v; })}>Save</Button>
                </div>
              </Field>
            ))}
            {s.tools.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary className="lv-small">Tools agents may call</summary>
                <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                  <LabeledCheck on={!c.tools} onChange={(v) => void save({ ...c, tools: v ? null : s.tools.map((t) => t.name) })} label="Every tool the server lists (including ones it adds later)" />
                  {s.tools.map((t) => (
                    <label key={t.name} className="at-row lv-small" style={{ gap: 6, alignItems: 'flex-start' }} title={t.description}>
                      <input type="checkbox" data-testid={`mcp-${c.name}-tool-${t.name}`} disabled={!c.tools} checked={!c.tools || c.tools.includes(t.name)} onChange={(e) => void save({ ...c, tools: e.target.checked ? [...(c.tools ?? []), t.name] : (c.tools ?? []).filter((x) => x !== t.name) })} />
                      <span><code>{t.name}</code> <span className="at-subtle">{t.description.slice(0, 140)}</span></span>
                    </label>
                  ))}
                </div>
              </details>
            )}
            <div className="at-row" style={{ gap: 8, marginTop: 8 }}>
              <Button size="sm" data-testid={`mcp-${c.name}-test`} disabled={!!busy || missing.length > 0} onClick={() => void run('test', () => call('mcp.test', { name: c.name }))}>{busy === 'test' ? 'Connecting…' : s.tools.length ? 'Refresh tools' : 'Test connection'}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing({ draft: toDraft(c), prev: c })}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Remove the MCP server ${c.name} and its stored secrets?`)) void run('remove', () => call('mcp.remove', { name: c.name })); }}>Remove</Button>
              {missing.length > 0 && <span className="at-subtle lv-small">Save {missing.join(', ')} first.</span>}
            </div>
          </div>
        );
      })}
      {!editing && (
        <div className="at-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="at-subtle lv-small">Add:</span>
          {TEMPLATES.map((t) => <Button key={t.id} size="sm" data-testid={`mcp-add-${t.id}`} onClick={() => setEditing({ draft: { ...EMPTY, ...t.draft } })}>{t.label}</Button>)}
        </div>
      )}
      {editing && <McpForm initial={editing.draft} prev={editing.prev} taken={servers.map((s) => s.config.name).filter((n) => n !== editing.prev?.name)} onCancel={() => setEditing(null)} onSave={async (cfg) => {
        if (editing.prev && editing.prev.name !== cfg.name) await call('mcp.remove', { name: editing.prev.name });
        await save(cfg);
        setEditing(null);
      }} />}
    </section>
  );
}

function McpForm({ initial, prev, taken, onCancel, onSave }: { initial: Draft; prev?: McpServerConfig; taken: string[]; onCancel: () => void; onSave: (c: McpServerConfig) => Promise<void> }) {
  const [d, setD] = useState<Draft>(initial);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const problem = !/^[a-z0-9][a-z0-9-]{0,39}$/.test(d.name) ? 'Name: lowercase letters, digits and hyphens.'
    : taken.includes(d.name) ? 'A server with this name exists.'
      : d.transport === 'http' && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(d.url) ? 'URL: https (plain http only for localhost).'
        : d.transport === 'stdio' && !d.command.trim() ? 'Command is required.' : null;
  return (
    <div className="lv-card" data-testid="mcp-form" style={{ display: 'grid', gap: 8 }}>
      <Field label="Name"><Input data-testid="mcp-form-name" value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="docs" maxLength={40} /></Field>
      <Field label="Connection"><Seg items={[{ id: 'http' as const, label: 'Remote (HTTP)' }, { id: 'stdio' as const, label: 'Local command' }]} value={d.transport} onChange={(v) => set('transport', v)} /></Field>
      {d.transport === 'http' ? (
        <Field label="URL" help="Streamable HTTP endpoint. Servers that need an OAuth sign-in are not supported yet: use a token in a secret header instead."><Input data-testid="mcp-form-url" value={d.url} onChange={(e) => set('url', e.target.value)} placeholder="https://mcp.example.com/mcp" /></Field>
      ) : (<>
        <Field label="Command"><Input data-testid="mcp-form-command" value={d.command} onChange={(e) => set('command', e.target.value)} placeholder="npx" /></Field>
        <Field label="Arguments" help="One per line."><textarea className="lv-textarea" data-testid="mcp-form-args" rows={3} value={d.args} onChange={(e) => set('args', e.target.value)} /></Field>
        <Field label="Environment" help="KEY=value, one per line. Put tokens in secrets below instead."><textarea className="lv-textarea" rows={2} value={d.env} onChange={(e) => set('env', e.target.value)} /></Field>
        <Field label="Readable folders" help="Absolute paths the server may read, one per line (its own installation, for example). It sees nothing else outside its private home."><textarea className="lv-textarea" data-testid="mcp-form-paths" rows={2} value={d.readPaths} onChange={(e) => set('readPaths', e.target.value)} /></Field>
        <Field label="Network" help="npx needs the network to download the server. A server with network access can send what it receives elsewhere."><Toggle on={d.network} onChange={(v) => set('network', v)} label="Allow network access" /></Field>
      </>)}
      <Field label="Secrets" help={d.transport === 'http' ? 'Header names whose values you save after adding the server, e.g. Authorization.' : 'Environment variable names whose values you save after adding the server.'}><Input data-testid="mcp-form-secrets" value={d.secrets} onChange={(e) => set('secrets', e.target.value)} placeholder={d.transport === 'http' ? 'Authorization' : 'API_TOKEN'} /></Field>
      <Field label="Approval" help={d.approval === 'allow' ? 'Agents call this server without asking you. Choose this only for servers whose tools cannot change anything you care about.' : 'Every call shows you the server, the tool and its arguments, and waits for your decision.'}>
        <Seg items={[{ id: 'ask' as const, label: 'Ask before each call' }, { id: 'allow' as const, label: 'Trusted' }]} value={d.approval} onChange={(v) => set('approval', v)} />
      </Field>
      <Field label="Roles">
        <div className="at-row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {ROLES.map((r) => <LabeledCheck key={r} on={d.roles.includes(r)} onChange={(v) => set('roles', v ? [...d.roles, r] : d.roles.filter((x) => x !== r))} label={roleName(r)} />)}
        </div>
      </Field>
      <div className="at-row" style={{ gap: 8 }}>
        <Button data-testid="mcp-form-save" variant="primary" disabled={!!problem} onClick={() => void onSave(toConfig(d, prev))}>{prev ? 'Save' : 'Add server'}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {problem && <span className="at-subtle lv-small">{problem}</span>}
      </div>
    </div>
  );
}
