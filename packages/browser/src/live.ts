// A live, operator-driven browser tab: one Chromium process shared by every tab, one fresh,
// non-persistent context per tab (no cookies, storage or service workers shared), navigation limited
// to addresses the caller allows. Frames are JPEG screenshots; input is mouse, wheel and keyboard.
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { resolveBrowser } from './resolve';

export type LiveInputKind = 'click' | 'move' | 'scroll' | 'type' | 'key' | 'navigate' | 'back' | 'forward' | 'reload';
export interface LiveInput { kind: LiveInputKind; x?: number; y?: number; dx?: number; dy?: number; text?: string; key?: string; url?: string }
export interface LiveState { url: string; title: string }

const NAV_TIMEOUT = 20_000;

/** Launch the shared headless Chromium the live tabs run in. */
export async function launchLiveChromium(): Promise<Browser> {
  const exe = resolveBrowser();
  if (!exe.path) throw new Error(exe.detail);
  const { chromium } = await import('playwright-core');
  return chromium.launch({ executablePath: exe.path, headless: true, args: ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'] });
}

export class LiveTab {
  private constructor(private readonly context: BrowserContext, private readonly page: Page, readonly width: number, readonly height: number, private readonly allow: (url: string) => boolean) {}

  static async open(browser: Browser, opts: { width: number; height: number; allow: (url: string) => boolean }): Promise<LiveTab> {
    const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block', ignoreHTTPSErrors: false });
    // Only requests to addresses outside the allow-list are intercepted; top-level navigations there are refused.
    await context.route((u) => !opts.allow(u.href), (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame().parentFrame() === null) return route.abort('blockedbyclient');
      return route.continue();
    });
    const page = await context.newPage();
    const tab = new LiveTab(context, page, opts.width, opts.height, opts.allow);
    page.on('dialog', (d) => { void d.dismiss().catch(() => {}); });
    // Links that open a new window load in this tab instead, so the operator never loses sight of them.
    context.on('page', (p) => {
      if (p === page) return;
      void p.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {}).then(async () => {
        const url = p.url();
        await p.close().catch(() => {});
        if (url && url !== 'about:blank' && opts.allow(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      });
    });
    return tab;
  }

  async state(): Promise<LiveState> {
    return { url: this.page.url(), title: (await this.page.title().catch(() => '')).slice(0, 300) };
  }

  async goto(url: string): Promise<void> {
    if (!this.allow(url)) throw new Error('Address not allowed: use https, or http on 127.0.0.1/localhost');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  }

  async frame(): Promise<Buffer> {
    return this.page.screenshot({ type: 'jpeg', quality: 70, timeout: 5_000, animations: 'allow', caret: 'initial' });
  }

  async input(i: LiveInput): Promise<void> {
    const m = this.page.mouse, k = this.page.keyboard;
    const x = clamp(i.x ?? 0, this.width), y = clamp(i.y ?? 0, this.height);
    switch (i.kind) {
      case 'click': await m.click(x, y); return;
      case 'move': await m.move(x, y); return;
      case 'scroll': if (i.x != null && i.y != null) await m.move(x, y); await m.wheel(i.dx ?? 0, i.dy ?? 0); return;
      case 'type': if (i.text) await k.type(i.text); return;
      case 'key': if (i.key) await k.press(i.key); return;
      case 'navigate': if (!i.url) throw new Error('navigate needs a url'); await this.goto(i.url); return;
      case 'back': await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); return;
      case 'forward': await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); return;
      case 'reload': await this.page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); return;
    }
  }

  async close(): Promise<void> { await this.context.close().catch(() => {}); }
}

const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v)));
