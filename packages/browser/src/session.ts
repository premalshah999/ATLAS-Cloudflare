// Browser sessions owned by one task (manual §25): fresh context, navigation restricted to allowed
// origins, structured steps with expected outcomes, console/network capture, screenshots and a trace.
import type { Browser, BrowserContext, ElementHandle, Locator, Page } from 'playwright-core';
import type { BrowserStep } from '@atlas/contracts';
import { resolveBrowser } from './resolve';
import { resolveRefFn, snapshotFn } from './snapshot';

export interface StepResult { ok: boolean; step: BrowserStep; message: string; durationMs: number; screenshot?: Buffer; url: string; /** Text the step read from the page (snapshot, console, network). Untrusted page content. */ text?: string }
export interface ConsoleEntry { type: string; text: string; at: number }
export interface NetworkEntry { method: string; url: string; status: number | null; type: string; ms: number | null; failure: string | null }

const LOG_MAX = 500;
export interface Observations { consoleErrors: string[]; pageErrors: string[]; failedRequests: string[]; badResponses: string[]; blockedNavigations: string[] }

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  page: Page | null = null;
  readonly observed: Observations = { consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [], blockedNavigations: [] };
  /** Everything the page logged and requested, newest LOG_MAX of each (ADR 0027). */
  readonly consoleLog: ConsoleEntry[] = [];
  readonly networkLog: NetworkEntry[] = [];
  private readConsole = 0;
  private readNetwork = 0;
  private droppedConsole = 0;
  private droppedNetwork = 0;

  constructor(private readonly baseUrl: string, private readonly allowedOrigins: string[] = []) {}

  get origins() { return [new URL(this.baseUrl).origin, ...this.allowedOrigins.map((o) => new URL(o).origin)]; }

  async open(opts: { trace?: boolean } = {}) {
    const exe = resolveBrowser();
    if (!exe.path) throw new Error(exe.detail);
    const { chromium } = await import('playwright-core');
    this.browser = await chromium.launch({ executablePath: exe.path, headless: true, // No proxy: QA only ever loads the app on loopback. On Windows, proxy auto-detection (WPAD) made the first
    // navigation exceed its 10 s timeout on CI while the API checks against the same app passed in milliseconds.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
    // A fresh, non-persistent context per session: no cookies or storage shared across projects or tasks.
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block', ignoreHTTPSErrors: false });
    if (opts.trace) await this.context.tracing.start({ screenshots: true, snapshots: true });
    const allowed = this.origins;
    await this.context.route('**/*', (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === this.page?.mainFrame()) {
        let origin = '';
        try { origin = new URL(req.url()).origin; } catch { /* data: etc. */ }
        if (!allowed.includes(origin)) { this.observed.blockedNavigations.push(req.url()); return route.abort('blockedbyclient'); }
      }
      return route.continue();
    });
    this.page = await this.context.newPage();
    this.page.on('console', (m) => {
      if (m.type() === 'error') this.observed.consoleErrors.push(m.text().slice(0, 1000));
      this.consoleLog.push({ type: m.type(), text: m.text().slice(0, 1000), at: Date.now() });
      if (this.consoleLog.length > LOG_MAX) { this.consoleLog.shift(); this.droppedConsole++; }
    });
    const logRequest = (r: import('playwright-core').Request, status: number | null, failure: string | null) => {
      const t = r.timing();
      this.networkLog.push({ method: r.method(), url: r.url().slice(0, 500), status, type: r.resourceType(), ms: t.responseEnd > 0 ? Math.round(t.responseEnd) : null, failure });
      if (this.networkLog.length > LOG_MAX) { this.networkLog.shift(); this.droppedNetwork++; }
    };
    this.page.on('requestfinished', (r) => { void r.response().then((res) => logRequest(r, res?.status() ?? null, null), () => logRequest(r, null, null)); });
    this.page.on('requestfailed', (r) => logRequest(r, null, r.failure()?.errorText ?? 'failed'));
    this.page.on('pageerror', (e) => this.observed.pageErrors.push(String(e.message).slice(0, 1000)));
    this.page.on('requestfailed', (r) => this.observed.failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? 'failed'}`));
    this.page.on('response', (r) => { if (r.status() >= 400) this.observed.badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
    return exe.detail;
  }

  async step(s: BrowserStep, timeoutMs = 10_000): Promise<StepResult> {
    const page = this.page!;
    const t0 = Date.now();
    const done = (ok: boolean, message: string, screenshot?: Buffer): StepResult => ({ ok, step: s, message, durationMs: Date.now() - t0, screenshot, url: page.url() });
    try {
      switch (s.action) {
        case 'goto': {
          const res = await page.goto(new URL(s.path, this.baseUrl).toString(), { timeout: timeoutMs, waitUntil: 'load' });
          return done(!!res && res.status() < 400, `GET ${s.path} → ${res?.status() ?? 'no response'}`);
        }
        case 'click': {
          if (s.ref) { const el = await this.byRef(s.ref); if (typeof el === 'string') return done(false, el); await el.click({ timeout: timeoutMs }); return done(true, `clicked ${s.ref}`); }
          const loc = s.selector ? page.locator(s.selector) : s.role ? page.getByRole(s.role as never, { name: s.name }) : page.getByText(s.text ?? '', { exact: false });
          await loc.first().click({ timeout: timeoutMs });
          return done(true, `clicked ${s.selector ?? s.role ?? s.text}`);
        }
        case 'fill': {
          const el = await this.target(s);
          if (typeof el === 'string') return done(false, el);
          await el.fill(s.value, { timeout: timeoutMs });
          return done(true, `filled ${s.ref ?? s.selector}`);
        }
        case 'hover': {
          const el = await this.target(s);
          if (typeof el === 'string') return done(false, el);
          await el.hover({ timeout: timeoutMs });
          return done(true, `hovering ${s.ref ?? s.selector}`);
        }
        case 'select': {
          const el = await this.target(s);
          if (typeof el === 'string') return done(false, el);
          // By value, else by visible label: agents read labels in the snapshot.
          const picked = await el.selectOption(s.value, { timeout: timeoutMs }).catch(() => el.selectOption({ label: s.value }, { timeout: timeoutMs }));
          return done(picked.length > 0, picked.length ? `selected "${s.value}" in ${s.ref ?? s.selector}` : `no option "${s.value}" in ${s.ref ?? s.selector}`);
        }
        case 'check': {
          const el = await this.target(s);
          if (typeof el === 'string') return done(false, el);
          await el.setChecked(s.checked, { timeout: timeoutMs });
          return done(true, `${s.checked ? 'checked' : 'unchecked'} ${s.ref ?? s.selector}`);
        }
        case 'snapshot': {
          const r = await page.evaluate(snapshotFn, s.selector ?? null);
          if (r.missing) return done(false, `no element matches ${s.selector}`);
          const title = await page.title().catch(() => '');
          const head = `Page: ${title ? `"${title}" ` : ''}${new URL(page.url()).pathname}${new URL(page.url()).search} · ${r.count} element${r.count === 1 ? '' : 's'}${r.truncated ? ' (truncated at 400; take a snapshot of a part with selector)' : ''}`;
          return { ...done(true, head), text: r.lines.join('\n') || '(nothing visible)' };
        }
        case 'reload': { const res = await page.reload({ timeout: timeoutMs, waitUntil: 'load' }); return done(!!res && res.status() < 400, `reloaded → ${res?.status() ?? 'no response'}`); }
        case 'back': { const res = await page.goBack({ timeout: timeoutMs, waitUntil: 'load' }); return done(true, res ? `back → ${res.status()}` : 'back (no earlier page in this session)'); }
        case 'viewport': await page.setViewportSize({ width: s.width, height: s.height }); return done(true, `viewport ${s.width}×${s.height}`);
        case 'console': {
          const fresh = this.consoleLog.slice(Math.max(0, this.readConsole - this.droppedConsole));
          const skipped = this.readConsole < this.droppedConsole;
          this.readConsole = this.droppedConsole + this.consoleLog.length;
          const errors = fresh.filter((e) => e.type === 'error').length;
          return { ...done(true, `${fresh.length} new console message${fresh.length === 1 ? '' : 's'}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}${skipped ? ' (older ones dropped)' : ''}`), text: fresh.slice(-100).map((e) => `[${e.type}] ${e.text}`).join('\n') || '(none)' };
        }
        case 'network': {
          const fresh = this.networkLog.slice(Math.max(0, this.readNetwork - this.droppedNetwork));
          const skipped = this.readNetwork < this.droppedNetwork;
          this.readNetwork = this.droppedNetwork + this.networkLog.length;
          const bad = fresh.filter((e) => e.failure || (e.status ?? 0) >= 400).length;
          const origin = new URL(this.baseUrl).origin;
          const short = (u: string) => (u.startsWith(origin) ? u.slice(origin.length) || '/' : u);
          return { ...done(true, `${fresh.length} new request${fresh.length === 1 ? '' : 's'}${bad ? `, ${bad} failed` : ''}${skipped ? ' (older ones dropped)' : ''}`), text: fresh.slice(-100).map((e) => `${e.method} ${short(e.url)} → ${e.failure ? `failed (${e.failure})` : e.status ?? '?'}${e.ms != null ? ` · ${e.ms} ms` : ''} · ${e.type}`).join('\n') || '(none)' };
        }
        case 'press': await (s.selector ? page.locator(s.selector).first().press(s.key, { timeout: timeoutMs }) : page.keyboard.press(s.key)); return done(true, `pressed ${s.key}`);
        case 'expectText': {
          const loc = s.selector ? page.locator(s.selector).first() : page.locator('body');
          try { await loc.filter({ hasText: s.text }).first().waitFor({ timeout: timeoutMs }); return done(true, `found "${s.text}"`); }
          catch { const actual = (await loc.innerText({ timeout: 2000 }).catch(() => '')).slice(0, 300); return done(false, `expected "${s.text}"${s.selector ? ` in ${s.selector}` : ''}; found "${actual}"`, await page.screenshot()); }
        }
        case 'expectNoText': {
          const body = await (s.selector ? page.locator(s.selector).first() : page.locator('body')).innerText({ timeout: timeoutMs });
          return body.includes(s.text) ? done(false, `unexpected "${s.text}"`, await page.screenshot()) : done(true, `"${s.text}" absent`);
        }
        case 'expectUrl': {
          const ok = await page.waitForURL((u) => u.pathname === s.path, { timeout: timeoutMs }).then(() => true, () => false);
          return ok ? done(true, `at ${s.path}`) : done(false, `expected ${s.path}, at ${new URL(page.url()).pathname}`, await page.screenshot());
        }
        case 'expectVisible': {
          const ok = await page.locator(s.selector).first().waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true, () => false);
          return ok ? done(true, `${s.selector} visible`) : done(false, `${s.selector} not visible`, await page.screenshot());
        }
        case 'screenshot': return done(true, `screenshot ${s.name}`, await page.screenshot({ fullPage: true }));
        case 'wait': await page.waitForTimeout(s.ms); return done(true, `waited ${s.ms} ms`);
      }
    } catch (e) {
      const shot = await page.screenshot().catch(() => undefined);
      return done(false, (e as Error).message.split('\n')[0].slice(0, 500), shot);
    }
  }

  /** A blank page in this session's context, for work that loads no app content (the visual diff). */
  async scratchPage(): Promise<Page> { return this.context!.newPage(); }

  /** The element behind a ref from the latest snapshot, or why there is none. */
  private async byRef(ref: string): Promise<ElementHandle | string> {
    const h = await this.page!.evaluateHandle(resolveRefFn, ref);
    const el = h.asElement();
    if (!el) { await h.dispose(); return `${ref} is not on the page any more (it changed or navigated since the snapshot); take a new snapshot`; }
    return el as ElementHandle;
  }

  private async target(s: { ref?: string; selector?: string }): Promise<ElementHandle | Locator | string> {
    if (s.ref) return this.byRef(s.ref);
    return this.page!.locator(s.selector!).first();
  }

  async close(tracePath?: string) {
    if (this.context && tracePath) await this.context.tracing.stop({ path: tracePath }).catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = null; this.context = null; this.page = null;
  }
}
