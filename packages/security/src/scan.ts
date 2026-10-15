// The deterministic half of ATLAS's security engineer (ADR 0023). It reads only what a change adds:
// - the added lines of a unified diff;
// - the before and after of manifests and CI workflows.
// It reports what it can show from text alone: leaked secrets, injection-prone calls, disabled TLS checks, risky
// dependency changes, and CI configuration a pull request could abuse. It runs nothing and fetches nothing.
// A match is observed by ATLAS, not claimed by a model, and it carries the matching line (with secrets masked) as
// evidence.

export type Severity = 'high' | 'medium' | 'low' | 'info';
export interface SecurityHit {
  rule: string;
  severity: Severity;
  file: string;
  line: number | null;
  title: string;
  detail: string;
  recommendation: string;
  /** The matching text with any secret masked. */
  snippet: string;
}
export interface FileChange { path: string; before: string | null; after: string | null }

// ---- Unified diff → added lines ----

export function addedLines(diff: string): Map<string, { line: number; text: string }[]> {
  const out = new Map<string, { line: number; text: string }[]>();
  let file: string | null = null;
  let n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !out.has(file)) out.set(file, []);
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { n = Number(h[1]); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) { out.get(file)!.push({ line: n, text: raw.slice(1) }); n++; }
    else if (raw.startsWith(' ')) n++;
    // '-' lines do not advance the new file's numbering.
  }
  return out;
}

// ---- Secrets ----

const mask = (s: string) => s.length <= 8 ? '********' : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;

const SECRETS: { rule: string; title: string; re: RegExp }[] = [
  { rule: 'secret.aws-access-key', title: 'AWS access key ID', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'secret.github-token', title: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { rule: 'secret.slack-token', title: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'secret.stripe-key', title: 'Stripe live secret key', re: /\b(sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
  { rule: 'secret.google-api-key', title: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'secret.anthropic-key', title: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { rule: 'secret.openai-key', title: 'OpenAI API key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { rule: 'secret.private-key', title: 'Private key', re: /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY( BLOCK)?-----/ },
  { rule: 'secret.url-credentials', title: 'Password in a URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]{6,}@[^\s'"]+/i },
];

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const f = new Map<string, number>();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

const PLACEHOLDER = /^(x+|\*+|changeme|change-me|example|your[-_a-z]*|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|process\.env\.|os\.environ|todo|test|dummy|fake|sample)/i;
const ASSIGNED_SECRET = /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i;

function scanSecrets(file: string, lines: { line: number; text: string }[]): SecurityHit[] {
  const hits: SecurityHit[] = [];
  for (const { line, text } of lines) {
    let matched = false;
    for (const s of SECRETS) {
      const m = s.re.exec(text);
      if (!m) continue;
      matched = true;
      hits.push({
        rule: s.rule, severity: 'high', file, line, title: `${s.title} committed`, snippet: text.replace(m[0], mask(m[0])).trim().slice(0, 200),
        detail: `An added line contains what looks like a ${s.title.toLowerCase()}. Anything committed is readable by everyone with access to the repository, and stays in its history.`,
        recommendation: 'Remove it from the change, revoke or rotate the credential, and read it from the environment or a secret store at runtime.',
      });
      break;
    }
    if (matched) continue;
    const a = ASSIGNED_SECRET.exec(text);
    if (a && !PLACEHOLDER.test(a[2]) && entropy(a[2]) >= 3.5) {
      hits.push({
        rule: 'secret.assigned', severity: 'medium', file, line, title: `Hard-coded ${a[1].toLowerCase()}`, snippet: text.replace(a[2], mask(a[2])).trim().slice(0, 200),
        detail: `A ${a[1].toLowerCase()} is assigned a literal, random-looking value.`,
        recommendation: 'Read it from configuration or the environment; keep real values out of the repository.',
      });
    }
  }
  return hits;
}

// ---- Dangerous code ----

const CODE: { rule: string; severity: Severity; files: RegExp; re: RegExp; title: string; detail: string; recommendation: string }[] = [
  { rule: 'code.command-injection', severity: 'high', files: /\.(c|m)?[jt]sx?$/, re: /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|["'][^"']*["']\s*\+)/,
    title: 'Shell command built from a string', detail: 'child_process exec runs its argument through a shell; interpolated values can inject commands.', recommendation: 'Use execFile/spawn with an argument array and no shell.' },
  { rule: 'code.shell-true', severity: 'high', files: /\.py$/, re: /\bsubprocess\.\w+\([^)]*shell\s*=\s*True/,
    title: 'subprocess with shell=True', detail: 'Passing a command string to a shell lets interpolated values inject commands.', recommendation: 'Pass an argument list and leave shell=False.' },
  { rule: 'code.os-system', severity: 'medium', files: /\.py$/, re: /\bos\.(system|popen)\s*\(/,
    title: 'os.system / os.popen', detail: 'Runs its argument through a shell.', recommendation: 'Use subprocess.run with an argument list.' },
  { rule: 'code.eval', severity: 'medium', files: /\.(c|m)?[jt]sx?$/, re: /(^|[^.\w])(eval\s*\(|new\s+Function\s*\()/,
    title: 'Dynamic code evaluation', detail: 'eval and new Function run strings as code; with any outside input this is code injection.', recommendation: 'Parse data (JSON.parse) or dispatch through a fixed table instead.' },
  { rule: 'code.eval', severity: 'medium', files: /\.py$/, re: /(^|[^.\w])(eval|exec)\s*\(/,
    title: 'Dynamic code evaluation', detail: 'eval/exec run strings as code.', recommendation: 'Use ast.literal_eval for literals, or a fixed dispatch table.' },
  { rule: 'code.sql-interpolation', severity: 'high', files: /\.(c|m)?[jt]sx?$|\.py$/, re: /(`|f["'])[^`"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`"']*(\$\{|\{[a-zA-Z_])/i,
    title: 'SQL built by string interpolation', detail: 'Interpolating values into SQL text allows SQL injection.', recommendation: 'Use parameterized queries (placeholders with bound values).' },
  { rule: 'code.tls-disabled', severity: 'high', files: /\.(c|m)?[jt]sx?$|\.py$|\.ya?ml$|\.env/, re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["']?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/,
    title: 'TLS certificate verification disabled', detail: 'Connections accept any certificate, so anyone on the path can read and change them.', recommendation: 'Keep verification on; add the needed CA instead.' },
  { rule: 'code.xss-sink', severity: 'medium', files: /\.(c|m)?[jt]sx?$|\.html?$|\.vue$|\.svelte$/, re: /dangerouslySetInnerHTML|\.innerHTML\s*=(?!\s*["'`]\s*["'`])|\bv-html=|\{@html /,
    title: 'HTML injected without escaping', detail: 'Assigning markup from data renders any script it contains (XSS).', recommendation: 'Render text (textContent), or sanitize with a vetted sanitizer first.' },
  { rule: 'code.unsafe-deserialization', severity: 'medium', files: /\.py$/, re: /\bpickle\.loads?\(|\byaml\.load\((?![^)]*SafeLoader)/,
    title: 'Unsafe deserialization', detail: 'pickle and yaml.load without SafeLoader execute code embedded in the data.', recommendation: 'Use json, or yaml.safe_load.' },
  { rule: 'code.weak-hash', severity: 'low', files: /\.(c|m)?[jt]sx?$|\.py$/, re: /createHash\(\s*["'](md5|sha1)["']\)|hashlib\.(md5|sha1)\(/,
    title: 'Weak hash function', detail: 'MD5 and SHA-1 are broken for security purposes (fine for non-security checksums).', recommendation: 'Use SHA-256, and a password hash (argon2, scrypt, bcrypt) for passwords.' },
  { rule: 'code.insecure-random', severity: 'low', files: /\.(c|m)?[jt]sx?$/, re: /(token|secret|password|nonce|salt|session)\w*\s*=.*Math\.random\(/i,
    title: 'Math.random for a secret value', detail: 'Math.random is predictable.', recommendation: 'Use crypto.randomBytes or crypto.randomUUID.' },
  { rule: 'code.cors-any', severity: 'low', files: /\.(c|m)?[jt]sx?$|\.py$/, re: /Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']|origin\s*:\s*["']\*["']/,
    title: 'CORS allows any origin', detail: 'Any site can read responses from this endpoint in a browser.', recommendation: 'List the origins that need access.' },
  { rule: 'code.path-from-request', severity: 'medium', files: /\.(c|m)?[jt]sx?$/, re: /(readFile|createReadStream|sendFile|path\.(join|resolve))\s*\([^)]*\breq\.(params|query|body)\b/,
    title: 'File path from the request', detail: 'A path built from request input can escape the intended directory (path traversal).', recommendation: 'Resolve the path and check it stays inside the allowed root, or map ids to files.' },
  { rule: 'script.pipe-to-shell', severity: 'high', files: /./, re: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
    title: 'Downloaded script piped to a shell', detail: 'Runs whatever the server returns, unreviewed and unpinned.', recommendation: 'Download a pinned version, verify its checksum, then run it.' },
  { rule: 'script.world-writable', severity: 'medium', files: /./, re: /\bchmod\s+(-R\s+)?(0?777|a\+w)\b/,
    title: 'World-writable permissions', detail: 'Any local user or process can modify these files.', recommendation: 'Grant the narrowest permission that works.' },
];

function scanCode(file: string, lines: { line: number; text: string }[]): SecurityHit[] {
  const hits: SecurityHit[] = [];
  for (const r of CODE) {
    if (!r.files.test(file)) continue;
    for (const { line, text } of lines) {
      const t = text.trim();
      if (/^(\/\/|#|\*|\/\*)/.test(t)) continue; // comments
      if (!r.re.test(text)) continue;
      hits.push({ rule: r.rule, severity: r.severity, file, line, title: r.title, detail: r.detail, recommendation: r.recommendation, snippet: t.slice(0, 200) });
    }
  }
  return hits;
}

function sensitiveFile(file: string): SecurityHit | null {
  const base = file.split('/').pop()!;
  if (/^\.env(\.(?!example$|sample$|template$|dist$)[\w-]+)?$/.test(base)) {
    return { rule: 'secret.env-file', severity: 'high', file, line: null, title: 'Environment file committed', snippet: base, detail: '.env files hold local secrets and configuration.', recommendation: 'Remove it, add it to .gitignore, and commit a .env.example with placeholders.' };
  }
  if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa)$|\.(pem|p12|pfx|key|keystore|jks)$/i.test(base)) {
    return { rule: 'secret.key-file', severity: 'high', file, line: null, title: 'Key or certificate store committed', snippet: base, detail: 'Private keys and keystores grant whatever they protect.', recommendation: 'Remove it, rotate the key, and load it from a secret store at runtime.' };
  }
  return null;
}

// ---- Manifests and CI ----

// Widely used package names: a new dependency one edit away from one of these is a classic typosquat.
const POPULAR = ['react', 'react-dom', 'express', 'lodash', 'axios', 'chalk', 'commander', 'debug', 'request', 'moment', 'webpack', 'typescript', 'eslint', 'prettier', 'jest', 'vitest', 'next', 'vue', 'dotenv', 'uuid', 'yargs', 'cors', 'body-parser', 'mongoose', 'redis', 'pg', 'mysql', 'sequelize', 'jsonwebtoken', 'bcrypt', 'nodemailer', 'socket.io', 'ws', 'zod', 'rxjs', 'classnames', 'underscore', 'async', 'glob', 'minimist', 'colors', 'electron', 'vite', 'esbuild', 'babel', 'requests', 'numpy', 'pandas', 'flask', 'django', 'boto3', 'urllib3', 'setuptools', 'pyyaml', 'cryptography', 'jinja2', 'pillow', 'scipy', 'matplotlib', 'pytest'];

export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function json(s: string | null): Record<string, any> | null { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function packageJson(c: FileChange): SecurityHit[] {
  const before = json(c.before) ?? {}, after = json(c.after);
  if (!after) return [];
  const hits: SecurityHit[] = [];
  const deps = (p: Record<string, any>) => ({ ...p.dependencies, ...p.devDependencies, ...p.optionalDependencies, ...p.peerDependencies }) as Record<string, string>;
  const was = deps(before), now = deps(after);
  const added = Object.keys(now).filter((n) => !(n in was));
  for (const n of added) {
    const spec = String(now[n]);
    const near = POPULAR.find((p) => p !== n && n.length > 3 && editDistance(n, p) === 1);
    if (near) hits.push({ rule: 'deps.typosquat', severity: 'high', file: c.path, line: null, title: `Dependency "${n}" is one letter from "${near}"`, snippet: `"${n}": "${spec}"`, detail: 'Names one edit away from a popular package are a common way to slip in malicious code.', recommendation: `Check that "${n}" is the package you meant; "${near}" is the well-known one.` });
    if (/^(git\+|git:|github:|https?:|file:)|\.tgz$/.test(spec) || /^[\w-]+\/[\w.-]+(#.*)?$/.test(spec)) {
      hits.push({ rule: 'deps.unpinned-source', severity: 'medium', file: c.path, line: null, title: `Dependency "${n}" comes from outside the registry`, snippet: `"${n}": "${spec}"`, detail: 'A git URL, tarball or local path bypasses the registry and its version pinning; the content can change under the same reference.', recommendation: 'Use a published version, or pin to a commit SHA and review it.' });
    }
  }
  if (added.length) hits.push({ rule: 'deps.added', severity: 'info', file: c.path, line: null, title: `New dependencies: ${added.slice(0, 10).join(', ')}${added.length > 10 ? `, +${added.length - 10}` : ''}`, snippet: added.join(', ').slice(0, 200), detail: 'New code from outside the project will run in development, CI and possibly production.', recommendation: 'Confirm each is needed, maintained and licensed compatibly.' });
  for (const s of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
    const a = after.scripts?.[s], b = before.scripts?.[s];
    if (a && a !== b) hits.push({ rule: 'deps.install-script', severity: 'high', file: c.path, line: null, title: `Install-time script "${s}" ${b ? 'changed' : 'added'}`, snippet: `"${s}": ${JSON.stringify(a).slice(0, 160)}`, detail: 'It runs automatically on every install, on every developer machine and CI runner.', recommendation: 'Avoid install scripts; if one is needed, keep it minimal and reviewed.' });
  }
  return hits;
}

function pythonDeps(c: FileChange): SecurityHit[] {
  const hits: SecurityHit[] = [];
  const names = (s: string | null) => new Set((s ?? '').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#') && !l.startsWith('-')).map((l) => l.split(/[<>=!~;\s[]/)[0]));
  const was = names(c.before), now = names(c.after);
  for (const n of now) {
    if (was.has(n)) continue;
    const near = POPULAR.find((p) => p !== n && n.length > 3 && editDistance(n, p) === 1);
    if (near) hits.push({ rule: 'deps.typosquat', severity: 'high', file: c.path, line: null, title: `Dependency "${n}" is one letter from "${near}"`, snippet: n, detail: 'Names one edit away from a popular package are a common way to slip in malicious code.', recommendation: `Check that "${n}" is the package you meant.` });
  }
  if (/--(extra-)?index-url/.test(c.after ?? '') && !/--(extra-)?index-url/.test(c.before ?? '')) {
    hits.push({ rule: 'deps.package-index', severity: 'high', file: c.path, line: null, title: 'Package index changed', snippet: (/.*--(extra-)?index-url.*/.exec(c.after ?? '')?.[0] ?? '').slice(0, 200), detail: 'An extra or replaced index can serve a different package under a trusted name (dependency confusion).', recommendation: 'Keep the default index, or pin hashes (--require-hashes).' });
  }
  return hits;
}

function workflow(c: FileChange): SecurityHit[] {
  const after = c.after ?? '', before = c.before ?? '';
  const hits: SecurityHit[] = [];
  const newly = (re: RegExp) => re.test(after) && !re.test(before);
  if (/\bpull_request_target\b/.test(after) && /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(sha|ref)/.test(after) && (newly(/\bpull_request_target\b/) || newly(/github\.event\.pull_request\.head\.(sha|ref)/))) {
    hits.push({ rule: 'ci.pull-request-target-checkout', severity: 'high', file: c.path, line: null, title: 'pull_request_target checks out the pull request', snippet: 'pull_request_target + checkout of the PR head', detail: 'The job runs untrusted pull request code with the base repository\'s secrets and a write token.', recommendation: 'Use pull_request for untrusted code, or never check out the PR head in pull_request_target.' });
  }
  const injected = /run:[^\n]*\$\{\{\s*github\.event\.(issue|pull_request|comment|review|head_commit|discussion)[\w.]*\.(title|body|message|head_ref|label|name)\b/;
  if (newly(injected) || (injected.test(after) && after.split(injected).length > before.split(injected).length)) {
    hits.push({ rule: 'ci.script-injection', severity: 'high', file: c.path, line: null, title: 'Untrusted event text interpolated into a run step', snippet: (injected.exec(after)?.[0] ?? '').slice(0, 200), detail: 'Titles, bodies and branch names are attacker-controlled; ${{ }} pastes them into the shell script.', recommendation: 'Pass them through env: and quote the variable in the script.' });
  }
  if (newly(/permissions:\s*write-all/)) hits.push({ rule: 'ci.write-all', severity: 'medium', file: c.path, line: null, title: 'Workflow token gets every write permission', snippet: 'permissions: write-all', detail: 'Any step, including third-party actions, can push, publish and change settings.', recommendation: 'Grant only the permissions the job needs.' });
  return hits;
}

/** Scan a change: its unified diff (for added lines) and the before/after of files that need whole-file reading. */
export function scanChange(diff: string, files: FileChange[] = []): SecurityHit[] {
  const hits: SecurityHit[] = [];
  const added = addedLines(diff);
  for (const [file, lines] of added) {
    const s = sensitiveFile(file);
    if (s) hits.push(s);
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/.test(file)) continue;
    hits.push(...scanSecrets(file, lines), ...scanCode(file, lines));
  }
  for (const c of files) {
    if (/(^|\/)package\.json$/.test(c.path)) hits.push(...packageJson(c));
    else if (/(^|\/)requirements[\w.-]*\.txt$/.test(c.path)) hits.push(...pythonDeps(c));
    else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(c.path)) hits.push(...workflow(c));
  }
  // One report per rule and location.
  const seen = new Set<string>();
  return hits.filter((h) => { const k = `${h.rule}:${h.file}:${h.line}:${h.title}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Files whose whole before/after the scanner reads. */
export const WHOLE_FILE = /(^|\/)package\.json$|(^|\/)requirements[\w.-]*\.txt$|^\.github\/workflows\/[^/]+\.ya?ml$/;

export function report(hits: SecurityHit[]): string {
  if (!hits.length) return 'Security scan: nothing found in the added code, dependencies or CI configuration.';
  const order: Severity[] = ['high', 'medium', 'low', 'info'];
  return [`Security scan: ${hits.length} result${hits.length === 1 ? '' : 's'} (${order.map((s) => `${hits.filter((h) => h.severity === s).length} ${s}`).join(', ')})`, '',
    ...[...hits].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)).map((h) => `[${h.severity}] ${h.rule} · ${h.file}${h.line ? `:${h.line}` : ''}\n  ${h.title}\n  ${h.snippet}\n  ${h.detail}\n  Fix: ${h.recommendation}`)].join('\n');
}
