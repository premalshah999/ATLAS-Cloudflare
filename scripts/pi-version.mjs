// Reports the installed Pi packages against the pinned upstream (manual §8).
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pinned = { version: '0.87.1', gitHead: 'f07218c4d4bbc12bef056a7058c3dd49dfe41abe', license: 'MIT' };
let failed = false;
for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai']) {
  const dir = path.join(path.resolve('node_modules'), name);
  const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const ok = pj.version === pinned.version && pj.license === pinned.license;
  if (!ok) failed = true;
  console.log(`${ok ? '✓' : '✗'} ${name}@${pj.version} · ${pj.license} · ${pj.repository?.url ?? ''}${pj.gitHead ? ` · ${pj.gitHead}` : ''}`);
}
console.log(`pinned: ${pinned.version} (upstream commit ${pinned.gitHead})`);
// The upstream LICENSE text must ship with ATLAS (the npm tarballs carry none).
try {
  const text = readFileSync(path.resolve('licenses/third-party/pi-LICENSE.txt'), 'utf8');
  const ok = /^MIT License/.test(text) && /Mario Zechner/.test(text) && /WITHOUT WARRANTY OF ANY KIND/.test(text);
  if (!ok) failed = true;
  console.log(`${ok ? '✓' : '✗'} licenses/third-party/pi-LICENSE.txt (upstream MIT text)`);
} catch { failed = true; console.log('✗ licenses/third-party/pi-LICENSE.txt is missing'); }
process.exit(failed ? 1 : 0);
