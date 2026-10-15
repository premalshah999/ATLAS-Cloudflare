// Scripted behavior for the bundled sample project (fixtures/sample-app). Sample output, not a model.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FakeScript } from './index';

export const SAMPLE_FIX = `// Fixed by the ATLAS sample script.
export function slugify(title) {
  return title
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[\\u2019'.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

export const sampleSlugifyScript: FakeScript = {
  name: 'sample-slugify',
  matches: (input) => {
    if (input.roleId !== 'coder') return false;
    const f = path.join(input.cwd, 'src', 'slugify.js');
    return existsSync(f) && readFileSync(f, 'utf8').includes('ATLAS-SAMPLE');
  },
  steps: (input) => input.permittedTools.includes('write_file')
    ? [
        { say: 'Reading the slug helper and its tests before changing anything.' },
        { tool: 'read_file', args: { path: 'src/slugify.js' } },
        { tool: 'read_file', args: { path: 'test/slugify.test.js' } },
        { tool: 'run_tests', args: {} },
        { say: 'All five tests fail: case, punctuation and repeated separators are not handled. Rewriting slugify to normalize, lowercase and collapse non-alphanumerics.' },
        { tool: 'write_file', args: { path: 'src/slugify.js', content: SAMPLE_FIX } },
        { tool: 'run_tests', args: {} },
        { claim: 'Rewrote slugify() to normalize, lowercase, strip apostrophes and collapse separators. Tests pass locally.' },
      ]
    : [
        { tool: 'read_file', args: { path: 'src/slugify.js' } },
        { tool: 'run_tests', args: {} },
        { claim: 'Plan-only: slugify() ignores case, punctuation and repeated separators. Recommended fix: normalize, lowercase, collapse non-alphanumerics.' },
      ],
};

/** Marker in a mission objective that selects the scripted UI sample (ADR 0027: visual proof). */
export const UI_SAMPLE_MARKER = '[ui sample]';

/** The sample page with a subtitle and a result card: a visible change for ATLAS's before/after comparison. */
export function sampleUiPage(page: string): string {
  return page
    .replace('output{display:block;margin-top:16px;font-family:monospace}', 'output{display:block;margin-top:16px;font-family:monospace;padding:12px 14px;border-radius:8px;background:#eef2ff;color:#3730a3;min-height:1.4em}.sub{color:#555;margin:-8px 0 24px}')
    .replace('<h1>Slug maker</h1>', '<h1>Slug maker</h1>\n  <p class="sub">Turn any post title into a clean, lowercase URL slug.</p>');
}

/** UI sample: the slugify fix, plus a clearer page. */
export const sampleUiScript: FakeScript = {
  name: 'sample-ui',
  matches: async (input) => (await sampleSlugifyScript.matches(input)) && input.prompt.includes(UI_SAMPLE_MARKER) && input.permittedTools.includes('write_file'),
  steps: (input) => [
    { say: 'Reading the slug helper, its tests and the page before changing anything.' },
    { tool: 'read_file', args: { path: 'src/slugify.js' } },
    { tool: 'read_file', args: { path: 'public/index.html' } },
    { tool: 'run_tests', args: {} },
    { tool: 'write_file', args: { path: 'src/slugify.js', content: SAMPLE_FIX } },
    { say: 'Explaining the tool under the heading and showing the slug in a result card.' },
    { tool: 'write_file', args: { path: 'public/index.html', content: sampleUiPage(readFileSync(path.join(input.cwd, 'public', 'index.html'), 'utf8')) } },
    { tool: 'run_tests', args: {} },
    { claim: 'Fixed slugify() and made the page clearer: a one-line explanation and a result card. Tests pass locally.' },
  ],
};

/** Marker in a mission objective that selects the scripted desktop sample. */
export const DESKTOP_SAMPLE_MARKER = '[desktop sample]';

export const sampleRegressionScript: FakeScript = {
  name: 'sample-regression',
  matches: (input) => input.prompt.includes('Work on task regression now.') && existsSync(path.join(input.cwd, 'src/slugify.js')),
  steps: () => [
    { say: 'Adding independent regression coverage in my own worktree while the implementation task runs.' },
    { tool: 'read_file', args: { path: 'test/slugify.test.js' } },
    { wait: 3000 },
    { tool: 'write_file', args: { path: 'test/slugify.additional.test.js', content: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\ntest('accented titles normalize', () => assert.equal(slugify('Café Déjà Vu'), 'cafe-deja-vu'));\ntest('empty titles remain empty', () => assert.equal(slugify(''), ''));\n" } },
    { claim: 'Added two regression assertions. Their result must be checked on the integrated commit.' },
  ],
};

/**
 * Scripted planner for the samples: plans a desktop operator task for the desktop sample and declines
 * otherwise (the orchestrator then uses its deterministic plan).
 */
export function samplePlanner(req: { objective: string; verification: { name: string; required: boolean }[] }): unknown {
  if (req.objective.includes('[parallel sample]')) return {
    summary: 'Two independent agents change implementation and regression tests concurrently, then a reviewer checks their integrated work. Scripted decisions; real worktrees and checks.',
    scope: 'src/slugify.js and test/slugify.additional.test.js in isolated worktrees.',
    tasks: [
      { key: 'implement', title: 'Fix slug generation', role: 'coder', dependsOn: [], files: ['src/slugify.js'], acceptance: ['Normalize titles into lowercase URL slugs'], tools: ['read_file', 'write_file', 'run_tests'], risk: 'low' },
      { key: 'regression', title: 'Add independent regression coverage', role: 'coder', dependsOn: [], files: ['test/slugify.additional.test.js'], acceptance: ['Cover accents and empty input'], tools: ['read_file', 'write_file'], risk: 'low' },
      { key: 'review', title: 'Review both checkpoints', role: 'reviewer', dependsOn: ['implement', 'regression'], acceptance: ['Inspect the integrated diff and execute its tests'], tools: ['view_diff', 'run_tests', 'report_finding'], risk: 'low' },
    ],
    verification: req.verification,
  };
  if (!req.objective.includes(DESKTOP_SAMPLE_MARKER)) return null;
  return {
    summary: 'Scripted desktop sample: a desktop operator works on an isolated virtual display.',
    scope: 'A new virtual display; no files change.',
    tasks: [{ key: 'desktop', title: 'Operate the virtual desktop', role: 'desktop_operator', dependsOn: [], acceptance: ['The desktop session is recorded with screenshots'], tools: ['desktop_action', 'read_file'], risk: 'elevated' }],
    verification: req.verification,
  };
}

/** Desktop operator sample: looks, clicks, pauses long enough for an operator to take over, types. */
export const sampleDesktopScript: FakeScript = {
  name: 'sample-desktop',
  matches: (input) => input.roleId === 'desktop_operator',
  steps: () => [
    { say: 'Taking a screenshot of the virtual display before acting.' },
    { tool: 'desktop_action', args: { action: 'screenshot' } },
    { tool: 'desktop_action', args: { action: 'launch', app: 'xmessage', args: ['-center', '-title', 'ATLAS desktop sample', 'Hello from an app running in the ATLAS sandbox on a virtual display.'] } },
    { tool: 'desktop_action', args: { action: 'waitFor', windowTitle: 'ATLAS desktop sample', timeoutMs: 10000 } },
    { tool: 'desktop_action', args: { action: 'windows' } },
    { tool: 'desktop_action', args: { action: 'click', x: 640, y: 400 } },
    { wait: 8000 },
    { tool: 'desktop_action', args: { action: 'type', text: 'hello from the agent' } },
    { tool: 'desktop_action', args: { action: 'screenshot' } },
    { claim: 'Operated the virtual desktop (scripted sample).' },
  ],
};
