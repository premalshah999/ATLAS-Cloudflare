// Mission composer (manual §34): repository, objective, constraints, approval mode, runtime, preflight.
import React, { useEffect, useState } from 'react';
import { DEFAULT_BUDGET, type ApprovalMode, type MissionBudget, type ModelInfo, type RuntimeHealth, type RuntimeKind } from '@atlas/contracts';
import { Badge, Button, Field, Icon, Input, Seg, Select } from '../ui/primitives';
import { IFolderOpen, IInfo, IWarn, IXCircle, ISpark } from '../lib/icons';
import { call, type Preflight } from './api';
import { go, refreshLists, useLive } from './store';
import { openRepository } from './shell';
import { toast } from './toast';
import { ModelSelect } from './models';

const MODES: { id: ApprovalMode; label: string; help: string }[] = [
  { id: 'ask_risky', label: 'Ask for risky actions', help: 'Reads, edits inside the worktree and safe commands (tests, git status) run directly. Installs, network, deletes and git writes wait for you.' },
  { id: 'ask_all_writes', label: 'Ask for every write', help: 'Every file write and every privileged command waits for your approval.' },
  { id: 'plan_only', label: 'Read-only', help: 'Agents may read and run tests but cannot change files or run privileged commands.' },
];

export function NewMission({ workspaceId, item }: { workspaceId?: string; item?: { id: string; title: string; detail: string } }) {
  const workspaces = useLive((s) => s.workspaces);
  const [ws, setWs] = useState<string | undefined>(workspaceId ?? workspaces[0]?.id);
  const [title, setTitle] = useState(item?.title ?? '');
  const [goal, setGoal] = useState(item?.detail || item?.title || '');
  const [constraints, setConstraints] = useState('');
  const [mode, setMode] = useState<ApprovalMode>('ask_risky');
  const [runtime, setRuntime] = useState<RuntimeKind>('fake');
  const [health, setHealth] = useState<RuntimeHealth[]>([]);
  const [pre, setPre] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<{ target: string; provider: string; allowed: boolean }[]>([]);
  const [target, setTarget] = useState<string>('none');
  const [budget, setBudget] = useState<MissionBudget>(DEFAULT_BUDGET);
  const [showBudget, setShowBudget] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string | null>(null);

  useEffect(() => { if (!ws && workspaces[0]) setWs(workspaceId ?? workspaces[0].id); }, [workspaces, ws, workspaceId]);
  useEffect(() => { void call('models.list').then(setModels).catch(() => {}); }, []);
  useEffect(() => { void call('runtime.health').then((h) => { setHealth(h); if (h.find((x) => x.runtime === 'pi')?.ok) setRuntime('pi'); }).catch(() => {}); }, []);
  useEffect(() => {
    if (!ws) return;
    setPre(null);
    void call('workspace.preflight', { workspaceId: ws, runtime }).then(setPre).catch((e) => setPre([{ level: 'block', message: (e as Error).message }]));
  }, [ws, runtime]);
  useEffect(() => { setTarget('none'); setTargets([]); if (ws) void call('deploy.targets', { workspaceId: ws }).then(setTargets).catch(() => {}); }, [ws]);

  const blocked = !pre || pre.some((p) => p.level === 'block');
  const pi = health.find((h) => h.runtime === 'pi');
  const submit = async () => {
    if (!ws || !title.trim() || !goal.trim()) return;
    setBusy(true);
    try {
      const m = await call('mission.create', { workspaceId: ws, title: title.trim(), goal: goal.trim(), constraints, approvalMode: mode, runtime, budget, targetEnvironment: target === 'none' ? null : target, model: runtime === 'pi' ? model : null, ...(item ? { item: item.id } : {}) });
      await call('mission.plan', { missionId: m.id });
      await refreshLists();
      go({ screen: 'mission', missionId: m.id });
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not create the mission', body: (e as Error).message });
    } finally { setBusy(false); }
  };

  if (!workspaces.length) {
    return (
      <div className="at-screen lv-page">
        <div className="at-pagehead"><span className="heading">New mission</span></div>
        <div className="lv-scroll"><div className="lv-narrow"><p className="at-muted">Open a repository first.</p><Button variant="primary" icon={IFolderOpen} onClick={() => void openRepository()}>Open repository</Button></div></div>
      </div>
    );
  }

  return (
    <div className="at-screen lv-page" data-testid="new-mission">
      <div className="at-pagehead"><span className="heading">New mission</span></div>
      <div className="lv-scroll">
        <form className="lv-narrow lv-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {item && <div className="lv-callout" data-testid="mission-for-item" style={{ marginTop: 0 }}><span>For the team item <b>{item.title}</b>. Starting it takes the item (refused if a teammate already has it) and shares this mission with the team.</span></div>}
          <Field label="Repository">
            <div className="at-row" style={{ gap: 8 }}>
              <Select value={ws ?? ''} width={360} onChange={(v) => setWs(v)} options={workspaces.map((w) => ({ id: w.id, label: w.name, hint: w.branch ?? 'no git' }))} />
              <Button type="button" variant="ghost" icon={IFolderOpen} onClick={async () => { const id = await openRepository(); if (id) setWs(id); }}>Open another…</Button>
            </div>
          </Field>
          <Field label="Title"><Input data-testid="mission-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix slug generation for post titles" maxLength={160} /></Field>
          <Field label="Objective" help="Describe the outcome. ATLAS turns it into a plan you approve before anything runs.">
            <textarea data-testid="mission-goal" className="lv-textarea body-lg" rows={5} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="slugify() should lowercase, drop punctuation and collapse separators so the tests in test/slugify.test.js pass." />
          </Field>
          <Field label="Constraints" help="Optional. Things the agent must not do or must preserve.">
            <textarea className="lv-textarea" rows={2} value={constraints} onChange={(e) => setConstraints(e.target.value)} placeholder="Do not change the public function signature." />
          </Field>
          <Field label="Approval mode" help={MODES.find((m) => m.id === mode)!.help}>
            <Seg items={MODES.map((m) => ({ id: m.id, label: m.label }))} value={mode} onChange={setMode} />
          </Field>
          <Field label="Agent runtime" help={runtime === 'fake'
            ? 'Scripted sample runtime: deterministic behavior for the bundled sample project, a read-only survey elsewhere. No model is called.'
            : pi?.detail ?? 'Checking Pi…'}>
            <Seg items={[{ id: 'fake' as const, label: 'Scripted (no model)' }, { id: 'pi' as const, label: `Pi${pi ? (pi.ok ? '' : ' · not configured') : ''}` }]} value={runtime} onChange={setRuntime} />
          </Field>
          {runtime === 'pi' && (
            <Field label="Model" help="Every agent of this mission uses it. Leave it on Settings to use the default, fast and strong models chosen there per role.">
              <ModelSelect testId="mission-model" models={models} value={model} onChange={setModel} empty="From Settings (per role)" />
            </Field>
          )}
          <Field label="Target environment" help={targets.length === 0
            ? 'No deploy target in atlas.config.json: the mission verifies the change locally and deploys nothing.'
            : target === 'none' ? 'Verify locally only. Nothing is deployed.' : targets.find((t) => t.target === target)?.allowed
              ? 'After every check passes, ATLAS asks you to approve one staging deployment, verifies the served revision independently and rolls back on failure.'
              : 'This target is not on your allowlist (Settings → Deployments). The deploy stage will refuse it.'}>
            <Seg items={[{ id: 'none', label: 'None (local only)' }, ...targets.map((t) => ({ id: t.target, label: `${t.target} · staging${t.allowed ? '' : ' · not allowed'}` }))]} value={target} onChange={setTarget} />
          </Field>
          <Field label="Budget" aside={<button type="button" className="lv-link" onClick={() => setShowBudget(!showBudget)}>{showBudget ? 'Hide' : 'Change'}</button>}
            help={`${budget.maxConcurrentAgents} agents at once · ${budget.maxTasks} tasks · delegation depth ${budget.maxDelegationDepth} · ${budget.maxTokens.toLocaleString()} tokens · ${budget.maxWallClockMinutes} min. The mission stops with a reason at any limit.`}>
            {showBudget && (
              <div className="lv-budget-grid" data-testid="budget-fields">
                {([['maxConcurrentAgents', 'Agents at once', 1, 8], ['maxTasks', 'Tasks', 1, 50], ['maxDelegationDepth', 'Delegation depth', 0, 4], ['maxTokens', 'Tokens', 1000, 50_000_000], ['maxWallClockMinutes', 'Minutes', 1, 1440]] as const).map(([k, label, min, max]) => (
                  <label key={k} className="lv-budget-field"><span className="at-subtle lv-small">{label}</span>
                    <Input type="number" min={min} max={max} value={budget[k]} onChange={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v)) setBudget((b) => ({ ...b, [k]: Math.max(min, Math.min(max, v)) })); }} />
                  </label>
                ))}
              </div>
            )}
          </Field>

          <div className="lv-preflight" data-testid="preflight" data-ready={pre ? 'true' : 'false'}>
            <div className="at-label">Preflight</div>
            {!pre ? <div className="at-subtle lv-small">Checking the repository…</div> : pre.length === 0 ? <div className="at-subtle lv-small">No issues found.</div> : pre.map((p, i) => (
              <div key={i} className="lv-pf" data-level={p.level}>
                <Icon as={p.level === 'block' ? IXCircle : p.level === 'warn' ? IWarn : IInfo} size="sm" />
                <span>{p.message}</span>
              </div>
            ))}
          </div>

          <div className="at-row" style={{ gap: 8, marginTop: 8 }}>
            <Button type="submit" variant="primary" icon={ISpark} disabled={busy || blocked || !title.trim() || !goal.trim()} data-testid="plan-mission">Plan mission</Button>
            <span className="at-subtle lv-small">Planning does not change anything. You approve the plan before agents start.</span>
            {runtime === 'fake' && <Badge tone="sample">scripted runtime</Badge>}
          </div>
        </form>
      </div>
    </div>
  );
}
