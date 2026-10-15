// The page as an agent reads it (ADR 0027): interactive elements, headings, landmarks and text, in document order,
// each with a ref ("e12") that later steps can target. Refs live in a page-side map, never in the DOM, so taking a
// snapshot does not change the app. A navigation or reload drops them; a stale ref is refused, not guessed.

/** Runs in the page. Kept as source text so the package needs no DOM typings and nothing is transpiled into it. */
export const SNAPSHOT_SCRIPT = `(scope) => {
  const MAX = 400;
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { lines: [], count: 0, truncated: false, missing: true };
  const refs = new Map();
  window.__atlasRefs = refs;
  let n = 0;
  const lines = [];
  let truncated = false;
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const cut = (s, k) => (s.length > k ? s.slice(0, k - 1) + '…' : s);
  const shown = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || el.hidden) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  };
  const sized = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const label = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((x) => x.innerText).join(' '); if (clean(t)) return clean(t); }
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    if (el.labels && el.labels.length) return clean(Array.from(el.labels).map((l) => l.innerText).join(' '));
    for (const a of ['placeholder', 'title', 'alt']) if (el.getAttribute(a)) return clean(el.getAttribute(a));
    return '';
  };
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox' };
  const role = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'input') { const ty = (el.getAttribute('type') || 'text').toLowerCase(); return ty === 'hidden' ? null : INPUT_ROLE[ty] || 'textbox'; }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'combobox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'img') return 'img';
    if (t === 'nav') return 'navigation';
    if (t === 'main') return 'main';
    if (t === 'form') return 'form';
    if (t === 'dialog') return 'dialog';
    if (t === 'table') return 'table';
    if (t === 'li') return 'listitem';
    if (el.isContentEditable) return 'textbox';
    return null;
  };
  const INTERACTIVE = new Set(['link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'slider', 'switch', 'tab', 'menuitem', 'option']);
  const LANDMARK = new Set(['navigation', 'main', 'form', 'dialog', 'table', 'banner', 'contentinfo', 'region', 'alert', 'status']);
  const add = (depth, text, el) => {
    if (lines.length >= MAX) { truncated = true; return null; }
    const ref = 'e' + (++n);
    refs.set(ref, el);
    lines.push('  '.repeat(depth) + '- ' + text + ' [ref=' + ref + ']');
    return ref;
  };
  const ownText = (el) => clean(Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' '));
  const walk = (el, depth) => {
    for (const child of Array.from(el.children)) {
      if (truncated) return;
      if (!shown(child)) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
      const r = role(child);
      if (r && INTERACTIVE.has(r)) {
        if (!sized(child)) continue;
        let text = r + ' "' + cut(label(child) || clean(child.innerText || child.value), 80) + '"';
        if (r === 'link') { try { const u = new URL(child.href, location.href); text += ' → ' + (u.origin === location.origin ? u.pathname + u.search + u.hash : u.href); } catch (e) {} }
        if ((r === 'textbox' || r === 'searchbox') && 'value' in child) text += ' value="' + cut(clean(child.value), 80) + '"';
        if (r === 'checkbox' || r === 'radio' || r === 'switch') text += child.checked ? ' checked' : ' unchecked';
        if (r === 'combobox' && child.tagName === 'SELECT') text += ' selected="' + cut(clean(child.selectedOptions[0] ? child.selectedOptions[0].text : ''), 60) + '" options=' + JSON.stringify(Array.from(child.options).slice(0, 15).map((o) => cut(clean(o.text), 40)));
        if (child.disabled || child.getAttribute('aria-disabled') === 'true') text += ' disabled';
        if (child.required) text += ' required';
        add(depth, text, child);
        continue;
      }
      if (r === 'heading') { add(depth, 'heading[' + (child.tagName.match(/^H([1-6])$/) || [0, child.getAttribute('aria-level') || 2])[1] + '] "' + cut(clean(child.innerText), 120) + '"', child); continue; }
      if (r === 'img') { const a = label(child); if (a && sized(child)) add(depth, 'img "' + cut(a, 80) + '"', child); continue; }
      let next = depth;
      if (r && LANDMARK.has(r)) { const l = label(child); add(depth, r + (l ? ' "' + cut(l, 60) + '"' : ''), child); next = depth + 1; }
      const t = ownText(child);
      if (t && sized(child)) add(next, 'text "' + cut(t, 160) + '"', child);
      walk(child, next);
    }
  };
  const top = ownText(root);
  if (top) add(0, 'text "' + cut(top, 160) + '"', root);
  walk(root, 0);
  return { lines, count: n, truncated, missing: false };
}`;

/** Finds a ref from the latest snapshot. Null when the page navigated since, or the element is gone. */
export const RESOLVE_REF_SCRIPT = `(ref) => { const el = window.__atlasRefs && window.__atlasRefs.get(ref); return el && el.isConnected ? el : null; }`;

// Playwright sends a function's source to the page and calls it there with the argument. Built once from the text
// above; nothing in them runs in the daemon.
export const snapshotFn = new Function(`return ${SNAPSHOT_SCRIPT}`)() as (scope: string | null) => { lines: string[]; count: number; truncated: boolean; missing: boolean };
export const resolveRefFn = new Function(`return ${RESOLVE_REF_SCRIPT}`)() as (ref: string) => unknown;
