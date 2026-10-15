// One repository's team space, as this installation sees it: read the record, write signed entries, sync.
import { AtlasError, EntryBodies, TEAM_REF, type EntryBody, type EntryKind, type TeamEntry } from '@atlas/contracts';
import { entryId, invitePublicKey, inviteProof, newInviteCode, normalizeInviteCode, type Signer } from './crypto';
import { fold, type TeamRecord, type TeamState } from './fold';
import { TeamStore, type SyncResult } from './store';

export interface TeamSpaceOptions {
  root: string;
  signer: Signer;
  /** Environment for fetch and push (e.g. ATLAS's GitHub token for a github.com origin). */
  netEnv?: () => Promise<Record<string, string>> | Record<string, string>;
  now?: () => Date;
}

export class TeamSpace {
  readonly store: TeamStore;
  private cache: { head: string | null; records: TeamRecord[]; state: TeamState } | null = null;

  constructor(private readonly o: TeamSpaceOptions) {
    this.store = new TeamStore(o.root, o.netEnv);
  }

  get me() { return this.o.signer.keyId; }
  get ref() { return TEAM_REF; }

  async read(): Promise<{ head: string | null; records: TeamRecord[]; state: TeamState }> {
    const head = await this.store.head();
    if (this.cache && this.cache.head === head) return this.cache;
    const { records } = await this.store.load();
    return (this.cache = { head, records, state: fold(records) });
  }

  async state(): Promise<TeamState> { return (await this.read()).state; }

  /** Sign and record an entry; refused here (not written) when the record would not accept it. */
  async write<K extends EntryKind>(kind: K, body: z_in<K>): Promise<{ id: string; state: TeamState }> {
    const { records, state } = await this.read();
    const parsed = EntryBodies[kind].parse(body) as EntryBody<K>;
    if (kind !== 'space.create' && !state.space) throw new AtlasError('invalid_request', 'There is no team space in this repository yet.');
    // Stamped after everything this installation has seen, so its own entries keep their order even when its clock
    // is behind a teammate's.
    const now = (this.o.now?.() ?? new Date()).getTime();
    const after = state.lastAt ? Date.parse(state.lastAt) + 1 : 0;
    const at = new Date(Math.max(now, after)).toISOString();
    const unsigned: Omit<TeamEntry, 'sig'> = { v: 1, space: kind === 'space.create' ? null : state.space!.id, kind, at, author: this.me, publicKey: this.o.signer.publicKey, body: parsed as Record<string, unknown> };
    const id = entryId(unsigned);
    const entry: TeamEntry = { ...unsigned, sig: this.o.signer.sign(id).signature };
    const next = fold([...records, { id, entry }]);
    const refused = next.rejected.find((x) => x.id === id);
    if (refused) throw new AtlasError('invalid_request', `Not recorded: ${refused.reason}.`);
    await this.store.append([{ id, entry }], `ATLAS team: ${kind}`);
    this.cache = null;
    return { id, state: next };
  }

  sync(): Promise<SyncResult> {
    this.cache = null;
    return this.store.sync().finally(() => { this.cache = null; });
  }

  // ---- Operations with more than one step ----

  async create(name: string, me: { name: string; email?: string }) {
    const { state } = await this.read();
    if (state.space) throw new AtlasError('invalid_request', `This repository already has the team space “${state.space.name}”.`);
    return this.write('space.create', { name, member: me });
  }

  /** A new invitation; the code is returned once and stored nowhere. */
  async invite(o: { role: 'maintainer' | 'member'; teams: string[]; uses: number; days: number; note?: string }): Promise<{ code: string; id: string }> {
    const code = newInviteCode();
    const expiresAt = new Date((this.o.now?.() ?? new Date()).getTime() + o.days * 86_400_000).toISOString();
    const { id } = await this.write('member.invite', { invitePublicKey: invitePublicKey(code), role: o.role, teams: o.teams, uses: o.uses, expiresAt, note: o.note ?? '' });
    return { code, id };
  }

  /** Join: with a code, the matching invitation admits this key at once; without one, it asks the maintainers. */
  async join(me: { name: string; email?: string }, code?: string) {
    const { state } = await this.read();
    if (!state.space) throw new AtlasError('invalid_request', 'There is no team space in this repository yet. Sync first, or start one.');
    if (!code) return this.write('member.join', { name: me.name, email: me.email });
    if (normalizeInviteCode(code).length !== 24) throw new AtlasError('invalid_request', 'That is not an ATLAS invitation code.');
    const pub = invitePublicKey(code);
    const inv = [...state.invites.values()].find((i) => i.publicKey === pub);
    if (!inv) throw new AtlasError('invalid_request', 'No invitation in this team space matches that code. Sync to fetch new invitations, or check the code.');
    return this.write('member.join', { name: me.name, email: me.email, invite: { id: inv.id, signature: inviteProof(code, state.space.id, inv.id, this.me) } });
  }
}

type z_in<K extends EntryKind> = import('zod').input<(typeof EntryBodies)[K]>;
