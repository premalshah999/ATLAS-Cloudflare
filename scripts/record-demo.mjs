// Captures a real Electron mission and makes a narrated screenshot walkthrough.
// Narration is synthesized locally with macOS `say`; raw interaction video is retained.
// No screen, results, agent execution or cloud deployment is fabricated.
import { _electron as electron, expect } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test-results', `demo-${Date.now()}`);
mkdirSync(out, { recursive: true });
const ffmpeg = process.env.ATLAS_FFMPEG ?? 'ffmpeg';
const repo = path.join(out, 'sample-app');
execFileSync(process.execPath, [path.join(root, 'scripts/seed-sample.mjs'), repo]);
const scenes = [
  ['Home', 'ATLAS is local-first mission control for teams of software agents. Its central rule is that an agent claim is not evidence. You describe an outcome, approve a plan, and then inspect independently collected proof before anything reaches your project. The Home dashboard shows what needs your decision, what is running, what is ready for review, and how far this machine is through setup: a repository, a provider key, the operating system sandbox, and the Cloudflare connection.'],
  ['Mission', 'This objective asks two agents to work at the same time: one fixes slug generation, another adds regression coverage. The recording uses the explicitly labeled scripted runtime, so it needs no model credentials, and its decisions are deterministic. Everything else is real: the git worktrees, concurrent scheduling, file edits, merges, tests, browser checks, review and publication.'],
  ['Plan', 'Before anything runs, ATLAS validates a task graph. The implementation and regression tasks do not depend on each other and declare different files, so they may overlap. Review depends on both checkpoints, and a security review follows. Declared file overlaps would be serialized instead, and a real merge conflict stops integration rather than being papered over.'],
  ['Concurrent work', 'Approving the plan starts both writers in separate git worktrees. Each starts from the same base commit, on its own branch, with its own attempt record. Neither can touch your checkout. Every command an agent asks for passes through policy, runs as an argument array inside the operating system sandbox, and is recorded with its output and exit status.'],
  ['Task graph', 'The completed graph keeps the structure of the work. The two writers overlapped in time; review started only when both checkpoints existed. ATLAS then integrated both checkpoints into one mission branch, and re-ran verification on that integrated revision, not on either agent alone.'],
  ['Changes', 'Changes shows the real patch from the checkpointed work. The implementation normalizes text, removes accent marks, lowercases, and collapses separators. The regression task added a separate test file for accented titles and repeated punctuation. Both contributions are present on the integration branch.'],
  ['Activity', 'The activity timeline is append-only. It separates agent messages from commands, policy decisions, approvals and checks, and each filter shows exactly what its count says. This is the audit trail that can be exported as a signed log and imported read-only on another machine.'],
  ['Evidence', 'Evidence is the release gate. ATLAS itself ran the project tests, the API checks and the browser flow on the integrated revision, plus a deterministic security scan and review. The mission is called verified only because those required checks actually passed. An agent saying it is done never counts.'],
  ['Report', 'The Report tab puts it on one page: what was asked, how long it took, how many tasks finished, how many required checks passed, tool calls and tokens, every check with its command, open review findings, and provenance: the base commit, the integrated branch, the agents involved, the Cloudflare publication and your decision.'],
  ['Browser QA', 'Browser checks run against the application started from the checkpointed code, inside the sandbox. The Browser view keeps every step and its screenshots: the sample fills in a title and checks the resulting slug. A visual check compares pages before and after the change.'],
  ['Cloudflare Artifacts', 'Now the Cloudflare part, live. Publishing sends this mission to a dedicated Cloudflare Artifacts repository through our Worker. The Worker creates the repository and issues a ten-minute, repository-scoped git token. ATLAS pushes the base commit, both agent branches, the review checkpoint and the integration branch, then the Worker reads every branch back through the Artifacts API. Only because every remote commit ID matches does ATLAS record a verified publication. Model keys never reach Cloudflare.'],
  ['Operator decision', 'The decision stays with a person. Accepting keeps the integration branch for you to merge, and never rewrites your checkout. Rejecting removes the isolated work. With a GitHub token, ATLAS can also open a pull request, read CI, and start a follow-up mission that fixes a failing check on the same branch.'],
  ['Agents', 'The Agents screen shows every role ATLAS can run as versioned policy: its tools, its capabilities, whether it may write code, which model tier it uses, and its limits on tool calls, tokens and time. The orchestrator plans, coders write in their own worktrees, reviewers and testers read, and the deployment verifier checks a served revision.'],
  ['Activity across missions', 'Activity across missions collects recent events from every mission in one feed, each linking back to its mission, so a person supervising many agents can see what happened without opening each one.'],
  ['Providers and models', 'Settings reaches every key-based provider the Pi runtime supports. Keys are encrypted with the operating system credential store and redacted from every log and export. A Test button checks a key for free at the provider\'s own API; DeepSeek is used only through api dot deepseek dot com, and its balance is checked too. Each role tier can use a different model.'],
  ['Summary', 'To summarize: ATLAS lets many agents change one repository at the same time, safely. Work happens in isolated worktrees under policy and an operating system sandbox. Results are integrated, verified independently, reviewed, and published to Cloudflare Artifacts with every commit confirmed. A person decides what ships. The source is open, and the instructions to run it are in the repository.'],
];
const audio = scenes.map(([title, text], i) => {
  const file = path.join(out, `voice-${i}.aiff`);
  const txt = path.join(out, `voice-${i}.txt`);
  writeFileSync(txt, text);
  execFileSync('say', ['-v', 'Samantha', '-r', '145', '-f', txt, '-o', file]);
  const probe = spawnSync(ffmpeg, ['-i', file], { encoding: 'utf8' });
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(probe.stderr);
  if (!match) throw new Error(`Cannot measure narration ${i}`);
  return { title, text, file, seconds: +match[1] * 3600 + +match[2] * 60 + +match[3] };
});
const env = { ...process.env, ATLAS_E2E: '1', ATLAS_USER_DATA: path.join(out, 'profile'), ATLAS_E2E_OPEN_DIR: repo };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/_API_KEY$/.test(key)) delete env[key];
const desktop = path.join(root, 'apps/desktop');
const started = Date.now();
const app = await electron.launch({ args: [desktop], cwd: desktop, env, recordVideo: { dir: path.join(out, 'raw'), size: { width: 1440, height: 900 } } });
const page = await app.firstWindow();
await page.getByTestId('daemon-status').and(page.locator('[data-state="ready"]')).waitFor();
const timeline = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const show = async (i, action) => {
  if (action) await action();
  const time = (Date.now() - started) / 1000;
  timeline.push({ ...audio[i], start: time });
  console.log(`Scene ${i + 1}/${scenes.length}: ${audio[i].title}`);
  await page.screenshot({ path: path.join(out, `scene-${String(i + 1).padStart(2, '0')}.png`) });
  await wait(150);
};
try {
  page.on('dialog', (d) => void d.accept());
  const cloudUrl = process.env.ATLAS_CLOUD_URL, cloudToken = process.env.ATLAS_CLOUD_TOKEN;
  if (!cloudUrl || !cloudToken) throw new Error('Set ATLAS_CLOUD_URL and ATLAS_CLOUD_TOKEN: the Cloudflare scene publishes live.');
  await page.getByRole('button', { name: 'Open repository' }).first().click(); await expect(page.getByTestId('workspace-card')).toBeVisible();
  await page.evaluate(async ({ url, token }) => { const a = window.atlas; await a.invoke('settings.set', { key: 'cloud.url', value: url }); await a.invoke('deploy.secrets.set', { target: 'cloudflare', name: 'ATLAS_CLOUD_TOKEN', value: token }); }, { url: cloudUrl, token: cloudToken });
  await show(0, async () => { await page.getByRole('button', { name: 'Home' }).first().click(); await expect(page.getByTestId('home-setup')).toBeVisible(); await wait(500); });
  await show(1, async () => {
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Parallel implementation and regression coverage');
    await page.getByTestId('mission-goal').fill('[parallel sample] Fix slugify and add regression coverage in parallel, then review and verify the integrated result.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
  });
  await show(2, async () => { await page.getByTestId('plan-mission').click(); await expect(page.getByTestId('plan')).toContainText('regression'); });
  await show(3, async () => { await page.getByTestId('approve-plan').click(); await page.getByRole('tab', { name: /Tasks/ }).click(); await wait(1500); });
  await show(4, async () => { await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 90_000 }); await page.getByRole('tab', { name: /Tasks/ }).click(); });
  await show(5, async () => { await page.getByRole('tab', { name: /Changes/ }).click(); });
  await show(6, async () => { await page.getByRole('tab', { name: /Activity/ }).click(); await page.locator('.lv-chip', { hasText: 'Commands' }).first().click(); });
  await show(7, async () => { await page.getByRole('tab', { name: /Evidence/ }).click(); await expect(page.getByTestId('outcome')).toContainText('Verified'); });
  await show(8, async () => { await page.getByRole('tab', { name: /Report/ }).click(); await expect(page.getByTestId('report-panel')).toBeVisible(); });
  await show(9, async () => { await page.getByRole('tab', { name: /Browser/ }).click(); });
  await show(10, async () => {
    await page.getByRole('tab', { name: 'Cloudflare' }).click();
    await page.getByRole('button', { name: /Publish to Cloudflare/ }).click();
    await expect(page.getByText('All published commit IDs match')).toBeVisible({ timeout: 120_000 });
  });
  await show(11, async () => { await page.getByRole('tab', { name: /Changes/ }).click(); await page.getByTestId('accept').click(); await expect(page.getByText('Accepted by you')).toBeVisible(); });
  await show(12, async () => { await page.getByRole('button', { name: 'Agents' }).first().click(); await expect(page.getByTestId('agent-detail')).toBeVisible(); await page.getByTestId('agent-role').nth(1).click(); });
  await show(13, async () => { await page.getByRole('button', { name: 'Activity' }).first().click(); await expect(page.getByTestId('activity-row').first()).toBeVisible({ timeout: 15_000 }); });
  await show(14, async () => { await page.getByTestId('open-palette').click(); await page.keyboard.type('settings'); await page.keyboard.press('Enter'); await expect(page.getByTestId('settings')).toBeVisible(); await page.getByTestId('providers').scrollIntoViewIfNeeded(); });
  await show(15, async () => { await page.getByRole('button', { name: 'Home' }).first().click(); await wait(500); });
  const video = page.video();
  await app.close();
  const raw = await video.path();
  const rawCopy = path.join(out, 'ATLAS-demo-raw.webm');
  copyFileSync(raw, rawCopy);
  writeFileSync(path.join(out, 'timeline.json'), JSON.stringify({ raw: rawCopy, duration: (Date.now() - started) / 1000, scenes: timeline }, null, 2));
  console.log(`Recording complete: ${out}`);
} catch (e) { await app.close(); writeFileSync(path.join(out, 'timeline-partial.json'), JSON.stringify(timeline, null, 2)); throw e; }
const clips = [];
for (let i = 0; i < scenes.length; i++) {
  const clip = path.join(out, `clip-${i}.mp4`);
  execFileSync(ffmpeg, ['-y', '-loop', '1', '-framerate', '10', '-i', path.join(out, `scene-${String(i + 1).padStart(2, '0')}.png`), '-i', audio[i].file, '-t', String(Math.max(24, audio[i].seconds + 1)), '-vf', 'scale=1440:900,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', '-af', 'apad', clip], { stdio: 'ignore' });
  clips.push(`file '${clip}'`);
}
const list = path.join(out, 'clips.txt');
writeFileSync(list, clips.join('\n'));
const final = path.join(out, 'ATLAS-demo.mp4');
execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final], { stdio: 'ignore' });
console.log(`Narrated walkthrough: ${final}`);
