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
  ['Projects', 'ATLAS is local-first mission control for software engineering agents. Its central idea is that an agent claim is not evidence. A person describes an outcome, approves a plan, and inspects independently collected results before accepting a change. This demonstration runs the built Electron application on a Mac. It uses a small sample repository with an intentional slug-generation bug. The original checkout will remain unchanged throughout the mission.'],
  ['Mission', 'The objective asks two agents to work in parallel: one fixes slug generation, while another adds regression coverage. This recording uses the explicitly labeled scripted runtime, so it needs no model credentials. The decisions are deterministic. The worktrees, file edits, concurrent scheduling, commands, merges, and verification are real. The same orchestration also supports the Pi model runtime when a provider key is configured. We keep risky actions subject to approval.'],
  ['Plan', 'Before execution, ATLAS presents a validated task graph. The implementation and regression tasks have no dependency on each other, and declare different files. The reviewer depends on both checkpoints. This is how ATLAS separates independent work from work that must wait. Plans have tool and role allowlists, cycle checks, and budgets. Approval starts the mission; proposing a plan alone does not authorize agents to execute it.'],
  ['Concurrent work', 'Now the two writer tasks run in separate Git worktrees. Each starts from the same baseline, with its own branch and attempt record. The implementation task examines the failing tests and changes the slug helper. The other task adds assertions for accented titles and empty input. Neither edits the original checkout. The scheduler respects the concurrency budget. A dependent reviewer starts only after both writers have produced checkpoints.'],
  ['Task graph', 'The completed graph preserves the structure of the work. Independent writers can overlap; dependencies determine when the next task can start. ATLAS integrates writer checkpoints into a mission branch. It serializes writers that declare overlapping files, and a real merge conflict stops integration rather than silently choosing a result. Those behaviors also have integration tests against temporary Git repositories. This prototype has a small configurable concurrency budget; it does not claim hundred-thousand-agent scale.'],
  ['Changes', 'The Changes view shows the actual patch from the checkpointed work. Here the implementation normalizes text, removes combining accent marks, lowercases the title, and collapses separators. The independent regression file adds executable assertions. Both contributions reach the integrated result. This view is based on Git state, not a model summary. The operator can inspect the changed files before accepting or rejecting the mission, while their original branch remains untouched.'],
  ['Activity', 'The activity timeline records the sequence of decisions and tool execution. It distinguishes agent messages from commands, approvals, policy decisions, and checks. Commands retain their output and exit status. A failing test during diagnosis is useful evidence; it is not a successful release. ATLAS then checks the integrated revision again. This distinction matters when an agent claims that it fixed something but the actual tests still fail.'],
  ['Evidence', 'The Evidence view shows the independent release gate. For this sample, ATLAS executes the project test command and checks the application endpoints and browser flow on the integrated revision. A passing label must come from the recorded check result. The displayed commit connects the evidence to the code being reviewed. This is still limited by the quality of the project checks: passing tests cannot prove that every possible behavior is correct.'],
  ['Review', 'Review findings have structure and provenance. A confirmed finding requires a failing reproduction that ATLAS itself ran. A reviewer opinion without that evidence is treated differently. This demonstration uses a scripted reviewer, and makes no claim that a live model reviewed the patch. The purpose here is to show the review and verification boundary. The operator remains responsible for accepting risks and deciding whether the integrated change should be retained.'],
  ['Browser QA', 'Browser checks run against the application started from the checkpointed code. The Browser view preserves the executed steps and their screenshots. The sample submits a title and checks the resulting slug, alongside separate API checks. These are real browser interactions and assertions from this mission. They give the operator another kind of evidence beyond a terminal test command, while keeping the code revision and the observed application behavior connected.'],
  ['Cloudflare integration status', 'The Cloudflare integration is implemented but not deployed in this recording. A Worker is designed to create a dedicated Artifacts repository, issue a short-lived Git token, and independently read back every published branch hash. The desktop only records publication success after all hashes match. Our account was blocked because Artifacts requires Workers Paid. Local development also uses remote Artifacts. Therefore this recording does not demonstrate a successful cloud publication, and that requirement remains unresolved.'],
  ['Operator decision', 'Accepting the change preserves the integration branch for the operator to merge. It does not rewrite the original checkout. Rejecting a mission instead removes its isolated work. ATLAS also supports exporting a redacted, checksummed audit log and importing it as a read-only archive. The product combines agent coordination with an explicit human decision and durable evidence, rather than treating the last agent message as the final state of the project.'],
  ['Providers and handoff', 'Settings provides encrypted key entry for nine API-key providers, including Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, xAI, Groq, Mistral, and Cerebras. A model can be selected for new Pi missions. No live provider request was made in this recording. The source includes Mac setup instructions, the demo objective, and the Worker deployment guide. The local workflow is tested. Completing the Cloudflare challenge requirements still needs Artifacts access and a successful live publication before submission.'],
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
  await show(0, async () => { await page.getByRole('button', { name: 'Open repository' }).first().click(); await expect(page.getByTestId('workspace-card')).toBeVisible(); });
  await show(1, async () => {
    await page.getByRole('button', { name: 'New mission' }).first().click();
    await page.getByTestId('mission-title').fill('Parallel implementation and regression coverage');
    await page.getByTestId('mission-goal').fill('[parallel sample] Fix slugify and add regression coverage in parallel, then review and verify the integrated result.');
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-ready', 'true');
  });
  await show(2, async () => { await page.getByTestId('plan-mission').click(); await expect(page.getByTestId('plan')).toContainText('regression'); });
  await show(3, async () => { await page.getByTestId('approve-plan').click(); await page.getByRole('tab', { name: /Tasks/ }).click(); });
  await show(4, async () => { await expect(page.getByTestId('mission')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 }); });
  await show(5, async () => { await page.getByRole('tab', { name: /Changes/ }).click(); });
  await show(6, async () => { await page.getByRole('tab', { name: /Activity/ }).click(); await page.locator('.lv-chip', { hasText: 'Commands' }).first().click(); });
  await show(7, async () => { await page.getByRole('tab', { name: /Evidence/ }).click(); await expect(page.getByTestId('outcome')).toContainText('Verified'); });
  await show(8, async () => { await page.getByRole('tab', { name: /Review/ }).click(); });
  await show(9, async () => { await page.getByRole('tab', { name: /Browser/ }).click(); });
  await show(10, async () => { await page.getByRole('tab', { name: 'Cloudflare' }).click(); });
  await show(11, async () => { await page.getByRole('tab', { name: /Changes/ }).click(); await page.getByTestId('accept').click(); await expect(page.getByText('Accepted by you')).toBeVisible(); });
  await show(12, async () => { await page.getByTestId('open-palette').click(); await page.keyboard.type('settings'); await page.keyboard.press('Enter'); await expect(page.getByTestId('settings')).toBeVisible(); await page.getByLabel('Provider/model').scrollIntoViewIfNeeded(); });
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
