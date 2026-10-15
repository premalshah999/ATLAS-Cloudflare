// Web access in the real app (ADR 0030): turn it on, see the search accounts (three trial keys from the launching
// shell, as on a system without a credential store), test them against a fake provider on loopback, watch an account
// that is out of searches rest and come back, and keep every key out of the interface.
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { launch } from './app';

const KEYS = ['tvly-trial-one-0001', 'tvly-trial-two-0002', 'tvly-trial-three-0003'];

async function fakeTavily() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const key = String(req.headers.authorization ?? '').replace('Bearer ', '');
    seen.push(`${req.method} ${req.url} ${key}`);
    res.setHeader('content-type', 'application/json');
    if (req.url !== '/api.tavily.com/search') { res.statusCode = 404; res.end('{}'); return; }
    if (key === KEYS[0]) { res.statusCode = 432; res.end(JSON.stringify({ detail: { error: "This request exceeds your plan's set usage limit." } })); return; }
    if (key === KEYS[2]) { res.statusCode = 401; res.end(JSON.stringify({ detail: { error: 'Unauthorized: missing or invalid API key.' } })); return; }
    res.end(JSON.stringify({ results: [{ title: 'Example', url: 'https://example.com/', content: 'x' }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() };
}

test('web access: search accounts take turns, rest when out of searches, and their keys stay out of the interface', async () => {
  const provider = await fakeTavily();
  const { app, page } = await launch({ env: { TAVILY_API_KEY: KEYS.join(','), ATLAS_WEB_TEST_BASE: provider.base } });
  try {
    await page.getByRole('button', { name: 'Settings' }).first().click();
    const section = page.getByTestId('web-settings');
    await section.scrollIntoViewIfNeeded();
    // Off until the operator turns it on.
    await expect(section.getByTestId('web-role-coder')).toHaveCount(0);
    await section.getByTestId('web-enabled').getByRole('switch').click();
    await expect(section.getByTestId('web-role-coder')).toBeVisible();

    const accounts = section.getByTestId('web-account');
    await expect(accounts).toHaveCount(3);
    await expect(accounts.nth(0)).toContainText('Tavily (environment 1)');
    await expect(accounts.nth(0)).toContainText('from the environment');
    await expect(accounts.nth(0)).toHaveAttribute('data-health', 'ready');

    // Trial 1 is out of searches: it rests, with the provider's words.
    await accounts.nth(0).getByTestId('web-account-test').click();
    await expect(accounts.nth(0)).toHaveAttribute('data-health', 'quota');
    await expect(accounts.nth(0)).toContainText(/Out of searches until/);
    await expect(accounts.nth(0).getByTestId('web-account-error')).toContainText("432: This request exceeds your plan's set usage limit.");
    // Trial 2 works and counts the search.
    await accounts.nth(1).getByTestId('web-account-test').click();
    await expect(accounts.nth(1)).toHaveAttribute('data-health', 'ready');
    await expect(accounts.nth(1).getByTestId('web-account-usage')).toHaveText('1 today · 1 this month');
    // Trial 3's key is rejected: it stays out until the key changes or the operator says so.
    await accounts.nth(2).getByTestId('web-account-test').click();
    await expect(accounts.nth(2)).toHaveAttribute('data-health', 'rejected');
    await accounts.nth(0).getByTestId('web-account-reset').click();
    await expect(accounts.nth(0)).toHaveAttribute('data-health', 'ready');

    // Allowed sites are saved as host names.
    await section.getByTestId('web-sites').fill('developer.mozilla.org\n*.python.org');
    await section.getByTestId('web-sites-save').click();
    await expect(section.getByTestId('web-sites-save')).toBeDisabled();

    // Adding an account: the form needs a key before it can be saved.
    await section.getByTestId('web-add-account').click();
    await expect(section.getByTestId('web-form-save')).toBeDisabled();
    await section.getByTestId('web-form-key').fill('tvly-new-key-123');
    await expect(section.getByTestId('web-form-save')).toBeEnabled();

    // The provider saw each key once, from the daemon; the interface never shows one.
    expect(provider.seen).toEqual(KEYS.map((k) => `POST /api.tavily.com/search ${k}`));
    const html = await page.content();
    for (const k of KEYS) expect(html).not.toContain(k);
  } finally {
    await app.close();
    provider.close();
  }
});
