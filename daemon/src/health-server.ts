/**
 * Tiny HTTP server for liveness checks. Exposes:
 *
 *   GET /health  → JSON daemon state (200 always; the body tells you what)
 *   GET /        → same as /health
 *
 * Intentionally minimal — no auth, no other endpoints. Railway public
 * URL is fine to leave open because the response only describes the
 * daemon's tick state (no secrets, no captures, no tokens).
 *
 * Listens on the PORT env var Railway injects (defaults to 8080 locally).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type { Scheduler } from './scheduler.js';

const DEFAULT_PORT = 8080;

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
      const body = JSON.stringify(
        {
          status: 'ok',
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
          uptimeSec: process.uptime(),
        },
        null,
        2,
      );
      res.writeHead(200, {
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
