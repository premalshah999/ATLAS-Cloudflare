// Runs several real Pi missions at once in the installed ATLAS (operator profile): model plans, model agents,
// independent verification, staging, then — for verified results — accept and open a GitHub pull request.
// Usage: node scripts/live/run-team.mjs <repo> <mission.json>...
// Operator policy (printed for every request): approve low/elevated; approve high only for the project's own
// check scripts (scripts/atlas/*) and staging deploys; deny anything else.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { openAtlas } from './session.mjs';

const [repo, ...files] = process.argv.slice(2);
const specs = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(f, 'utf8')) }));
const out = path.join(path.dirname(files[0]), 'runs', `team-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const okHigh = (a) => /^(bash )?scripts\/atlas\/(test-backend|test-frontend|lint-frontend|build)\.sh\b/.test(a.action) || a.capability?.startsWith('deploy');

const { app, page, invoke } = await openAtlas({ openDir: repo });
const shot = async (name) => page.screenshot({ path: path.join(out, `${name}.png`) }).catch(() => {});
const openMission = async (title) => {
  await page.getByTestId('open-palette').click().catch(() => {});
  await page.keyboard.type(title.slice(0, 40));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
};
try {
  await invoke('settings.set', { key: 'deploy.allowedTargets', value: ['local-staging'] });
  let ws = (await invoke('workspace.list')).find((w) => w.root === repo);
  if (!ws) ws = await invoke('workspace.open');
  await invoke('workspace.refresh', { workspaceId: ws.id }).catch(() => {});
  for (const p of await invoke('workspace.preflight', { workspaceId: ws.id, runtime: 'pi' })) log(`preflight ${p.level}: ${p.message}`);

  const missions = [];
  for (const s of specs) {
    const m = await invoke('mission.create', { workspaceId: ws.id, title: s.title, goal: s.goal, constraints: s.constraints ?? '', approvalMode: 'ask_risky', runtime: 'pi', budget: s.budget ?? { maxConcurrentAgents: 2 }, targetEnvironment: s.staging === false ? null : 'local-staging' });
    missions.push({ id: m.id, spec: s, state: 'planning', seen: new Map(), handled: new Set(), done: false, published: false });
    log(`[${s.key}] mission ${m.id} created: ${s.title}`);
  }
  // Plans are made concurrently by the orchestrator model.
  await Promise.all(missions.map(async (x) => {
    try { await invoke('mission.plan', { missionId: x.id }); } catch (e) { log(`[${x.spec.key}] plan request: ${e.message}`); }
  }));
  const started = Date.now();
  let lastShot = 0, shotIdx = 0;
  for (;;) {
    for (const x of missions) {
      if (x.done) continue;
      const snap = await invoke('mission.get', { missionId: x.id });
      const m = snap.mission;
      if (m.state === 'awaiting_approval' && snap.plan && !x.approved) {
        const src = (await invoke('events.since', { missionId: x.id, afterSeq: 0 })).find((e) => e.type === 'plan.proposed')?.payload.source;
        log(`[${x.spec.key}] PLAN v${snap.plan.plan.version} (source: ${src}) — ${snap.plan.plan.summary ?? ''}`);
        for (const t of snap.plan.plan.tasks) log(`[${x.spec.key}]   - [${t.role}] ${t.key}: ${t.title}${t.dependsOn?.length ? `  (after ${t.dependsOn.join(', ')})` : ''}`);
        await invoke('mission.approvePlan', { missionId: x.id });
        x.approved = true;
        log(`[${x.spec.key}] operator: plan approved`);
      }
      for (const t of snap.tasks) if (x.seen.get(t.id) !== t.state) { x.seen.set(t.id, t.state); log(`[${x.spec.key}] task ${t.key} [${t.role}] → ${t.state}`); }
      for (const a of snap.approvals.filter((q) => q.status === 'pending' && !x.handled.has(q.id))) {
        x.handled.add(a.id);
        const decision = a.risk !== 'high' || okHigh(a) ? 'approve' : 'deny';
        log(`[${x.spec.key}] APPROVAL ${a.risk} · ${a.agentRole} · ${a.tool}/${a.capability} · ${a.action.slice(0, 160)} → operator ${decision}`);
        await invoke('approval.respond', { approvalId: a.id, decision }).catch((e) => log(`approval failed: ${e.message}`));
      }
      if (TERMINAL.has(m.state)) {
        x.done = true;
        log(`[${x.spec.key}] RESULT state=${m.state} verdict=${m.verdict} outcome=${m.outcome}`);
        for (const c of snap.checks) log(`[${x.spec.key}]   check ${c.name}: ${c.result}${c.reason ? ` — ${c.reason.slice(0, 140)}` : ''}`);
        for (const f of snap.findings) log(`[${x.spec.key}]   finding ${f.severity} ${f.status}: ${f.title}`);
        log(`[${x.spec.key}] tokens=${snap.budget.tokens} toolCalls=${snap.budget.toolCalls} elapsed=${Math.round(snap.budget.elapsedMs / 1000)}s`);
        if (m.state === 'completed' && m.verdict === 'verified' && x.spec.publish !== false) {
          try {
            await invoke('mission.decide', { missionId: x.id, decision: 'accept' });
            log(`[${x.spec.key}] operator: accepted (verified)`);
            const pr = await invoke('mission.publish', { missionId: x.id });
            log(`[${x.spec.key}] PULL REQUEST ${JSON.stringify(pr?.published ?? pr).slice(0, 300)}`);
          } catch (e) { log(`[${x.spec.key}] publish: ${e.message}`); }
        }
        writeFileSync(path.join(out, `${x.spec.key}-${x.id}.json`), JSON.stringify({ spec: x.spec, mission: m, tasks: snap.tasks, checks: snap.checks, findings: snap.findings, budget: snap.budget }, null, 2));
      }
    }
    if (Date.now() - lastShot > 90_000) {
      const live = missions.filter((x) => !x.done);
      if (live.length) { const x = live[shotIdx++ % live.length]; await openMission(x.spec.title); await shot(`control-${String(shotIdx).padStart(3, '0')}-${x.spec.key}`); }
      lastShot = Date.now();
    }
    if (missions.every((x) => x.done)) break;
    if (Date.now() - started > 75 * 60_000) { log('team timeout: cancelling the rest'); for (const x of missions.filter((y) => !y.done)) await invoke('mission.cancel', { missionId: x.id }).catch(() => {}); }
    await page.waitForTimeout(5000);
  }
  log(`all missions finished · output ${out}`);
} finally {
  await app.close();
}
