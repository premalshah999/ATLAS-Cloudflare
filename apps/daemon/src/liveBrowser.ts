// The operator's live browser (Browser screen): real-time, interactive tabs driven only by the person
// at the keyboard. Agents have no access to these sessions, and nothing here runs agent-requested work.
// Each tab gets a fresh, isolated browser context; at most MAX_SESSIONS exist at once; idle ones close.
import { randomBytes } from 'node:crypto';
import { AtlasError, isLiveBrowserUrl } from '@atlas/contracts';
import { LiveTab, launchLiveChromium, type LiveInput } from '@atlas/browser';
import type { Repo } from '@atlas/storage';

export const MAX_SESSIONS = 3;
const IDLE_MS = 10 * 60_000;
const DEFAULT_SIZE = { width: 1280, height: 800 };

type Chromium = Awaited<ReturnType<typeof launchLiveChromium>>;
interface Session { id: string; tab: LiveTab; lastUsed: number; busy: Promise<unknown> }

export { isLiveBrowserUrl };

export class LiveBrowserManager {
  private browser: Promise<Chromium> | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly reaper: NodeJS.Timeout;

  constructor(private readonly deps: { repo?: Repo; launch?: () => Promise<Chromium> } = {}) {
    this.reaper = setInterval(() => { void this.reapIdle(); }, 60_000);
    this.reaper.unref?.();
  }

  get count() { return this.sessions.size; }

  async open(p: { url: string; width?: number; height?: number }) {
    if (!isLiveBrowserUrl(p.url)) throw new AtlasError('invalid_request', 'Only https addresses, or http on 127.0.0.1/localhost, can be opened');
    if (this.sessions.size >= MAX_SESSIONS) throw new AtlasError('resource_limit', `At most ${MAX_SESSIONS} live browser tabs can be open; close one first`);
    const browser = await this.chromium();
    const width = p.width ?? DEFAULT_SIZE.width, height = p.height ?? DEFAULT_SIZE.height;
    const tab = await LiveTab.open(browser, { width, height, allow: isLiveBrowserUrl });
    const id = `lbr_${randomBytes(9).toString('hex')}`;
    const s: Session = { id, tab, lastUsed: Date.now(), busy: Promise.resolve() };
    this.sessions.set(id, s);
    let error: string | undefined;
    try { await tab.goto(p.url); } catch (e) { error = firstLine(e); }
    return { sessionId: id, width, height, ...(await tab.state()), ...(error ? { error } : {}) };
  }

  async frame(sessionId: string) {
    const s = this.must(sessionId);
    s.lastUsed = Date.now();
    const jpeg = await s.tab.frame();
    return { png: jpeg.toString('base64'), mime: 'image/jpeg' as const, ...(await s.tab.state()), ts: Date.now() };
  }

  async input(sessionId: string, i: LiveInput) {
    const s = this.must(sessionId);
    s.lastUsed = Date.now();
    if (i.kind === 'navigate' && (!i.url || !isLiveBrowserUrl(i.url))) throw new AtlasError('invalid_request', 'Only https addresses, or http on 127.0.0.1/localhost, can be opened');
    // Inputs on one tab apply in the order they arrived.
    const run = s.busy.then(() => s.tab.input(i));
    s.busy = run.catch(() => {});
    let error: string | undefined;
    try { await run; } catch (e) { error = firstLine(e); }
    return { ok: !error, ...(await s.tab.state()), ...(error ? { error } : {}) };
  }

  async close(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: true };
    this.sessions.delete(sessionId);
    await s.tab.close();
    if (!this.sessions.size) await this.releaseBrowser();
    return { ok: true };
  }

  /** Staging and preview addresses ATLAS deployed, newest first: the places an operator most often wants to look. */
  urls(): string[] {
    const repo = this.deps.repo;
    if (!repo) return [];
    const out: string[] = [];
    const add = (u: unknown) => { if (typeof u === 'string' && isLiveBrowserUrl(u) && !out.includes(u)) out.push(u); };
    try { for (const d of repo.deployments()) add(d.url); } catch { /* best effort */ }
    try {
      for (const m of repo.missions().slice(0, 20)) {
        for (const e of repo.eventsSince(m.id, 0)) if (e.type === 'deploy.event') add((e.payload as { url?: unknown } | null)?.url);
      }
    } catch { /* best effort */ }
    return out.slice(0, 12);
  }

  async shutdown() {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.values()].map((s) => s.tab.close()));
    this.sessions.clear();
    await this.releaseBrowser();
  }

  private must(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new AtlasError('stale_session', 'This live browser tab has closed; open it again');
    return s;
  }

  private chromium(): Promise<Chromium> {
    if (!this.browser) {
      const launching = (this.deps.launch ?? launchLiveChromium)();
      this.browser = launching;
      launching.then((b) => b.on('disconnected', () => { if (this.browser === launching) { this.browser = null; this.sessions.clear(); } }), () => { if (this.browser === launching) this.browser = null; });
    }
    return this.browser;
  }

  private async releaseBrowser() {
    const b = this.browser;
    this.browser = null;
    if (b) await b.then((x) => x.close(), () => {}).catch(() => {});
  }

  private async reapIdle() {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) if (now - s.lastUsed > IDLE_MS) await this.close(s.id);
  }
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300);
