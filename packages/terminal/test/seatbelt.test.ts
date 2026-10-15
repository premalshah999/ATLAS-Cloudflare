// The macOS Seatbelt profile is generated text; these checks run on every platform so a profile regression is
// caught on Linux CI too. The behavioural checks are in sandbox.test.ts (run on macOS).
import { describe, expect, it } from 'vitest';
import { seatbeltProfile } from '../src';

const base = {
  root: '/Users/dev/work/app', scratch: '/private/var/folders/ab/T/atlas-sbhome-1-x', network: false,
  readWrite: ['/Users/dev/work/app/.git/worktrees/t1'], readOnly: ['/Users/dev/.nvm/versions/node/v22'],
  home: '/Users/dev', userTemp: '/private/var/folders/ab/T',
};
const rule = (p: string, kind: string) => p.split('\n').find((l) => l.startsWith(`(deny ${kind}`))!;

describe('seatbeltProfile', () => {
  it('denies reads under every shared user-data location, except granted paths', () => {
    const p = seatbeltProfile(base);
    const data = rule(p, 'file-read-data');
    for (const loc of ['/Users/dev', '/Users', '/Volumes', '/private/var/folders/ab/T', '/private/tmp']) expect(data).toContain(`(subpath "${loc}")`);
    for (const ok of [base.root, base.scratch, ...base.readWrite, ...base.readOnly]) expect(data).toContain(`(require-not (subpath "${ok}"))`);
    // A sibling in the user temp dir (another mission, a test canary) is not granted.
    expect(data).not.toContain('(require-not (subpath "/private/var/folders/ab/T"))');
  });

  it('writes only the root, read-write paths and the private scratch directory', () => {
    const w = rule(seatbeltProfile(base), 'file-write*');
    expect(w.match(/require-not \(subpath "([^"]+)"\)/g)).toEqual([base.root, ...base.readWrite, base.scratch].map((x) => `require-not (subpath "${x}")`).concat('require-not (subpath "/dev/fd")'));
    expect(w).not.toContain('/private/var/folders/ab/T")');
  });

  it('parents of granted paths get metadata only, never data (realpath works, listing does not)', () => {
    const p = seatbeltProfile(base);
    const meta = rule(p, 'file-read-metadata');
    for (const parent of ['/Users', '/Users/dev', '/Users/dev/work', '/private/var/folders/ab/T']) expect(meta).toContain(`(require-not (literal "${parent}"))`);
    expect(rule(p, 'file-read-data')).not.toContain('literal "/Users/dev"');
  });

  it('network is denied unless granted', () => {
    expect(seatbeltProfile(base)).toContain('(deny network-outbound');
    expect(seatbeltProfile({ ...base, network: true })).not.toContain('network-outbound');
  });

  it('pseudo-terminals only for operator terminal sessions', () => {
    const plain = seatbeltProfile(base);
    expect(plain).not.toContain('/dev/ptmx');
    expect(plain).not.toContain('pseudo-tty');
    const pty = seatbeltProfile({ ...base, pty: true });
    expect(rule(pty, 'file-write*')).toContain('(require-not (literal "/dev/ptmx"))');
    expect(pty).toContain('(allow pseudo-tty)');
  });

  it('protected paths (the worktree git metadata, ADR 0031) are denied writes last, inside the writable root', () => {
    const protect = [`${base.root}/.git`, '/Users/dev/work/repo/.git/worktrees/t1'];
    const lines = seatbeltProfile({ ...base, protect }).split('\n');
    expect(lines.at(-1)).toBe(`(deny file-write* ${protect.map((p) => `(literal "${p}") (subpath "${p}")`).join(' ')})`);
    expect(seatbeltProfile(base).split('\n').filter((l) => l.startsWith('(deny file-write*'))).toHaveLength(1);
  });
});
