// Creates a git repository from fixtures/sample-app for the demo mission.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'atlas-sample-app'));
if (existsSync(target)) {
  if (!process.argv.includes('--force')) { console.error(`${target} already exists (use --force to recreate)`); process.exit(1); }
  rmSync(target, { recursive: true, force: true });
}
cpSync(path.join(root, 'fixtures', 'sample-app'), target, { recursive: true });
const g = (...args) => execFileSync('git', args, { cwd: target, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'ATLAS sample', GIT_AUTHOR_EMAIL: 'sample@atlas.local', GIT_COMMITTER_NAME: 'ATLAS sample', GIT_COMMITTER_EMAIL: 'sample@atlas.local' } });
g('init', '-q', '-b', 'main');
g('add', '-A');
g('commit', '-q', '-m', 'Sample app with a slugify bug');
console.log(`Sample repository ready: ${target}\nOpen it in ATLAS with "Open repository".`);
