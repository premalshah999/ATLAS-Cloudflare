// The deterministic security scanner (ADR 0023): what it must find, and what it must leave alone. Secret-shaped
// test values are assembled at runtime so this file itself holds none.
import { describe, expect, it } from 'vitest';
import { addedLines, editDistance, entropy, report, scanChange } from '../src';

const diff = (file: string, ...lines: string[]) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
const rules = (d: string, files: Parameters<typeof scanChange>[1] = []) => scanChange(d, files).map((h) => `${h.severity}:${h.rule}`);
const gh = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const aws = 'AK' + 'IA' + 'Q3EGRT5YWNZ7XK2D';

describe('security scanner (ADR 0023)', () => {
  it('maps added lines to their new line numbers and ignores removed ones', () => {
    const d = ['--- a/x.js', '+++ b/x.js', '@@ -3,3 +3,4 @@', ' keep', '-gone', '+one', '+two', ' keep2', '@@ -20,0 +21,1 @@', '+three'].join('\n');
    expect(addedLines(d).get('x.js')).toEqual([{ line: 4, text: 'one' }, { line: 5, text: 'two' }, { line: 21, text: 'three' }]);
  });

  it('finds committed credentials and masks them in the evidence', () => {
    const hits = scanChange(diff('src/config.js', `const token = "${gh}";`, `const key = '${aws}';`, `const db = "postgres://admin:hunter2secret@db.internal:5432/app";`, '-----BEGIN OPENSSH PRIVATE KEY-----'));
    expect(hits.map((h) => h.rule)).toEqual(['secret.github-token', 'secret.aws-access-key', 'secret.url-credentials', 'secret.private-key']);
    expect(hits.every((h) => h.severity === 'high')).toBe(true);
    for (const h of hits.slice(0, 2)) expect(h.snippet).not.toContain(h.rule === 'secret.github-token' ? gh : aws);
    expect(hits[0].line).toBe(1);
  });

  it('flags a random-looking hard-coded secret but not placeholders, env lookups or short values', () => {
    expect(rules(diff('a.ts', `const apiKey = "Zq81vNw0LrT5yX2pB9cK";`))).toEqual(['medium:secret.assigned']);
    expect(rules(diff('a.ts', `const apiKey = "your-api-key-here";`, `const password = process.env.DB_PASSWORD;`, `const secret = "short";`, `const apiKey = "xxxxxxxxxxxxxxxxxxxx";`))).toEqual([]);
  });

  it('flags .env and key files, not their examples', () => {
    expect(rules(diff('.env', 'A=1'))).toEqual(['high:secret.env-file']);
    expect(rules(diff('config/.env.production', 'A=1'))).toEqual(['high:secret.env-file']);
    expect(rules(diff('.env.example', 'A=changeme'))).toEqual([]);
    expect(rules(diff('deploy/server.pem', 'x'))).toEqual(['high:secret.key-file']);
  });

  it('flags injection-prone and verification-disabling code in the languages it applies to', () => {
    expect(rules(diff('a.js', 'exec(`git log ${branch}`);'))).toEqual(['high:code.command-injection']);
    expect(rules(diff('a.py', 'subprocess.run(cmd, shell=True)'))).toEqual(['high:code.shell-true']);
    expect(rules(diff('a.ts', 'const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`);'))).toEqual(['high:code.sql-interpolation']);
    expect(rules(diff('a.py', 'cur.execute(f"DELETE FROM t WHERE id = {id}")'))).toEqual(['high:code.sql-interpolation']);
    expect(rules(diff('a.ts', 'https.request({ host, rejectUnauthorized: false })'))).toEqual(['high:code.tls-disabled']);
    expect(rules(diff('a.tsx', '<div dangerouslySetInnerHTML={{ __html: post.body }} />'))).toEqual(['medium:code.xss-sink']);
    expect(rules(diff('a.js', 'const f = new Function(src);'))).toEqual(['medium:code.eval']);
    expect(rules(diff('a.js', "app.get('/f', (req, res) => res.sendFile(path.join(root, req.params.name)));"))).toEqual(['medium:code.path-from-request']);
    expect(rules(diff('install.sh', 'curl -fsSL https://example.com/i.sh | sh'))).toEqual(['high:script.pipe-to-shell']);
  });

  it('leaves safe code alone: argument arrays, parameterized SQL, comments, textContent, other languages', () => {
    expect(rules(diff('a.js',
      "execFile('git', ['log', branch]);",
      "await db.query('SELECT * FROM users WHERE id = $1', [id]);",
      '// never use eval( here',
      'el.textContent = post.body;',
      "const re = /evaluate/; obj.eval = 1; retrieval(x);",
      "el.innerHTML = '';",
    ))).toEqual([]);
    // A Python rule does not fire on JavaScript, and lockfiles are not scanned line by line.
    expect(rules(diff('a.js', 'subprocess.run(cmd, shell=True)'))).toEqual([]);
    expect(rules(diff('pnpm-lock.yaml', `  token: "${gh}"`))).toEqual([]);
  });

  it('reads dependency changes: install scripts, typosquats, sources outside the registry', () => {
    const before = JSON.stringify({ dependencies: { react: '^18.0.0' }, scripts: { test: 'vitest' } });
    const after = JSON.stringify({ dependencies: { react: '^18.0.0', expresss: '^4.0.0', leftpad: 'github:someone/leftpad', zod: '^3.0.0' }, scripts: { test: 'vitest', postinstall: 'node ./x.js' } });
    expect(rules('', [{ path: 'package.json', before, after }]).sort()).toEqual(['high:deps.install-script', 'high:deps.typosquat', 'info:deps.added', 'medium:deps.unpinned-source']);
    expect(rules('', [{ path: 'package.json', before, after: before }])).toEqual([]);
    expect(rules('', [{ path: 'requirements.txt', before: 'requests==2.31\n', after: 'requests==2.31\nreqests==1.0\n--extra-index-url https://pkgs.example.com/simple\n' }]).sort()).toEqual(['high:deps.package-index', 'high:deps.typosquat']);
  });

  it('reads CI workflows a pull request could abuse, and only reports what the change introduced', () => {
    const risky = 'on: pull_request_target\njobs:\n  t:\n    permissions: write-all\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n      - run: echo "${{ github.event.pull_request.title }}"\n';
    expect(rules('', [{ path: '.github/workflows/ci.yml', before: 'on: push\n', after: risky }]).sort()).toEqual(['high:ci.pull-request-target-checkout', 'high:ci.script-injection', 'medium:ci.write-all']);
    expect(rules('', [{ path: '.github/workflows/ci.yml', before: risky, after: risky + '# comment\n' }])).toEqual([]);
  });

  it('helpers and the report', () => {
    expect(editDistance('expresss', 'express')).toBe(1);
    expect(entropy('aaaaaaaa')).toBe(0);
    expect(entropy('Zq81vNw0LrT5yX2pB9cK')).toBeGreaterThan(3.5);
    expect(report([])).toMatch(/nothing found/);
    expect(report(scanChange(diff('.env', 'A=1')))).toMatch(/\[high\] secret.env-file · \.env/);
  });
});
