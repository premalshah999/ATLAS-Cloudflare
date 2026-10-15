// Desktop control inside a mission (manual §26–27): consent, single-use session approval, operator
// takeover mid-run, and evidence (screenshots + audited actions) in the mission record.
import { describe, expect, it } from 'vitest';
import { forTask, type FakeScript } from '@atlas/runtime-fake';
import { createDesktopTool, DesktopManager, desktopSupport } from '@atlas/desktop-control';
import { sampleRepo } from '../helpers';
import { autoDecide, makeOrchestrator, startMission, waitFor } from './harness';

const plan = { summary: 'desktop', scope: 'virtual display', tasks: [{ key: 'desk', title: 'Check the desktop', role: 'desktop_operator', dependsOn: [], acceptance: ['desktop checked'], tools: ['desktop_action', 'read_file'], risk: 'elevated' }], verification: [{ name: 'tests', required: true }] };

function setup(scripts: FakeScript[], enabled: boolean, planned: unknown = plan) {
  const changes: string[] = [];
  const mgr = new DesktopManager({ session: (_i, change, by) => changes.push(`${change}:${by}`) });
  const h = makeOrchestrator({
    scripts, planner: () => planned,
    toolFactories: {
      desktop_action: (c) => createDesktopTool({
        manager: mgr, missionId: c.missionId, taskId: c.taskId, worktree: c.worktree, sandbox: null, size: { width: 640, height: 480 },
        enabled: () => c.setting('desktop.enabled', false), requestApproval: c.requestApproval,
        putScreenshot: (n, png) => c.putArtifact({ kind: 'screenshot', name: n, bytes: png }).id, emit: (t, p, ids) => c.emit(t, p, ids),
      }),
    },
  });
  h.repo.setSetting('desktop.enabled', enabled);
  return { h, mgr, changes };
}

it.runIf(process.env.ATLAS_REQUIRE_DESKTOP === '1')('desktop control is available on this runner', () => {
  expect(desktopSupport(), desktopSupport().detail).toMatchObject({ ok: true });
});

describe.skipIf(!desktopSupport().ok)('desktop control in a mission', () => {
  it('operator takeover mid-run blocks the agent; every action and frame is recorded', async () => {
    const script = forTask('desk', [
      { tool: 'desktop_action', args: { action: 'screenshot' } },
      { tool: 'desktop_action', args: { action: 'click', x: 100, y: 100 } },
      { wait: 1200 },
      { tool: 'desktop_action', args: { action: 'click', x: 300, y: 300 } },
      { claim: 'Desktop checked.' },
    ], 'desktop_operator');
    const { h, mgr, changes } = setup([script], true);
    const root = sampleRepo();
    const ws = await h.orch.registerWorkspace(root);
    const m = h.orch.createMission({ workspaceId: ws.id, title: 'Desktop', goal: 'Check the desktop', constraints: '', approvalMode: 'ask_risky', runtime: 'fake' });
    await h.orch.plan(m.id);
    await h.orch.approvePlan(m.id);
    const stop = autoDecide(h, m.id, 'desktop_action');
    // Take over as soon as the agent's first click has landed.
    await waitFor(() => h.events.some((e) => e.type === 'desktop.action' && e.payload.action === 'click'));
    const s = mgr.list()[0];
    await mgr.control(s.id, 'takeover');
    await h.orch.settle(m.id);
    stop();

    const approvals = h.repo.approvals(m.id).filter((a) => a.tool === 'desktop_action');
    expect(approvals).toHaveLength(1); // one consent for the whole session, not per action
    expect(approvals[0].capability).toBe('desktop.input');
    const actions = h.events.filter((e) => e.type === 'desktop.action').map((e) => [e.payload.action, e.payload.ok]);
    expect(actions).toEqual([['screenshot', true], ['click', true], ['click', false]]);
    const refused = h.events.filter((e) => e.type === 'agent.tool_result' && e.payload.tool === 'desktop_action').at(-1)!;
    expect(String(refused.payload.output ?? refused.payload.summary ?? JSON.stringify(refused.payload))).toMatch(/operator has taken over/);
    // The screenshot and the landed click left frames; the refused click sent no input, so it has none.
    expect(h.artifacts.list(m.id).filter((a) => a.kind === 'screenshot')).toHaveLength(2);
    expect(changes).toEqual(['started:agent', 'takeover:operator', 'attempt ended:system']);
    expect(mgr.list()).toHaveLength(0); // the display ends with the attempt
  });

  it('with desktop control off, nothing starts and no approval is requested', async () => {
    const script = forTask('desk', [{ tool: 'desktop_action', args: { action: 'screenshot' } }, { claim: 'done' }], 'desktop_operator');
    const { h, mgr } = setup([script], false);
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    expect(h.repo.approvals(id).filter((a) => a.tool === 'desktop_action')).toHaveLength(0);
    const r = h.events.find((e) => e.type === 'agent.tool_result' && e.payload.tool === 'desktop_action')!;
    expect(JSON.stringify(r.payload)).toMatch(/Desktop control is turned off/);
    expect(mgr.list()).toHaveLength(0);
  });

  it('a coder cannot reach the desktop even with the tool installed', async () => {
    const script = forTask('desk', [{ tool: 'desktop_action', args: { action: 'click', x: 1, y: 1 } }, { claim: 'done' }], 'coder');
    const { h, mgr } = setup([script], true, { ...plan, tasks: [{ ...plan.tasks[0], role: 'coder', tools: ['read_file'] }] });
    const id = await startMission(h, sampleRepo());
    await h.orch.settle(id);
    expect(mgr.list()).toHaveLength(0);
    expect(h.events.some((e) => e.type === 'desktop.action')).toBe(false);
    const r = h.events.find((e) => e.type === 'agent.tool_result' && e.payload.tool === 'desktop_action');
    expect(r?.payload.ok).toBe(false);
  });
});
