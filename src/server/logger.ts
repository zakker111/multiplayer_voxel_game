/**
 * Structured server logger with levels, timestamps, and optional file output.
 *
 * Configuration via environment variables:
 *   LOG_LEVEL  = debug | info | warn | error   (default: info)
 *   LOG_FILE   = path to a log file            (e.g. /home/admin/logs/game.log)
 *
 * Every line is emitted both to stdout/stderr (so Render's live log viewer and
 * `docker logs` show it) and, if LOG_FILE is set, appended to that file so an
 * operator can tail it or run CLI admin commands against a running server.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const TAGS: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

class Logger {
  private threshold: number;
  private filePath: string | null = null;

  constructor() {
    const level = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
    this.threshold = LEVELS[level] ?? LEVELS.info;
    if (process.env.LOG_FILE) {
      try {
        this.filePath = process.env.LOG_FILE;
      } catch {
        this.filePath = null;
      }
    }
  }

  private format(level: LogLevel, scope: string, msg: string, meta?: unknown): string {
    const ts = new Date().toISOString();
    let line = `${ts} [${TAGS[level]}] [${scope}] ${msg}`;
    if (meta !== undefined) {
      try {
        line += ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
      } catch {
        line += ` [unserializable meta]`;
      }
    }
    return line;
  }

  private emit(level: LogLevel, scope: string, msg: string, meta?: unknown): void {
    if (LEVELS[level] < this.threshold) return;
    const line = this.format(level, scope, msg, meta);
    if (level === 'error') console.error(line);
    else console.log(line);
    if (this.filePath) {
      try {
        // Lazy require keeps this module usable in bundled/browser contexts
        // where 'fs' is unavailable.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        fs.appendFileSync(this.filePath, line + '\n');
      } catch {
        // File logging is best-effort; never crash the game loop over it.
      }
    }
  }

  debug(scope: string, msg: string, meta?: unknown): void { this.emit('debug', scope, msg, meta); }
  info(scope: string, msg: string, meta?: unknown): void { this.emit('info', scope, msg, meta); }
  warn(scope: string, msg: string, meta?: unknown): void { this.emit('warn', scope, msg, meta); }
  error(scope: string, msg: string, meta?: unknown): void { this.emit('error', scope, msg, meta); }
}

export const logger = new Logger();

/** Create a child logger that prefixes every line with [name]. */
export function createLogger(name: string) {
  return {
    debug: (msg: string, meta?: unknown) => logger.debug(name, msg, meta),
    info: (msg: string, meta?: unknown) => logger.info(name, msg, meta),
    warn: (msg: string, meta?: unknown) => logger.warn(name, msg, meta),
    error: (msg: string, meta?: unknown) => logger.error(name, msg, meta),
  };
}
