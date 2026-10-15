// Skills (ADR 0013, 0019): reviewed procedures agents can load. Bundled skills ship with ATLAS; operator skills are
// written here or imported. Skills found in a repository or in another tool's skill folder (Claude Code, Codex,
// OpenCode) are untrusted until imported at the exact version reviewed.
import React, { useEffect, useState } from 'react';
import type { AgentRole } from '@atlas/contracts';
import { Badge, Button, Check, Field, Input, Toggle } from '../ui/primitives';
import { call, type SkillsState, type SkillView } from './api';
import { useLive } from './store';
import { roleName } from './format';
import { toast } from './toast';

const ROLES: AgentRole[] = ['orchestrator', 'coder', 'reviewer', 'tester', 'browser_qa', 'desktop_operator', 'deployment_verifier'];
type Draft = { name: string; description: string; roles: AgentRole[]; triggers: string; body: string; editing: boolean };

/** Body of a SKILL.md: everything after the front matter. */
const bodyOf = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

export function SkillsSection() {
  const all = useLive((s) => s.workspaces);
  const workspaces = all.filter((w) => w.isGit);
  const [ws, setWs] = useState<string>(workspaces[0]?.id ?? '');
  const [state, setState] = useState<SkillsState | null>(null);
  const [open, setOpen] = useState<{ key: string; text: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const reload = () => call('skills.list', ws ? { workspaceId: ws } : {}).then(setState).catch(() => {});
  useEffect(() => { void reload(); }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = (s: SkillView) => `${s.source}:${s.origin ?? ''}:${s.name}`;
  const read = (s: SkillView) => call('skills.read', { name: s.name, source: s.source === 'repository' ? 'repository' : s.source === 'external' ? 'external' : 'trusted', ...(s.source !== 'bundled' && s.source !== 'operator' && ws ? { workspaceId: ws } : {}), ...(s.source === 'external' ? { hash: s.hash } : {}) });
  const show = (s: SkillView) => {
    if (open?.key === key(s)) { setOpen(null); return; }
    void read(s).then((r) => setOpen({ key: key(s), text: r.text })).catch((e) => toast({ tone: 'danger', title: 'Not readable', body: (e as Error).message }));
  };
  const edit = (s: SkillView) => void read(s).then((r) => setDraft({ name: s.name, description: s.description, roles: s.roles as AgentRole[], triggers: s.triggers.join(', '), body: bodyOf(r.text), editing: s.source === 'operator' })).catch(() => {});
  const importIt = (s: SkillView) => void call('skills.import', { name: s.name, hash: s.hash, from: s.source === 'external' ? 'external' : 'repository', ...(ws ? { workspaceId: ws } : {}) })
    .then((r) => { setState(r); setOpen(null); toast({ tone: 'info', title: `Imported ${s.name}`, body: 'This exact version is now offered to agents.' }); })
    .catch((e) => toast({ tone: 'danger', title: 'Not imported', body: (e as Error).message }));

  const row = (s: SkillView) => {
    const trusted = s.source === 'bundled' || s.source === 'operator';
    return (
      <div key={key(s)} className="lv-rt" data-testid="skill-row" data-source={s.source} data-name={s.name}>
        <div className="at-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="body-strong at-mono">{s.name}</span><span className="at-mono at-subtle lv-small">v{s.version} · {s.hash.slice(0, 12)}</span>
          <Badge tone={trusted ? 'outline' : 'warning'}>{s.source === 'repository' ? 'in repository · not trusted' : s.source === 'external' ? `${s.origin} · not trusted` : s.source}</Badge>
          {trusted && !s.enabled && <Badge tone="outline">off</Badge>}
          <span style={{ flex: 1 }} />
          {trusted && <Toggle on={s.enabled} onChange={(v) => void call('skills.setEnabled', { name: s.name, enabled: v }).then(() => reload())} label={`Offer ${s.name} to agents`} />}
          <Button size="sm" variant="ghost" onClick={() => show(s)}>{open?.key === key(s) ? 'Hide' : 'Read'}</Button>
          {trusted && <Button size="sm" variant="ghost" data-testid={`skill-edit-${s.name}`} onClick={() => edit(s)}>{s.source === 'operator' ? 'Edit' : 'Customize'}</Button>}
          {!trusted && open?.key === key(s) && <Button size="sm" onClick={() => importIt(s)} data-testid="skill-import">Import this version</Button>}
          {s.source === 'operator' && <Button size="sm" variant="ghost" onClick={() => void call('skills.remove', { name: s.name }).then(() => reload())}>Remove</Button>}
        </div>
        <span className="at-muted lv-small">{s.description}</span>
        <span className="at-subtle lv-small">Offered to: {s.roles.length ? s.roles.map(roleName).join(', ') : 'every role'}{s.files.length > 1 ? ` · ${s.files.length - 1} reference file${s.files.length > 2 ? 's' : ''}` : ''}</span>
        {s.triggers?.length > 0 && <span className="at-subtle lv-small" data-testid="skill-triggers">Recommended when a task mentions: {s.triggers.slice(0, 10).join(', ')}{s.triggers.length > 10 ? ` and ${s.triggers.length - 10} more` : ''}</span>}
        {s.usage && <span className="at-subtle lv-small" data-testid="skill-usage">Loaded in {s.usage.missions} mission{s.usage.missions === 1 ? '' : 's'} · {s.usage.verified} verified · {s.usage.failed} failed</span>}
        {open?.key === key(s) && <pre className="lv-proc-body" style={{ maxHeight: 300, whiteSpace: 'pre-wrap' }}>{open.text}</pre>}
      </div>
    );
  };

  return (
    <section className="lv-section" data-testid="skills">
      <div className="at-label">Skills</div>
      <p className="at-muted lv-small" style={{ margin: 0 }}>Reviewed procedures agents can load when relevant. Every load is recorded with the skill's hash. Skills describe how to work; ATLAS still verifies every result independently. Turn a skill off to stop offering it without deleting it.</p>
      {state?.trusted.map(row)}
      {draft ? <SkillForm draft={draft} onCancel={() => setDraft(null)} onSaved={(r) => { setState(r); setDraft(null); void reload(); }} /> : (
        <div><Button size="sm" data-testid="skill-new" onClick={() => setDraft({ name: '', description: '', roles: [], triggers: '', body: '## When to use\n\n## Procedure\n1. \n\n## Rules\n- ', editing: false })}>New skill</Button></div>
      )}
      {workspaces.length > 0 && (
        <>
          <div className="at-row" style={{ gap: 8, marginTop: 8 }}>
            <span className="at-label">Found in repository</span>
            <select className="lv-native-select" value={ws} onChange={(e) => setWs(e.target.value)}>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          </div>
          {state && !state.repository.length && <span className="at-subtle lv-small">No skills in .agents/skills or .pi/skills.</span>}
          {state?.repository.map(row)}
        </>
      )}
      <div className="at-label" style={{ marginTop: 8 }}>Found in other tools</div>
      {state && !state.external.length && <span className="at-subtle lv-small">No other skills in the Claude Code, Codex or OpenCode skill folders (ATLAS's own synced copies are not listed).</span>}
      {state?.external.map(row)}
      {state?.errors.length ? <span className="at-subtle lv-small">Not loaded: {state.errors.join('; ')}</span> : null}
    </section>
  );
}

function SkillForm({ draft, onCancel, onSaved }: { draft: Draft; onCancel: () => void; onSaved: (s: SkillsState) => void }) {
  const [d, setD] = useState(draft);
  const problem = !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.name) ? 'Name: lowercase words joined by hyphens.' : !d.description.trim() ? 'A description tells agents when to load it.' : !d.body.trim() ? 'Write the procedure.' : null;
  const triggers = d.triggers.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const save = () => void call('skills.save', { name: d.name, description: d.description, roles: d.roles, triggers, body: d.body })
    .then((r) => { toast({ tone: 'info', title: `Saved ${d.name}`, body: 'Offered to agents from their next attempt.' }); onSaved(r); })
    .catch((e) => toast({ tone: 'danger', title: 'Skill not saved', body: (e as Error).message }));
  return (
    <div className="lv-card" data-testid="skill-form" style={{ display: 'grid', gap: 8 }}>
      <Field label="Name" help={!d.editing && draft.name ? 'Saving creates your own copy; it replaces the bundled skill of the same name for agents.' : undefined}>
        <Input data-testid="skill-form-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="release-notes" maxLength={64} disabled={d.editing} />
      </Field>
      <Field label="Description" help="Agents see this in their skill index and load the skill when it matches."><Input data-testid="skill-form-description" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} maxLength={1024} /></Field>
      <Field label="Recommend when the task mentions" help="Comma-separated words or phrases; end a word with * to match its forms (flak* matches flaky). ATLAS recommends the skill to agents whose task matches.">
        <Input data-testid="skill-form-triggers" value={d.triggers} onChange={(e) => setD({ ...d, triggers: e.target.value })} placeholder="release, changelog, version bump" maxLength={1200} />
      </Field>
      <Field label="Offered to" help="None selected: every role.">
        <div className="at-row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {ROLES.map((r) => <span key={r} className="at-row lv-small" style={{ gap: 6 }}><Check on={d.roles.includes(r)} onChange={(v) => setD({ ...d, roles: v ? [...d.roles, r] : d.roles.filter((x) => x !== r) })} label={roleName(r)} />{roleName(r)}</span>)}
        </div>
      </Field>
      <Field label="Procedure (Markdown)"><textarea className="lv-textarea at-mono" data-testid="skill-form-body" rows={10} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} /></Field>
      <div className="at-row" style={{ gap: 8 }}>
        <Button variant="primary" data-testid="skill-form-save" disabled={!!problem} onClick={save}>Save skill</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {problem && <span className="at-subtle lv-small">{problem}</span>}
      </div>
    </div>
  );
}
