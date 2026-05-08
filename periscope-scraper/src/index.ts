/**
 * Entry point for the periscope-scraper Railway service.
 *
 * Lifecycle:
 *   1. Initialize Sentry first (so any later boot error is captured).
 *   2. Initialize pino logger.
 *   3. Validate env (importing ./config triggers required-var checks).
 *   4. Run one tick immediately — Railway restarts shouldn't lose 10 min.
 *   5. setInterval every MS_PER_TICK; each tick is a no-op outside RTH.
 *   6. SIGTERM handler clears the interval, flushes Sentry, exits 0.
 *
 * One-shot test mode: set FORCE_TICK=true to bypass the RTH gate, run a
 * single tick, and exit. Useful for verifying auth + selectors locally
 * before the next market open without waiting for the schedule. The loop
 * is NOT started in this mode.
 */

import * as Sentry from '@sentry/node';
import pino from 'pino';

// Sentry must initialize from raw process.env BEFORE importing ./config,
// because config.ts calls requireEnv() at module load and throws on
// missing DATABASE_URL / SENTRY_DSN / UW_SESSION_COOKIE. If we imported
// config first those throws would crash the process with no Sentry
// breadcrumb — exactly the boot failure we most want visibility into.
const rawSentryDsn = process.env.SENTRY_DSN;
if (rawSentryDsn != null && rawSentryDsn.trim() !== '') {
  Sentry.init({ dsn: rawSentryDsn, tracesSampleRate: 0 });
}

// Now safe to load config (and capture its throws via the Sentry above).
const { LOG_LEVEL, MS_PER_TICK, isMarketHours } = await import('./config.js');
const { insertSnapshots } = await import('./db.js');
const { scrapeAllPanels } = await import('./scrape.js');

const logger = pino({ level: LOG_LEVEL });

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;

async function runTick(opts: { bypassMarketHours?: boolean } = {}): Promise<void> {
  if (tickInFlight) {
    logger.warn('previous tick still running, skipping');
    return;
  }
  if (!opts.bypassMarketHours && !isMarketHours(new Date())) {
    logger.debug('outside RTH, skipping tick');
    return;
  }

  tickInFlight = true;
  const startedAt = Date.now();
  try {
    const rows = await scrapeAllPanels();
    const inserted = await insertSnapshots(rows);
    logger.info(
      { rows: rows.length, inserted, ms: Date.now() - startedAt },
      'tick complete',
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err, ms: Date.now() - startedAt }, 'tick failed');
  } finally {
    tickInFlight = false;
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutdown requested');
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  try {
    await Sentry.flush(2000);
  } catch (err) {
    logger.error({ err }, 'sentry flush failed');
  }
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

logger.info('periscope-scraper starting');

const forceTick =
  (process.env.FORCE_TICK ?? '').trim().toLowerCase() === 'true';

if (forceTick) {
  logger.info('FORCE_TICK=true — running one tick (RTH gate bypassed) then exiting');
  await runTick({ bypassMarketHours: true });
  await Sentry.flush(2000);
  process.exit(0);
}

// Fire one tick immediately so a Railway restart mid-session resumes promptly.
await runTick();

intervalHandle = setInterval(() => {
  void runTick();
}, MS_PER_TICK);
