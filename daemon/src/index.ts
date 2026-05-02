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
import { createScheduler, type Scheduler } from './scheduler.js';
import { runCapture } from './capture.js';
import { fetchGexLandscape } from './gex.js';
import { postTraceLiveAnalyze } from './api-client.js';
import { startHealthServer, type HealthServer } from './health-server.js';

/**
 * Cleanup contract used by `fatalExit` and `gracefulShutdown`. Exported
 * for unit-testability; the real wiring is `{ scheduler, health, sentry }`
 * with `sentry` bound to `@sentry/node` namespace methods.
 */
export interface ShutdownDeps {
  scheduler: Pick<Scheduler, 'stop'>;
  health: Pick<HealthServer, 'close'>;
  sentry: { close: (timeout?: number) => Promise<boolean> };
  exit: (code: number) => void;
}

/**
 * Process-level safety net. Must clean up in this order:
 *   1. scheduler.stop()  — clear interval, no new ticks
 *   2. health.close()    — stop accepting HTTP requests
 *   3. sentry.close()    — drain queued events (2s budget)
 *   4. exit(1)
 *
 * Errors from health.close() are swallowed so Sentry drain still runs.
 * Returns the cleanup promise so tests can await ordering assertions.
 */
export function fatalExit(deps: ShutdownDeps): Promise<void> {
  deps.scheduler.stop();
  return deps.health
    .close()
    .catch(() => undefined)
    .then(() => deps.sentry.close(2000))
    .then(() => undefined)
    .finally(() => deps.exit(1));
}

/**
 * Graceful shutdown for SIGTERM / SIGINT. Same ordering as `fatalExit`
 * but exits with code 0.
 */
export function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  deps.scheduler.stop();
  return deps.health
    .close()
    .catch(() => undefined)
    .then(() => deps.sentry.close(2000))
    .then(() => undefined)
    .finally(() => deps.exit(0));
}

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

  const shutdownDeps: ShutdownDeps = {
    scheduler,
    health,
    sentry: { close: (timeout) => Sentry.close(timeout) },
    exit: (code) => process.exit(code),
  };

  // Graceful shutdown on SIGTERM / SIGINT — Railway sends SIGTERM with
  // a grace period before SIGKILL.
  process.on('SIGTERM', () => {
    logger.info({ signal: 'SIGTERM' }, 'Received shutdown signal');
    void gracefulShutdown(shutdownDeps);
  });
  process.on('SIGINT', () => {
    logger.info({ signal: 'SIGINT' }, 'Received shutdown signal');
    void gracefulShutdown(shutdownDeps);
  });

  // Process-level safety nets — these should never fire if the per-tick
  // try/catch is doing its job, but if they do we want clean cleanup +
  // a Sentry trail. Railway auto-restart papered over the previous shape
  // (which only drained Sentry) but explicit cleanup is more graceful
  // and avoids orphaned timers / sockets racing the exit.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    Sentry.captureException(err);
    void fatalExit(shutdownDeps);
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
    void fatalExit(shutdownDeps);
  });
}

// Only invoke bootstrap when this file is run directly (not when imported
// by unit tests). The standard ESM idiom — argv[1] resolves to the module
// path that Node was invoked with.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/daemon/src/index.ts') === true ||
  process.argv[1]?.endsWith('/daemon/src/index.js') === true;

if (invokedDirectly) {
  try {
    await bootstrap();
  } catch (err: unknown) {
    process.stderr.write(
      `FATAL: daemon bootstrap failed — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
