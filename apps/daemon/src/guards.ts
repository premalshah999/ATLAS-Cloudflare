// Process-level safety nets for the daemon. A promise that rejects with nobody listening must not take every running
// mission down with it (Node's default is to exit). It is logged with its stack and the daemon keeps serving; an
// uncaught synchronous exception still exits, because state after one is unknown, but it is logged first.
export interface GuardLog { error(msg: string, data?: Record<string, unknown>): void }

export function installCrashGuards(log: GuardLog, opts: { exit?: (code: number) => void } = {}): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const describe = (e: unknown) => (e instanceof Error ? { message: e.message, stack: e.stack?.split('\n').slice(0, 8).join('\n') } : { message: String(e) });
  const onRejection = (reason: unknown) => { log.error('unhandled rejection (daemon kept running)', describe(reason)); };
  const onException = (err: unknown) => { log.error('uncaught exception (daemon exiting)', describe(err)); exit(1); };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return () => { process.off('unhandledRejection', onRejection); process.off('uncaughtException', onException); };
}

/** Run `fn` once, however many times the returned function is called (signals can arrive together). */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}
