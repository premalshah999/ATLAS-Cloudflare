// Dev loop: Vite for the renderer, esbuild --watch for main/preload/daemon, then Electron.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// IDE terminals can inherit this from their Electron host.
delete process.env.ELECTRON_RUN_AS_NODE;
const procs = [];
const run = (cmd, args, env = {}) => { const p = spawn(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } }); procs.push(p); return p; };

run('npx', ['vite', '-c', 'renderer/vite.config.ts']);
await new Promise((r) => { const b = spawn('node', ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' }); b.on('exit', r); });
run('node', ['scripts/build.mjs', '--watch']);
await new Promise((r) => setTimeout(r, 1500));
const app = run('npx', ['electron', '.'], { VITE_DEV_SERVER_URL: 'http://localhost:5173/' });
app.on('exit', () => { for (const p of procs) p.kill(); process.exit(0); });
