// `atlas.config.json` in a repository (manual §28, §25, §30–31). Repository content is untrusted:
// everything it starts runs in the OS sandbox and is shown in the plan before approval.
import { z } from 'zod';

const argv = z.array(z.string().min(1).max(1000)).min(1).max(50);
const relPath = z.string().regex(/^\/[^\s]*$/, 'must be an absolute URL path like /healthz').max(2000);

export const BrowserStep = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), path: relPath }).strict(),
  z.object({ action: z.literal('click'), selector: z.string().max(500).optional(), text: z.string().max(500).optional(), role: z.string().max(40).optional(), name: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('fill'), selector: z.string().min(1).max(500), value: z.string().max(10_000) }).strict(),
  z.object({ action: z.literal('select'), selector: z.string().min(1).max(500), value: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('press'), key: z.string().min(1).max(40), selector: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('expectText'), text: z.string().min(1).max(2000), selector: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('expectNoText'), text: z.string().min(1).max(2000), selector: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('expectUrl'), path: relPath }).strict(),
  z.object({ action: z.literal('expectVisible'), selector: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal('screenshot'), name: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('wait'), ms: z.number().int().min(0).max(10_000) }).strict(),
]);
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
