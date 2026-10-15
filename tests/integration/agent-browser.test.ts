// The agent's browser (ADR 0027): a snapshot of the page with refs, actions on those refs, and the page's console and
// network as the agent reads them. Against a small real app in a real Chromium.
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserActionArgs, BrowserSession, resolveBrowser, startApp } from '@atlas/browser';
import { startProcess } from '@atlas/terminal';
import { tmpDir } from '../helpers';

const PAGE = `<!doctype html><html><head><title>Orders</title></head><body>
<nav><a href="/about">About</a> <a href="https://example.com/help">Help</a></nav>
<main>
  <h1>Orders</h1>
  <p>Place an order below.</p>
  <p style="display:none">secret hidden text</p>
  <div aria-hidden="true">decorative</div>
  <form aria-label="New order" onsubmit="return false">
    <label for="who">Customer</label><input id="who">
    <label for="size">Size</label><select id="size"><option value="s">Small</option><option value="l">Large</option></select>
    <label><input type="checkbox" id="gift"> Gift wrap</label>
    <button id="go" type="button">Place order</button>
    <button type="button" disabled>Cancel</button>
  </form>
  <span id="tip" onmouseover="this.textContent='tooltip shown'">hover me</span>
  <p id="out"></p>
</main>
<script>
document.getElementById('go').addEventListener('click', async () => {
  const who = document.getElementById('who').value, size = document.getElementById('size').selectedOptions[0].text, gift = document.getElementById('gift').checked;
  console.log('placing order for ' + who);
  const r = await fetch('/api/order');
  await fetch('/missing');
  console.error('analytics failed');
  document.getElementById('out').textContent = 'Order ' + (await r.text()) + ' placed for ' + who + ' (' + size + (gift ? ', gift' : '') + ')';
});
</script></body></html>`;
const ABOUT = '<!doctype html><title>About</title><h1>About us</h1>';

async function app() {
  const dir = tmpDir();
  writeFileSync(path.join(dir, 'page.html'), PAGE);
  writeFileSync(path.join(dir, 'about.html'), ABOUT);
  writeFileSync(path.join(dir, 'server.js'), `const fs = require('fs');
require('http').createServer((q, s) => {
  if (q.url === '/') { s.setHeader('content-type', 'text/html'); return s.end(fs.readFileSync(__dirname + '/page.html')); }
  if (q.url === '/about') { s.setHeader('content-type', 'text/html'); return s.end(fs.readFileSync(__dirname + '/about.html')); }
  if (q.url === '/api/order') return s.end('#42');
  s.statusCode = 404; s.end('no');
}).listen(process.env.PORT, '127.0.0.1');`);
  const sandbox = { available: true, detail: '', run: async () => { throw new Error('unused'); }, start: async (o: { command: string; args: string[]; env?: Record<string, string> }) => startProcess({ command: o.command, args: o.args, cwd: dir, env: { PATH: process.env.PATH!, ...o.env } }) };
  return startApp(sandbox as never, { start: ['node', 'server.js'], readyPath: '/', readyTimeoutSec: 20, env: {} });
}

describe.skipIf(!resolveBrowser().path)('the agent browser (ADR 0027)', () => {
  it('reads the page as a list of refs, acts on them, and reads console and network', async () => {
    const a = await app();
    const s = new BrowserSession(a.baseUrl);
    try {
      await s.open();
      expect((await s.step({ action: 'goto', path: '/' })).ok).toBe(true);
      const before = await s.page!.evaluate(() => document.body.outerHTML);
      const snap = await s.step({ action: 'snapshot' });
      expect(snap.message).toMatch(/^Page: "Orders" \/ · \d+ elements$/);
      const lines = snap.text!.split('\n');
      const refOf = (re: RegExp) => /\[ref=(e\d+)\]$/.exec(lines.find((l) => re.test(l))!)![1];
      expect(lines).toEqual(expect.arrayContaining([
        expect.stringMatching(/^- navigation \[ref=e\d+\]$/),
        expect.stringMatching(/^ {2}- link "About" → \/about \[ref=e\d+\]$/),
        expect.stringMatching(/^ {2}- link "Help" → https:\/\/example\.com\/help \[ref=e\d+\]$/),
        expect.stringMatching(/^ {2}- heading\[1\] "Orders" \[ref=e\d+\]$/),
        expect.stringMatching(/^ {2}- text "Place an order below\." \[ref=e\d+\]$/),
        expect.stringMatching(/^ {4}- textbox "Customer" value="" \[ref=e\d+\]$/),
        expect.stringMatching(/^ {4}- combobox "Size" selected="Small" options=\["Small","Large"\] \[ref=e\d+\]$/),
        expect.stringMatching(/^ {4}- checkbox "Gift wrap" unchecked \[ref=e\d+\]$/),
        expect.stringMatching(/^ {4}- button "Place order" \[ref=e\d+\]$/),
        expect.stringMatching(/^ {4}- button "Cancel" disabled \[ref=e\d+\]$/),
      ]));
      expect(lines.some((l) => /- form "New order"/.test(l))).toBe(true);
      // Hidden and decorative content is not listed.
      expect(snap.text).not.toMatch(/secret hidden text|decorative/);
      // Taking a snapshot does not change the page.
      expect(await s.page!.evaluate(() => document.body.outerHTML)).toBe(before);

      expect((await s.step({ action: 'fill', ref: refOf(/textbox "Customer"/), value: 'Ada' })).ok).toBe(true);
      const sel = await s.step({ action: 'select', ref: refOf(/combobox "Size"/), value: 'Large' });
      expect(sel).toMatchObject({ ok: true, message: expect.stringMatching(/selected "Large"/) });
      expect((await s.step({ action: 'check', ref: refOf(/checkbox "Gift wrap"/), checked: true })).ok).toBe(true);
      expect((await s.step({ action: 'hover', ref: refOf(/text "hover me"/) })).ok).toBe(true);
      expect((await s.step({ action: 'click', ref: refOf(/button "Place order"/) })).ok).toBe(true);
      expect((await s.step({ action: 'expectText', selector: '#out', text: 'Order #42 placed for Ada (Large, gift)' })).ok).toBe(true);

      const again = await s.step({ action: 'snapshot', selector: 'main' });
      expect(again.text).toMatch(/text "tooltip shown"/);
      expect(again.text).toMatch(/textbox "Customer" value="Ada"/);
      expect(again.text).toMatch(/checkbox "Gift wrap" checked/);
      expect(again.text).toMatch(/text "Order #42 placed for Ada \(Large, gift\)"/);
      expect(again.text).not.toMatch(/link "About"/);

      const con = await s.step({ action: 'console' });
      // Chromium also logs the 404 itself as an error.
      expect(con.message).toMatch(/^\d+ new console messages, \d+ errors?$/);
      expect(con.text).toMatch(/^\[log\] placing order for Ada$/m);
      expect(con.text).toMatch(/^\[error\] analytics failed$/m);
      expect((await s.step({ action: 'console' })).text).toBe('(none)');
      await expect.poll(async () => (await s.step({ action: 'network' })).text ?? '', { timeout: 5000 }).toMatch(/GET \/missing → 404/);
      const net = s.networkLog.map((e) => `${e.method} ${new URL(e.url).pathname} ${e.status}`);
      expect(net).toEqual(expect.arrayContaining(['GET / 200', 'GET /api/order 200', 'GET /missing 404']));

      // A ref from before a reload is refused, not guessed; the agent is told to take a new snapshot.
      const stale = refOf(/button "Place order"/);
      expect((await s.step({ action: 'reload' })).ok).toBe(true);
      const r = await s.step({ action: 'click', ref: stale });
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/is not on the page any more .* take a new snapshot/) });

      await s.step({ action: 'snapshot' });
      expect((await s.step({ action: 'click', ref: refOf(/link "About"/) })).ok).toBe(true);
      expect((await s.step({ action: 'expectUrl', path: '/about' })).ok).toBe(true);
      expect((await s.step({ action: 'back' })).ok).toBe(true);
      expect(new URL(s.page!.url()).pathname).toBe('/');
      expect((await s.step({ action: 'viewport', width: 400, height: 700 })).ok).toBe(true);
      expect(s.page!.viewportSize()).toEqual({ width: 400, height: 700 });
      expect((await s.step({ action: 'snapshot', selector: '#nothing-here' }))).toMatchObject({ ok: false, message: 'no element matches #nothing-here' });
    } finally {
      await s.close();
      await a.stop();
    }
  }, 90_000);

  it('actions on one element need a ref or a selector, and refs have one form', () => {
    expect(BrowserActionArgs.safeParse({ step: { action: 'fill', value: 'x' } }).success).toBe(false);
    expect(BrowserActionArgs.safeParse({ step: { action: 'click', ref: 'button' } }).success).toBe(false);
    expect(BrowserActionArgs.safeParse({ step: { action: 'select', ref: 'e3', value: 'Large' } }).success).toBe(true);
    expect(BrowserActionArgs.safeParse({ step: { action: 'viewport', width: 100, height: 700 } }).success).toBe(false);
  });
});
