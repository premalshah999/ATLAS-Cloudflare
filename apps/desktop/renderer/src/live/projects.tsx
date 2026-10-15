import React, { useEffect, useState } from 'react';
import { Badge, Button, Dot, EmptyState, Icon, Input } from '../ui/primitives';
import { IFolderOpen, IPlus, IRepo, IBranch, IHistory, IDoc, IShield } from '../lib/icons';
import { call, type AcceptanceView } from './api';
import { toast } from './toast';
import { refreshLists } from './store';
import { go, useLive } from './store';
import { openRepository, dotFor } from './shell';
import { ago, missionStatus } from './format';

export function Projects() {
  const workspaces = useLive((s) => s.workspaces);
  const missions = useLive((s) => s.missions);
  const status = useLive((s) => s.status.state);
  const archived = missions.filter((m) => m.archived || !workspaces.some((w) => w.id === m.workspaceId));
  return (
    <div className="at-screen lv-page" data-testid="projects">
      <div className="at-pagehead">
        <span className="heading">Projects</span><span style={{ flex: 1 }} />
        <Button variant="ghost" icon={IHistory} disabled={status !== 'ready'} data-testid="import-mission" onClick={() => void call('mission.import').then(async (m) => { if (!m) return; await refreshLists(); toast({ tone: 'info', title: 'Audit log imported', body: 'Checksums verified. The mission opens read-only.' }); go({ screen: 'mission', missionId: m.id }); }).catch((e) => toast({ tone: 'danger', title: 'Import refused', body: (e as Error).message }))}>Import audit log…</Button>
        <Button variant="primary" icon={IFolderOpen} kbd="⌘ O" onClick={() => void openRepository()} disabled={status !== 'ready'}>Open repository</Button>
      </div>
      <div className="lv-scroll">
        {workspaces.length === 0 ? (
          <EmptyState center icon={IRepo} title="Open a repository to begin"
            body="ATLAS reads the repository and runs agents in isolated git worktrees. Your checkout is never edited. To try the bundled sample project, run `pnpm seed:sample` and open the folder it prints.">
            <Button variant="primary" icon={IFolderOpen} onClick={() => void openRepository()} disabled={status !== 'ready'}>Open repository</Button>
          </EmptyState>
        ) : (
          <div className="lv-grid">
            {workspaces.map((w) => {
              const ms = missions.filter((m) => m.workspaceId === w.id);
              return (
                <section key={w.id} className="lv-card" data-testid="workspace-card">
                  <div className="lv-card-head">
                    <Icon as={IRepo} className="at-subtle" />
                    <span className="heading at-trunc">{w.name}</span>
                    <span style={{ flex: 1 }} />
                    <Button size="sm" icon={IPlus} onClick={() => go({ screen: 'new', workspaceId: w.id })}>New mission</Button>
                  </div>
                  <div className="lv-card-meta">
                    <span className="at-mono at-subtle at-trunc" title={w.root}>{w.root}</span>
                    {w.isGit ? <span className="at-row" style={{ gap: 6 }}><Icon as={IBranch} size="sm" className="at-subtle" /><span className="at-mono">{w.branch}</span><span className="at-mono at-subtle">{w.head?.slice(0, 7)}</span>{w.dirty ? <Badge tone="warning">{w.dirty} uncommitted</Badge> : <Badge tone="outline">clean</Badge>}</span> : <Badge tone="warning">not a git repository</Badge>}
                  </div>
                  <Facts workspaceId={w.id} />
                  <Acceptance workspaceId={w.id} />
                  <div className="at-label" style={{ margin: '14px 0 6px' }}>Missions</div>
                  {ms.length === 0 ? <div className="at-subtle lv-small">No missions yet.</div> : (
                    <ul className="lv-list">
                      {ms.slice(0, 6).map((m) => (
                        <li key={m.id}>
                          <button type="button" className="lv-row" onClick={() => go({ screen: 'mission', missionId: m.id })}>
                            <Dot s={dotFor(m)} />
                            <span className="at-trunc" style={{ fontWeight: 500 }}>{m.title}</span>
                            <span className="at-subtle lv-small" data-testid="mission-status">{missionStatus(m).word}</span>
                            <span style={{ flex: 1 }} />
                            <span className="at-subtle lv-small">{ago(m.updatedAt)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
        {archived.length > 0 && (
          <section className="lv-card" style={{ margin: '0 24px 24px' }} data-testid="archives">
            <div className="lv-card-head"><Icon as={IHistory} className="at-subtle" /><span className="heading">Imported audit logs</span></div>
            <ul className="lv-list">{archived.map((m) => <li key={m.id}><button type="button" className="lv-row" onClick={() => go({ screen: 'mission', missionId: m.id })}><Dot s={dotFor(m)} /><span className="at-trunc" style={{ fontWeight: 500 }}>{m.title}</span><span className="at-subtle lv-small">{missionStatus(m).word} · read-only</span></button></li>)}</ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** Operator-maintained project facts, included in every agent's context bundle (manual §17). */
function Facts({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  useEffect(() => { if (open && text === null) void call('workspace.facts.get', { workspaceId }).then((r) => { setText(r.text); setSaved(r.text); }).catch(() => setText('')); }, [open]);
  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" className="lv-link" onClick={() => setOpen(!open)}><Icon as={IDoc} size="sm" /> Project facts{saved ? ` · ${saved.split('\n').filter(Boolean).length} lines` : ''}</button>
      {open && text !== null && (
        <div style={{ marginTop: 6 }}>
          <textarea className="lv-textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Facts every agent should know, e.g.\n- Use pnpm, never npm\n- The API is versioned under /v2'} maxLength={20000} />
          <div className="at-row" style={{ gap: 6, marginTop: 6 }}>
            <Button size="sm" disabled={text === saved} onClick={() => void call('workspace.facts.set', { workspaceId, text }).then((r) => { setSaved(r.text); toast({ tone: 'info', title: 'Project facts saved', body: 'New agent attempts include them in their context.' }); }).catch((e) => toast({ tone: 'danger', title: 'Not saved', body: (e as Error).message }))}>Save facts</Button>
            <span className="at-subtle lv-small">Shown to agents as operator-provided context, with its hash recorded.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Holdout acceptance tests: kept by ATLAS outside the repository and never shown to agents; they run at the gate on
 * the integrated code and must pass for "Verified". The tests import the project from `../` (they run inside
 * `.atlas-acceptance/` in the integration worktree).
 */
function Acceptance({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [suite, setSuite] = useState<AcceptanceView | null>(null);
  const [file, setFile] = useState('acceptance.test.js');
  const [code, setCode] = useState('');
  const [cmd, setCmd] = useState('node --test .atlas-acceptance/acceptance.test.js');
  const load = (s: AcceptanceView | null) => {
    setSuite(s); setLoaded(true);
    if (s) { const [f, c] = Object.entries(s.files)[0] ?? ['acceptance.test.js', '']; setFile(f); setCode(c); setCmd([s.command, ...s.args].join(' ')); }
  };
  useEffect(() => { if (open && !loaded) void call('workspace.acceptance.get', { workspaceId }).then(load).catch(() => setLoaded(true)); }, [open]);
  const save = () => {
    const [command, ...args] = cmd.trim().split(/\s+/);
    void call('workspace.acceptance.set', { workspaceId, command, args, files: { [file]: code } })
      .then((s) => { load(s); toast({ tone: 'info', title: 'Acceptance tests saved', body: 'They run at the gate of every new or re-verified mission. Agents never see them.' }); })
      .catch((e) => toast({ tone: 'danger', title: 'Not saved', body: (e as Error).message }));
  };
  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" className="lv-link" onClick={() => setOpen(!open)} data-testid="acceptance-toggle"><Icon as={IShield} size="sm" /> Holdout acceptance tests{suite ? ` · ${suite.hash.slice(0, 12)}` : ''}</button>
      {open && loaded && (
        <div style={{ marginTop: 6 }}>
          <div className="at-row" style={{ gap: 6 }}>
            <Input value={file} onChange={(e) => setFile(e.target.value)} aria-label="File name" style={{ maxWidth: 220 }} />
            <Input value={cmd} onChange={(e) => setCmd(e.target.value)} aria-label="Command" />
          </div>
          <textarea className="lv-textarea at-mono" rows={8} value={code} onChange={(e) => setCode(e.target.value)} placeholder={"import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\n\ntest('requirement', () => assert.equal(slugify('Fish & Chips'), 'fish-chips'));"} data-testid="acceptance-code" style={{ marginTop: 6 }} />
          <div className="at-row" style={{ gap: 6, marginTop: 6 }}>
            <Button size="sm" disabled={!code.trim() || !file.trim()} onClick={save} data-testid="acceptance-save">Save acceptance tests</Button>
            {suite && <Button size="sm" variant="ghost" onClick={() => void call('workspace.acceptance.remove', { workspaceId }).then(() => { setSuite(null); setCode(''); })}>Remove</Button>}
            <span className="at-subtle lv-small">Stored by ATLAS, never in the repository; agents cannot read them. Required to pass for “Verified”.</span>
          </div>
        </div>
      )}
    </div>
  );
}
