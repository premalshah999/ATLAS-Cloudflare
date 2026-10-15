// web_fetch (ADR 0030): one GET of a public page, read as text. Connections go only to public addresses (checked on
// the resolved address of every hop), redirects are followed by hand and checked again, answers are capped in size
// and time, and nothing is sent but the request line and a few plain headers: no cookies, no credentials.
import http from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable as NodeReadable } from 'node:stream';
import { guardedLookup, isPublicAddress, urlProblem, type AddressFilter } from './guard';
import { htmlToText } from './html';

export interface FetchedPage {
  ok: boolean;
  url: string;
  status: number | null;
  contentType: string;
  title: string;
  text: string;
  bytes: number;
  ms: number;
  redirects: string[];
  /** Why there is no text (refused, failed, not text). */
  error: string | null;
}

export interface FetchOptions {
  signal: AbortSignal;
  allowed?: AddressFilter;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml|x-yaml|yaml|toml)|[^;]*\+(json|xml))/i;

function once(url: URL, o: Required<Omit<FetchOptions, 'signal'>> & { signal: AbortSignal }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET', lookup: guardedLookup(o.allowed) as never, signal: o.signal, timeout: o.timeoutMs,
      headers: { 'User-Agent': o.userAgent, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' },
    }, (res) => {
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
      let stream: NodeReadable = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(createGunzip());
      else if (enc === 'deflate') stream = res.pipe(createInflate());
      else if (enc === 'br') stream = res.pipe(createBrotliDecompress());
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (c: Buffer) => {
        if (truncated) return;
        size += c.length;
        if (size > o.maxBytes) { truncated = true; chunks.push(c.subarray(0, c.length - (size - o.maxBytes))); res.destroy(); stream.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }));
      stream.on('error', (e) => { if (!truncated) reject(e); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`no answer within ${Math.round(o.timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

function decode(body: Buffer, contentType: string): string {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset, { fatal: false }).decode(body); } catch { return new TextDecoder('utf-8').decode(body); }
}

export async function fetchPage(raw: string, opts: FetchOptions): Promise<FetchedPage> {
  const o = { allowed: isPublicAddress, maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 5, userAgent: 'ATLAS-agent/1 (+https://github.com/premalshah999/atlas)', ...opts };
  const t0 = Date.now();
  const redirects: string[] = [];
  const fail = (url: string, error: string, status: number | null = null): FetchedPage => ({ ok: false, url, status, contentType: '', title: '', text: '', bytes: 0, ms: Date.now() - t0, redirects, error });
  let url = raw;
  for (let hop = 0; ; hop++) {
    const problem = urlProblem(url, o.allowed);
    if (problem) return fail(url, `Refused: ${problem}`);
    let r;
    try { r = await once(new URL(url), o); } catch (e) {
      if (o.signal.aborted) return fail(url, 'Cancelled');
      const code = (e as { code?: string }).code;
      return fail(url, code === 'EATLASBLOCKED' ? `Refused: ${(e as Error).message}` : `Could not load the page: ${(e as Error).message}${code && !(e as Error).message.includes(code) ? ` (${code})` : ''}`);
    }
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      if (hop >= o.maxRedirects) return fail(url, `Too many redirects (more than ${o.maxRedirects})`, r.status);
      const next = new URL(String(r.headers.location), url).toString();
      redirects.push(`${r.status} → ${next}`);
      url = next;
      continue;
    }
    const contentType = String(r.headers['content-type'] ?? '').toLowerCase();
    const base: FetchedPage = { ok: r.status < 400, url, status: r.status, contentType, title: '', text: '', bytes: r.body.length, ms: Date.now() - t0, redirects, error: null };
    if (!contentType.includes('html') && contentType && !TEXTUAL.test(contentType)) {
      return { ...base, ok: false, error: `Not a text page (${contentType.split(';')[0]}, ${r.body.length} bytes)` };
    }
    const body = decode(r.body, contentType);
    const html = contentType.includes('html') || (!contentType && /^\s*(<!doctype html|<html)/i.test(body));
    const read = html ? htmlToText(body, url) : { title: '', text: body };
    return { ...base, title: read.title, text: `${read.text}${r.truncated ? `\n… [page cut at ${Math.round(o.maxBytes / 1024)} KB]` : ''}`, error: r.status >= 400 ? `HTTP ${r.status}` : null };
  }
}
