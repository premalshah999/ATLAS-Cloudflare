// Team spaces through the daemon (ADR 0021): two complete ATLAS installations (each its own database, key and
// clone) that share only the repository's origin. Shared missions, reviews gating publishing, teammates approving a
// plan that runs on another machine, and a runner taking an item assigned to agents.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sampleSlugifyScript } from '@atlas/runtime-fake';
import { sampleRepo, tmpDir } from '../helpers';
import { explainChecks, makeOrchestrator, waitFor } from './harness';
import { TeamHub } from '../../apps/daemon/src/team';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** An origin and `names.length` installations, each with a clone of it. */
async function world(names: string[]) {
  const seed = sampleRepo();
  const origin = path.join(tmpDir(), 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  return Promise.all(names.map(async (name) => {
    const root = path.join(tmpDir(), name);
    execFileSync('git', ['clone', '-q', origin, root]);
    sh(root, 'config', 'user.name', name);
    let hub: TeamHub | null = null;
    const h = makeOrchestrator({ scripts: [sampleSlugifyScript], publishGate: (m, files) => hub!.gate(m, files) });
    hub = new TeamHub({ repo: h.repo, orch: h.orch, log: quiet, forge: () => null });
    const ws = await h.orch.registerWorkspace(root);
    hub.setSettings(ws.id, { autoSync: false });
    return { name, root, h, hub, ws: ws.id };
  }));
}
type Node = Awaited<ReturnType<typeof world>>[number];

async function team(names: string[]) {
  const nodes = await world(names);
  const [lead, ...rest] = nodes;
  await lead.hub.create(lead.ws, { name: 'Acme', displayName: lead.name });
  await lead.hub.write(lead.ws, 'team.upsert', { slug: 'web', name: 'Web', owns: ['src/'] });
  await lead.hub.sync(lead.ws);
  for (const n of rest) {
    const { code } = await lead.hub.invite(lead.ws, { role: 'member', teams: ['web'], uses: 1, days: 1 });
    await lead.hub.sync(lead.ws);
    await n.hub.join(n.ws, { displayName: n.name, code });
  }
  await syncAll(nodes);
  return nodes;
}
async function syncAll(nodes: Node[]) { for (let i = 0; i < 3; i++) for (const n of nodes) await n.hub.sync(n.ws); }

async function verifiedMission(n: Node) {
  const m = n.h.orch.createMission({ workspaceId: n.ws, title: 'Fix slugify', goal: 'Make slugify produce valid URL slugs.', constraints: '', approvalMode: 'ask_risky', runtime: 'fake' });
  await n.h.orch.plan(m.id);
  await n.h.orch.approvePlan(m.id);
  await n.h.orch.settle(m.id);
  expect(n.h.repo.mission(m.id)!.verdict, explainChecks(n.h, m.id)).toBe('verified');
  return n.h.repo.mission(m.id)!;
}

describe('team spaces through the daemon (ADR 0021)', () => {
  it('shares a mission with its diff; the owning team\'s approval of that commit unblocks publishing', async () => {
    const [alice, bob] = await team(['Alice', 'Bob']);
    const m = await verifiedMission(alice);
    await alice.h.orch.decide(m.id, 'accept');
    // Alice is not in Web, which owns src/: her change to src/slugify.js needs Web's approval.
    expect(await alice.hub.gate(m, await alice.h.orch.changedFiles(m.id))).toMatch(/Needs an approving review of this commit from Web \(src\/slugify.js\).*share the mission/);
    expect((await alice.h.orch.forgeView(m.id)).blocker).toMatch(/Web/);

    await alice.hub.shareMission(m.id, { teams: ['web'] });
    await syncAll([alice, bob]);
    const seen = (await bob.hub.view(bob.ws)).missions.find((x) => x.missionId === m.id)!;
    expect(seen).toMatchObject({ title: 'Fix slugify', verdict: 'verified', decision: 'accepted', commit: m.integrationCommit, hasPatch: true, mine: false, requested: { teams: ['web'], people: [] } });
    expect(seen.owners).toEqual([{ team: 'web', paths: ['src/slugify.js'], approvedBy: null }]);
    expect(seen.checks.some((c) => c.name === 'tests' && c.result === 'pass')).toBe(true);
    expect(await bob.hub.patch(bob.ws, m.id)).toMatch(/^diff --git a\/src\/slugify\.js/m);

    await bob.hub.write(bob.ws, 'review', { missionId: m.id, commit: m.integrationCommit!, verdict: 'approve', note: 'Looks right.' });
    await syncAll([alice, bob]);
    expect(await alice.hub.gate(m, await alice.h.orch.changedFiles(m.id))).toBeNull();
    // The review shows in Alice's mission timeline, attributed to Bob.
    const ev = alice.h.events.find((e) => e.missionId === m.id && e.type === 'team.review')!;
    expect(ev.actor).toMatchObject({ kind: 'teammate', name: 'Bob' });
    expect(ev.payload).toMatchObject({ verdict: 'approve', current: true, note: 'Looks right.' });
    // What remains is the forge (this origin is a local path, not github.com), not the team.
    expect((await alice.h.orch.forgeView(m.id)).blocker).toMatch(/not a github.com repository/);
  }, 180_000);

  it('runs a plan a teammate approved, only on a machine whose operator allowed it, and only that plan', async () => {
    const [alice, bob] = await team(['Alice', 'Bob']);
    const mk = async () => {
      const m = alice.h.orch.createMission({ workspaceId: alice.ws, title: 'Fix slugify', goal: 'Make slugify produce valid URL slugs.', constraints: '', approvalMode: 'ask_risky', runtime: 'fake' });
      await alice.h.orch.plan(m.id);
      await alice.hub.shareMission(m.id);
      return m.id;
    };
    const first = await mk();
    await syncAll([alice, bob]);
    expect((await bob.hub.view(bob.ws)).missions[0].plan).toMatchObject({ version: 1, awaitingApproval: true });
    await bob.hub.approvePlan(bob.ws, first);
    await syncAll([alice, bob]);
    // Not allowed here yet: the approval is recorded, the mission does not start.
    expect(alice.h.repo.mission(first)!.state).toBe('awaiting_approval');

    alice.hub.setSettings(alice.ws, { acceptPlanApprovals: true });
    await syncAll([alice, bob]);
    await waitFor(() => alice.h.repo.mission(first)!.state !== 'awaiting_approval');
    const approved = alice.h.events.find((e) => e.missionId === first && e.type === 'plan.approved')!;
    expect(approved.actor).toMatchObject({ kind: 'teammate', name: 'Bob' });
    await alice.h.orch.settle(first);

    // An approval binds to the plan's version and content: re-planning needs a new one.
    const second = await mk();
    await syncAll([alice, bob]);
    await bob.hub.approvePlan(bob.ws, second);
    await alice.h.orch.plan(second); // v2 replaces the plan Bob approved
    await syncAll([alice, bob]);
    expect(alice.h.repo.mission(second)!.state).toBe('awaiting_approval');
    expect(alice.h.repo.mission(second)!.planVersion).toBe(2);
    // The author cannot approve her own plan through the team record.
    await expect(alice.hub.approvePlan(alice.ws, second)).rejects.toThrow(/approves their own plan/);
  }, 240_000);

  it('a runner takes an item assigned to its team\'s agents, a teammate approves the plan, and the item moves to review', async () => {
    const [alice, bob] = await team(['Alice', 'Bob']);
    bob.hub.setSettings(bob.ws, { runner: { enabled: true, teams: ['web'], runtime: 'fake', approvalMode: 'ask_risky' } });
    await alice.hub.write(alice.ws, 'item.create', { title: 'Fix slugify', detail: 'Make slugify produce valid URL slugs.', team: 'web', assignee: 'agents', priority: 'high' });
    // An item for a team this runner does not serve is left alone.
    await alice.hub.write(alice.ws, 'team.upsert', { slug: 'ops', name: 'Ops' });
    await alice.hub.write(alice.ws, 'item.create', { title: 'Rotate keys', team: 'ops', assignee: 'agents' });
    await syncAll([alice, bob]);

    const runs = bob.h.repo.missions();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ title: 'Fix slugify', state: 'awaiting_approval', runtime: 'fake' });
    expect(bob.h.events.find((e) => e.missionId === runs[0].id && e.type === 'mission.created')!.actor).toEqual({ kind: 'system', component: 'team-runner' });
    let view = await alice.hub.view(alice.ws);
    const item = view.items.find((i) => i.title === 'Fix slugify')!;
    expect(item).toMatchObject({ status: 'in_progress', assignee: bob.h.orch.exportKeyId(), missions: [runs[0].id] });
    expect(view.items.find((i) => i.title === 'Rotate keys')!.status).toBe('open');

    await alice.hub.approvePlan(alice.ws, runs[0].id);
    await syncAll([alice, bob]);
    await waitFor(() => bob.h.repo.mission(runs[0].id)!.state !== 'awaiting_approval');
    await bob.h.orch.settle(runs[0].id);
    expect(bob.h.repo.mission(runs[0].id)!.verdict, explainChecks(bob.h, runs[0].id)).toBe('verified');
    // Regression (CI): the update is coalesced; an unrelated event closing the window must not stop the item moving.
    bob.h.repo.append({ missionId: runs[0].id, taskId: null, attemptId: null, type: 'task.state', actor: { kind: 'system', component: 'test' }, payload: { key: 'x', from: 'done', to: 'done' }, artifactIds: [] });
    await new Promise((r) => setTimeout(r, 1500)); // the snapshot and item update are debounced
    await syncAll([alice, bob]);
    view = await alice.hub.view(alice.ws);
    expect(view.items.find((i) => i.id === item.id)!.status).toBe('review');
    expect(view.missions.find((x) => x.missionId === runs[0].id)).toMatchObject({ verdict: 'verified', state: 'completed', item: item.id });
    // One item at a time is enough here: no second mission was started for it.
    expect(bob.h.repo.missions()).toHaveLength(1);
  }, 240_000);
});
