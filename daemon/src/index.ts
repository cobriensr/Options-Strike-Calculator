/**
 * TRACE Live capture daemon — entry point.
 *
 * Boot sequence:
 *   1. Load + validate config (fails fast on missing env)
 *   2. Init Sentry (best-effort — no DSN means in-process logging only)
 *   3. Build the logger
 *   4. Wire the capture cycle: fetch GEX → spawn capture script → POST
 *   5. Start the market-hours scheduler
 *   6. Wire SIGTERM/SIGINT graceful shutdown
 *
 * Run: `npx tsx daemon/src/index.ts` (assumes env loaded via shell or
 * `--env-file=.env` flag). Set `BYPASS_MARKET_HOURS_GATE=1` for testing
 * a single tick outside market hours.
 */

import * as Sentry from '@sentry/node';
import { loadConfig } from './config.js';
import { makeLogger } from './logger.js';
import { createScheduler } from './scheduler.js';
import { runCapture } from './capture.js';
import { fetchGexLandscape } from './gex.js';
import { postTraceLiveAnalyze } from './api-client.js';
import { startHealthServer } from './health-server.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = makeLogger(config.logLevel);

  if (config.sentryDsn) {
    Sentry.init({
      dsn: config.sentryDsn,
      tracesSampleRate: 0,
      // The daemon is a single long-running process; ship errors only.
    });
    logger.info('Sentry initialized');
  } else {
    logger.warn('SENTRY_DSN not set — error capture disabled');
  }

  logger.info(
    {
      endpoint: config.endpoint,
      cadenceSec: config.cadenceMs / 1000,
      bypassMarketHoursGate: config.bypassMarketHoursGate,
    },
    'TRACE Live daemon starting',
  );

  // ── Capture cycle ────────────────────────────────────────────────
  async function tick(): Promise<void> {
    const cycleLogger = logger.child({
      cycle: new Date().toISOString(),
    });

    cycleLogger.info('Cycle start');

    // 1. Capture screenshots (spawns scripts/capture-trace-live.ts)
    const capture = await runCapture({ logger: cycleLogger });
    cycleLogger.info(
      {
        spot: capture.spot,
        stabilityPct: capture.stabilityPct,
        capturedAt: capture.capturedAt,
      },
      'Capture complete',
    );

    // 2. Build GEX landscape from Neon at the same instant
    const gex = await fetchGexLandscape({
      databaseUrl: config.databaseUrl,
      capturedAt: capture.capturedAt,
      logger: cycleLogger,
    });
    if (!gex) {
      cycleLogger.warn('No GEX snapshot — skipping POST this cycle');
      return;
    }

    // 3. POST to /api/trace-live-analyze
    try {
      await postTraceLiveAnalyze({
        endpoint: config.endpoint,
        ownerSecret: config.ownerSecret,
        logger: cycleLogger,
        capturedAt: capture.capturedAt,
        spot: capture.spot,
        stabilityPct: capture.stabilityPct,
        images: capture.images,
        gex,
      });
      cycleLogger.info('POST succeeded');
    } catch (err) {
      cycleLogger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'POST failed (after retries)',
      );
      Sentry.captureException(err);
    }
  }

  // ── Scheduler ────────────────────────────────────────────────────
  const scheduler = createScheduler({
    cadenceMs: config.cadenceMs,
    bypassMarketHoursGate: config.bypassMarketHoursGate,
    logger,
    onTick: tick,
  });

  scheduler.start();

  // Health endpoint — Railway public URL serves /health for liveness
  // checks and ad-hoc "is the daemon alive?" curls. Listens on PORT
  // (Railway injects this; defaults to 8080 locally).
  const health = startHealthServer({ scheduler, logger });

  // Graceful shutdown on SIGTERM / SIGINT — Railway sends SIGTERM with
  // a grace period before SIGKILL.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Received shutdown signal');
    scheduler.stop();
    void health.close().finally(() => {
      void Sentry.close(2000).then(() => {
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Process-level safety nets — these should never fire if the per-tick
  // try/catch is doing its job, but if they do we want a clean Sentry trail.
  // Use Sentry.close() for proper drain (matches the graceful-shutdown path).
  const fatalExit = (): void => {
    void Sentry.close(2000).finally(() => process.exit(1));
  };
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    Sentry.captureException(err);
    fatalExit();
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandledRejection');
    // unhandledRejection's reason can be any value — wrap non-Errors so
    // Sentry gets a usable stack trace + fingerprint.
    Sentry.captureException(
      reason instanceof Error
        ? reason
        : new Error(`unhandledRejection: ${String(reason)}`),
    );
    fatalExit();
  });
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(
    `FATAL: daemon bootstrap failed — ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
