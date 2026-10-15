// Harness sync (ADR 0019): ATLAS's trusted skills and MCP servers are written to Claude Code, Codex and OpenCode,
// the places those tools read them from. They stay separate tools; ATLAS only keeps their files in step.
//
// Ownership: ATLAS records the hash of everything it writes. It updates or removes only what it wrote and what is
// unchanged since; anything else at the same place is a conflict and is left alone. A plan is shown before anything
// is written, and applying recomputes it and refuses if it no longer matches the preview.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from '@atlas/contracts';
import { BLOCK_BEGIN, BLOCK_END, codexTable, entryFor, findBlock, readForeign, tomlServerNames, type ForeignServer } from './formats';
import { locations, type Target } from './targets';

export interface SkillSource { name: string; dir: string; files: string[]; hash: string }
export interface SyncInput { skills: SkillSource[]; mcp: McpServerConfig[] }
/** What ATLAS wrote: key → hash of the content it wrote. */
export type SyncState = Record<string, string>;
export type Action = 'create' | 'update' | 'delete' | 'unchanged' | 'conflict';
export interface Change { kind: 'skill' | 'mcp'; name: string; path: string; action: Action; reason?: string }

interface Op { key: string; run(): string | null }
export interface SyncPlan {
  changes: Change[];
  /** Why a part is not synced for this target (unsupported location). */
  notes: string[];
  /** Hash of the changes, to check at apply time that nothing moved since the preview. */
  id: string;
  ops: Op[];
  /** State keys that no longer exist and are dropped on apply. */
  forget: string[];
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Same hash as the skill library computes (orchestrator skills.ts): sorted files, name\0content\0. */
export function dirHash(dir: string): string | null {
  if (!existsSync(dir)) return null;
  if (lstatSync(dir).isSymbolicLink()) return 'symlink';
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else if (e.isFile()) files.push(r);
    }
  };
  walk('');
  const h = createHash('sha256');
  for (const f of files.sort()) h.update(f).update('\0').update(readFileSync(path.join(dir, f))).update('\0');
  return h.digest('hex');
}

function writeAtomic(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symbolic link; ATLAS does not write through links`);
  const tmp = `${file}.atlas-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function copySkill(src: SkillSource, dest: string) {
  const staging = `${dest}.atlas-${process.pid}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  for (const f of src.files) {
    mkdirSync(path.dirname(path.join(staging, f)), { recursive: true });
    writeFileSync(path.join(staging, f), readFileSync(path.join(src.dir, f)));
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  renameSync(staging, dest);
}

export function plan(target: Target, input: SyncInput, state: SyncState, what: { skills: boolean; mcp: boolean } = { skills: true, mcp: true }): SyncPlan {
  const loc = locations(target);
  const changes: Change[] = [];
  const ops: Op[] = [];
  const forget: string[] = [];
  const notes: string[] = [];

  if (what.skills && !loc.skills) notes.push(loc.skillsWhyNot ?? 'Skills are not synced for this target.');
  if (what.skills && loc.skills) {
    const root = loc.skills;
    for (const s of input.skills) {
      const dest = path.join(root, s.name);
      const key = `skill:${dest}`;
      const have = dirHash(dest);
      if (have === 'symlink') { changes.push({ kind: 'skill', name: s.name, path: dest, action: 'conflict', reason: 'a symbolic link is there' }); continue; }
      const push = (action: Action, reason?: string) => changes.push({ kind: 'skill', name: s.name, path: dest, action, ...(reason ? { reason } : {}) });
      if (have === null) push('create');
      else if (have === s.hash) { push('unchanged'); ops.push({ key, run: () => s.hash }); continue; }
      else if (state[key] === have) push('update');
      else { push('conflict', state[key] ? 'changed outside ATLAS since the last sync' : 'a skill with this name exists that ATLAS did not write'); continue; }
      ops.push({ key, run: () => { copySkill(s, dest); return s.hash; } });
    }
    const wanted = new Set(input.skills.map((s) => path.join(root, s.name)));
    for (const [key, h] of Object.entries(state)) {
      if (!key.startsWith(`skill:${root}${path.sep}`)) continue;
      const dest = key.slice('skill:'.length);
      if (wanted.has(dest) || path.dirname(dest) !== root) continue;
      const name = path.basename(dest);
      const have = dirHash(dest);
      if (have === null) { forget.push(key); continue; }
      if (have !== h) { changes.push({ kind: 'skill', name, path: dest, action: 'conflict', reason: 'no longer in ATLAS, but changed outside ATLAS: left in place' }); continue; }
      changes.push({ kind: 'skill', name, path: dest, action: 'delete' });
      ops.push({ key, run: () => { rmSync(dest, { recursive: true, force: true }); return null; } });
    }
  }

  if (what.mcp && !loc.mcp) notes.push(loc.mcpWhyNot ?? 'MCP servers are not synced for this target.');
  if (what.mcp && loc.mcp) {
    const { format, file } = loc.mcp;
    const servers = input.mcp.filter((c) => c.enabled);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (format === 'codex-toml') planToml(file, text, servers, state, changes, ops);
    else planJson(format, file, text, servers, state, changes, ops, forget);
  }

  const id = sha(stable(changes));
  return { changes, notes, id, ops, forget };
}

function planJson(format: 'claude-json' | 'opencode-json', file: string, text: string | null, servers: McpServerConfig[], state: SyncState, changes: Change[], ops: Op[], forget: string[]) {
  const container = format === 'claude-json' ? 'mcpServers' : 'mcp';
  let doc: Record<string, unknown> = {};
  if (text !== null) {
    try { doc = JSON.parse(text) as Record<string, unknown>; }
    catch {
      for (const c of servers) changes.push({ kind: 'mcp', name: c.name, path: file, action: 'conflict', reason: 'the file is not plain JSON (comments?); ATLAS does not rewrite it' });
      return;
    }
  }
  const current = (doc[container] && typeof doc[container] === 'object' ? doc[container] : {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  const written: Record<string, string> = {};
  const render = entryFor(format);
  let dirty = false;
  for (const c of servers) {
    const key = `mcp:${file}#${c.name}`;
    const want = render(c);
    const push = (action: Action, reason?: string) => changes.push({ kind: 'mcp', name: c.name, path: file, action, ...(reason ? { reason } : {}) });
    if (!(c.name in current)) { push('create'); next[c.name] = want; written[key] = sha(stable(want)); dirty = true; continue; }
    const have = sha(stable(current[c.name]));
    if (have === sha(stable(want))) { push('unchanged'); written[key] = have; continue; }
    if (state[key] === have) { push('update'); next[c.name] = want; written[key] = sha(stable(want)); dirty = true; continue; }
    push('conflict', state[key] ? 'changed outside ATLAS since the last sync' : 'a server with this name exists that ATLAS did not write');
  }
  for (const [key, h] of Object.entries(state)) {
    if (!key.startsWith(`mcp:${file}#`)) continue;
    const name = key.slice(`mcp:${file}#`.length);
    if (servers.some((c) => c.name === name)) continue;
    if (!(name in current)) { forget.push(key); continue; }
    if (sha(stable(current[name])) !== h) { changes.push({ kind: 'mcp', name, path: file, action: 'conflict', reason: 'no longer in ATLAS, but changed outside ATLAS: left in place' }); continue; }
    changes.push({ kind: 'mcp', name, path: file, action: 'delete' });
    delete next[name];
    written[key] = '';
    dirty = true;
  }
  const keys = Object.keys(written);
  ops.push({
    key: `mcp-file:${file}`,
    run: () => {
      if (dirty) {
        const out = { ...(text === null && format === 'opencode-json' ? { $schema: 'https://opencode.ai/config.json' } : {}), ...doc, [container]: next };
        writeAtomic(file, `${JSON.stringify(out, null, 2)}\n`);
      }
      return null;
    },
  });
  for (const k of keys) ops.push({ key: k, run: () => written[k] || null });
}

function planToml(file: string, text: string | null, servers: McpServerConfig[], state: SyncState, changes: Change[], ops: Op[]) {
  const key = `mcp:${file}#block`;
  const src = text ?? '';
  const block = findBlock(src);
  const outside = tomlServerNames(block ? src.slice(0, block.start) + src.slice(block.end) : src);
  const inBlock = new Set(block ? tomlServerNames(block.body) : []);
  const take: McpServerConfig[] = [];
  for (const c of servers) {
    if (outside.includes(c.name)) { changes.push({ kind: 'mcp', name: c.name, path: file, action: 'conflict', reason: 'config.toml already defines this server outside ATLAS\'s block' }); continue; }
    take.push(c);
  }
  const body = take.map(codexTable).join('\n\n');
  if (block && state[key] !== sha(block.body) && block.body !== body) {
    for (const c of take) changes.push({ kind: 'mcp', name: c.name, path: file, action: 'conflict', reason: 'ATLAS\'s block in config.toml was edited outside ATLAS' });
    return;
  }
  for (const c of take) changes.push({ kind: 'mcp', name: c.name, path: file, action: !inBlock.has(c.name) ? 'create' : block!.body === body ? 'unchanged' : 'update' });
  for (const n of inBlock) if (!take.some((c) => c.name === n)) changes.push({ kind: 'mcp', name: n, path: file, action: 'delete' });
  if (block?.body === body) { ops.push({ key, run: () => sha(body) }); return; }
  if (!block && !take.length) return;
  ops.push({
    key,
    run: () => {
      let out: string;
      if (!take.length) out = (src.slice(0, block!.start) + src.slice(block!.end)).replace(/\n{3,}/g, '\n\n');
      else {
        const managed = `${BLOCK_BEGIN}\n${body}\n${BLOCK_END}`;
        out = block ? src.slice(0, block.start) + managed + src.slice(block.end) : `${src}${src && !src.endsWith('\n') ? '\n' : ''}${src ? '\n' : ''}${managed}\n`;
      }
      writeAtomic(file, out);
      return take.length ? sha(body) : null;
    },
  });
}

/** Write a plan. The plan is recomputed first; if it differs from the one the operator saw, nothing is written. */
export function apply(target: Target, input: SyncInput, state: SyncState, expectedId: string, what?: { skills: boolean; mcp: boolean }): { state: SyncState; changes: Change[] } {
  const p = plan(target, input, state, what);
  if (p.id !== expectedId) throw Object.assign(new Error('Files changed since the preview. Preview again before syncing.'), { kind: 'invalid_request' });
  const next = { ...state };
  for (const k of p.forget) delete next[k];
  for (const op of p.ops) {
    const h = op.run();
    if (op.key.startsWith('mcp-file:')) continue;
    if (h) next[op.key] = h; else delete next[op.key];
  }
  return { state: next, changes: p.changes };
}

/** MCP servers defined in a target's config that ATLAS did not write: candidates to bring into ATLAS. */
export function foreignServers(target: Target, state: SyncState): ForeignServer[] {
  const loc = locations(target);
  if (!loc.mcp || !existsSync(loc.mcp.file)) return [];
  let text = readFileSync(loc.mcp.file, 'utf8');
  if (loc.mcp.format === 'codex-toml') { const b = findBlock(text); if (b) text = text.slice(0, b.start) + text.slice(b.end); }
  const owned = new Set(Object.keys(state).filter((k) => k.startsWith(`mcp:${loc.mcp!.file}#`)).map((k) => k.split('#').pop()));
  return readForeign(loc.mcp.format, text).filter((s) => !owned.has(s.name));
}
