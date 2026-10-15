import { describe, expect, it, vi, afterEach } from 'vitest';
import worker from '../src/index';
afterEach(() => vi.restoreAllMocks());
const secret = 'test-connection-token-with-at-least-32-characters';
const request = (path: string, body: unknown = {}, token = secret) => new Request(`https://worker.example${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
describe('Worker authorization and verification', () => {
  it('denies missing/wrong authentication without calling Artifacts', async () => {
    const get = vi.fn();
    const response = await worker.fetch(request('/repos/atlas-test/connect', {}, 'wrong'), { ARTIFACTS: { get } as any, ATLAS_CLOUD_TOKEN: secret });
    expect(response.status).toBe(401); expect(get).not.toHaveBeenCalled();
  });
  it('refuses verification of arbitrary refs', async () => {
    const get = vi.fn();
    const response = await worker.fetch(request('/repos/atlas-test/verify', { refs: [{ ref: 'HEAD', sha: 'a'.repeat(40) }] }), { ARTIFACTS: { get } as any, ATLAS_CLOUD_TOKEN: secret });
    expect(response.status).toBe(400); expect(get).not.toHaveBeenCalled();
  });
  it('reports a remote mismatch as unverified and disposes the handle', async () => {
    const dispose = vi.fn();
    const log = vi.fn(async () => [{ hash: 'b'.repeat(40) }]);
    const get = vi.fn(async () => ({ log, [Symbol.dispose]: dispose }));
    const response = await worker.fetch(request('/repos/atlas-test/verify', { refs: [{ ref: 'refs/heads/main', sha: 'a'.repeat(40) }] }), { ARTIFACTS: { get } as any, ATLAS_CLOUD_TOKEN: secret });
    expect(response.status).toBe(200); expect(((await response.json()) as { verified: boolean }).verified).toBe(false); expect(dispose).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith({ ref: 'main', limit: 1 });
  });
  it('never returns upstream credential-bearing exceptions', async () => {
    const get = vi.fn(async () => { throw new Error('secret-art_v1_hidden'); });
    const response = await worker.fetch(request('/repos/atlas-test/connect'), { ARTIFACTS: { get } as any, ATLAS_CLOUD_TOKEN: secret });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('secret-art_v1');
  });
});
