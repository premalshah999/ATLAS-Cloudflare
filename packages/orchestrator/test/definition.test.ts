// definitionChange against real git repositories, covering the misses found by the independent review (finding J).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sampleRepo, sh } from '../../../tests/helpers';
import { definitionChange } from '../src/definition';

function repoWith(edit: (root: string) => void) {
  const root = sampleRepo();
  const base = sh(root, 'git', ['rev-parse', 'HEAD']);
  edit(root);
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['-c', 'core.quotepath=true', 'commit', '-qm', 'change']);
  return { root, base, commit: sh(root, 'git', ['rev-parse', 'HEAD']) };
}
const pkg = (root: string, f: (p: any) => void) => { const file = path.join(root, 'package.json'); const p = JSON.parse(readFileSync(file, 'utf8')); f(p); writeFileSync(file, JSON.stringify(p, null, 2)); };

describe('definitionChange', () => {
  it('follows fan-out runners (run-s test:*) to the scripts they run', async () => {
    const root = sampleRepo();
    pkg(root, (p) => { p.scripts.test = 'run-s test:*'; p.scripts['test:unit'] = 'node --test'; });
    sh(root, 'git', ['commit', '-qam', 'fanout']);
    const base = sh(root, 'git', ['rev-parse', 'HEAD']);
    pkg(root, (p) => { p.scripts['test:unit'] = 'node -e 0'; });
    sh(root, 'git', ['commit', '-qam', 'neuter']);
    const d = await definitionChange(root, base, sh(root, 'git', ['rev-parse', 'HEAD']));
    expect(d.changed).toContain('package.json#scripts.test:unit');
  });

  it('sees runner config in any directory, nested package.json files and conftest.py', async () => {
    const { root, base, commit } = repoWith((r) => {
      writeFileSync(path.join(r, 'jest.config.json'), '{"testMatch":[]}');
      mkdirSync(path.join(r, 'packages/a'), { recursive: true });
      writeFileSync(path.join(r, 'packages/a/package.json'), JSON.stringify({ name: 'a', scripts: { test: 'exit 0' } }));
      writeFileSync(path.join(r, 'conftest.py'), 'collect_ignore_glob = ["*"]\n');
    });
    const d = await definitionChange(root, base, commit);
    expect(d.changed).toEqual(expect.arrayContaining(['jest.config.json', 'conftest.py']));
    // A new workspace package's test script is an addition (not weakening), but it is visible.
    expect(d.added).toContain('packages/a/package.json#scripts.test');
  });

  it('reports deleted tests with non-ASCII names (NUL-separated parsing)', async () => {
    const { root, base, commit } = (() => {
      const r = sampleRepo();
      mkdirSync(path.join(r, 'test/ü'), { recursive: true });
      writeFileSync(path.join(r, 'test/ü/a.test.js'), "import { test } from 'node:test';\ntest('x', () => {});\n");
      sh(r, 'git', ['add', '-A']); sh(r, 'git', ['commit', '-qm', 'add']);
      const b = sh(r, 'git', ['rev-parse', 'HEAD']);
      rmSync(path.join(r, 'test/ü/a.test.js'));
      sh(r, 'git', ['add', '-A']); sh(r, 'git', ['commit', '-qm', 'rm']);
      return { root: r, base: b, commit: sh(r, 'git', ['rev-parse', 'HEAD']) };
    })();
    const d = await definitionChange(root, base, commit);
    expect(d.deletedTests).toEqual(['test/ü/a.test.js']);
  });

  it('the approval hash follows content: same tree → same hash, different content → different hash', async () => {
    const a = repoWith((r) => rmSync(path.join(r, 'test/slugify.test.js')));
    const d1 = await definitionChange(a.root, a.base, a.commit);
    // Re-commit the same tree (as re-integration does): same hash.
    sh(a.root, 'git', ['commit', '-q', '--allow-empty', '-m', 'same tree']);
    const d2 = await definitionChange(a.root, a.base, sh(a.root, 'git', ['rev-parse', 'HEAD']));
    expect(d2.hash).toBe(d1.hash);
    // Different code with the same deletion: different hash.
    writeFileSync(path.join(a.root, 'src/slugify.js'), "export const slugify = () => 'nope';\n");
    sh(a.root, 'git', ['commit', '-qam', 'break']);
    const d3 = await definitionChange(a.root, a.base, sh(a.root, 'git', ['rev-parse', 'HEAD']));
    expect(d3.hash).not.toBe(d1.hash);
  });

  it('fails loudly when git cannot answer (no silent empty result)', async () => {
    const root = sampleRepo();
    await expect(definitionChange(root, 'deadbeef'.repeat(5), sh(root, 'git', ['rev-parse', 'HEAD']))).rejects.toThrow(/git .* failed/);
  });
});
