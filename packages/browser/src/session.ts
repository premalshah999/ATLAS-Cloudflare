// Browser sessions owned by one task (manual §25): fresh context, navigation restricted to allowed
// origins, structured steps with expected outcomes, console/network capture, screenshots and a trace.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { BrowserStep } from '@atlas/contracts';
import { resolveBrowser } from './resolve';

export interface StepResult { ok: boolean; step: BrowserStep; message: string; durationMs: number; screenshot?: Buffer; url: string }
export interface Observations { consoleErrors: string[]; pageErrors: string[]; failedRequests: string[]; badResponses: string[]; blockedNavigations: string[] }

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  page: Page | null = null;
  readonly observed: Observations = { consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [], blockedNavigations: [] };

  constructor(private readonly baseUrl: string, private readonly allowedOrigins: string[] = []) {}

  get origins() { return [new URL(this.baseUrl).origin, ...this.allowedOrigins.map((o) => new URL(o).origin)]; }

  async open(opts: { trace?: boolean } = {}) {
    const exe = resolveBrowser();
    if (!exe.path) throw new Error(exe.detail);
    this.browser = await chromium.launch({ executablePath: exe.path, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
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
    this.page.on('console', (m) => { if (m.type() === 'error') this.observed.consoleErrors.push(m.text().slice(0, 1000)); });
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
          const loc = s.selector ? page.locator(s.selector) : s.role ? page.getByRole(s.role as never, { name: s.name }) : page.getByText(s.text ?? '', { exact: false });
          await loc.first().click({ timeout: timeoutMs });
          return done(true, `clicked ${s.selector ?? s.role ?? s.text}`);
        }
        case 'fill': await page.locator(s.selector).first().fill(s.value, { timeout: timeoutMs }); return done(true, `filled ${s.selector}`);
        case 'select': await page.locator(s.selector).first().selectOption(s.value, { timeout: timeoutMs }); return done(true, `selected ${s.value} in ${s.selector}`);
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

  async close(tracePath?: string) {
    if (this.context && tracePath) await this.context.tracing.stop({ path: tracePath }).catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = null; this.context = null; this.page = null;
  }
}
