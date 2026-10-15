// ADR 0018 through the real app: add MCP servers from Settings, keep their secrets out of the interface, test the
// connection, and narrow the tools agents get. A fake server stands in for real ones (no network).
import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './app';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../../packages/mcp/test/fake-server.cjs');
const TOKEN = 'Bearer good-token';

async function remoteServer(): Promise<{ url: string; proc: ChildProcess }> {
  const port = await new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
  const proc = spawn(process.execPath, [SERVER, '--http', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => proc.stdout!.once('data', r));
  return { url: `http://127.0.0.1:${port}/mcp`, proc };
}

test('MCP servers: add remote and local servers, save a secret, test, narrow tools', async () => {
  const remote = await remoteServer();
  // No OS credential store under CI's virtual display: the secret comes from the launching shell, as documented.
  const { app, page } = await launch({ env: { ATLAS_MCP_SECRET_DOCS_AUTHORIZATION: TOKEN } });
  try {
    await page.getByRole('button', { name: 'Settings' }).first().click();
    const section = page.getByTestId('mcp-servers');
    await section.scrollIntoViewIfNeeded();

    // Remote server with a secret header.
    await page.getByTestId('mcp-add-http').click();
    await page.getByTestId('mcp-form-name').fill('docs');
    await page.getByTestId('mcp-form-url').fill('http://example.com/mcp');
    await expect(page.getByTestId('mcp-form-save')).toBeDisabled();
    await page.getByTestId('mcp-form-url').fill(remote.url);
    await page.getByTestId('mcp-form-secrets').fill('authorization');
    await page.getByTestId('mcp-form-save').click();
    const docs = page.getByTestId('mcp-docs');
    await expect(docs).toContainText('asks before each call');
    await expect(docs.locator('.at-badge', { hasText: /^set$/ })).toHaveCount(1);
    await page.getByTestId('mcp-docs-test').click();
    await expect(docs).toContainText('8 of 8 tools offered');

    // Offer only one tool.
    await docs.locator('summary').click();
    await docs.getByText('Every tool the server lists').click();
    await expect(docs).toContainText('8 of 8 tools offered');
    // Each box saves before it changes (controlled by the daemon's state): click, then wait for the new state.
    for (const t of ['env', 'read', 'net', 'leak', 'big', 'ask', 'fail']) {
      await page.getByTestId(`mcp-docs-tool-${t}`).click();
      await expect(page.getByTestId(`mcp-docs-tool-${t}`)).not.toBeChecked();
    }
    await expect(docs).toContainText('1 of 8 tools offered');

    const view = await page.evaluate(async () => {
      const a = (window as any).atlas;
      const list = await a.invoke('mcp.list', {});
      let rejected = '';
      try { await a.invoke('mcp.save', { server: { name: 'evil', transport: 'http', url: 'https://user:pw@example.com/mcp' } }); } catch (e) { rejected = (e as Error).message; }
      return { list: JSON.stringify(list), rejected };
    });
    expect(view.list).not.toContain('good-token');
    expect(view.list).toContain('"tools":["echo"]');
    expect(view.rejected).toBeTruthy();

    // A local server runs in the OS sandbox and may read only the folders given (Windows: see ADR 0016).
    if (process.platform !== 'win32') {
      await page.getByTestId('mcp-add-stdio').click();
      await page.getByTestId('mcp-form-name').fill('local');
      await page.getByTestId('mcp-form-command').fill(process.execPath);
      await page.getByTestId('mcp-form-args').fill(SERVER);
      await page.getByTestId('mcp-form-save').click();
      await page.getByTestId('mcp-local-test').click();
      await expect(page.getByTestId('mcp-local-error')).toContainText('exited before answering');
      await page.getByTestId('mcp-local').getByRole('button', { name: 'Edit' }).click();
      await page.getByTestId('mcp-form-paths').fill(path.dirname(SERVER));
      await page.getByTestId('mcp-form-save').click();
      await page.getByTestId('mcp-local-test').click();
      await expect(page.getByTestId('mcp-local')).toContainText('8 of 8 tools offered');
      await expect(page.getByTestId('mcp-local')).toContainText('no network');
    }

    page.on('dialog', (d) => void d.accept());
    await docs.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByTestId('mcp-docs')).toHaveCount(0);
  } finally { await app.close(); remote.proc.kill(); }
});
