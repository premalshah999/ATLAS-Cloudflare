// HTML to readable text for agents (ADR 0030): headings, paragraphs, lists, links with their targets, code blocks and
// table cells, without scripts, styles or markup. Small and dependency-free; it reads documentation pages, not every
// page perfectly.

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·', times: '×', rarr: '→', larr: '←', para: '¶', sect: '§', deg: '°' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
};

export interface Readable { title: string; text: string }

export function htmlToText(html: string, baseUrl: string): Readable {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  const title = decodeEntities((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  s = s.replace(/<(script|style|noscript|template|svg|iframe|object|canvas|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // The page's main content when it marks it; navigation and footers are mostly noise for an agent.
  const main = s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? s.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  if (main && main.replace(/<[^>]*>/g, '').trim().length > 200) s = main;
  else s = s.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? s;
  s = s.replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, (m) => (m.replace(/<[^>]*>/g, '').trim().length > 2000 ? m : ' '));

  // Code blocks keep their line breaks: set aside, restored at the end.
  const blocks: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    blocks.push(decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/\n+$/, ''));
    return `\n\uE000${blocks.length - 1}\uE000\n`;
  });
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const label = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const href = attr(`<a${attrs}>`, 'href');
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) return label;
    let abs = href;
    try { abs = new URL(href, baseUrl).toString(); } catch { /* keep as written */ }
    return label ? `[${label}](${abs})` : '';
  });
  s = s.replace(/<img\b[^>]*>/gi, (tag) => { const alt = attr(tag, 'alt'); return alt ? ` [image: ${alt}] ` : ' '; });
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${inner.replace(/<[^>]*>/g, '')}\``);
  s = s.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(t[dh])\b[^>]*>/gi, ' | ').replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/?(p|div|section|header|ul|ol|dl|dt|dd|table|tbody|thead|blockquote|figure|figcaption|form|fieldset|details|summary|hr)\b[^>]*>/gi, '\n\n');
  s = decodeEntities(s.replace(/<[^>]*>/g, ' '));
  s = s.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  s = s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => `\`\`\`\n${blocks[Number(i)]}\n\`\`\``);
  return { title, text: s };
}
