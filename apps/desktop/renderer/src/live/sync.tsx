// Sync with other tools (ADR 0019): ATLAS's skills and MCP servers, written to where Claude Code, Codex and OpenCode
// read them. Those tools stay separate; ATLAS keeps their files in step. Preview first, then sync.
import React, { useEffect, useState } from 'react';
import { mcpSecretEnv, type McpServerConfig } from '@atlas/contracts';
import { Badge, Button, Check, Seg } from '../ui/primitives';
import { call, type ForeignServer, type SyncPreview } from './api';
import { useLive } from './store';
import { toast } from './toast';
import { MCP_CHANGED } from './mcp';

type Harness = 'claude-code' | 'codex' | 'opencode';
const TOOLS: { id: Harness; label: string; help: string }[] = [
  { id: 'claude-code', label: 'Claude Code', help: 'Skills in ~/.claude/skills or the repository\'s .claude/skills; MCP servers in the repository\'s .mcp.json.' },
  { id: 'codex', label: 'Codex', help: 'Skills in ~/.codex/skills; MCP servers in a marked block of ~/.codex/config.toml.' },
  { id: 'opencode', label: 'OpenCode', help: 'Skills in ~/.config/opencode/skills or .opencode/skills; MCP servers in opencode.json.' },
];
const TONE = { create: 'success', update: 'accent', delete: 'warning', unchanged: 'outline', conflict: 'danger' } as const;

export function SyncSection() {
  return (
    <section className="lv-section" data-testid="sync">
      <div className="at-label">Sync with other tools</div>
      <p className="at-muted lv-small">Write ATLAS's enabled skills and MCP servers to the places Claude Code, Codex and OpenCode read them, so the same procedures and tools are there when you work in those tools. They remain separate tools with their own permissions; ATLAS's approvals do not apply there. Secret values are never written: their configs reference environment variables you export (for example {mcpSecretEnv('docs', 'Authorization')}). ATLAS updates or removes only what it wrote and nobody changed since; anything else is reported as a conflict and left alone.</p>
      {TOOLS.map((t) => <ToolCard key={t.id} tool={t} />)}
    </section>
  );
}

function ToolCard({ tool }: { tool: (typeof TOOLS)[number] }) {
  const workspaces = useLive((s) => s.workspaces).filter((w) => w.isGit);
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [ws, setWs] = useState(workspaces[0]?.id ?? '');
  const [skills, setSkills] = useState(true);
  const [mcp, setMcp] = useState(true);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [foreign, setForeign] = useState<ForeignServer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const target = { harness: tool.id, scope, ...(scope === 'project' ? { workspaceId: ws } : {}), skills, mcp };
  useEffect(() => { setPreview(null); setForeign(null); }, [scope, ws, skills, mcp]);
  const run = async <T,>(f: () => Promise<T>, ok?: (v: T) => void) => {
    setBusy(true);
    try { ok?.(await f()); } catch (e) { toast({ tone: 'danger', title: `${tool.label}: not synced`, body: (e as Error).message }); } finally { setBusy(false); }
  };
  const writes = preview?.changes.filter((c) => ['create', 'update', 'delete'].includes(c.action)).length ?? 0;
  const add = (f: ForeignServer) => void run(() => call('mcp.save', { server: { ...(f.config as McpServerConfig) } }), () => {
    toast({ tone: 'info', title: `Added ${f.name} to ATLAS`, body: f.secretNames.length ? `Enter ${f.secretNames.join(', ')} under MCP servers, then test it. Values were not copied.` : 'Test it under MCP servers.' });
    setForeign((x) => x?.filter((y) => y !== f) ?? null);
    window.dispatchEvent(new Event(MCP_CHANGED));
  });
  return (
    <div className="lv-card" data-testid={`sync-${tool.id}`} style={{ marginBottom: 10, display: 'grid', gap: 8 }}>
      <div className="at-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <b>{tool.label}</b>
        <Seg items={[{ id: 'user' as const, label: 'Your account' }, { id: 'project' as const, label: 'A repository' }]} value={scope} onChange={setScope} />
        {scope === 'project' && <select className="lv-native-select" value={ws} onChange={(e) => setWs(e.target.value)}>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}
        <span className="at-row lv-small" style={{ gap: 6 }}><Check on={skills} onChange={setSkills} label="Skills" />Skills</span>
        <span className="at-row lv-small" style={{ gap: 6 }}><Check on={mcp} onChange={setMcp} label="MCP servers" />MCP servers</span>
      </div>
      <span className="at-subtle lv-small">{tool.help}</span>
      <div className="at-row" style={{ gap: 8 }}>
        <Button size="sm" data-testid={`sync-${tool.id}-preview`} disabled={busy || (scope === 'project' && !ws) || (!skills && !mcp)} onClick={() => void run(() => call('sync.preview', target), setPreview)}>Preview</Button>
        {preview && <Button size="sm" variant="primary" data-testid={`sync-${tool.id}-apply`} disabled={busy || !writes} onClick={() => void run(() => call('sync.apply', { ...target, id: preview.id }), (r) => {
          toast({ tone: 'info', title: `${tool.label} synced`, body: `${writes} change${writes === 1 ? '' : 's'} written.` });
          void call('sync.preview', target).then(setPreview);
          void r;
        })}>{writes ? `Sync ${writes} change${writes === 1 ? '' : 's'}` : 'In sync'}</Button>}
        {mcp && <Button size="sm" variant="ghost" data-testid={`sync-${tool.id}-foreign`} disabled={busy || (scope === 'project' && !ws)} onClick={() => void run(() => call('sync.foreign', target), setForeign)}>Bring its MCP servers into ATLAS</Button>}
      </div>
      {preview && (
        <div data-testid={`sync-${tool.id}-changes`} style={{ display: 'grid', gap: 4 }}>
          {preview.notes.map((n) => <span key={n} className="at-subtle lv-small">{n}</span>)}
          {!preview.changes.length && !preview.notes.length && <span className="at-subtle lv-small">Nothing to sync: no enabled skills or MCP servers.</span>}
          {preview.changes.map((c) => (
            <div key={`${c.kind}:${c.name}:${c.path}`} className="at-row lv-small" style={{ gap: 6 }} data-action={c.action}>
              <Badge tone={TONE[c.action]}>{c.action}</Badge>
              <span>{c.kind === 'skill' ? 'skill' : 'MCP server'} <b className="at-mono">{c.name}</b></span>
              <span className="at-subtle at-mono" title={c.path}>{c.path}</span>
              {c.reason && <span className="at-subtle">· {c.reason}</span>}
            </div>
          ))}
        </div>
      )}
      {foreign && (
        <div data-testid={`sync-${tool.id}-foreign-list`} style={{ display: 'grid', gap: 4 }}>
          {!foreign.length && <span className="at-subtle lv-small">No MCP servers there that ATLAS does not already manage.</span>}
          {foreign.map((f) => (
            <div key={f.name} className="at-row lv-small" style={{ gap: 6 }}>
              <b className="at-mono">{f.name}</b>
              {f.problem ? <span className="at-subtle">not importable: {f.problem}</span> : <>
                <span className="at-subtle">{String(f.config?.transport) === 'http' ? String(f.config?.url) : `${String(f.config?.command)} ${((f.config?.args as string[]) ?? []).join(' ')}`}</span>
                {f.secretNames.length > 0 && <span className="at-subtle">· secrets to enter: {f.secretNames.join(', ')}</span>}
                <Button size="sm" variant="ghost" onClick={() => add(f)}>Add to ATLAS</Button>
              </>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
