// web_browse (ADR 0030): a real browser on the open web for an agent. A fresh context per attempt, no downloads, no
// service workers, and every request filtered: public addresses only, and by default GET-like methods only, so
// browsing reads the web and cannot submit forms or post anything. Navigating the page to another site needs that
// site to be known (found by a search, on the operator's list, or approved); otherwise it is blocked and the agent
// is told to open it, which goes through the gate.
import type { Browser, BrowserContext, ElementHandle, Locator, Page } from 'playwright-core';
import { resolveBrowser, resolveRefFn, snapshotFn } from '@atlas/browser';
import type { WebBrowseStep } from '@atlas/contracts';
import { hostChecker, isPublicAddress, urlProblem, type AddressFilter } from './guard';
import { htmlToText } from './html';

export interface BrowseResult { ok: boolean; message: string; url: string; text?: string; screenshot?: Buffer; blocked: string[] }

export interface WebBrowserOptions {
  allowSubmit: boolean;
  /** Whether the page may navigate its main frame to this host without the gate (known or allowed site). */
  mayNavigate(host: string): boolean;
  allowed?: AddressFilter;
  timeoutMs?: number;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TEXT_MAX = 20_000;

export class WebBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /** Requests refused since the last step, reported with the step's result. */
  private blocked: string[] = [];
  /** A main-frame navigation was refused since the last step: Chromium shows its error page shortly after. */
  private navBlocked = false;
  private readonly check: (host: string) => Promise<string | null>;

  constructor(private readonly o: WebBrowserOptions) {
    this.check = hostChecker(o.allowed ?? isPublicAddress);
  }

  private async ensure(): Promise<Page> {
    if (this.page) return this.page;
    const exe = resolveBrowser();
    if (!exe.path) throw new Error(exe.detail);
    const { chromium } = await import('playwright-core');
    this.browser = await chromium.launch({ executablePath: exe.path, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: false, serviceWorkers: 'block', ignoreHTTPSErrors: false, locale: 'en-US' });
    const allowed = this.o.allowed ?? isPublicAddress;
    await this.context.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      if (!/^https?:/i.test(url)) return route.continue();
      const refuse = (why: string) => {
        this.blocked.push(`${req.method()} ${url.slice(0, 200)}: ${why}`);
        if (req.isNavigationRequest() && req.frame() === this.page?.mainFrame()) this.navBlocked = true;
        return route.abort('blockedbyclient');
      };
      const problem = urlProblem(url, allowed);
      if (problem) return refuse(problem);
      const host = new URL(url).hostname;
      const addr = await this.check(host);
      if (addr) return refuse(addr);
      if (!this.o.allowSubmit && !READ_METHODS.has(req.method())) return refuse(`${req.method()} requests are off (browsing only reads; the operator can allow form submissions in Settings)`);
      if (req.isNavigationRequest() && req.frame() === this.page?.mainFrame() && !this.o.mayNavigate(host.toLowerCase())) {
        return refuse(`${host} is not a known site; open it with web_browse {"action":"open","url":…} (it may need approval)`);
      }
      return route.continue();
    });
    this.page = await this.context.newPage();
    return this.page;
  }

  /** Open a URL the gate already allowed. */
  async open(url: string): Promise<BrowseResult> {
    const page = await this.ensure();
    const t = this.o.timeoutMs ?? 20_000;
    this.blocked = [];
    try {
      const res = await page.goto(url, { timeout: t, waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      const status = res?.status() ?? null;
      return this.withSnapshot(status !== null && status < 400, `GET ${url} → ${status ?? 'no response'}`);
    } catch (e) {
      return { ok: false, message: (e as Error).message.split('\n')[0].slice(0, 400), url: page.url(), blocked: this.take() };
    }
  }

  private take() { const b = this.blocked; this.blocked = []; return b.slice(-10); }

  private async withSnapshot(ok: boolean, message: string): Promise<BrowseResult> {
    const page = this.page!;
    // A navigation ATLAS refused leaves Chromium on its error page (a moment later): return to the page the agent was
    // reading.
    if (this.navBlocked) {
      this.navBlocked = false;
      for (let i = 0; i < 60 && !page.url().startsWith('chrome-error://'); i++) await page.waitForTimeout(50);
      if (page.url().startsWith('chrome-error://')) await page.goBack({ timeout: 10_000, waitUntil: 'domcontentloaded' }).catch(() => null);
      message = `${message} (the navigation was blocked; still on ${page.url()})`;
    }
    const title = await page.title().catch(() => '');
    const snap = await page.evaluate(snapshotFn, null).catch(() => null);
    const text = snap ? `Page: ${title ? `"${title}" ` : ''}${page.url()} · ${snap.count} elements${snap.truncated ? ' (truncated at 400; use text, or snapshot with a selector)' : ''}\n${snap.lines.join('\n')}` : undefined;
    return { ok, message, url: page.url(), text, blocked: this.take() };
  }

  private async byRef(ref: string): Promise<ElementHandle | string> {
    const h = await this.page!.evaluateHandle(resolveRefFn, ref);
    const el = h.asElement();
    if (!el) { await h.dispose(); return `${ref} is not on the page any more; take a new snapshot`; }
    return el as ElementHandle;
  }
  private async target(s: { ref?: string; selector?: string; text?: string }): Promise<ElementHandle | Locator | string> {
    if (s.ref) return this.byRef(s.ref);
    if (s.selector) return this.page!.locator(s.selector).first();
    if (s.text) return this.page!.getByText(s.text, { exact: false }).first();
    return 'name a ref (from the snapshot), a selector or text';
  }

  async step(s: Exclude<WebBrowseStep, { action: 'open' }>): Promise<BrowseResult> {
    if (!this.page) return { ok: false, message: 'No page is open yet: start with {"action":"open","url":"https://…"}', url: '', blocked: [] };
    const page = this.page;
    const t = this.o.timeoutMs ?? 10_000;
    const done = (ok: boolean, message: string, extra: Partial<BrowseResult> = {}): BrowseResult => ({ ok, message, url: page.url(), blocked: this.take(), ...extra });
    try {
      switch (s.action) {
        case 'snapshot': {
          const r = await page.evaluate(snapshotFn, s.selector ?? null);
          if (r.missing) return done(false, `no element matches ${s.selector}`);
          return done(true, `${r.count} elements${r.truncated ? ' (truncated at 400)' : ''}`, { text: r.lines.join('\n') || '(nothing visible)' });
        }
        case 'text': {
          const html = s.selector ? await page.locator(s.selector).first().evaluate((el) => el.outerHTML) : await page.content();
          const read = htmlToText(html, page.url());
          const slice = read.text.slice(s.offset, s.offset + TEXT_MAX);
          const more = read.text.length > s.offset + TEXT_MAX ? `\n… [${read.text.length - s.offset - TEXT_MAX} more characters: text with offset ${s.offset + TEXT_MAX}]` : '';
          return done(true, `${read.text.length} characters of text${s.offset ? ` from ${s.offset}` : ''}`, { text: `${read.title ? `# ${read.title}\n\n` : ''}${slice}${more}` });
        }
        case 'click': {
          const el = await this.target(s);
          if (typeof el === 'string') return done(false, el);
          await el.click({ timeout: t });
          await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => {});
          return this.withSnapshot(true, `clicked ${s.ref ?? s.selector ?? s.text}`);
        }
        case 'fill': { const el = await this.target(s); if (typeof el === 'string') return done(false, el); await el.fill(s.value, { timeout: t }); return done(true, `filled ${s.ref ?? s.selector}`); }
        case 'select': {
          const el = await this.target(s);
          if (typeof el === 'string') return done(false, el);
          const picked = await el.selectOption(s.value, { timeout: t }).catch(() => el.selectOption({ label: s.value }, { timeout: t }));
          return done(picked.length > 0, picked.length ? `selected "${s.value}"` : `no option "${s.value}"`);
        }
        case 'check': { const el = await this.target(s); if (typeof el === 'string') return done(false, el); await el.setChecked(s.checked, { timeout: t }); return done(true, `${s.checked ? 'checked' : 'unchecked'} ${s.ref ?? s.selector}`); }
        case 'hover': { const el = await this.target(s); if (typeof el === 'string') return done(false, el); await el.hover({ timeout: t }); return done(true, `hovering ${s.ref ?? s.selector}`); }
        case 'press': {
          await (s.selector ? page.locator(s.selector).first().press(s.key, { timeout: t }) : page.keyboard.press(s.key));
          await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => {});
          return this.withSnapshot(true, `pressed ${s.key}`);
        }
        case 'scroll': await page.mouse.wheel(0, s.dy); await page.waitForTimeout(200); return this.withSnapshot(true, `scrolled ${s.dy}px`);
        case 'back': { const r = await page.goBack({ timeout: t, waitUntil: 'domcontentloaded' }); return this.withSnapshot(true, r ? `back → ${r.status()}` : 'back (no earlier page)'); }
        case 'screenshot': return done(true, `screenshot ${s.name}`, { screenshot: await page.screenshot({ fullPage: false }) });
        case 'wait': await page.waitForTimeout(s.ms); return done(true, `waited ${s.ms} ms`);
      }
    } catch (e) {
      return done(false, (e as Error).message.split('\n')[0].slice(0, 400));
    }
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = null; this.context = null; this.page = null;
  }
}
