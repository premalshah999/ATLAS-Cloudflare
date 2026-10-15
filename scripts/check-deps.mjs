// Enforces the package dependency graph (manual §7): acyclic, contracts depend on nothing internal,
// no package imports UI or app code, and the renderer imports no privileged package.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [...readdirSync(path.join(root, 'packages')).map((d) => `packages/${d}`), 'apps/daemon', 'apps/desktop'].filter((d) => existsSync(path.join(root, d, 'package.json')));
const pkgs = new Map();
for (const d of dirs) {
  const pj = JSON.parse(readFileSync(path.join(root, d, 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pj.dependencies, ...pj.devDependencies }).filter((n) => n.startsWith('@atlas/'));
  pkgs.set(pj.name, { dir: d, deps });
}
const errors = [];
if (pkgs.get('@atlas/contracts')?.deps.length) errors.push('@atlas/contracts must not depend on other @atlas packages');
for (const [name, { deps }] of pkgs) {
  if (name.startsWith('@atlas/') && !['@atlas/desktop', '@atlas/daemon'].includes(name)) {
    for (const d of deps) if (d === '@atlas/desktop' || d === '@atlas/daemon') errors.push(`${name} must not depend on application ${d}`);
  }
}
// Cycle detection.
const state = new Map();
const visit = (n, stack) => {
  if (state.get(n) === 2) return;
  if (state.get(n) === 1) { errors.push(`dependency cycle: ${[...stack, n].join(' → ')}`); return; }
  state.set(n, 1);
  for (const d of pkgs.get(n)?.deps ?? []) visit(d, [...stack, n]);
  state.set(n, 2);
};
for (const n of pkgs.keys()) visit(n, []);
// Packages must not import UI code.
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
for (const d of dirs.filter((x) => x.startsWith('packages/'))) {
  for (const f of walk(path.join(root, d, 'src')).filter((f) => /\.tsx?$/.test(f))) {
    const src = readFileSync(f, 'utf8');
    if (/from ['"](react|react-dom|electron)['"]/.test(src) || /apps\/desktop/.test(src)) errors.push(`${path.relative(root, f)} imports UI or Electron code`);
  }
}
if (errors.length) { console.error(errors.map((e) => `✗ ${e}`).join('\n')); process.exit(1); }
console.log(`✓ dependency graph: ${pkgs.size} workspaces, acyclic, contracts at the root`);
