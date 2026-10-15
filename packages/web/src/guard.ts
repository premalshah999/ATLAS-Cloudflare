// Where the agent's web tools may connect (ADR 0030): public internet addresses only. Loopback, private networks,
// link-local (cloud metadata at 169.254.169.254), carrier-grade NAT, multicast and reserved ranges are refused, so a
// page or an agent cannot use ATLAS to reach the operator's machine or local network. The check runs on the
// address actually connected to (a custom DNS lookup), so a name that resolves to a private address is refused even
// when it looked public a moment earlier.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

const V4_BLOCKED: [number, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([ip, bits]) => [v4(ip as string)!, bits as number]);

function v4(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}
const inV4 = (n: number, base: number, bits: number) => bits === 0 || Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));

/** Expand an IPv6 address to eight 16-bit groups; null when it does not parse. */
function v6groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const tail = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) { const n = v4(tail[1]); if (n === null) return null; s = s.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const all = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/** Whether connecting to this IP address reaches the public internet. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, '').split('%')[0]);
  if (kind === 4) {
    const n = v4(ip)!;
    if (n === 0xffffffff) return false;
    return !V4_BLOCKED.some(([base, bits]) => inV4(n, base, bits));
  }
  if (kind === 6) {
    const g = v6groups(ip);
    if (!g) return false;
    if (g.every((x) => x === 0)) return false; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the IPv4 inside.
    const embedded = (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
    if (embedded) return isPublicAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
    if ((g[0] & 0xff00) === 0xff00) return false; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
    if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return false; // discard
    return true;
  }
  return false;
}

/** Names that never mean a public site. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;

export type AddressFilter = (ip: string) => boolean;

/** Why a URL may not be opened by an agent (scheme, credentials, local names, private addresses), or null. */
export function urlProblem(raw: string, allowed: AddressFilter = isPublicAddress): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `only http and https pages can be opened (not ${u.protocol.replace(':', '')})`;
  if (u.username || u.password) return 'URLs with credentials are refused';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'no host';
  if (isIP(host)) return allowed(host) ? null : `${host} is not a public internet address`;
  if (!host.includes('.') || LOCAL_NAME.test(host.replace(/\.$/, ''))) {
    // Tests open local fixtures under a name; the default filter refuses every local name.
    return allowed === isPublicAddress ? `${host} is a local name, not a public site` : null;
  }
  return null;
}

/** A DNS lookup for http(s).request that refuses names resolving to an address the filter rejects. */
export function guardedLookup(allowed: AddressFilter = isPublicAddress) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, cb: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void) => {
    const opts = typeof options === 'number' ? { family: options } : options ?? {};
    dnsLookup(hostname, { all: true, family: opts.family as 0 | 4 | 6 | undefined }, (err, addrs) => {
      if (err) return cb(err);
      const bad = addrs.find((a) => !allowed(a.address));
      if (bad || !addrs.length) {
        const e = Object.assign(new Error(`${hostname} resolves to ${bad?.address ?? 'nothing'}, which is not a public internet address`), { code: 'EATLASBLOCKED' });
        return cb(e);
      }
      if (opts.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

/** Async host check for the browser's request filter, cached briefly per host. */
export function hostChecker(allowed: AddressFilter = isPublicAddress, ttlMs = 60_000) {
  const cache = new Map<string, { ok: string | null; at: number }>();
  return async (host: string): Promise<string | null> => {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    const hit = cache.get(h);
    if (hit && Date.now() - hit.at < ttlMs) return hit.ok;
    let verdict: string | null;
    if (isIP(h)) verdict = allowed(h) ? null : `${h} is not a public internet address`;
    else {
      try {
        const addrs = await dns.lookup(h, { all: true });
        const bad = addrs.find((a) => !allowed(a.address));
        verdict = bad ? `${h} resolves to ${bad.address}, which is not a public internet address` : addrs.length ? null : `${h} does not resolve`;
      } catch (e) { verdict = `${h} does not resolve (${(e as { code?: string }).code ?? 'error'})`; }
    }
    cache.set(h, { ok: verdict, at: Date.now() });
    return verdict;
  };
}
