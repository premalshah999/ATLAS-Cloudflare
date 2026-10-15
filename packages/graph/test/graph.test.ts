// The code graph (ADR 0024): symbols and imports per language, resolution inside the repository, the queries an
// agent reads, incremental updates for a worktree's edits, and limits.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFromDir, buildGraph, describeFile, extract, findSymbol, overview, related, withChanges } from '../src';

const here = path.dirname(fileURLToPath(import.meta.url));

const repo = buildGraph([
  { path: 'src/util/slug.ts', text: "export function slugify(s: string) { return s; }\nconst local = 1;\nexport interface Opts { a: number }\n" },
  { path: 'src/api.ts', text: "import { slugify } from './util/slug';\nimport express from 'express';\nexport class Api {}\nexport const handler = () => slugify('x');\n" },
  { path: 'src/index.ts', text: "import { Api } from './api.js';\nexport default async function main() {}\n" },
  { path: 'test/slug.test.ts', text: "import { slugify } from '../src/util/slug';\n" },
  { path: 'app/models.py', text: "import os\nfrom .db import session\n\nclass User:\n    def save(self):\n        pass\n\ndef _private():\n    pass\n" },
  { path: 'app/db.py', text: 'session = None\n' },
  { path: 'cmd/main.go', text: 'package main\nimport "fmt"\nfunc Run() {}\ntype server struct{}\n' },
  { path: 'src/lib.rs', text: 'use std::io;\npub fn parse() {}\nstruct Inner;\npub mod net;\n' },
]);

describe('code graph (ADR 0024)', () => {
  it('extracts symbols with their kind, line and visibility, per language', () => {
    expect(extract('a.ts', "export async function load() {}\nclass Hidden {}\nexport type T = string;").symbols).toEqual([
      { name: 'load', kind: 'function', line: 1, exported: true }, { name: 'Hidden', kind: 'class', line: 2, exported: false }, { name: 'T', kind: 'type', line: 3, exported: true },
    ]);
    expect(repo.files['app/models.py'].symbols.map((s) => `${s.kind} ${s.name} ${s.exported}`)).toEqual(['class User true', 'method save false', 'function _private false']);
    expect(repo.files['cmd/main.go'].symbols.map((s) => `${s.name} ${s.exported}`)).toEqual(['Run true', 'server false']);
    expect(repo.files['src/lib.rs'].symbols.map((s) => `${s.kind} ${s.name} ${s.exported}`)).toEqual(['function parse true', 'type Inner false', 'module net true']);
  });

  it('resolves imports inside the repository, including .js specifiers for .ts files and relative Python modules', () => {
    expect(repo.files['src/api.ts'].resolved).toEqual(['src/util/slug.ts']);
    expect(repo.files['src/index.ts'].resolved).toEqual(['src/api.ts']);
    expect(repo.files['app/models.py'].resolved).toEqual(['app/db.py']);
    expect(repo.importedBy['src/util/slug.ts'].sort()).toEqual(['src/api.ts', 'test/slug.test.ts']);
    expect(repo.files['test/slug.test.ts'].test).toBe(true);
  });

  it('answers the questions an agent asks', () => {
    expect(describeFile(repo, 'src/util/slug.ts')).toMatch(/Defines: function slugify @1; \(local\) const local @2; type Opts @3[\s\S]*Imported by: src\/api.ts\nTests that import it: test\/slug.test.ts/);
    expect(describeFile(repo, 'src/api.ts')).toMatch(/External imports: express/);
    expect(findSymbol(repo, 'slugify')).toMatch(/function slugify at src\/util\/slug.ts:1 \(exported\); imported by src\/api.ts, test\/slug.test.ts/);
    expect(findSymbol(repo, 'slug')).toMatch(/No exact match; similar names/);
    expect(findSymbol(repo, 'nope')).toMatch(/No symbol named like/);
    expect(related(repo, 'src/index.ts')).toBe('Files within 2 import steps of src/index.ts:\n  1 · src/api.ts\n  2 · src/util/slug.ts');
    expect(overview(repo)).toMatch(/Most imported \(core modules\):\n {2}src\/util\/slug.ts ← 2 files; defines slugify, Opts/);
    expect(describeFile(repo, 'README.md')).toMatch(/not in the code graph/);
  });

  it('updates for a worktree\'s edits without re-reading unchanged files', () => {
    const g2 = withChanges(repo, [
      { path: 'src/util/format.ts', text: "export function format() {}\n" },
      { path: 'src/api.ts', text: "import { format } from './util/format';\nexport class Api {}\n" },
      { path: 'app/db.py', text: null },
    ]);
    expect(g2.files['src/api.ts'].resolved).toEqual(['src/util/format.ts']);
    expect(g2.importedBy['src/util/slug.ts']).toEqual(['test/slug.test.ts']);
    expect(g2.files['app/db.py']).toBeUndefined();
    expect(g2.files['app/models.py'].resolved).toEqual([]);
    expect(g2.files['cmd/main.go']).toBe(repo.files['cmd/main.go']);
  });

  it('indexes a real repository from its git file list, skipping dependencies and build output', async () => {
    const root = path.resolve(here, '../../../fixtures/sample-app');
    const list = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '.'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).concat(['node_modules/x/index.js', 'dist/bundle.js']);
    const g = await buildFromDir(root, list);
    expect(Object.keys(g.files)).toContain('src/slugify.js');
    expect(Object.keys(g.files).some((p) => p.startsWith('node_modules') || p.startsWith('dist'))).toBe(false);
    expect(g.importedBy['src/slugify.js']?.length).toBeGreaterThan(0);
  });
});
