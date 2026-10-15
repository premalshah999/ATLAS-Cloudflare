import { describe, expect, it } from 'vitest';
import { LIVE_KEY, Requests } from '@atlas/contracts';
import { isLiveBrowserUrl, LiveBrowserManager, MAX_SESSIONS } from '../src/liveBrowser';

describe('live browser address rules', () => {
  it('allows https anywhere and plain http only on this machine', () => {
    for (const ok of ['https://example.com', 'https://staging.acme.dev/path?q=1', 'http://127.0.0.1:5173/', 'http://localhost:3000', 'http://[::1]:8080/', 'http://app.localhost:4000']) expect(isLiveBrowserUrl(ok), ok).toBe(true);
    for (const bad of ['http://example.com', 'http://192.168.1.10', 'http://10.0.0.1:80', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'ftp://x.org', 'https://user:pw@example.com', 'not a url', '']) expect(isLiveBrowserUrl(bad), bad).toBe(false);
  });

  it('the IPC schema refuses disallowed addresses and keys before the daemon sees them', () => {
    expect(Requests['browser.live.open'].safeParse({ url: 'https://example.com' }).success).toBe(true);
    expect(Requests['browser.live.open'].safeParse({ url: 'file:///etc/hosts' }).success).toBe(false);
    expect(Requests['browser.live.input'].safeParse({ sessionId: 'lbr_abcdef123456', kind: 'navigate', url: 'http://evil.example' }).success).toBe(false);
    expect(Requests['browser.live.input'].safeParse({ sessionId: 'lbr_abcdef123456', kind: 'key', key: 'Meta+a' }).success).toBe(true);
    for (const k of ['Enter', 'Backspace', 'ArrowLeft', 'Shift+Tab', 'Control+Shift+z']) expect(LIVE_KEY.test(k), k).toBe(true);
    for (const k of ['rm -rf', 'Enter;Tab', 'Hyper+a']) expect(LIVE_KEY.test(k), k).toBe(false);
  });

  it('refuses a disallowed address without launching a browser, and caps open tabs', async () => {
    let launches = 0;
    const m = new LiveBrowserManager({ launch: async () => { launches++; throw new Error('no browser in unit tests'); } });
    await expect(m.open({ url: 'http://example.com' })).rejects.toThrow(/https/);
    expect(launches).toBe(0);
    await expect(m.frame('lbr_missing00')).rejects.toThrow(/closed/);
    expect(MAX_SESSIONS).toBe(3);
    await m.shutdown();
  });
});
