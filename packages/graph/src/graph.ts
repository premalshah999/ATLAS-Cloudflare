// A code graph of a repository (ADR 0024): files, the symbols they define, what they import, and who imports them.
// Agents query it instead of re-reading files, so the structure of the codebase stays available however much
// conversation was compacted away. Extraction is deterministic and dependency-free: line-oriented patterns per
// language. It is a map, not a compiler: it can miss dynamic imports and odd syntax, and it says so.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type Lang = 'ts' | 'js' | 'py' | 'go' | 'rs' | 'java' | 'kt' | 'rb' | 'other';
export interface GraphSymbol { name: string; kind: 'function' | 'class' | 'type' | 'const' | 'method' | 'module'; line: number; exported: boolean }
export interface GraphFile { path: string; lang: Lang; lines: number; symbols: GraphSymbol[]; imports: string[]; resolved: string[]; test: boolean }
export interface CodeGraph { version: 1; files: Record<string, GraphFile>; importedBy: Record<string, string[]>; builtAt: string; truncated: boolean }

const LANG: Record<string, Lang> = { '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.py': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.kt': 'kt', '.rb': 'rb' };
export const langOf = (p: string): Lang => LANG[path.extname(p).toLowerCase()] ?? 'other';
const SKIP = /(^|\/)(node_modules|\.git|dist|build|out|coverage|vendor|target|\.next|\.venv|venv|__pycache__)(\/|$)|\.min\.js$|\.d\.ts$/;
export const indexable = (p: string) => langOf(p) !== 'other' && !SKIP.test(p);
const isTest = (p: string) => /(^|\/)(tests?|__tests__|spec)\//.test(p) || /[._-](test|spec)\.[a-z]+$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p);

type Rule = { re: RegExp; kind: GraphSymbol['kind']; exported?: (m: RegExpExecArray, line: string) => boolean };
const RULES: Partial<Record<Lang, { symbols: Rule[]; imports: RegExp[] }>> = {
  ts: {
    symbols: [
      { re: /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', exported: (m) => !!m[1] },
      { re: /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', exported: (m) => !!m[1] },
      { re: /^\s*(export\s+)?(declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'type', exported: (m) => !!m[1] },
      { re: /^\s*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: 'const', exported: (m) => !!m[1] },
    ],
    imports: [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*import\s+['"]([^'"]+)['"]/g],
  },
  py: {
    symbols: [
      { re: /^(async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', exported: (m) => !m[2].startsWith('_') },
      { re: /^\s+(async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'method', exported: () => false },
      { re: /^class\s+([A-Za-z_]\w*)/, kind: 'class', exported: (m) => !m[1].startsWith('_') },
    ],
    imports: [/^\s*from\s+([.\w]+)\s+import\b/g, /^\s*import\s+([\w.]+)/g],
  },
  go: {
    symbols: [
      { re: /^func\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function', exported: (m) => /^[A-Z]/.test(m[2]) },
      { re: /^type\s+([A-Za-z_]\w*)/, kind: 'type', exported: (m) => /^[A-Z]/.test(m[1]) },
    ],
    imports: [/^\s*import\s+"([^"]+)"/g, /^\s*"([^"]+)"\s*$/g],
  },
  rs: {
    symbols: [
      { re: /^\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', exported: (m) => !!m[1] },
      { re: /^\s*(pub(\([^)]*\))?\s+)?(struct|enum|trait|type)\s+([A-Za-z_]\w*)/, kind: 'type', exported: (m) => !!m[1] },
      { re: /^\s*(pub(\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: 'module', exported: (m) => !!m[1] },
    ],
    imports: [/^\s*use\s+([\w:]+)/g],
  },
  java: {
    symbols: [
      { re: /^\s*(public\s+|protected\s+|private\s+)?(abstract\s+|final\s+|static\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)/, kind: 'class', exported: (m) => m[1]?.trim() === 'public' },
    ],
    imports: [/^\s*import\s+(static\s+)?([\w.]+)/g],
  },
  kt: {
    symbols: [
      { re: /^\s*(private\s+|internal\s+)?(data\s+|sealed\s+|abstract\s+|open\s+)*(class|interface|object)\s+([A-Za-z_]\w*)/, kind: 'class', exported: (m) => !m[1] },
      { re: /^\s*(private\s+|internal\s+)?(suspend\s+)?fun\s+([A-Za-z_]\w*)/, kind: 'function', exported: (m) => !m[1] },
    ],
    imports: [/^\s*import\s+([\w.]+)/g],
  },
  rb: {
    symbols: [
      { re: /^\s*def\s+(self\.)?([A-Za-z_]\w*[?!]?)/, kind: 'method', exported: () => true },
      { re: /^\s*(class|module)\s+([A-Z]\w*(::\w+)*)/, kind: 'class', exported: () => true },
    ],
    imports: [/^\s*require(_relative)?\s+['"]([^'"]+)['"]/g],
  },
};
RULES.js = RULES.ts;

/** Symbols and import specifiers of one file. */
export function extract(file: string, text: string): Pick<GraphFile, 'lang' | 'lines' | 'symbols' | 'imports'> {
  const lang = langOf(file);
  const r = RULES[lang];
  const lines = text.split('\n');
  const symbols: GraphSymbol[] = [];
  const imports = new Set<string>();
  if (r) {
    lines.forEach((line, i) => {
      if (line.length > 400) return;
      for (const s of r.symbols) {
        const m = s.re.exec(line);
        if (!m) continue;
        // The name is the last capture that is an identifier (earlier groups are modifiers and keywords).
        const name = [...m].slice(1).reverse().find((g) => g && /^[A-Za-z_$][\w$:?!]*$/.test(g));
        if (name) symbols.push({ name, kind: s.kind, line: i + 1, exported: s.exported?.(m, line) ?? false });
        break;
      }
      for (const re of r.imports) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) { const spec = m[m.length - 1]; if (spec) imports.add(spec); if (!re.global) break; }
      }
    });
  }
  return { lang, lines: lines.length, symbols: symbols.slice(0, 400), imports: [...imports].slice(0, 200) };
}

/** Resolve an import specifier to a file of the repository, when it names one. */
function resolveImport(from: string, spec: string, lang: Lang, paths: Set<string>): string | null {
  const dir = path.posix.dirname(from);
  const tryAll = (base: string, exts: string[]) => {
    for (const e of exts) { const p = path.posix.normalize(base + e); if (paths.has(p)) return p; }
    return null;
  };
  if (lang === 'ts' || lang === 'js') {
    if (!spec.startsWith('.')) return null;
    const base = path.posix.join(dir, spec);
    const stripped = base.replace(/\.(m|c)?js$/, '');
    return tryAll(base, ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js']) ?? tryAll(stripped, ['.ts', '.tsx', '.mts']);
  }
  if (lang === 'py') {
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    const rest = spec.slice(dots).replace(/\./g, '/');
    const base = dots ? path.posix.join(dir, '../'.repeat(dots - 1), rest) : rest;
    return tryAll(base, ['.py', '/__init__.py']);
  }
  if (lang === 'rb') return spec.startsWith('.') ? tryAll(path.posix.join(dir, spec), ['', '.rb']) : null;
  return null;
}

export function buildGraph(files: { path: string; text: string }[], truncated = false): CodeGraph {
  const paths = new Set(files.map((f) => f.path));
  const out: Record<string, GraphFile> = {};
  for (const f of files) {
    const e = extract(f.path, f.text);
    out[f.path] = { path: f.path, ...e, resolved: [...new Set(e.imports.map((s) => resolveImport(f.path, s, e.lang, paths)).filter((x): x is string => !!x))], test: isTest(f.path) };
  }
  const importedBy: Record<string, string[]> = {};
  for (const f of Object.values(out)) for (const r of f.resolved) (importedBy[r] ??= []).push(f.path);
  return { version: 1, files: out, importedBy, builtAt: new Date().toISOString(), truncated };
}

const MAX_FILES = 6000, MAX_BYTES = 512 * 1024;
/**
 * Build from a directory, given its file list (e.g. `git ls-files`). Asynchronous and chunked: it yields to the event
 * loop between batches, so a large repository is indexed alongside a running mission without stalling it.
 */
export async function buildFromDir(dir: string, list: string[]): Promise<CodeGraph> {
  const wanted = list.filter(indexable);
  const files: { path: string; text: string }[] = [];
  for (let i = 0; i < Math.min(wanted.length, MAX_FILES); i += 64) {
    const batch = wanted.slice(i, Math.min(i + 64, MAX_FILES));
    const read = await Promise.all(batch.map(async (p) => {
      try { const st = await fs.stat(path.join(dir, p)); if (!st.isFile() || st.size > MAX_BYTES) return null; return { path: p, text: await fs.readFile(path.join(dir, p), 'utf8') }; } catch { return null; }
    }));
    for (const r of read) if (r) files.push(r);
    await new Promise((res) => setImmediate(res));
  }
  return buildGraph(files, wanted.length > MAX_FILES);
}

/** The graph with some files replaced by their current text (a worktree's edits since the graph was built). */
export function withChanges(g: CodeGraph, changed: { path: string; text: string | null }[]): CodeGraph {
  const gone = new Set(changed.map((c) => c.path));
  const all: Record<string, GraphFile> = {};
  for (const f of Object.values(g.files)) if (!gone.has(f.path)) all[f.path] = f;
  // Only changed files are re-extracted; every file's imports are re-resolved against the new set of paths.
  for (const c of changed) if (c.text !== null && indexable(c.path)) all[c.path] = { path: c.path, ...extract(c.path, c.text), resolved: [], test: isTest(c.path) };
  const paths = new Set(Object.keys(all));
  for (const f of Object.values(all)) f.resolved = [...new Set(f.imports.map((s) => resolveImport(f.path, s, f.lang, paths)).filter((x): x is string => !!x))];
  const importedBy: Record<string, string[]> = {};
  for (const f of Object.values(all)) for (const r of f.resolved) (importedBy[r] ??= []).push(f.path);
  return { version: 1, files: all, importedBy, builtAt: new Date().toISOString(), truncated: g.truncated };
}

// ---- Queries (text an agent reads) ----

const loc = (f: string, l: number) => `${f}:${l}`;

export function overview(g: CodeGraph, limit = 25): string {
  const files = Object.values(g.files);
  const byLang = new Map<string, number>();
  for (const f of files) byLang.set(f.lang, (byLang.get(f.lang) ?? 0) + 1);
  const central = files.filter((f) => !f.test).map((f) => ({ f, n: g.importedBy[f.path]?.length ?? 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, limit);
  const entry = files.filter((f) => !f.test && !(g.importedBy[f.path]?.length) && f.resolved.length > 0).slice(0, 10);
  const tests = files.filter((f) => f.test);
  return [
    `Code graph: ${files.length} source files (${[...byLang].map(([l, n]) => `${n} ${l}`).join(', ')}), ${tests.length} test files${g.truncated ? '; truncated at the size limit' : ''}.`,
    central.length ? `Most imported (core modules):\n${central.map(({ f, n }) => `  ${f.path} ← ${n} file${n === 1 ? '' : 's'}; defines ${f.symbols.filter((s) => s.exported).slice(0, 6).map((s) => s.name).join(', ') || '—'}`).join('\n')}` : '',
    entry.length ? `Entry points (import others, imported by none):\n${entry.map((f) => `  ${f.path}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function describeFile(g: CodeGraph, p: string): string {
  const f = g.files[p];
  if (!f) return `${p} is not in the code graph (not a source file, or not indexed). Use list_files and read_file.`;
  const by = g.importedBy[p] ?? [];
  const tests = by.filter((x) => g.files[x]?.test);
  return [
    `${p} (${f.lang}, ${f.lines} lines${f.test ? ', test' : ''})`,
    `Defines: ${f.symbols.length ? f.symbols.slice(0, 40).map((s) => `${s.exported ? '' : '(local) '}${s.kind} ${s.name} @${s.line}`).join('; ') : 'nothing recognized'}`,
    `Imports (in this repository): ${f.resolved.join(', ') || 'none'}`,
    `External imports: ${f.imports.filter((i) => !i.startsWith('.')).slice(0, 20).join(', ') || 'none'}`,
    `Imported by: ${by.filter((x) => !tests.includes(x)).join(', ') || 'none'}`,
    `Tests that import it: ${tests.join(', ') || 'none found'}`,
  ].join('\n');
}

export function findSymbol(g: CodeGraph, name: string, limit = 30): string {
  const exact = Object.values(g.files).flatMap((f) => f.symbols.filter((s) => s.name === name).map((s) => ({ f, s })));
  const partial = exact.length ? [] : Object.values(g.files).flatMap((f) => f.symbols.filter((s) => s.name.toLowerCase().includes(name.toLowerCase())).map((s) => ({ f, s }))).slice(0, limit);
  const hits = exact.length ? exact : partial;
  if (!hits.length) return `No symbol named like "${name}" in the code graph.`;
  return [`${exact.length ? 'Defined' : `No exact match; similar names`}:`, ...hits.slice(0, limit).map(({ f, s }) => `  ${s.kind} ${s.name} at ${loc(f.path, s.line)}${s.exported ? ' (exported)' : ''}; imported by ${(g.importedBy[f.path] ?? []).slice(0, 8).join(', ') || 'nothing'}`)].join('\n');
}

export function related(g: CodeGraph, p: string, depth = 2): string {
  if (!g.files[p]) return `${p} is not in the code graph.`;
  const seen = new Map<string, number>([[p, 0]]);
  let frontier = [p];
  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const x of frontier) for (const y of [...(g.files[x]?.resolved ?? []), ...(g.importedBy[x] ?? [])]) if (!seen.has(y)) { seen.set(y, d); next.push(y); }
    frontier = next;
  }
  const rows = [...seen].filter(([x]) => x !== p).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, 60);
  return rows.length ? [`Files within ${depth} import steps of ${p}:`, ...rows.map(([x, d]) => `  ${d} · ${x}${g.files[x]?.test ? ' (test)' : ''}`)].join('\n') : `${p} imports and is imported by nothing in this repository.`;
}
