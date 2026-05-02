/**
 * Tiny HTTP server for liveness checks. Exposes:
 *
 *   GET /health  → JSON daemon state (200 healthy, 503 wedged/stopped)
 *   GET /        → same as /health
 *
 * Returns 503 when EITHER:
 *   - scheduler.status !== 'running' (stopped / never-started)
 *   - lastFailAt > lastSuccessAt && uptime > WEDGED_DAEMON_THRESHOLD_MS
 *     (wedged after recovery window — scheduler still ticking but every
 *     cycle is failing)
 *
 * The recovery-window guard means a single failure right after boot
 * does not immediately flip the probe to 503 — the daemon gets 30 min
 * to recover before Railway is told to bounce it. Once that grace
 * window has passed, every subsequent fail-without-success keeps the
 * probe red until lastSuccessAt advances past lastFailAt.
 *
 * Intentionally minimal — no auth, no other endpoints. Railway public
 * URL is fine to leave open because the response only describes the
 * daemon's tick state (no secrets, no captures, no tokens).
 *
 * Listens on the PORT env var Railway injects (defaults to 8080 locally).
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Logger } from 'pino';
import type { Scheduler, SchedulerState } from './scheduler.js';

const DEFAULT_PORT = 8080;

/**
 * Recovery window before a fail-without-success state is treated as
 * "wedged" by the liveness probe. 30 min covers the worst recoverable
 * outage we've observed in production (browserless cold start +
 * upstream Schwab/UW retries). Past this, Railway should bounce the
 * container.
 */
export const WEDGED_DAEMON_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Decide the HTTP status code for the current daemon state. Pure
 * function, exported for unit testing.
 *
 * @param state    Snapshot from `scheduler.getState()`
 * @param uptimeMs Process uptime in ms (process.uptime() * 1000)
 */
export function computeHealthStatus(
  state: SchedulerState,
  uptimeMs: number,
): 200 | 503 {
  if (state.status !== 'running') {
    return 503;
  }
  const lastFail = state.lastFailAt ? Date.parse(state.lastFailAt) : Number.NaN;
  const lastSuccess = state.lastSuccessAt
    ? Date.parse(state.lastSuccessAt)
    : Number.NaN;
  const failingAfterRecovery =
    Number.isFinite(lastFail) &&
    (!Number.isFinite(lastSuccess) || lastFail > lastSuccess) &&
    uptimeMs > WEDGED_DAEMON_THRESHOLD_MS;
  return failingAfterRecovery ? 503 : 200;
}

export interface HealthServer {
  close: () => Promise<void>;
}

export function startHealthServer(args: {
  scheduler: Scheduler;
  logger: Logger;
  port?: number;
}): HealthServer {
  const { scheduler, logger } = args;
  const port =
    args.port ??
    (process.env.PORT ? Number.parseInt(process.env.PORT, 10) : DEFAULT_PORT);

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/';
    if (url === '/' || url === '/health' || url.startsWith('/health?')) {
      const state = scheduler.getState();
      const uptimeSec = process.uptime();
      const code = computeHealthStatus(state, uptimeSec * 1000);
      const body = JSON.stringify(
        {
          status: code === 200 ? 'ok' : 'unhealthy',
          scheduler: state.status,
          inWindow: state.marketHours.inWindow,
          windowReason: state.marketHours.reason,
          etDate: state.marketHours.etDate,
          etMinutes: state.marketHours.etMinutes,
          inFlight: state.inFlight,
          lastTickAt: state.lastTickAt,
          lastSuccessAt: state.lastSuccessAt,
          lastFailAt: state.lastFailAt,
          lastError: state.lastError,
          lastDurationMs: state.lastDurationMs,
          startedAt: state.startedAt,
          totals: state.totals,
          uptimeSec,
        },
        null,
        2,
      );
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: url }));
  };

  const server = createServer(handler);

  server.listen(port, () => {
    logger.info({ port }, 'Health server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Health server error');
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
