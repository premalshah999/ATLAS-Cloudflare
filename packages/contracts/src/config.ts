// `atlas.config.json` in a repository (manual §28, §25, §30–31). Repository content is untrusted:
// everything it starts runs in the OS sandbox and is shown in the plan before approval.
import { z } from 'zod';

const argv = z.array(z.string().min(1).max(1000)).min(1).max(50);
const relPath = z.string().regex(/^\/[^\s]*$/, 'must be an absolute URL path like /healthz').max(2000);

/** An element from the latest `snapshot`, e.g. "e12" (ADR 0027). */
const ref = z.string().regex(/^e\d{1,5}$/, 'a ref from the latest snapshot, like e12');
export const BrowserStep = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), path: relPath }).strict(),
  z.object({ action: z.literal('click'), ref: ref.optional(), selector: z.string().max(500).optional(), text: z.string().max(500).optional(), role: z.string().max(40).optional(), name: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('fill'), ref: ref.optional(), selector: z.string().min(1).max(500).optional(), value: z.string().max(10_000) }).strict(),
  // The page as an agent reads it: interactive and text elements, each with a ref the next steps can target.
  z.object({ action: z.literal('snapshot'), selector: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('hover'), ref: ref.optional(), selector: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('select'), ref: ref.optional(), selector: z.string().max(500).optional(), value: z.string().max(500) }).strict(),
  z.object({ action: z.literal('check'), ref: ref.optional(), selector: z.string().max(500).optional(), checked: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal('reload') }).strict(),
  z.object({ action: z.literal('back') }).strict(),
  z.object({ action: z.literal('viewport'), width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2160) }).strict(),
  // What the page logged and requested since the session started (or since the last read of each).
  z.object({ action: z.literal('console') }).strict(),
  z.object({ action: z.literal('network') }).strict(),
  z.object({ action: z.literal('press'), key: z.string().min(1).max(40), selector: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('expectText'), text: z.string().min(1).max(2000), selector: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('expectNoText'), text: z.string().min(1).max(2000), selector: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('expectUrl'), path: relPath }).strict(),
  z.object({ action: z.literal('expectVisible'), selector: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal('screenshot'), name: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('wait'), ms: z.number().int().min(0).max(10_000) }).strict(),
]).superRefine((s, ctx) => {
  // Actions on one element take it by ref (from the latest snapshot) or by selector.
  if (['fill', 'hover', 'select', 'check'].includes(s.action) && !('ref' in s && s.ref) && !('selector' in s && s.selector)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${s.action} needs a ref or a selector` });
});
export type BrowserStep = z.infer<typeof BrowserStep>;

export const ApiCheck = z.object({
  name: z.string().min(1).max(100),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  path: relPath,
  body: z.string().max(100_000).optional(),
  headers: z.record(z.string().max(200), z.string().max(2000)).optional(),
  expectStatus: z.number().int().min(100).max(599).default(200),
  bodyIncludes: z.string().max(2000).optional(),
  maxLatencyMs: z.number().int().min(1).max(120_000).optional(),
  required: z.boolean().default(true),
}).strict();
export type ApiCheck = z.infer<typeof ApiCheck>;

export const AtlasConfig = z.object({
  version: z.literal(1),
  checks: z.array(z.object({ name: z.string().regex(/^[a-z0-9:_-]{1,40}$/i), command: argv, required: z.boolean().default(true), timeoutSec: z.number().int().min(1).max(3600).default(600) }).strict()).max(20).default([]),
  app: z.object({
    start: argv,
    port: z.number().int().min(1024).max(65535).optional(),
    readyPath: relPath.default('/'),
    readyTimeoutSec: z.number().int().min(1).max(600).default(60),
    env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(2000)).default({}),
  }).strict().optional(),
  browser: z.object({
    failOnConsoleErrors: z.boolean().default(true),
    flows: z.array(z.object({ name: z.string().min(1).max(100), required: z.boolean().default(true), steps: z.array(BrowserStep).min(1).max(100) }).strict()).max(50).default([]),
  }).strict().optional(),
  api: z.array(ApiCheck).max(100).default([]),
  /**
   * Visual proof (ADR 0027): the pages ATLAS renders at the mission's base and at its result, and compares. Without
   * this section: "/" and the pages the browser flows open.
   */
  visual: z.object({
    enabled: z.boolean().default(true),
    pages: z.array(z.object({ name: z.string().min(1).max(60), path: relPath }).strict()).max(10).optional(),
    /** Share of pixels that may differ before a page counts as changed (anti-aliasing, cursors). */
    thresholdPercent: z.number().min(0).max(50).default(0.1),
    viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2160) }).strict().default({ width: 1280, height: 800 }),
  }).strict().optional(),
  deploy: z.object({
    target: z.string().min(1).max(100),
    provider: z.enum(['local', 'command']),
    /** local: the app block is served from an ATLAS-managed release directory. command: run this to deploy. */
    command: argv.optional(),
    /** command provider: how to read the deployed URL and id from stdout. */
    urlPattern: z.string().max(500).optional(),
    idPattern: z.string().max(500).optional(),
    rollbackCommand: argv.optional(),
    logsCommand: argv.optional(),
    /** Path that returns the deployed revision (the commit). Required to pass staging verification. */
    versionPath: relPath.optional(),
    readyPath: relPath.default('/'),
    readyTimeoutSec: z.number().int().min(1).max(1800).default(120),
    errorLogPattern: z.string().max(500).optional(),
    maxErrorRate: z.number().min(0).max(1).default(0),
    syntheticRequests: z.number().int().min(0).max(1000).default(20),
    latencyP95Ms: z.number().int().min(1).max(120_000).optional(),
  }).strict().optional(),
}).strict();
export type AtlasConfig = z.infer<typeof AtlasConfig>;

export const CONFIG_FILE = 'atlas.config.json';
