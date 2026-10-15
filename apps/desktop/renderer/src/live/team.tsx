// Team space (ADR 0021): the people and agents working on one repository. Board, shared missions with reviews,
// people and teams, activity, and what this machine does for the team. The record lives in the repository's own git
// remote; this screen reads it from the daemon and refreshes every few seconds.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ItemView, MemberView, PipelineSettings, SharedMissionView, TeamInfo, TeamView } from '@atlas/contracts';
import { Badge, Button, Check, EmptyState, Icon, Input, Seg, Tabs, Toggle, Tip } from '../ui/primitives';
import { IUsers, IPlus, IRetry, ICopy, IFileDiff, ICheck, IXCircle, IMessage, IAgents, IExternal, IKey, IWarn } from '../lib/icons';
import { call } from './api';
import { go, useLive } from './store';
import { ago, initials } from './format';
import { toast } from './toast';

type Tab = 'board' | 'missions' | 'people' | 'activity' | 'automation';
const STATUS: { id: ItemView['status']; label: string }[] = [
  { id: 'open', label: 'Open' }, { id: 'in_progress', label: 'In progress' }, { id: 'review', label: 'In review' }, { id: 'done', label: 'Done' },
];
const PRIORITY_TONE = { urgent: 'danger', high: 'warning', normal: 'outline', low: 'outline' } as const;

export function TeamScreen({ workspaceId }: { workspaceId?: string }) {
  const workspaces = useLive((s) => s.workspaces).filter((w) => w.isGit);
  const ws = workspaceId && workspaces.some((w) => w.id === workspaceId) ? workspaceId : workspaces[0]?.id;
  const [view, setView] = useState<TeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('board');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { if (ws) void call('team.get', { workspaceId: ws }).then((v) => { setView(v); setError(null); }).catch((e) => setError((e as Error).message)); }, [ws]);
  useEffect(() => { setView(null); load(); const t = window.setInterval(load, 4000); return () => window.clearInterval(t); }, [load]);
  const act = async <T,>(label: string, fn: () => Promise<T>, after?: (v: T) => void) => {
    setBusy(true);
    try { const v = await fn(); after?.(v); if (v && typeof v === 'object' && 'workspaceId' in (v as object)) setView(v as unknown as TeamView); else load(); }
    catch (e) { toast({ tone: 'danger', title: label, body: (e as Error).message }); }
    finally { setBusy(false); }
  };

  if (!ws) return <div className="at-screen lv-page"><EmptyState center icon={IUsers} title="Open a git repository" body="A team space lives in a repository's own git remote. Open one to start or join its team." /></div>;
  const sync = view?.sync;
  return (
    <div className="at-screen lv-page" data-testid="team">
      <div className="at-pagehead lv-team-head">
        <span className="heading">{view?.space?.name ?? 'Team'}</span>
        {workspaces.length > 1 && <select className="lv-native-select" value={ws} onChange={(e) => go({ screen: 'team', workspaceId: e.target.value })}>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}
        <span style={{ flex: 1 }} />
        {view && (
          <Tip label={sync?.error ?? (view.remote ? `Shared through ${view.remote} on the ref refs/atlas/team` : 'No origin remote')}>
            <span className="lv-small at-row" style={{ gap: 6 }} data-testid="team-sync" data-state={sync?.state} data-at={sync?.at ?? ''}>
              <span className={`lv-pulse lv-pulse--${sync?.state ?? 'idle'}`} />
              {sync?.state === 'syncing' ? 'Syncing…' : sync?.state === 'error' ? 'Sync failed' : sync?.state === 'local' ? 'This machine only' : sync?.at ? `Synced ${ago(sync.at)}` : 'Not synced yet'}
            </span>
          </Tip>
        )}
        {view?.remote && <Button size="sm" variant="ghost" icon={IRetry} disabled={busy} data-testid="team-sync-now" onClick={() => void act('Sync failed', () => call('team.sync', { workspaceId: ws }))}>Sync</Button>}
      </div>
      <div className="lv-scroll">
        {error && <div className="lv-callout" style={{ margin: 20 }}><Icon as={IWarn} /><span>{error}</span></div>}
        {!view ? <div className="lv-loading">Loading team…</div>
          : !view.space || !view.me.member ? <Onboard view={view} busy={busy} act={act} />
          : (
            <>
              <div className="lv-tabs" style={{ padding: '0 20px' }}>
                <Tabs value={tab} onChange={setTab} items={[
                  { id: 'board', label: 'Board', count: view.items.filter((i) => i.status !== 'done' && i.status !== 'closed').length || undefined },
                  { id: 'missions', label: 'Missions', count: view.missions.filter((m) => needsMe(view, m)).length || undefined },
                  { id: 'people', label: 'People', count: view.joinRequests.length ? `${view.members.length} · ${view.joinRequests.length} waiting` : view.members.length },
                  { id: 'activity', label: 'Activity' },
                  { id: 'automation', label: 'Automation' },
                ]} />
              </div>
              <div className="lv-team-body">
                {tab === 'board' && <Board view={view} busy={busy} act={act} />}
                {tab === 'missions' && <Missions view={view} busy={busy} act={act} />}
                {tab === 'people' && <People view={view} busy={busy} act={act} />}
                {tab === 'activity' && <Activity view={view} />}
                {tab === 'automation' && <Automation view={view} busy={busy} act={act} />}
              </div>
            </>
          )}
      </div>
    </div>
  );
}

type Act = <T>(label: string, fn: () => Promise<T>, after?: (v: T) => void) => Promise<void>;
const nameOf = (v: TeamView, keyId: string | null) => !keyId ? 'Nobody' : keyId === 'agents' ? 'Agents' : v.members.find((m) => m.keyId === keyId)?.name ?? `${keyId.slice(0, 8)}…`;
const needsMe = (v: TeamView, m: SharedMissionView) => !m.mine && (
  (m.plan?.awaitingApproval && !m.planApprovals.some((a) => a.by === v.me.keyId && a.planVersion === m.plan!.version))
  || m.owners.some((o) => !o.approvedBy && v.teams.find((t) => t.slug === o.team)?.members.includes(v.me.keyId))
  || m.requested.people.includes(v.me.keyId) && !m.reviews.some((r) => r.by === v.me.keyId && r.current));

function Avatar({ name, agents, me, empty }: { name: string; agents?: boolean; me?: boolean; empty?: boolean }) {
  return <span className={`lv-avatar${agents ? ' lv-avatar--agents' : ''}${me ? ' lv-avatar--me' : ''}${empty ? ' lv-avatar--empty' : ''}`} title={name}>{agents ? <Icon as={IAgents} size="sm" /> : empty ? '' : initials(name)}</span>;
}

// ---- Joining ----

function Onboard({ view, busy, act }: { view: TeamView; busy: boolean; act: Act }) {
  const [name, setName] = useState(view.me.name);
  const [space, setSpace] = useState('');
  const [code, setCode] = useState('');
  const ws = view.workspaceId;
  if (view.space && view.me.requested) {
    return (
      <div className="lv-narrow">
        <EmptyState icon={IUsers} title={`Waiting to join “${view.space.name}”`} body="A maintainer admits you from their ATLAS. This screen updates when they have; nothing else is needed from you.">
          <Button variant="ghost" icon={IRetry} disabled={busy} onClick={() => void act('Sync failed', () => call('team.sync', { workspaceId: ws }))}>Check now</Button>
        </EmptyState>
        <KeyNote view={view} />
      </div>
    );
  }
  return (
    <div className="lv-narrow" data-testid="team-onboard">
      <p className="at-muted">Work on this repository with other people and their agents: a shared board, missions you can follow and review, owner approvals, and agents that pick up work. There is no server and no account. The team record is signed and kept in this repository's git remote{view.remote ? <> (<code>{view.remote}</code>)</> : ''}, so everyone with access to the repository can take part.</p>
      {!view.remote && <div className="lv-callout"><Icon as={IWarn} /><span>This repository has no <b>origin</b> remote. You can start a team space, but it stays on this machine until the repository has one.</span></div>}
      <div className="lv-team-onboard">
        <div className="lv-card" style={{ display: 'grid', gap: 10 }}>
          <b>{view.space ? `Join “${view.space.name}”` : 'Join a team'}</b>
          <span className="at-muted lv-small">Paste the invitation code a teammate sent you. Without a code, ask to join and a maintainer admits you.</span>
          <Input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} data-testid="team-my-name" />
          <Input placeholder="ATLAS-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} data-testid="team-code" />
          <div className="at-row" style={{ gap: 8 }}>
            <Button variant="primary" disabled={busy || !name.trim() || !code.trim()} data-testid="team-join" onClick={() => void act('Could not join', () => call('team.join', { workspaceId: ws, displayName: name.trim(), code: code.trim() }), () => toast({ tone: 'info', title: 'You joined the team' }))}>Join with code</Button>
            {view.space && <Button variant="ghost" disabled={busy || !name.trim()} data-testid="team-ask" onClick={() => void act('Could not ask to join', () => call('team.join', { workspaceId: ws, displayName: name.trim() }))}>Ask to join</Button>}
          </div>
        </div>
        {!view.space && (
          <div className="lv-card" style={{ display: 'grid', gap: 10 }}>
            <b>Start a team space</b>
            <span className="at-muted lv-small">You become its first maintainer. Then invite people and create teams; each team can own paths of the repository.</span>
            <Input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input placeholder="Team space name, e.g. Acme web" value={space} onChange={(e) => setSpace(e.target.value)} data-testid="team-space-name" />
            <Button variant="primary" icon={IPlus} disabled={busy || !name.trim() || !space.trim()} data-testid="team-create" onClick={() => void act('Could not start the team space', () => call('team.create', { workspaceId: ws, name: space.trim(), displayName: name.trim() }))}>Start team space</Button>
          </div>
        )}
      </div>
      <KeyNote view={view} />
    </div>
  );
}

function KeyNote({ view }: { view: TeamView }) {
  return <p className="at-subtle lv-small" style={{ marginTop: 16 }}><Icon as={IKey} size="sm" /> This installation signs everything it writes with its key <code data-testid="team-key">{view.me.keyId.slice(0, 8)}…{view.me.keyId.slice(-4)}</code>. Read it to a maintainer if they want to be sure it is you.</p>;
}

// ---- Board ----

function Board({ view, busy, act }: { view: TeamView; busy: boolean; act: Act }) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const items = view.items.filter((i) => i.status !== 'closed' && (filter === 'all' || (filter === 'mine' ? i.assignee === view.me.keyId : i.team === filter)));
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Composer view={view} busy={busy} act={act} />
      <div className="at-row" style={{ gap: 8 }}>
        <Seg items={[{ id: 'all', label: 'Everything' }, { id: 'mine', label: 'Mine' }, ...view.teams.map((t) => ({ id: t.slug, label: t.name }))]} value={filter} onChange={setFilter} />
      </div>
      <div className="lv-board" data-testid="team-board">
        {STATUS.map((col) => {
          const list = items.filter((i) => i.status === col.id);
          return (
            <div key={col.id} className="lv-col" data-testid={`team-col-${col.id}`}>
              <div className="lv-col-head"><span className="at-label">{col.label}</span><span className="at-subtle lv-small">{list.length}</span></div>
              {list.map((i) => <ItemCard key={i.id} view={view} item={i} open={open === i.id} onToggle={() => setOpen(open === i.id ? null : i.id)} busy={busy} act={act} />)}
              {!list.length && <div className="lv-col-empty">Nothing here</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Composer({ view, busy, act }: { view: TeamView; busy: boolean; act: Act }) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [team, setTeam] = useState<string>('');
  const [assignee, setAssignee] = useState<string>('');
  const [priority, setPriority] = useState<ItemView['priority']>('normal');
  const [more, setMore] = useState(false);
  const submit = () => void act('Could not add the item', () => call('team.item.create', {
    workspaceId: view.workspaceId, item: { title: title.trim(), detail, team: team || null, assignee: (assignee || null) as string | null, priority },
  }), () => { setTitle(''); setDetail(''); setMore(false); });
  return (
    <div className="lv-card lv-composer" data-testid="team-composer">
      <div className="at-row" style={{ gap: 8 }}>
        <Input style={{ flex: 1 }} placeholder="Add work for the team: a bug, a feature, a chore…" value={title} onChange={(e) => setTitle(e.target.value)} onFocus={() => setMore(true)} onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) submit(); }} data-testid="team-item-title" />
        <Button variant="primary" icon={IPlus} disabled={busy || !title.trim() || (assignee === 'agents' && !team)} data-testid="team-item-add" onClick={submit}>Add</Button>
      </div>
      {more && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <textarea className="lv-textarea" rows={3} placeholder="What done looks like. Agents use this as their goal." value={detail} onChange={(e) => setDetail(e.target.value)} data-testid="team-item-detail" />
          <div className="at-row lv-small" style={{ gap: 8, flexWrap: 'wrap' }}>
            <label className="at-row" style={{ gap: 6 }}>Team <select className="lv-native-select" value={team} onChange={(e) => setTeam(e.target.value)} data-testid="team-item-team"><option value="">None</option>{view.teams.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}</select></label>
            <label className="at-row" style={{ gap: 6 }}>For <select className="lv-native-select" value={assignee} onChange={(e) => setAssignee(e.target.value)} data-testid="team-item-assignee">
              <option value="">Anyone</option>
              <option value="agents" disabled={!team}>Agents of the team{team ? '' : ' (choose a team)'}</option>
              {view.members.map((m) => <option key={m.keyId} value={m.keyId}>{m.name}{m.me ? ' (you)' : ''}</option>)}
            </select></label>
            <Seg items={(['low', 'normal', 'high', 'urgent'] as const).map((p) => ({ id: p, label: p[0].toUpperCase() + p.slice(1) }))} value={priority} onChange={setPriority} />
          </div>
        </div>
      )}
    </div>
  );
}

function ItemCard({ view, item, open, onToggle, busy, act }: { view: TeamView; item: ItemView; open: boolean; onToggle: () => void; busy: boolean; act: Act }) {
  const [comment, setComment] = useState('');
  const ws = view.workspaceId;
  const team = view.teams.find((t) => t.slug === item.team);
  const mine = item.assignee === view.me.keyId;
  const missions = view.missions.filter((m) => item.missions.includes(m.missionId));
  const local = useLive((s) => s.missions);
  const update = (patch: Record<string, unknown>) => void act('Could not update the item', () => call('team.item.update', { workspaceId: ws, item: item.id, ...patch }));
  return (
    <div className={`lv-item${open ? ' lv-item--open' : ''}`} data-testid="team-item" data-title={item.title} data-status={item.status}>
      <button type="button" className="lv-item-main" onClick={onToggle}>
        <span className="lv-item-title">{item.title}</span>
        <span className="at-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {item.priority !== 'normal' && <Badge tone={PRIORITY_TONE[item.priority]}>{item.priority}</Badge>}
          {team && <Badge tone="outline">{team.name}</Badge>}
          {missions.map((m) => <Badge key={m.missionId} tone={m.verdict === 'verified' ? 'success' : m.state === 'failed' ? 'danger' : 'accent'}>{m.pipeline ?? m.state}</Badge>)}
          {item.comments.length > 0 && <span className="at-subtle lv-small"><Icon as={IMessage} size="sm" /> {item.comments.length}</span>}
          <span style={{ flex: 1 }} />
          <Avatar name={item.assignee ? nameOf(view, item.assignee) : 'Unassigned'} agents={item.assignee === 'agents'} me={mine} empty={!item.assignee} />
        </span>
      </button>
      {open && (
        <div className="lv-item-detail">
          {item.detail && <p className="lv-small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{item.detail}</p>}
          <span className="at-subtle lv-small">Added by {nameOf(view, item.createdBy)} {ago(item.createdAt)} · {item.assignee === 'agents' ? `waiting for ${team?.name ?? 'the team'}'s agents: a teammate's ATLAS that runs them picks it up` : `assigned to ${nameOf(view, item.assignee)}`}</span>
          <div className="at-row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {(item.status === 'open' || mine) && <Button size="sm" variant="primary" disabled={busy} data-testid="team-item-start" onClick={() => go({ screen: 'new', workspaceId: ws, item: { id: item.id, title: item.title, detail: item.detail } })}>Start a mission</Button>}
            {item.status === 'open' && !mine && <Button size="sm" disabled={busy} data-testid="team-item-claim" onClick={() => void act('Could not take it', () => call('team.item.claim', { workspaceId: ws, item: item.id }))}>Take it</Button>}
            {STATUS.filter((s) => s.id !== item.status).map((s) => <Button key={s.id} size="sm" variant="ghost" disabled={busy} onClick={() => update({ status: s.id })}>Move to {s.label.toLowerCase()}</Button>)}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => update({ status: 'closed' })}>Close</Button>
          </div>
          {missions.map((m) => {
            const here = local.find((x) => x.id === m.missionId);
            return <div key={m.missionId} className="lv-small at-row" style={{ gap: 6 }}><Icon as={IAgents} size="sm" />{here ? <a href="#" onClick={(e) => { e.preventDefault(); go({ screen: 'mission', missionId: m.missionId }); }}>{m.title}</a> : <span>{m.title}</span>} · {nameOf(view, m.author)} · {m.pipeline}</div>;
          })}
          <Comments view={view} list={item.comments} />
          <div className="at-row" style={{ gap: 6 }}>
            <Input style={{ flex: 1 }} placeholder="Comment" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && comment.trim()) void act('Comment not added', () => call('team.comment', { workspaceId: ws, item: item.id, text: comment.trim() }), () => setComment('')); }} />
          </div>
        </div>
      )}
    </div>
  );
}

function Comments({ view, list }: { view: TeamView; list: { id: string; by: string; at: string; text: string }[] }) {
  if (!list.length) return null;
  return <div className="lv-comments">{list.map((c) => <div key={c.id} className="lv-comment"><Avatar name={nameOf(view, c.by)} /><div><b className="lv-small">{nameOf(view, c.by)}</b> <span className="at-subtle lv-small">{ago(c.at)}</span><div className="lv-small" style={{ whiteSpace: 'pre-wrap' }}>{c.text}</div></div></div>)}</div>;
}

// ---- Shared missions and reviews ----

function Missions({ view, busy, act }: { view: TeamView; busy: boolean; act: Act }) {
  if (!view.missions.length) return <EmptyState icon={IAgents} title="No shared missions yet" body="Share a mission from its page (More → Share with the team), or turn on “Share every mission” under Automation. Teammates then follow it, review its change and approve its plan." />;
  const first = [...view.missions].sort((a, b) => Number(needsMe(view, b)) - Number(needsMe(view, a)));
  return <div style={{ display: 'grid', gap: 10 }} data-testid="team-missions">{first.map((m) => <SharedMissionCard key={m.missionId} view={view} m={m} busy={busy} act={act} />)}</div>;
}

function SharedMissionCard({ view, m, busy, act }: { view: TeamView; m: SharedMissionView; busy: boolean; act: Act }) {
  const [patch, setPatch] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const ws = view.workspaceId;
  const mine = m.mine;
  // Missions that run on this machine open in place.
  const local = useLive((st) => st.missions).some((x) => x.id === m.missionId);
  const myReview = m.reviews.filter((r) => r.by === view.me.keyId && r.current).at(-1);
  const planApprovedByMe = m.plan && m.planApprovals.some((a) => a.by === view.me.keyId && a.planVersion === m.plan!.version);
  const review = (verdict: 'approve' | 'changes') => void act('Review not recorded', () => call('team.review', { workspaceId: ws, missionId: m.missionId, commit: m.commit!, verdict, note }), () => { setNote(''); toast({ tone: 'info', title: verdict === 'approve' ? 'Approved' : 'Changes requested', body: `${nameOf(view, m.author)} sees it after the next sync.` }); });
  return (
    <div className="lv-card" data-testid="team-mission" data-title={m.title} style={{ display: 'grid', gap: 8 }}>
      <div className="at-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Avatar name={nameOf(view, m.author)} me={mine} />
        {local ? <a href="#" className="lv-link" data-testid="team-mission-open" onClick={(e) => { e.preventDefault(); go({ screen: 'mission', missionId: m.missionId }); }}><b>{m.title}</b></a> : <b>{m.title}</b>}
        <Badge tone={m.verdict === 'verified' ? 'success' : m.verdict === 'failed' || m.state === 'failed' ? 'danger' : 'accent'}>{m.pipeline ?? m.state}</Badge>
        {m.pullRequest && <a className="lv-small" href={m.pullRequest.url} target="_blank" rel="noreferrer">#{m.pullRequest.number}<Icon as={IExternal} size="sm" /></a>}
        {needsMe(view, m) && <Badge tone="warning">needs you</Badge>}
        <span style={{ flex: 1 }} />
        <span className="at-subtle lv-small">{nameOf(view, m.author)} · updated {ago(m.updatedAt)}</span>
      </div>
      {m.goal && <div className="at-muted lv-small lv-clamp">{m.goal}</div>}
      <div className="at-row lv-small" style={{ gap: 6, flexWrap: 'wrap' }}>
        {m.checks.map((c) => <Badge key={c.name} tone={c.result === 'pass' ? 'success' : c.result === 'fail' ? 'danger' : 'outline'}>{c.name}: {c.result}</Badge>)}
        {m.files.length > 0 && <span className="at-subtle">{m.files.length} file{m.files.length === 1 ? '' : 's'} changed</span>}
      </div>
      {m.owners.length > 0 && (
        <div className="at-row lv-small" style={{ gap: 6, flexWrap: 'wrap' }} data-testid="team-owners">
          {m.owners.map((o) => <Badge key={o.team} tone={o.approvedBy ? 'success' : 'warning'} icon={o.approvedBy ? ICheck : IWarn}>{view.teams.find((t) => t.slug === o.team)?.name ?? o.team}: {o.approvedBy ? `approved by ${nameOf(view, o.approvedBy)}` : `needs approval (${o.paths.slice(0, 2).join(', ')})`}</Badge>)}
        </div>
      )}
      {m.reviews.length > 0 && <div className="lv-small" style={{ display: 'grid', gap: 2 }}>{m.reviews.map((r) => <span key={r.id} className={r.current ? '' : 'at-subtle'}><Icon as={r.verdict === 'approve' ? ICheck : IXCircle} size="sm" /> {nameOf(view, r.by)} {r.verdict === 'approve' ? 'approved' : 'asked for changes'}{r.current ? '' : ' an earlier commit'}{r.note ? `: ${r.note}` : ''}</span>)}</div>}
      {m.plan?.awaitingApproval && (
        <div className="lv-callout" style={{ marginTop: 0 }}>
          <div style={{ flex: 1 }}><b>Plan v{m.plan.version} is waiting for approval.</b> {m.plan.summary} · {m.tasks.length} task{m.tasks.length === 1 ? '' : 's'}: {m.tasks.map((t) => t.title).join('; ')}</div>
          {!mine && <Button size="sm" variant="primary" disabled={busy || !!planApprovedByMe} data-testid="team-approve-plan" onClick={() => void act('Plan approval not recorded', () => call('team.plan.approve', { workspaceId: ws, missionId: m.missionId }), () => toast({ tone: 'info', title: 'Plan approved', body: `${nameOf(view, m.author)}'s ATLAS starts it if they allow teammates' approvals.` }))}>{planApprovedByMe ? 'You approved it' : 'Approve plan'}</Button>}
        </div>
      )}
      <div className="at-row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {m.hasPatch && <Button size="sm" variant="ghost" icon={IFileDiff} data-testid="team-view-diff" onClick={() => patch !== null ? setPatch(null) : void call('team.mission.patch', { workspaceId: ws, missionId: m.missionId }).then((r) => setPatch(r.patch ?? '')).catch(() => {})}>{patch !== null ? 'Hide change' : 'View change'}</Button>}
        {!mine && m.commit && (
          <>
            <Input style={{ flex: 1, minWidth: 180 }} placeholder="Review note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button size="sm" variant="primary" icon={ICheck} disabled={busy} data-testid="team-approve" onClick={() => review('approve')}>{myReview?.verdict === 'approve' ? 'Approved' : 'Approve'}</Button>
            <Button size="sm" disabled={busy} data-testid="team-request-changes" onClick={() => review('changes')}>Request changes</Button>
          </>
        )}
      </div>
      {patch !== null && <pre className="lv-diff" data-testid="team-diff">{patch.split('\n').map((l, i) => <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'lv-diff-add' : l.startsWith('-') && !l.startsWith('---') ? 'lv-diff-del' : l.startsWith('@@') ? 'lv-diff-hunk' : ''}>{l}{'\n'}</span>)}</pre>}
      <Comments view={view} list={m.comments} />
      <Input placeholder="Comment" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && comment.trim()) void act('Comment not added', () => call('team.comment', { workspaceId: ws, missionId: m.missionId, text: comment.trim() }), () => setComment('')); }} />
    </div>
  );
}

// ---- People and teams ----

function People({ view, busy, act }: { view: TeamView; busy: boolean; act: Act }) {
  const ws = view.workspaceId;
  const [code, setCode] = useState<string | null>(null);
  const [role, setRole] = useState<'member' | 'maintainer'>('member');
  const [teams, setTeams] = useState<string[]>([]);
  const [uses, setUses] = useState(1);
  const maint = view.me.maintainer;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {maint && view.joinRequests.length > 0 && (
        <section className="lv-section" style={{ marginBottom: 0 }}>
          <div className="at-label">Asking to join</div>
          {view.joinRequests.map((j) => <JoinRequest key={j.keyId} view={view} j={j} busy={busy} act={act} />)}
        </section>
      )}
      <section className="lv-section" style={{ marginBottom: 0 }} data-testid="team-members">
        <div className="at-label">People</div>
        {view.members.map((m) => <MemberRow key={m.keyId} view={view} m={m} busy={busy} act={act} />)}
      </section>
      {maint && (
        <section className="lv-section" style={{ marginBottom: 0 }}>
          <div className="at-label">Invite</div>
          <div className="lv-card" style={{ display: 'grid', gap: 8 }}>
            <div className="at-row lv-small" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Seg items={[{ id: 'member' as const, label: 'Member' }, { id: 'maintainer' as const, label: 'Maintainer' }]} value={role} onChange={setRole} />
              {view.teams.map((t) => <span key={t.slug} className="at-row" style={{ gap: 4 }}><Check on={teams.includes(t.slug)} onChange={(v) => setTeams(v ? [...teams, t.slug] : teams.filter((x) => x !== t.slug))} label={t.name} />{t.name}</span>)}
              <label className="at-row" style={{ gap: 4 }}>Uses <select className="lv-native-select" value={uses} onChange={(e) => setUses(Number(e.target.value))}>{[1, 5, 10, 25].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
              <Button size="sm" variant="primary" disabled={busy} data-testid="team-invite" onClick={() => void act('Invitation not created', () => call('team.invite', { workspaceId: ws, role, teams, uses, days: 7 }), (r) => setCode((r as { code: string }).code))}>Create invitation</Button>
            </div>
            {code && (
              <div className="lv-callout" style={{ marginTop: 0, alignItems: 'center' }}>
                <div style={{ flex: 1 }}>Send this code to the person you invite (valid 7 days, {uses} use{uses === 1 ? '' : 's'}). It is shown only now. <code className="lv-code-big" data-testid="team-invite-code">{code}</code></div>
                <Button size="sm" icon={ICopy} onClick={() => { void navigator.clipboard?.writeText(code).catch(() => {}); toast({ tone: 'info', title: 'Copied' }); }}>Copy</Button>
              </div>
            )}
            <span className="at-subtle lv-small">They open this repository in ATLAS, go to Team and paste the code. They are in as soon as both of you have synced: no approval step, no account.</span>
          </div>
        </section>
      )}
      <Teams view={view} busy={busy} act={act} />
      <KeyNote view={view} />
    </div>
  );
}

function JoinRequest({ view, j, busy, act }: { view: TeamView; j: TeamView['joinRequests'][number]; busy: boolean; act: Act }) {
  const [teams, setTeams] = useState<string[]>([]);
  return (
    <div className="lv-card at-row" style={{ gap: 8, flexWrap: 'wrap' }} data-testid="team-join-request">
      <Avatar name={j.name} /><b>{j.name}</b><span className="at-subtle lv-small">{j.email ?? ''} · key {j.keyId.slice(0, 8)}… · asked {ago(j.at)}</span>
      <span style={{ flex: 1 }} />
      {view.teams.map((t) => <span key={t.slug} className="at-row lv-small" style={{ gap: 4 }}><Check on={teams.includes(t.slug)} onChange={(v) => setTeams(v ? [...teams, t.slug] : teams.filter((x) => x !== t.slug))} label={t.name} />{t.name}</span>)}
      <Button size="sm" variant="primary" disabled={busy} data-testid="team-admit" onClick={() => void act('Not admitted', () => call('team.member.add', { workspaceId: view.workspaceId, keyId: j.keyId, role: 'member', teams }))}>Admit</Button>
    </div>
  );
}

function MemberRow({ view, m, busy, act }: { view: TeamView; m: MemberView; busy: boolean; act: Act }) {
  const maint = view.me.maintainer;
  const setTeams = (teams: string[]) => void act('Not changed', () => call('team.member.update', { workspaceId: view.workspaceId, keyId: m.keyId, teams }));
  return (
    <div className="lv-card at-row" style={{ gap: 8, flexWrap: 'wrap' }} data-testid="team-member" data-name={m.name}>
      <Avatar name={m.name} me={m.me} />
      <b>{m.name}{m.me ? ' (you)' : ''}</b>
      {m.role === 'maintainer' && <Badge tone="human">maintainer</Badge>}
      <span className="at-subtle lv-small">{m.email ?? ''} active {ago(m.lastActiveAt)}</span>
      <span style={{ flex: 1 }} />
      {view.teams.map((t) => maint
        ? <span key={t.slug} className="at-row lv-small" style={{ gap: 4 }}><Check on={m.teams.includes(t.slug)} onChange={(v) => setTeams(v ? [...m.teams, t.slug] : m.teams.filter((x) => x !== t.slug))} label={`${m.name} in ${t.name}`} />{t.name}</span>
        : m.teams.includes(t.slug) && <Badge key={t.slug} tone="outline">{t.name}</Badge>)}
      {maint && !m.me && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('Not changed', () => call('team.member.update', { workspaceId: view.workspaceId, keyId: m.keyId, role: m.role === 'maintainer' ? 'member' : 'maintainer' }))}>{m.role === 'maintainer' ? 'Make member' : 'Make maintainer'}</Button>}
      {maint && !m.me && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`Remove ${m.name} from the team space? Their past entries stay in the record.`)) void act('Not removed', () => call('team.member.remove', { workspaceId: view.workspaceId, keyId: m.keyId })); }}>Remove</Button>}
    </div>
  );
}

function Teams({ view, busy, act }: { view: TeamView; busy: boolean; act: Act }) {
  const [edit, setEdit] = useState<Partial<TeamInfo> | null>(null);
  const maint = view.me.maintainer;
  const save = () => {
    const name = (edit!.name ?? '').trim();
    const slug = edit!.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    void act('Team not saved', () => call('team.team.save', { workspaceId: view.workspaceId, team: { slug, name, description: edit!.description ?? '', owns: (edit!.owns ?? []).filter(Boolean), model: edit!.model ?? null } }), () => setEdit(null));
  };
  return (
    <section className="lv-section" style={{ marginBottom: 0 }} data-testid="team-teams">
      <div className="at-row"><div className="at-label" style={{ flex: 1 }}>Teams</div>{maint && <Button size="sm" variant="ghost" icon={IPlus} data-testid="team-new-team" onClick={() => setEdit({ owns: [] })}>New team</Button>}</div>
      <span className="at-muted lv-small">A team groups people and the agents that work for it. Paths a team owns need an approving review from one of its members before a change to them can be published.</span>
      {view.teams.map((t) => (
        <div key={t.slug} className="lv-card" style={{ display: 'grid', gap: 4 }} data-testid="team-team" data-slug={t.slug}>
          <div className="at-row" style={{ gap: 8 }}><b>{t.name}</b><span className="at-subtle lv-small">{t.members.length} member{t.members.length === 1 ? '' : 's'}{t.model ? ` · agents use ${t.model}` : ''}</span><span style={{ flex: 1 }} />{maint && <Button size="sm" variant="ghost" onClick={() => setEdit(t)}>Edit</Button>}</div>
          {t.description && <span className="at-muted lv-small">{t.description}</span>}
          {t.owns.length > 0 && <span className="lv-small">Owns {t.owns.map((g) => <code key={g} style={{ marginRight: 6 }}>{g}</code>)}</span>}
        </div>
      ))}
      {edit && (
        <div className="lv-card" style={{ display: 'grid', gap: 8 }}>
          <Input placeholder="Team name, e.g. Platform" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} data-testid="team-team-name" />
          <Input placeholder="Description" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
          <Input placeholder="Owned paths, comma separated: infra/, *.tf, src/payments/**" value={(edit.owns ?? []).join(', ')} onChange={(e) => setEdit({ ...edit, owns: e.target.value.split(',').map((x) => x.trim()) })} data-testid="team-team-owns" />
          <Input placeholder="Model for this team's agents (provider/model), optional" value={edit.model ?? ''} onChange={(e) => setEdit({ ...edit, model: e.target.value.trim() || null })} />
          <div className="at-row" style={{ gap: 6 }}>
            <Button size="sm" variant="primary" disabled={busy || !(edit.name ?? '').trim()} data-testid="team-team-save" onClick={save}>Save team</Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            {edit.slug && <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Remove the team ${edit.name}?`)) void act('Not removed', () => call('team.team.remove', { workspaceId: view.workspaceId, slug: edit.slug! }), () => setEdit(null)); }}>Remove team</Button>}
          </div>
        </div>
      )}
    </section>
  );
}

// ---- Activity ----

function Activity({ view }: { view: TeamView }) {
  return (
    <div className="lv-feed" data-testid="team-activity">
      {view.activity.map((a) => (
        <div key={a.id} className="lv-feed-row"><Avatar name={nameOf(view, a.by)} /><span className="lv-small"><b>{nameOf(view, a.by)}</b> {a.text}</span><span className="at-subtle lv-small">{ago(a.at)}</span></div>
      ))}
      {view.rejected.length > 0 && <div className="lv-callout"><Icon as={IWarn} /><span>{view.rejected.length} entr{view.rejected.length === 1 ? 'y' : 'ies'} in the record had no effect: {[...new Set(view.rejected.map((r) => r.reason))].slice(0, 4).join('; ')}.</span></div>}
    </div>
  );
}

// ---- Automation: this machine and the pipeline ----

function Automation({ view, busy, act }: { view: TeamView; busy: boolean; act: Act }) {
  const ws = view.workspaceId;
  const s = view.settings;
  const [pipe, setPipe] = useState<PipelineSettings | null>(null);
  useEffect(() => { void call('pipeline.get', { workspaceId: ws }).then(setPipe).catch(() => {}); }, [ws]);
  const set = (settings: Record<string, unknown>) => void act('Not saved', () => call('team.settings', { workspaceId: ws, settings }));
  const setP = (settings: Partial<PipelineSettings>) => void call('pipeline.set', { workspaceId: ws, settings }).then(setPipe).catch((e) => toast({ tone: 'danger', title: 'Not saved', body: (e as Error).message }));
  const runnerTeams = useMemo(() => new Set(s.runner.teams), [s.runner.teams]);
  const row = (label: string, help: string, on: boolean, onChange: (v: boolean) => void, testid: string) => (
    <div className="lv-setting-row" data-testid={testid}><div style={{ flex: 1 }}><b className="lv-small">{label}</b><div className="at-muted lv-small">{help}</div></div><Toggle on={on} onChange={onChange} label={label} /></div>
  );
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="lv-section" style={{ marginBottom: 0 }}>
        <div className="at-label">Delivery pipeline · this repository</div>
        <span className="at-muted lv-small">What ATLAS does after you accept a verified change. It never merges and never deploys to production; risky commands inside a fix still wait for a person.</span>
        {pipe && (
          <div className="lv-card" style={{ display: 'grid', gap: 10 }} data-testid="pipeline-settings">
            {row('Open the pull request on acceptance', 'Push the accepted branch and open (or update) its pull request without a second click. Needs a GitHub token.', pipe.autoPublish, (v) => setP({ autoPublish: v }), 'pipeline-autopublish')}
            <div className="lv-setting-row"><div style={{ flex: 1 }}><b className="lv-small">When CI fails</b><div className="at-muted lv-small">Prepare a fix mission for you, or run it: plan (approved automatically unless a task is high-risk), build, verify, push to the same pull request.</div></div>
              <Seg items={[{ id: 'off' as const, label: 'Do nothing' }, { id: 'propose' as const, label: 'Prepare a fix' }, { id: 'auto' as const, label: 'Fix automatically' }]} value={pipe.fixCi} onChange={(v) => setP({ fixCi: v })} />
            </div>
            {pipe.fixCi === 'auto' && row('Accept verified fixes', 'Accept an automatic fix when it is verified with no blocking finding. Off: a person accepts each fix.', pipe.autoAcceptFixes, (v) => setP({ autoAcceptFixes: v }), 'pipeline-autoaccept')}
            {pipe.fixCi !== 'off' && <div className="lv-setting-row"><div style={{ flex: 1 }}><b className="lv-small">Fix rounds per pull request</b><div className="at-muted lv-small">Then ATLAS stops and says a person needs to look.</div></div><Seg items={[1, 2, 3, 5].map((n) => ({ id: String(n), label: String(n) }))} value={String(pipe.maxFixRounds)} onChange={(v) => setP({ maxFixRounds: Number(v) })} /></div>}
          </div>
        )}
      </section>
      <section className="lv-section" style={{ marginBottom: 0 }}>
        <div className="at-label">This machine and the team</div>
        <div className="lv-card" style={{ display: 'grid', gap: 10 }}>
          {row('Keep in sync', 'Fetch and push the team record every 30 seconds and right after each change made here.', s.autoSync, (v) => set({ autoSync: v }), 'team-autosync')}
          {row('Share every mission', 'Every mission of this repository appears to the team as it runs, with its plan, checks and change.', s.shareAll, (v) => set({ shareAll: v }), 'team-shareall')}
          {row('Start plans teammates approve', 'A plan waiting here starts when a teammate approves that exact version. Off: only you approve plans on this machine.', s.acceptPlanApprovals, (v) => set({ acceptPlanApprovals: v }), 'team-accept-approvals')}
        </div>
      </section>
      <section className="lv-section" style={{ marginBottom: 0 }}>
        <div className="at-label">Agent runner</div>
        <span className="at-muted lv-small">Run the work the team assigns to agents. This machine claims an item, plans it as a mission here and shares it; a teammate approves the plan, the agents build and verify it in this machine's sandbox, and the item moves to review. Two at a time.</span>
        <div className="lv-card" style={{ display: 'grid', gap: 10 }} data-testid="team-runner">
          {row('Run agent work here', 'Uses this machine\'s models, keys and sandbox.', s.runner.enabled, (v) => set({ runner: { ...s.runner, enabled: v } }), 'team-runner-enabled')}
          <div className="at-row lv-small" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span>For</span>
            {view.teams.length === 0 && <span className="at-subtle">no teams yet: create one under People</span>}
            {view.teams.map((t) => <span key={t.slug} className="at-row" style={{ gap: 4 }}><Check on={runnerTeams.has(t.slug)} onChange={(v) => set({ runner: { ...s.runner, teams: v ? [...s.runner.teams, t.slug] : s.runner.teams.filter((x) => x !== t.slug) } })} label={t.name} />{t.name}</span>)}
            <Seg items={[{ id: 'pi' as const, label: 'Pi (models)' }, { id: 'fake' as const, label: 'Scripted sample' }]} value={s.runner.runtime} onChange={(v) => set({ runner: { ...s.runner, runtime: v } })} />
          </div>
        </div>
      </section>
      {busy && <span className="at-subtle lv-small">Saving…</span>}
    </div>
  );
}
