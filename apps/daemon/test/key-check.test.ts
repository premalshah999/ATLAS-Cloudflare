// credentials.test: a free key check at the provider's official API. DeepSeek is reached only at api.deepseek.com,
// and a valid key without balance is reported as such, not as a configuration failure.
import { afterEach, expect, it, vi } from 'vitest';
import { tmpDir } from '../../../tests/helpers';
import { DaemonService } from '../src/service';

const KEY = 'sk-deepseek-unit-test-0000000000';
afterEach(() => vi.unstubAllGlobals());

async function check(responses: Record<string, Response>) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    urls.push(url);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    return responses[url] ?? new Response('{}', { status: 404 });
  }));
  const svc = new DaemonService({ dataDir: tmpDir('atlas-keycheck-'), version: 'test', apiKeys: { deepseek: KEY } });
  const r = await svc.handle('credentials.test', { provider: 'deepseek' }) as { ok: boolean; status: number | null; detail: string };
  return { r, urls };
}

it('accepts a valid DeepSeek key with balance, using only the official API', async () => {
  const { r, urls } = await check({
    'https://api.deepseek.com/models': Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }),
    'https://api.deepseek.com/user/balance': Response.json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.20' }] }),
  });
  expect(r.ok).toBe(true);
  expect(r.detail).toContain('2 models');
  expect(r.detail).toContain('4.20 USD');
  expect(urls.every((u) => u.startsWith('https://api.deepseek.com/'))).toBe(true);
  expect(JSON.stringify(r)).not.toContain(KEY);
});

it('reports a rejected key and an empty balance distinctly', async () => {
  expect((await check({ 'https://api.deepseek.com/models': new Response('{}', { status: 401 }) })).r).toMatchObject({ ok: false, status: 401 });
  const empty = (await check({
    'https://api.deepseek.com/models': Response.json({ data: [] }),
    'https://api.deepseek.com/user/balance': Response.json({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] }),
  })).r;
  expect(empty).toMatchObject({ ok: false, status: 402 });
  expect(empty.detail).toContain('no usable balance');
});
