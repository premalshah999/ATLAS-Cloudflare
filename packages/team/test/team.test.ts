// Team spaces (ADR 0021) between installations that share only a git remote: a bare repository stands in for the
// origin, each "installation" is a clone with its own Ed25519 key. Real git, no network, no server.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEAM_REF, type TeamEntry } from '@atlas/contracts';
import { entryId, fold, globToRegExp, keyIdOf, ownership, teamParts, TeamSpace, type Signer } from '../src';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'atlas-team-'));

function signer(): Signer {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pub = (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
  return { keyId: keyIdOf(pub), publicKey: pub, sign: (d) => ({ keyId: keyIdOf(pub), publicKey: pub, signature: sign(null, Buffer.from(d, 'utf8'), privateKey).toString('base64') }) };
}

/** An origin with one commit, and `n` clones of it, each with its own installation key. */
function world(n = 2, now?: () => Date) {
  const origin = path.join(tmp(), 'origin.git');
  git(tmp(), 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(tmp(), 'seed');
  git(tmp(), 'init', '-q', '-b', 'main', seed);
  writeFileSync(path.join(seed, 'README.md'), 'app\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'init'); git(seed, 'push', '-q', origin, 'main');
  const spaces = Array.from({ length: n }, () => {
    const dir = path.join(tmp(), 'clone');
    git(tmp(), 'clone', '-q', origin, dir);
    return new TeamSpace({ root: dir, signer: signer(), now });
  });
  return Object.assign(spaces, { origin });
}

// Each test runs dozens of git processes; process start-up on Windows runners takes several times longer than elsewhere.
describe('team spaces over git (ADR 0021)', { timeout: 90_000 }, () => {
  it('starts a space, invites with a code, and the invitee is a member as soon as both sync', async () => {
    const w = world();
    const [alice, bob] = w;
    await alice.create('Acme app', { name: 'Alice', email: 'alice@acme.dev' });
    await alice.write('team.upsert', { slug: 'platform', name: 'Platform', owns: ['infra/**', 'deploy.yml'] });
    const { code } = await alice.invite({ role: 'member', teams: ['platform'], uses: 1, days: 7, note: 'for Bob' });
    expect(code).toMatch(/^ATLAS(-[0-9A-Z]{4}){6}$/);
    expect(await alice.sync()).toMatchObject({ pushed: 3, remote: true });
    // The origin has the record on its own ref; no branch was touched.
    expect(git(alice.store.root, 'ls-remote', 'origin').split('\n').map((l) => l.split('\t')[1]).sort()).toEqual(['HEAD', 'refs/atlas/team', 'refs/heads/main']);

    expect((await bob.sync()).pulled).toBe(3);
    // Codes are typed by people: case and dashes do not matter.
    await bob.join({ name: 'Bob' }, code.toLowerCase().replace(/-/g, ' '));
    await bob.sync();
    await alice.sync();
    for (const s of [alice, bob]) {
      const st = await s.state();
      expect([...st.members.values()].map((m) => [m.name, m.role, m.teams.join(',')])).toEqual([['Alice', 'maintainer', ''], ['Bob', 'member', 'platform']]);
      expect(st.rejected).toEqual([]);
    }
    // The code was single use: a third installation cannot reuse it.
    const carol = new TeamSpace({ root: path.join(tmp(), 'c'), signer: signer() });
    git(tmp(), 'clone', '-q', w.origin, carol.store.root);
    await carol.sync();
    await expect(carol.join({ name: 'Mallory' }, code)).rejects.toThrow(/already used/);
  });

  it('refuses a wrong or expired code, and a join without a code waits for a maintainer', async () => {
    let clock = new Date('2026-10-01T10:00:00Z');
    const [alice, bob] = world(2, () => clock);
    await alice.create('Acme', { name: 'Alice' });
    const { code } = await alice.invite({ role: 'member', teams: [], uses: 5, days: 1 });
    await alice.sync(); await bob.sync();
    await expect(bob.join({ name: 'Bob' }, 'ATLAS-0000-0000-0000-0000-0000-0000')).rejects.toThrow(/No invitation/);
    clock = new Date('2026-10-03T10:00:00Z');
    await expect(bob.join({ name: 'Bob' }, code)).rejects.toThrow(/expired/);

    await bob.join({ name: 'Bob' });
    await bob.sync(); await alice.sync();
    const st = await alice.state();
    expect([...st.joinRequests.keys()]).toEqual([bob.me]);
    // A member cannot admit people; a maintainer can.
    await alice.write('member.add', { keyId: bob.me, role: 'member', teams: [] });
    expect((await alice.state()).members.has(bob.me)).toBe(true);
    expect((await alice.state()).joinRequests.size).toBe(0);
  });

  it('ignores entries that are not signed by a member, tampered, or signed by another key', async () => {
    const [alice, bob] = world();
    await alice.create('Acme', { name: 'Alice' });
    await alice.sync(); await bob.sync();
    // Bob is not a member: his writes are refused before they are recorded…
    await expect(bob.write('item.create', { title: 'sneaky' })).rejects.toThrow(/not a member/);
    await expect(bob.write('team.upsert', { slug: 'x', name: 'X' })).rejects.toThrow(/not a member/);
    // …and entries written around ATLAS are kept in the record with no effect.
    const st = await bob.state();
    const forge = (author: Signer, kind: TeamEntry['kind'], body: Record<string, unknown>, mutate?: (e: TeamEntry) => void) => {
      const u = { v: 1 as const, space: st.space!.id, kind, at: new Date().toISOString(), author: author.keyId, publicKey: author.publicKey, body };
      const id = entryId(u);
      const e: TeamEntry = { ...u, sig: author.sign(id).signature };
      mutate?.(e);
      return { id, entry: e };
    };
    const outsider = signer();
    const aliceKey = (await alice.state()).members.get(alice.me)!.publicKey;
    await bob.store.append([
      forge(outsider, 'member.add', { keyId: outsider.keyId, role: 'maintainer', teams: [] }),
      forge(outsider, 'item.create', { title: 'tampered' }, (e) => { e.body = { title: 'changed after signing' }; }),
      // Claims to be Alice, signed by another key.
      forge(outsider, 'team.upsert', { slug: 'evil', name: 'Evil' }, (e) => { e.author = keyIdOf(aliceKey); e.publicKey = aliceKey; }),
    ], 'forged');
    await bob.sync(); await alice.sync();
    const s = await alice.state();
    expect(s.members.size).toBe(1);
    expect(s.items.size).toBe(0);
    expect(s.teams.size).toBe(0);
    expect(s.rejected.map((r) => r.reason).sort()).toEqual(['content does not match its id', 'content does not match its id', 'the author is not a member']);
  });

  it('merges concurrent work from two members without conflicts and never rewrites the origin', async () => {
    const [alice, bob] = world();
    await alice.create('Acme', { name: 'Alice' });
    const { code } = await alice.invite({ role: 'member', teams: [], uses: 1, days: 1 });
    await alice.sync(); await bob.sync(); await bob.join({ name: 'Bob' }, code); await bob.sync(); await alice.sync();
    const before = git(alice.store.root, 'ls-remote', 'origin', TEAM_REF).split('\t')[0];

    // Both work offline, then sync in either order.
    for (let i = 0; i < 3; i++) { await alice.write('item.create', { title: `alice ${i}` }); await bob.write('item.create', { title: `bob ${i}` }); }
    await alice.sync();
    const r = await bob.sync();
    expect(r.pulled).toBe(3);
    expect(r.pushed).toBe(3);
    await alice.sync();
    const a = teamParts(await alice.state(), alice.me), b = teamParts(await bob.state(), bob.me);
    expect(a.items.map((x) => x.title).sort()).toEqual(['alice 0', 'alice 1', 'alice 2', 'bob 0', 'bob 1', 'bob 2']);
    expect(b.items.map((x) => x.id)).toEqual(a.items.map((x) => x.id));
    expect(b.activity.map((x) => x.id)).toEqual(a.activity.map((x) => x.id));
    // Every earlier origin state is an ancestor of the current one: fast-forwards and merges only.
    const after = git(alice.store.root, 'ls-remote', 'origin', TEAM_REF).split('\t')[0];
    git(alice.store.root, 'fetch', '-q', 'origin', TEAM_REF);
    expect(() => git(alice.store.root, 'merge-base', '--is-ancestor', before, after)).not.toThrow();
  });

  it('gives a contested item to exactly one member, the same one on every machine', async () => {
    const [alice, bob] = world();
    await alice.create('Acme', { name: 'Alice' });
    const { code } = await alice.invite({ role: 'member', teams: [], uses: 1, days: 1 });
    const { id: item } = await alice.write('item.create', { title: 'Fix login' });
    await alice.sync(); await bob.sync(); await bob.join({ name: 'Bob' }, code); await bob.sync(); await alice.sync();
    await alice.write('item.claim', { item });
    await bob.write('item.claim', { item });
    await bob.sync(); await alice.sync(); await bob.sync();
    const [sa, sb] = [await alice.state(), await bob.state()];
    expect(sa.items.get(item)!.assignee).toBe(sb.items.get(item)!.assignee);
    expect(sa.rejected.filter((r) => r.kind === 'item.claim')).toHaveLength(1);
    expect(sa.rejected.find((r) => r.kind === 'item.claim')!.reason).toMatch(/already has it/);
    // Once the record shows it taken, the loser's ATLAS refuses to claim it again.
    const loser = sa.items.get(item)!.assignee === alice.me ? bob : alice;
    await expect(loser.write('item.claim', { item })).rejects.toThrow(/already has it/);
  });

  it('requires an approval from the owning team for a change to its paths, on the current commit, not from the author', async () => {
    const [alice, bob, carol] = world(3);
    await alice.create('Acme', { name: 'Alice' });
    await alice.write('team.upsert', { slug: 'platform', name: 'Platform', owns: ['infra/', '*.tf'] });
    await alice.write('team.upsert', { slug: 'web', name: 'Web', owns: ['src/ui/**'] });
    const inv = (teams: string[]) => alice.invite({ role: 'member', teams, uses: 1, days: 1 });
    const cb = await inv(['platform']), cc = await inv(['web']);
    await alice.sync();
    for (const [s, c, n] of [[bob, cb.code, 'Bob'], [carol, cc.code, 'Carol']] as const) { await s.sync(); await s.join({ name: n }, c); await s.sync(); }
    await alice.sync();
    const c1 = 'a'.repeat(40), c2 = 'b'.repeat(40);
    const snap = (commit: string) => ({ missionId: 'msn_abcdef12', title: 'Move DNS', goal: 'g', state: 'completed' as const, verdict: 'verified' as const, decision: null, runtime: 'fake' as const, baseCommit: c1, commit, files: ['infra/dns/main.tf', 'README.md'] });
    await carol.sync();
    await carol.write('mission.share', snap(c1));
    await carol.sync(); await bob.sync(); await alice.sync();

    const owners = () => alice.state().then((s) => ownership(s, carol.me, ['infra/dns/main.tf', 'README.md'], s.missions.get('msn_abcdef12')!.snapshot.commit, s.missions.get('msn_abcdef12')!.reviews));
    expect(await owners()).toEqual([{ team: 'platform', paths: ['infra/dns/main.tf'], approvedBy: null }]);
    await expect(carol.write('review', { missionId: 'msn_abcdef12', commit: c1, verdict: 'approve' })).rejects.toThrow(/own change/);
    // Alice is a maintainer but not in Platform, and Platform has a member: her approval does not count for it.
    await alice.write('review', { missionId: 'msn_abcdef12', commit: c1, verdict: 'approve' });
    expect((await owners())[0].approvedBy).toBeNull();
    await bob.write('review', { missionId: 'msn_abcdef12', commit: c1, verdict: 'approve' });
    await bob.sync(); await alice.sync();
    expect((await owners())[0].approvedBy).toBe(bob.me);
    // A new commit needs a new approval.
    await carol.sync(); await carol.write('mission.share', snap(c2)); await carol.sync(); await alice.sync();
    expect((await owners())[0].approvedBy).toBeNull();
    // Bob asks for changes after approving: his latest word counts.
    await bob.sync(); await bob.write('review', { missionId: 'msn_abcdef12', commit: c2, verdict: 'approve' }); await bob.write('review', { missionId: 'msn_abcdef12', commit: c2, verdict: 'changes', note: 'TTL too low' });
    await bob.sync(); await alice.sync();
    expect((await owners())[0].approvedBy).toBeNull();
    const view = teamParts(await alice.state(), alice.me).missions[0];
    expect(view.reviews.filter((r) => r.current).map((r) => r.verdict)).toEqual(['approve', 'changes']);
  });

  it('keeps one maintainer, stops a removed member\'s later writes, and lets a member leave', async () => {
    const [alice, bob] = world();
    await alice.create('Acme', { name: 'Alice' });
    await expect(alice.write('member.remove', { keyId: alice.me })).rejects.toThrow(/at least one maintainer/);
    await expect(alice.write('member.update', { keyId: alice.me, role: 'member' })).rejects.toThrow(/at least one maintainer/);
    const { code } = await alice.invite({ role: 'member', teams: [], uses: 1, days: 1 });
    await alice.sync(); await bob.sync(); await bob.join({ name: 'Bob' }, code); await bob.sync(); await alice.sync();
    await expect(bob.write('member.update', { keyId: alice.me, name: 'Al' })).rejects.toThrow(/only maintainers/);
    await bob.write('member.update', { keyId: bob.me, name: 'Robert' });
    await bob.sync(); await alice.sync();
    await alice.write('member.remove', { keyId: bob.me });
    await alice.sync();
    // Bob, offline, writes after his removal: his entry is refused everywhere once both sides sync.
    await bob.store.append([await (async () => {
      const st = await bob.state();
      const u = { v: 1 as const, space: st.space!.id, kind: 'item.create' as const, at: new Date(Date.now() + 60_000).toISOString(), author: bob.me, publicKey: st.members.get(bob.me)!.publicKey, body: { title: 'after removal' } };
      const id = entryId(u);
      return { id, entry: { ...u, sig: (bob as unknown as { o: { signer: Signer } }).o.signer.sign(id).signature } };
    })()], 'late');
    await bob.sync(); await alice.sync();
    const s = await alice.state();
    expect(s.items.size).toBe(0);
    expect(s.rejected.at(-1)!.reason).toBe('the author is no longer a member');
    expect(s.names.get(bob.me)).toBe('Robert');
  });

  it('matches ownership patterns like CODEOWNERS', () => {
    const m = (g: string, f: string) => globToRegExp(g).test(f);
    expect(m('infra/', 'infra/a/b.tf')).toBe(true);
    expect(m('infra', 'infra/a.tf')).toBe(true);
    expect(m('infra', 'infrastructure/a.tf')).toBe(false);
    expect(m('*.tf', 'main.tf')).toBe(true);
    expect(m('*.tf', 'infra/main.tf')).toBe(false);
    expect(m('**/*.tf', 'infra/main.tf')).toBe(true);
    expect(m('src/**/test/*.ts', 'src/test/a.ts')).toBe(true);
    expect(m('src/**/test/*.ts', 'src/x/y/test/a.ts')).toBe(true);
    expect(m('a.b', 'aXb')).toBe(false);
  });

  it('folds the same entries to the same state whatever order the files arrive in', () => {
    const a = signer();
    const mk = (kind: TeamEntry['kind'], body: Record<string, unknown>, at: string, space: string | null) => {
      const u = { v: 1 as const, space, kind, at, author: a.keyId, publicKey: a.publicKey, body };
      const id = entryId(u);
      return { id, entry: { ...u, sig: a.sign(id).signature } };
    };
    const g = mk('space.create', { name: 'S', member: { name: 'A' } }, '2026-01-01T00:00:00.000Z', null);
    const rest = [1, 2, 3, 4].map((i) => mk('item.create', { title: `t${i}` }, `2026-01-01T00:00:0${i}.000Z`, g.id));
    const s1 = fold([g, ...rest]), s2 = fold([...rest].reverse().concat(g));
    expect([...s2.items.keys()]).toEqual([...s1.items.keys()]);
    expect(createHash('sha256').update(JSON.stringify(s2.activity)).digest('hex')).toBe(createHash('sha256').update(JSON.stringify(s1.activity)).digest('hex'));
    void createPrivateKey;
  });
});
