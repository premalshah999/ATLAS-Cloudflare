import { expect, it } from 'vitest';
import { BrowserSession, resolveBrowser } from '../src';

it.skipIf(!resolveBrowser().path)('selects a real dropdown without submitting its form and refuses an absent option', async () => {
  const session = new BrowserSession('http://127.0.0.1:4321');
  await session.open();
  try {
    await session.page!.setContent('<form onsubmit="window.submitted=true;return false"><select id="status"><option value="todo">To do</option><option value="done">Complete</option></select><button>Save</button></form>');
    const good = await session.step({ action: 'select', selector: '#status', value: 'done' });
    expect(good.ok).toBe(true);
    expect(await session.page!.locator('#status').inputValue()).toBe('done');
    expect(await session.page!.evaluate(() => (window as unknown as { submitted?: boolean }).submitted)).toBeUndefined();
    const bad = await session.step({ action: 'select', selector: '#status', value: 'absent' }, 150);
    expect(bad.ok).toBe(false);
    expect(await session.page!.locator('#status').inputValue()).toBe('done');
    expect(await session.page!.evaluate(() => (window as unknown as { submitted?: boolean }).submitted)).toBeUndefined();
  } finally { await session.close(); }
});
