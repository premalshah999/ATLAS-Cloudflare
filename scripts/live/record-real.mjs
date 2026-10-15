// Narrated walkthrough of REAL missions (DeepSeek agents on a real repository) in the installed ATLAS, operator profile.
// Every screen is a live screenshot; narration is built from the missions' recorded facts. Nothing is scripted.
// Usage: ATLAS_FFMPEG=... node scripts/live/record-real.mjs <repo> [team-run-dir]
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openAtlas } from './session.mjs';

const [repo, teamDir] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.join(root, 'test-results', `real-demo-${Date.now()}`);
mkdirSync(out, { recursive: true });
const ffmpeg = process.env.ATLAS_FFMPEG ?? 'ffmpeg';
const scenes = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { app, page, invoke } = await openAtlas();
const shot = async (title, text) => { const file = path.join(out, `scene-${String(scenes.length + 1).padStart(2, '0')}.png`); await page.screenshot({ path: file }); scenes.push({ title, text, file }); console.log(`scene ${scenes.length}: ${title}`); };
try {
  const ws = (await invoke('workspace.list')).find((w) => w.root === repo);
  const missions = (await invoke('mission.list', {})).filter((m) => !ws || m.workspaceId === ws.id).filter((m) => m.runtime === 'pi');
  const finished = missions.filter((m) => ['completed', 'failed'].includes(m.state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const best = finished.find((m) => m.verdict === 'verified') ?? finished[0];
  if (!best) throw new Error('No finished real mission to show.');
  const snap = await invoke('mission.get', { missionId: best.id });
  const evs = await invoke('events.since', { missionId: best.id, afterSeq: 0 });
  const planSrc = evs.find((e) => e.type === 'plan.proposed')?.payload.source;
  const model = evs.find((e) => e.type === 'attempt.started')?.payload.model ?? 'DeepSeek';
  const pr = [...evs].reverse().find((e) => e.type === 'forge.published')?.payload;
  const passed = snap.checks.filter((c) => c.result === 'pass').length;
  const roles = [...new Set(snap.tasks.map((t) => t.role))];
  const verified = finished.filter((m) => m.verdict === 'verified').length;

  const go = async (s, extra = {}) => { await page.evaluate(([s, e]) => window.__atlasPreview.go(s, e), [s, extra]); await wait(1800); };
  await page.getByRole('button', { name: 'Command center' }).click();
  await wait(3500);
  await page.evaluate((id) => window.__atlasPreview.set({ missionId: id }), best.id);
  await wait(3500);

  await go('home');
  await shot('Home', `This is ATLAS, mission control for a team of AI software engineers, running on a real repository: Operon, a complaint-operations platform with a FastAPI backend and a React dashboard. Every value on these screens is live. ${missions.length} missions ran on this machine with real ${String(model).replace('deepseek/', 'DeepSeek ')} agents; ${verified} were independently verified. No scripted decisions.`);
  await go('mission');
  await shot('Mission Control', `Mission Control for "${best.title}". The orchestrator ${planSrc === 'model' ? 'model planned this mission itself' : 'staffed this mission'}: ${snap.tasks.length} tasks across ${roles.length} roles — ${roles.join(', ').replace(/_/g, ' ')}. The workforce graph shows who waits on whom. Needs you collects approvals and failures; the verification column is the independent gate.`);
  await go('graph');
  await shot('Task graph', `The task graph is laid out from the real dependency structure. Independent writers can run at the same time in separate git worktrees; reviewers and the security engineer start only when the checkpoints they depend on exist.`);
  const coder = snap.tasks.find((t) => t.role === 'coder');
  if (coder) { await go('agent', { agent: coder.key }); await shot('Agent detail', `This is the coder's real thread: its decision summaries, every tool call it made through policy, and its results. Below, the composer directs a running agent; the direction is delivered into its live session and it keeps its context.`); }
  await go('review');
  await shot('Review', `Review shows the actual patch from the checkpointed work, file by file, with the reviewer's and security engineer's findings pinned to the lines they concern. ${snap.findings.length} findings were recorded for this mission.`);
  await go('deploy');
  await shot('Deployments', `Deployments shows the verification pipeline: integration, build, tests, staging, API checks, browser QA and runtime health. ${passed} checks passed for this mission. ATLAS ran them itself; an agent saying "done" counts for nothing.`);
  await go('computer');
  await shot('Browser QA', `Browser QA is a real Playwright browser driving the app started from the mission's worktree, with every step and screenshot recorded.`);
  await go('terminal');
  await shot('Terminal', `Every agent command ran as an argument array inside the macOS sandbox and is recorded here. On the right is your own sandboxed shell in the mission worktree.`);
  await go('report');
  await shot('Report', `The report states what was asked, how long it took, what changed, what was independently verified, the decisions made, and what was not verified.${pr ? ` The accepted change was opened as pull request number ${pr.number} on GitHub, where CI runs.` : ''}`);
  await go('studio');
  await shot('Agent Studio', `Agent Studio shows each role exactly as policy enforces it: instructions, model tier, tools, capabilities, permissions and limits.`);
  await go('activity');
  await shot('Activity', `Activity collects every event across missions. That is the automated team: plan, delegate, build in parallel, review, secure, verify, publish — with a person deciding what ships.`);
  // The classic live mission view and the Cloudflare publication.
  await page.getByRole('button', { name: 'Back to ATLAS' }).click(); await wait(1500);
  await page.evaluate((id) => { localStorage.setItem('atlas:route', JSON.stringify({ screen: 'mission', missionId: id })); }, best.id);
  await page.reload(); await page.getByTestId('daemon-status').and(page.locator('[data-state="ready"]')).waitFor(); await wait(2500);
  await page.getByRole('tab', { name: /Evidence/ }).click().catch(() => {}); await wait(1200);
  await shot('Evidence', `The release gate in the mission view: every required check, its command and its result. Only a real pass makes a result verified.`);
  await page.getByRole('tab', { name: 'Cloudflare' }).click().catch(() => {}); await wait(1200);
  await shot('Cloudflare Artifacts', `Completed missions are published to a dedicated Cloudflare Artifacts repository through our Worker: the base, every agent branch and the integration branch. The Worker reads each branch back, and ATLAS records the publication only when every commit ID matches.`);
  if (teamDir && existsSync(teamDir)) for (const f of readdirSync(teamDir).filter((x) => x.endsWith('.png')).slice(0, 2)) { const dst = path.join(out, `team-${f}`); copyFileSync(path.join(teamDir, f), dst); scenes.splice(2, 0, { title: 'Running', text: 'Captured while the agents were working: real agents running at the same time, each in its own worktree.', file: dst }); }
} finally { await app.close(); }

const clips = [];
scenes.forEach((s, i) => {
  const txt = path.join(out, `voice-${i}.txt`); const aiff = path.join(out, `voice-${i}.aiff`); const clip = path.join(out, `clip-${i}.mp4`);
  writeFileSync(txt, s.text);
  execFileSync('say', ['-v', 'Samantha', '-r', '150', '-f', txt, '-o', aiff]);
  const probe = spawnSync(ffmpeg, ['-i', aiff], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(probe.stderr); const secs = m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 20;
  execFileSync(ffmpeg, ['-y', '-loop', '1', '-framerate', '10', '-i', s.file, '-i', aiff, '-t', String(Math.max(22, secs + 1.5)), '-vf', 'scale=1440:900,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', '-af', 'apad', clip], { stdio: 'ignore' });
  clips.push(`file '${clip}'`);
});
writeFileSync(path.join(out, 'clips.txt'), clips.join('\n'));
const final = path.join(out, 'ATLAS-demo.mp4');
execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(out, 'clips.txt'), '-c', 'copy', '-movflags', '+faststart', final], { stdio: 'ignore' });
console.log(`Narrated walkthrough of real missions: ${final}`);
