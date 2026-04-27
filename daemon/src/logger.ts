/**
 * pino logger for the daemon.
 *
 * - Local dev: pino-pretty transport for human-readable colored output.
 * - Railway: structured JSON to stdout — Railway's log viewer ingests it.
 *
 * Sentry capture is wired in `index.ts` via `Sentry.init` — errors logged
 * with `logger.error({ err })` are NOT auto-captured by Sentry; the caller
 * must `Sentry.captureException(err)` explicitly. This mirrors the api/_lib
 * pattern and keeps the dependency direction one-way.
 */

import pino, { type Logger } from 'pino';

export function makeLogger(level: string): Logger {
  // Detect Railway by RAILWAY_ENVIRONMENT; everything else is treated as
  // local dev and gets pretty-printed.
  const isRailway = process.env.RAILWAY_ENVIRONMENT !== undefined;
  const isProd = isRailway || process.env.NODE_ENV === 'production';

  if (isProd) {
    return pino({
      level,
      formatters: {
        level: (label) => ({ level: label }),
      },
      base: null,
    });
  }

  return pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  });
}
