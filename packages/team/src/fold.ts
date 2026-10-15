// Reading a team record (ADR 0021). Every installation folds the same set of entries in the same order (author time,
// then id) and applies the same rules, so all members see the same team without a server deciding. An entry that
// fails a rule is kept in the record but has no effect, and the view lists it with the reason.
import {
  EntryBodies, TeamEntry, type ActivityView, type CommentView, type EntryBody, type EntryKind, type InviteView, type ItemView, type JoinRequestView,
  type MemberView, type SharedMission, type SharedMissionView, type TeamInfo,
} from '@atlas/contracts';
import { entryId, inviteProofValid, keyIdOf, verifyEd25519 } from './crypto';
import { matchesAny } from './glob';

export interface TeamRecord { id: string; entry: TeamEntry }

export interface Member { keyId: string; publicKey: string; name: string; email: string | null; role: 'maintainer' | 'member'; teams: string[]; joinedAt: string; via: MemberView['via']; lastActiveAt: string }
interface Invite { id: string; by: string; publicKey: string; role: 'maintainer' | 'member'; teams: string[]; uses: number; used: string[]; expiresAt: string; note: string }
interface Item extends Omit<ItemView, 'comments'> { comments: CommentView[] }
interface Review { id: string; by: string; at: string; commit: string; verdict: 'approve' | 'changes'; note: string }
export interface Shared {
  snapshot: SharedMission; author: string; sharedAt: string; updatedAt: string;
  reviews: Review[]; comments: CommentView[]; planApprovals: { id: string; by: string; at: string; planVersion: number; planHash: string }[];
}

export interface TeamState {
  space: { id: string; name: string; createdAt: string; createdBy: string } | null;
  members: Map<string, Member>;
  former: Map<string, Member>;
  teams: Map<string, Omit<TeamInfo, 'members'>>;
  invites: Map<string, Invite>;
  joinRequests: Map<string, JoinRequestView & { publicKey: string }>;
  items: Map<string, Item>;
  missions: Map<string, Shared>;
  activity: ActivityView[];
  rejected: { id: string; kind: string; reason: string }[];
  /** Display names of everyone who ever wrote here (members, former members, people asking to join). */
  names: Map<string, string>;
  /** Time of the newest accepted entry: a new entry from here is stamped after it. */
  lastAt: string | null;
  size: number;
}

const checked = new Map<string, string | null>();
/** Signature, key id, schema: what can be checked about one entry on its own. Null when it is sound. */
export function entryProblem(r: TeamRecord): string | null {
  const memo = `${r.id}:${r.entry.sig}`;
  if (checked.has(memo)) return checked.get(memo)!;
  let problem: string | null = null;
  const e = TeamEntry.safeParse(r.entry);
  if (!e.success) problem = 'malformed entry';
  else if (entryId(e.data) !== r.id) problem = 'content does not match its id';
  else if (keyIdOf(e.data.publicKey) !== e.data.author) problem = 'author is not the signing key';
  else if (!verifyEd25519(r.id, e.data.publicKey, e.data.sig)) problem = 'bad signature';
  else if (!EntryBodies[e.data.kind].safeParse(e.data.body).success) problem = `malformed ${e.data.kind}`;
  if (checked.size > 50_000) checked.clear();
  checked.set(memo, problem);
  return problem;
}

const order = (a: TeamRecord, b: TeamRecord) => (a.entry.at < b.entry.at ? -1 : a.entry.at > b.entry.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function emptyState(): TeamState {
  return { space: null, members: new Map(), former: new Map(), teams: new Map(), invites: new Map(), joinRequests: new Map(), items: new Map(), missions: new Map(), activity: [], rejected: [], names: new Map(), lastAt: null, size: 0 };
}

class Refused extends Error {}
const refuse = (why: string): never => { throw new Refused(why); };

export function fold(records: TeamRecord[]): TeamState {
  const s = emptyState();
  const sound = records.filter((r) => {
    const p = entryProblem(r);
    if (p) s.rejected.push({ id: r.id, kind: String((r.entry as { kind?: unknown })?.kind ?? '?').slice(0, 40), reason: p });
    return !p;
  }).sort(order);
  // The space is the earliest `space.create`; a second one (two people started a space at once) loses.
  const genesis = sound.find((r) => r.entry.kind === 'space.create' && r.entry.space === null);
  if (!genesis) return s;
  for (const r of sound) {
    const e = r.entry;
    if (r === genesis) { apply(s, r); continue; }
    if (e.space !== genesis.id) { s.rejected.push({ id: r.id, kind: e.kind, reason: e.kind === 'space.create' ? 'another team space was started first' : 'belongs to another team space' }); continue; }
    try { apply(s, r); }
    catch (err) { if (err instanceof Refused) s.rejected.push({ id: r.id, kind: e.kind, reason: err.message }); else throw err; }
  }
  return s;
}

/** Apply one entry to the state, or throw Refused. Exported for `wouldAccept`. */
export function apply(s: TeamState, r: TeamRecord): void {
  const e = r.entry;
  const kind = e.kind;
  const body = EntryBodies[kind].parse(e.body) as EntryBody<EntryKind>;
  const by = s.members.get(e.author);
  const name = (k: string) => s.names.get(k) ?? `${k.slice(0, 8)}…`;
  const needMember = () => by ?? refuse(s.former.has(e.author) ? 'the author is no longer a member' : 'the author is not a member');
  const needMaintainer = () => { const m = needMember(); if (m.role !== 'maintainer') refuse('only maintainers can do this'); return m; };
  const maintainers = () => [...s.members.values()].filter((m) => m.role === 'maintainer').length;
  const knownTeams = (teams: string[]) => { for (const t of teams) if (!s.teams.has(t)) refuse(`no team named ${t}`); return [...new Set(teams)]; };
  const activity = (text: string, ref: { item?: string | null; missionId?: string | null } = {}) =>
    s.activity.push({ id: r.id, at: e.at, by: e.author, text, kind, item: ref.item ?? null, missionId: ref.missionId ?? null });
  const item = (id: string) => s.items.get(id) ?? refuse('no such item');

  switch (kind) {
    case 'space.create': {
      const b = body as EntryBody<'space.create'>;
      s.space = { id: r.id, name: b.name, createdAt: e.at, createdBy: e.author };
      s.members.set(e.author, { keyId: e.author, publicKey: e.publicKey, name: b.member.name, email: b.member.email ?? null, role: 'maintainer', teams: [], joinedAt: e.at, via: 'created', lastActiveAt: e.at });
      s.names.set(e.author, b.member.name);
      activity(`started the team space “${b.name}”`);
      break;
    }
    case 'member.invite': {
      const b = body as EntryBody<'member.invite'>;
      needMaintainer();
      s.invites.set(r.id, { id: r.id, by: e.author, publicKey: b.invitePublicKey, role: b.role, teams: knownTeams(b.teams), uses: b.uses, used: [], expiresAt: b.expiresAt, note: b.note });
      activity(`created an invitation${b.note ? ` (${b.note})` : ''}`);
      break;
    }
    case 'member.join': {
      const b = body as EntryBody<'member.join'>;
      if (s.members.has(e.author)) refuse('already a member');
      s.names.set(e.author, b.name);
      if (!b.invite) {
        s.joinRequests.set(e.author, { keyId: e.author, publicKey: e.publicKey, name: b.name, email: b.email ?? null, at: e.at });
        activity('asked to join');
        break;
      }
      const inv = s.invites.get(b.invite.id) ?? refuse('no such invitation');
      if (e.at > inv.expiresAt) refuse('the invitation expired');
      if (inv.used.length >= inv.uses) refuse('the invitation was already used');
      if (!s.members.has(inv.by)) refuse('the person who invited is no longer a member');
      if (!inviteProofValid(inv.publicKey, s.space!.id, inv.id, e.author, b.invite.signature)) refuse('wrong invitation code');
      inv.used.push(e.author);
      s.joinRequests.delete(e.author);
      s.former.delete(e.author);
      s.members.set(e.author, { keyId: e.author, publicKey: e.publicKey, name: b.name, email: b.email ?? null, role: inv.role, teams: inv.teams.filter((t) => s.teams.has(t)), joinedAt: e.at, via: 'invite', lastActiveAt: e.at });
      activity(`joined with ${name(inv.by)}’s invitation`);
      break;
    }
    case 'member.add': {
      const b = body as EntryBody<'member.add'>;
      needMaintainer();
      if (s.members.has(b.keyId)) refuse('already a member');
      const req = s.joinRequests.get(b.keyId) ?? refuse('this key has not asked to join');
      s.joinRequests.delete(b.keyId);
      s.former.delete(b.keyId);
      s.members.set(b.keyId, { keyId: b.keyId, publicKey: req.publicKey, name: req.name, email: req.email, role: b.role, teams: knownTeams(b.teams), joinedAt: e.at, via: 'added', lastActiveAt: e.at });
      activity(`added ${req.name}${b.role === 'maintainer' ? ' as a maintainer' : ''}`);
      break;
    }
    case 'member.update': {
      const b = body as EntryBody<'member.update'>;
      const self = b.keyId === e.author;
      if (!self || b.role !== undefined || b.teams !== undefined) needMaintainer(); else needMember();
      const m = s.members.get(b.keyId) ?? refuse('not a member');
      if (b.role === 'member' && m.role === 'maintainer' && maintainers() === 1) refuse('a team space keeps at least one maintainer');
      if (b.name) { m.name = b.name; s.names.set(m.keyId, b.name); }
      if (b.role) m.role = b.role;
      if (b.teams) m.teams = knownTeams(b.teams);
      activity(self ? 'updated their profile' : `updated ${m.name}`);
      break;
    }
    case 'member.remove': {
      const b = body as EntryBody<'member.remove'>;
      if (b.keyId !== e.author) needMaintainer(); else needMember();
      const m = s.members.get(b.keyId) ?? refuse('not a member');
      if (m.role === 'maintainer' && maintainers() === 1) refuse('a team space keeps at least one maintainer');
      s.members.delete(b.keyId);
      s.former.set(b.keyId, m);
      activity(b.keyId === e.author ? 'left the team space' : `removed ${m.name}`);
      break;
    }
    case 'team.upsert': {
      const b = body as EntryBody<'team.upsert'>;
      needMaintainer();
      const existed = s.teams.has(b.slug);
      s.teams.set(b.slug, { slug: b.slug, name: b.name, description: b.description, owns: b.owns, model: b.model });
      activity(`${existed ? 'updated' : 'created'} the team ${b.name}`);
      break;
    }
    case 'team.remove': {
      const b = body as EntryBody<'team.remove'>;
      needMaintainer();
      const t = s.teams.get(b.slug) ?? refuse('no such team');
      s.teams.delete(b.slug);
      for (const m of s.members.values()) m.teams = m.teams.filter((x) => x !== b.slug);
      activity(`removed the team ${t.name}`);
      break;
    }
    case 'item.create': {
      const b = body as EntryBody<'item.create'>;
      needMember();
      if (b.team) knownTeams([b.team]);
      if (b.assignee && b.assignee !== 'agents' && !s.members.has(b.assignee)) refuse('the assignee is not a member');
      if (b.assignee === 'agents' && !b.team) refuse('choose the team whose agents take it');
      s.items.set(r.id, { id: r.id, title: b.title, detail: b.detail, team: b.team, assignee: b.assignee, priority: b.priority, status: 'open', createdBy: e.author, createdAt: e.at, updatedAt: e.at, missions: [], comments: [] });
      activity(`created “${b.title}”${b.assignee === 'agents' ? ` for ${s.teams.get(b.team!)!.name}’s agents` : b.assignee ? ` for ${name(b.assignee)}` : ''}`, { item: r.id });
      break;
    }
    case 'item.update': {
      const b = body as EntryBody<'item.update'>;
      needMember();
      const it = item(b.item);
      if (b.team) knownTeams([b.team]);
      const team = b.team !== undefined ? b.team : it.team;
      if (b.assignee && b.assignee !== 'agents' && !s.members.has(b.assignee)) refuse('the assignee is not a member');
      if ((b.assignee ?? it.assignee) === 'agents' && !team) refuse('choose the team whose agents take it');
      const changes: string[] = [];
      if (b.title !== undefined && b.title !== it.title) { it.title = b.title; changes.push('renamed it'); }
      if (b.detail !== undefined) it.detail = b.detail;
      if (b.team !== undefined) it.team = b.team;
      if (b.priority !== undefined && b.priority !== it.priority) { it.priority = b.priority; changes.push(`set priority ${b.priority}`); }
      if (b.assignee !== undefined && b.assignee !== it.assignee) { it.assignee = b.assignee; changes.push(b.assignee === 'agents' ? 'assigned it to agents' : b.assignee ? `assigned it to ${name(b.assignee)}` : 'unassigned it'); }
      if (b.status !== undefined && b.status !== it.status) { it.status = b.status; changes.push(`moved it to ${b.status.replace('_', ' ')}`); }
      it.updatedAt = e.at;
      activity(`${changes.join(', ') || 'edited'} · “${it.title}”`, { item: it.id });
      break;
    }
    case 'item.claim': {
      const b = body as EntryBody<'item.claim'>;
      needMember();
      const it = item(b.item);
      if (it.assignee && it.assignee !== 'agents' && it.assignee !== e.author) refuse(`${name(it.assignee)} already has it`);
      if (it.status === 'done' || it.status === 'closed') refuse('the item is finished');
      it.assignee = e.author;
      it.status = 'in_progress';
      if (b.missionId && !it.missions.includes(b.missionId)) it.missions.push(b.missionId);
      it.updatedAt = e.at;
      activity(`picked up “${it.title}”`, { item: it.id, missionId: b.missionId });
      break;
    }
    case 'mission.share': {
      const b = body as EntryBody<'mission.share'>;
      needMember();
      const prev = s.missions.get(b.missionId);
      if (prev && prev.author !== e.author) refuse('another member shared this mission');
      if (b.item) { const it = item(b.item); if (!it.missions.includes(b.missionId)) it.missions.push(b.missionId); }
      const first = !prev;
      const was = prev?.snapshot;
      s.missions.set(b.missionId, { snapshot: b, author: e.author, sharedAt: prev?.sharedAt ?? e.at, updatedAt: e.at, reviews: prev?.reviews ?? [], comments: prev?.comments ?? [], planApprovals: prev?.planApprovals ?? [] });
      if (first) activity(`shared “${b.title}”`, { item: b.item, missionId: b.missionId });
      else if (was && (was.state !== b.state || was.verdict !== b.verdict || was.decision !== b.decision || was.pullRequest?.ci !== b.pullRequest?.ci || was.pipeline !== b.pipeline)) {
        const what = b.pipeline && b.pipeline !== was.pipeline ? b.pipeline : b.decision && b.decision !== was.decision ? b.decision : b.verdict && b.verdict !== was.verdict ? b.verdict : b.state.replace('_', ' ');
        activity(`“${b.title}”: ${what}`, { item: b.item, missionId: b.missionId });
      }
      break;
    }
    case 'review': {
      const b = body as EntryBody<'review'>;
      needMember();
      const m = s.missions.get(b.missionId) ?? refuse('no such shared mission');
      if (m.author === e.author) refuse('authors do not review their own change');
      m.reviews.push({ id: r.id, by: e.author, at: e.at, commit: b.commit, verdict: b.verdict, note: b.note });
      activity(`${b.verdict === 'approve' ? 'approved' : 'asked for changes to'} “${m.snapshot.title}”`, { missionId: b.missionId, item: m.snapshot.item });
      break;
    }
    case 'plan.approve': {
      const b = body as EntryBody<'plan.approve'>;
      needMember();
      const m = s.missions.get(b.missionId) ?? refuse('no such shared mission');
      if (m.author === e.author) refuse('the author approves their own plan in ATLAS directly');
      m.planApprovals.push({ id: r.id, by: e.author, at: e.at, planVersion: b.planVersion, planHash: b.planHash });
      activity(`approved the plan of “${m.snapshot.title}”`, { missionId: b.missionId, item: m.snapshot.item });
      break;
    }
    case 'comment': {
      const b = body as EntryBody<'comment'>;
      needMember();
      const c = { id: r.id, by: e.author, at: e.at, text: b.text };
      if (b.item) { const it = item(b.item); it.comments.push(c); activity(`commented on “${it.title}”`, { item: it.id }); }
      else { const m = s.missions.get(b.missionId!) ?? refuse('no such shared mission'); m.comments.push(c); activity(`commented on “${m.snapshot.title}”`, { missionId: b.missionId, item: m.snapshot.item }); }
      break;
    }
  }
  const m = s.members.get(e.author);
  if (m) m.lastActiveAt = e.at;
  if (!s.lastAt || e.at > s.lastAt) s.lastAt = e.at;
  s.size++;
}

/** Owner approval for a change (ADR 0021): every team owning a touched path needs an approval of this commit from one of its members other than the author. */
export function ownership(s: TeamState, author: string, files: string[], commit: string | null, reviews: Review[]): { team: string; paths: string[]; approvedBy: string | null }[] {
  const out: { team: string; paths: string[]; approvedBy: string | null }[] = [];
  for (const t of s.teams.values()) {
    if (!t.owns.length) continue;
    const paths = files.filter((f) => matchesAny(f, t.owns).length);
    if (!paths.length) continue;
    const owners = [...s.members.values()].filter((m) => m.teams.includes(t.slug) && m.keyId !== author);
    // A team with no other member: any other maintainer can approve for it.
    const eligible = new Set((owners.length ? owners : [...s.members.values()].filter((m) => m.role === 'maintainer' && m.keyId !== author)).map((m) => m.keyId));
    const latest = new Map<string, Review>();
    for (const r of reviews) if (r.commit === commit && eligible.has(r.by)) latest.set(r.by, r);
    const ok = [...latest.values()].find((r) => r.verdict === 'approve');
    out.push({ team: t.slug, paths: paths.slice(0, 20), approvedBy: ok?.by ?? null });
  }
  return out;
}

/** The renderer's view of the state, for the member `me`. */
export function teamParts(s: TeamState, me: string, now = new Date().toISOString()) {
  const members: MemberView[] = [...s.members.values()].map((m) => ({ keyId: m.keyId, name: m.name, email: m.email, role: m.role, teams: m.teams, joinedAt: m.joinedAt, via: m.via, lastActiveAt: m.lastActiveAt, me: m.keyId === me }))
    .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'maintainer' ? -1 : 1));
  const teams: TeamInfo[] = [...s.teams.values()].map((t) => ({ ...t, members: members.filter((m) => m.teams.includes(t.slug)).map((m) => m.keyId) })).sort((a, b) => a.name.localeCompare(b.name));
  const invites: InviteView[] = [...s.invites.values()].map((i) => ({ id: i.id, by: i.by, role: i.role, teams: i.teams, uses: i.uses, used: i.used.length, expiresAt: i.expiresAt, note: i.note, expired: now > i.expiresAt || i.used.length >= i.uses }));
  const joinRequests: JoinRequestView[] = [...s.joinRequests.values()].map(({ publicKey: _p, ...j }) => j);
  const items: ItemView[] = [...s.items.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const missions: SharedMissionView[] = [...s.missions.values()].map((m) => {
    const { patch, ...snap } = m.snapshot;
    return {
      ...snap, author: m.author, sharedAt: m.sharedAt, updatedAt: m.updatedAt, hasPatch: !!patch, comments: m.comments, mine: m.author === me,
      reviews: m.reviews.map((r) => ({ ...r, current: r.commit === m.snapshot.commit })),
      planApprovals: m.planApprovals.map(({ id: _i, ...p }) => p),
      owners: ownership(s, m.author, m.snapshot.files, m.snapshot.commit, m.reviews),
    };
  }).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { members, teams, invites, joinRequests, items, missions, activity: [...s.activity].reverse().slice(0, 300), rejected: s.rejected.slice(-50) };
}
