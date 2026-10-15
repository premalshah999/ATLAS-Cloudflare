import { describe, expect, it } from 'vitest';
import { artifactsRemote, workerUrl } from '../src';

describe('Cloudflare publication boundaries', () => {
  it('accepts only HTTPS Worker origins without credentials', () => {
    expect(workerUrl('https://atlas.example')).toBe('https://atlas.example');
    for (const url of ['http://atlas.example', 'https://user:pass@atlas.example', 'https://atlas.example/path', 'https://atlas.example/?token=x']) expect(() => workerUrl(url)).toThrow();
  });
  it('rejects token exfiltration destinations and credentials in remotes', () => {
    const host = `${'a'.repeat(32)}.artifacts.cloudflare.net`;
    expect(artifactsRemote(`https://${host}/git/atlas/demo.git`)).toContain(host);
    for (const url of [`https://${host}.evil.test/git/a/b.git`, `http://${host}/git/a/b.git`, `https://x:y@${host}/git/a/b.git`, 'https://evil.test/git/a/b.git']) expect(() => artifactsRemote(url)).toThrow();
  });
});
