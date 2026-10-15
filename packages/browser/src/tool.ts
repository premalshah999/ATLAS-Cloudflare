// browser_action for the browser_qa role: the app is started from the task's worktree on first use,
// one isolated browser session per attempt, closed when the attempt ends.
import { z } from 'zod';
import { BrowserStep, type AtlasConfig, type StageSandbox, type ToolResult } from '@atlas/contracts';
import { loadConfig } from '@atlas/workspace';
import { BrowserSession } from './session';
import { startApp, type RunningApp } from './app';

export const BrowserActionArgs = z.object({ step: BrowserStep }).strict();

export interface BrowserTool { invoke(args: unknown, signal: AbortSignal): Promise<ToolResult>; dispose(): Promise<void> }

export function createBrowserTool(o: { worktree: string; sandbox: StageSandbox; putScreenshot(name: string, png: Buffer): string; emit(payload: Record<string, unknown>, artifactIds: string[]): void }): BrowserTool {
  let app: RunningApp | null = null;
  let session: BrowserSession | null = null;
  const fail = (output: string): ToolResult => ({ ok: false, output, exitCode: null, artifactIds: [], error: 'process_failed' });
  return {
    async invoke(raw, signal) {
      const parsed = BrowserActionArgs.safeParse(raw);
      if (!parsed.success) return { ok: false, output: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, exitCode: null, artifactIds: [], error: 'invalid_args' };
      if (!session) {
        const { config, error } = loadConfig(o.worktree);
        if (!config?.app) return fail(error ?? 'No app section in atlas.config.json; there is nothing to open in the browser.');
        try { app = await startApp(o.sandbox, (config as AtlasConfig).app!, { signal }); }
        catch (e) { return fail((e as Error).message); }
        session = new BrowserSession(app.baseUrl);
        try { await session.open(); } catch (e) { await app.stop(); app = null; session = null; return fail((e as Error).message); }
      }
      const r = await session.step(parsed.data.step);
      const ids: string[] = [];
      if (r.screenshot) ids.push(o.putScreenshot(`${parsed.data.step.action}${r.ok ? '' : ' (failed)'}`, r.screenshot));
      o.emit({ action: parsed.data.step.action, ok: r.ok, message: r.message, url: r.url }, ids);
      const obs = session.observed;
      const notes = [obs.consoleErrors.length ? `${obs.consoleErrors.length} console error(s), latest: ${obs.consoleErrors.at(-1)}` : '', obs.blockedNavigations.length ? `blocked navigation to ${obs.blockedNavigations.at(-1)}` : ''].filter(Boolean).join('\n');
      // What the page shows or logged is data from the app under test, never instructions.
      const read = r.text !== undefined ? `\n<page-${parsed.data.step.action}>\n${r.text}\n</page-${parsed.data.step.action}>` : '';
      return { ok: r.ok, output: `${r.message}\nURL: ${r.url}${ids.length ? `\nScreenshot: ${ids[0]}` : ''}${notes ? `\n${notes}` : ''}${read}`, exitCode: null, artifactIds: ids, error: r.ok ? null : 'process_failed' };
    },
    async dispose() {
      await session?.close();
      await app?.stop();
      session = null; app = null;
    },
  };
}
