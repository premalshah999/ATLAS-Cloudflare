// Runs one real Pi mission (model decisions, no scripted runtime) in the installed ATLAS with the operator's profile.
// Usage: node scripts/live/run-mission.mjs <repo> <mission.json>
//   mission.json: { title, goal, constraints?, approve?: 'plan-only' | 'auto-low' }
// The operator's decisions are explicit and logged: the plan is approved after it is printed; agent approval requests
// of low or elevated risk are approved once and every one is printed with its exact action; high risk is denied.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { openAtlas } from './session.mjs';

const [repo, file] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(file, 'utf8'));
const out = path.join(path.dirname(file), 'runs');
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const { app, page, invoke } = await openAtlas({ openDir: repo });
let missionId = null;
try {
  let ws = (await invoke('workspace.list')).find((w) => w.root === repo);
  if (!ws) ws = await invoke('workspace.open');
  await invoke('workspace.refresh', { workspaceId: ws.id }).catch(() => {});
  const pre = await invoke('workspace.preflight', { workspaceId: ws.id, runtime: 'pi' });
  for (const p of pre) log(`preflight ${p.level}: ${p.message}`);
  if (pre.some((p) => p.level === 'block')) throw new Error('Preflight blocked the mission');

  const m = await invoke('mission.create', { workspaceId: ws.id, title: spec.title, goal: spec.goal, constraints: spec.constraints ?? '', approvalMode: 'ask_risky', runtime: 'pi', budget: spec.budget ?? { maxConcurrentAgents: 3 } });
  missionId = m.id;
  log(`mission ${m.id} created: ${m.title}`);
  await invoke('mission.plan', { missionId });

  let snap;
  for (;;) {
    snap = await invoke('mission.get', { missionId });
    if (snap.mission.state === 'awaiting_approval' && snap.plan) break;
    if (TERMINAL.has(snap.mission.state)) throw new Error(`Planning ended: ${snap.mission.state} ${snap.mission.outcome ?? ''}`);
    await page.waitForTimeout(3000);
  }
  log('PLAN (by the orchestrator model):');
  for (const t of snap.plan.plan.tasks) log(`  - [${t.role}] ${t.key}: ${t.title}${t.dependsOn?.length ? `  (after ${t.dependsOn.join(', ')})` : ''}`);
  await invoke('mission.approvePlan', { missionId });
  log('operator: plan approved');

  const seen = new Map();
  const handled = new Set();
  const started = Date.now();
  for (;;) {
    snap = await invoke('mission.get', { missionId });
    for (const t of snap.tasks) if (seen.get(t.id) !== t.state) { seen.set(t.id, t.state); log(`task ${t.key} [${t.role}] → ${t.state}`); }
    for (const a of snap.approvals.filter((x) => x.status === 'pending' && !handled.has(x.id))) {
      handled.add(a.id);
      const decision = a.risk === 'high' ? 'deny' : 'approve';
      log(`APPROVAL ${a.risk} · ${a.agentRole} · ${a.tool}/${a.capability} · ${a.action} · reason: ${a.reason} → operator ${decision}`);
      await invoke('approval.respond', { approvalId: a.id, decision }).catch((e) => log(`approval failed: ${e.message}`));
    }
    if (TERMINAL.has(snap.mission.state)) break;
    if (Date.now() - started > (spec.timeoutMin ?? 45) * 60_000) { log('timeout: cancelling'); await invoke('mission.cancel', { missionId }); }
    await page.waitForTimeout(5000);
  }
  const mm = snap.mission;
  log(`RESULT state=${mm.state} verdict=${mm.verdict} outcome=${mm.outcome}`);
  for (const c of snap.checks) log(`  check ${c.name}: ${c.result}${c.reason ? ` — ${c.reason.slice(0, 160)}` : ''}`);
  for (const f of snap.findings) log(`  finding ${f.severity} ${f.status}: ${f.title} (${f.file}${f.line ? `:${f.line}` : ''})`);
  log(`tokens=${snap.budget.tokens} toolCalls=${snap.budget.toolCalls} elapsed=${Math.round(snap.budget.elapsedMs / 1000)}s`);
  await page.evaluate((id) => { localStorage.setItem('atlas:route', JSON.stringify({ screen: 'mission', missionId: id })); }, missionId);
  writeFileSync(path.join(out, `${missionId}.json`), JSON.stringify({ spec, mission: mm, tasks: snap.tasks, checks: snap.checks, findings: snap.findings, budget: snap.budget }, null, 2));
} finally {
  if (missionId) log(`mission id: ${missionId}`);
  await app.close();
}
