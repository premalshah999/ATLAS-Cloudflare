// Authenticated repository broker. No provider keys ever reach this Worker.
export interface Env { ARTIFACTS: Artifacts; ATLAS_CLOUD_TOKEN: string }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const namePattern = /^atlas-[a-zA-Z0-9_-]{1,100}$/;

async function authorized(request: Request, secret: string | undefined) {
  if (!secret || secret.length < 32) return false;
  const expected = new TextEncoder().encode(`Bearer ${secret}`);
  const actual = new TextEncoder().encode(request.headers.get('Authorization') ?? '');
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', expected), crypto.subtle.digest('SHA-256', actual)]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ service: 'ATLAS', storage: 'Cloudflare Artifacts', version: 1 });
    if (!(await authorized(request, env.ATLAS_CLOUD_TOKEN))) return json({ error: 'Unauthorized' }, 401);
    const match = /^\/repos\/(atlas-[a-zA-Z0-9_-]{1,100})\/(connect|verify)$/.exec(url.pathname);
    if (!match || request.method !== 'POST') return json({ error: 'Not found' }, 404);
    const [, name, action] = match;
    if (!namePattern.test(name)) return json({ error: 'Invalid repository' }, 400);
    try {
      if (action === 'connect') {
        let repo: ArtifactsRepo;
        try { repo = await env.ARTIFACTS.get(name); }
        catch (e) {
          if (!String((e as { code?: string }).code ?? e).includes('NOT_FOUND')) throw e;
          await env.ARTIFACTS.create(name, { description: 'ATLAS mission checkpoints', setDefaultBranch: 'main' });
          repo = await env.ARTIFACTS.get(name);
        }
        using handle = repo;
        const info = await handle.info();
        const token = await handle.createToken('write', 600);
        return json({ name, remote: info.remote, token: token.plaintext, expiresAt: token.expiresAt });
      }
      const raw = await request.text();
      if (raw.length > 32_000) return json({ error: 'Request too large' }, 413);
      const body = JSON.parse(raw) as { refs?: { ref: string; sha: string }[] };
      if (!Array.isArray(body.refs) || body.refs.length < 1 || body.refs.length > 100 || body.refs.some((r) =>
        typeof r.ref !== 'string' || !/^refs\/heads\/(main|atlas\/[a-zA-Z0-9_/-]+)$/.test(r.ref) || !/^[a-f0-9]{40}$/.test(r.sha))) return json({ error: 'Invalid refs' }, 400);
      using repo = await env.ARTIFACTS.get(name);
      const refs = await Promise.all(body.refs.map(async ({ ref, sha }) => {
        const history = await repo.log({ ref: ref.slice('refs/heads/'.length), limit: 1 });
        const actual = history[0]?.hash ?? null;
        return { ref, expected: sha, actual, matches: actual === sha };
      }));
      return json({ name, verified: refs.every((r) => r.matches), refs, checkedAt: new Date().toISOString() });
    } catch (e) {
      if (e instanceof SyntaxError) return json({ error: 'Invalid JSON' }, 400);
      // Never echo upstream exceptions: they may contain credentials.
      return json({ error: 'Artifacts operation failed. Check namespace access and Worker logs.' }, 502);
    }
  },
};
