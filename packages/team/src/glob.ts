// Path patterns for team ownership, CODEOWNERS-like: `*` within a segment, `**` across segments, a trailing `/` or a
// bare directory name owns everything below it.
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let g = glob.trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A pattern without wildcards names a file or a directory (and everything inside it).
  const out = new RegExp(/[*?]/.test(g) ? `^${re}$` : `^${re}(?:/.*)?$`);
  cache.set(glob, out);
  return out;
}

export function matchesAny(file: string, globs: string[]): string[] {
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.filter((g) => globToRegExp(g).test(f));
}
