// Operational log (JSON lines), kept separate from the user-visible audit trail (manual §38). It rotates by size, so a
// long-running daemon never grows it without bound: daemon.log, then daemon.log.1 … daemon.log.<keep>.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { redactDeep } from '@atlas/contracts';

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 3;

/** Shift daemon.log → .1 → .2 …, dropping the oldest. Returns whether it rotated. */
export function rotateLog(file: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP, force = false): boolean {
  try {
    if (!existsSync(file) || (!force && statSync(file).size < maxBytes)) return false;
    rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    renameSync(file, `${file}.1`);
    return true;
  } catch { return false; }
}

export function createLogger(dir: string, o: { maxBytes?: number; keep?: number } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'daemon.log');
  let writes = 0;
  const write = (level: 'info' | 'warn' | 'error', msg: string, data: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...redactDeep(data) });
    // Checked every 200 lines: a stat per line would cost more than the log is worth.
    if (++writes % 200 === 0) rotateLog(file, o.maxBytes, o.keep);
    try { appendFileSync(file, line + '\n'); } catch { /* disk full: logging never takes the daemon down */ }
    if (level !== 'info') process.stderr.write(line + '\n');
  };
  return { file, info: (m: string, d?: Record<string, unknown>) => write('info', m, d), warn: (m: string, d?: Record<string, unknown>) => write('warn', m, d), error: (m: string, d?: Record<string, unknown>) => write('error', m, d) };
}
export type Logger = Pick<ReturnType<typeof createLogger>, 'info' | 'warn' | 'error'> & { file?: string };
