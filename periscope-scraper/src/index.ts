/**
 * Entry point for the periscope-scraper Railway service.
 *
 * Lifecycle:
 *   1. Initialize Sentry first (so any later boot error is captured).
 *   2. Initialize pino logger.
 *   3. Validate env (importing ./config triggers required-var checks).
 *   4. Run one tick immediately — Railway restarts shouldn't lose a slot.
 *   5. setInterval every MS_PER_TICK (1 min); each tick is a no-op
 *      outside the active polling window OR when the expected slot
 *      has already been captured.
 *   6. SIGTERM handler clears the interval, flushes Sentry, exits 0.
 *
 * Schedule-aware dedup:
 *   - The scraper wakes every minute during 08:21-15:14 CT (Mon-Fri).
 *   - It tracks `lastCapturedWindowEnd` — the end-time (e.g. "08:30")
 *     of the last UW slot it successfully captured.
 *   - When the most recently CLOSED 10-min window's end matches
 *     `lastCapturedWindowEnd`, the tick is a cheap no-op (skip scrape
 *     entirely — we already have this slot).
 *   - When they differ, scrape "Latest". If UW's panel still shows
 *     the same slot, log + retry next minute (UW hasn't rolled yet).
 *   - When UW rolls to a new slot, insert + post webhook + update
 *     `lastCapturedWindowEnd`. The dedup will then short-circuit
 *     subsequent ticks until the next 10-min boundary closes.
 *
 * This pattern absorbs UW's 1-3 min publication lag without polling
 * blindly, and ensures the first analyzable slot ("08:20 - 08:30")
 * and the debrief slot ("14:50 - 15:00") are captured as soon as UW
 * publishes them, rather than 10 min later on the next 10-min tick.
 *
 * One-shot test mode: set FORCE_TICK=true to bypass the window gate,
 * run a single tick, and exit. Useful for verifying auth + selectors
 * locally before the next market open without waiting for the
 * schedule. The loop is NOT started in this mode.
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

// Seed the Playwright storageState file from a base64 env var BEFORE
// loading config (which validates UW_AUTH_STATE_PATH). Pattern: encode
// the local ~/.periscope-probe-auth.json with `base64 -i ...` and set
// the result as Railway env var UW_AUTH_STATE_B64; this block decodes
// it to UW_AUTH_STATE_PATH on every container start. Idempotent — if
// the env var is unset (e.g., when running locally), this is a no-op
// and the existing file on disk (if any) is used.
{
  const b64 = (process.env.UW_AUTH_STATE_B64 ?? '').trim();
  if (b64 !== '') {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const target = process.env.UW_AUTH_STATE_PATH ?? '/data/uw-auth-state.json';
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, decoded, { mode: 0o600 });
      console.log(
        `auth-state seed: wrote ${decoded.length} bytes to ${target}`,
      );
    } catch (err) {
      console.error('auth-state seed failed:', err);
    }
  }
}

// Now safe to load config (and capture its throws via the Sentry above).
const { LOG_LEVEL, MS_PER_TICK, isInActivePollingWindow } =
  await import('./config.js');
const { expectedWindowEnd, parseSlotEnd } = await import('./dates.js');
const { insertSnapshots } = await import('./db.js');
const { scrapeAllPanels, scrapeBackfill, scrapeBackfillRange } =
  await import('./scrape.js');
const { loadWebhookConfig, postPlaybookWebhook } = await import('./webhook.js');

const logger = pino({ level: LOG_LEVEL });

// Webhook config loaded once at boot. When either var is missing, the
// helper short-circuits with `skipped: true` — lets us deploy code first
// and arm the webhook later by setting Railway env vars.
const webhookConfig = loadWebhookConfig();
if (webhookConfig.baseUrl == null || webhookConfig.secret == null) {
  logger.warn(
    {
      hasBaseUrl: webhookConfig.baseUrl != null,
      hasSecret: webhookConfig.secret != null,
    },
    'auto-playbook webhook DISABLED — VERCEL_BASE_URL or PERISCOPE_WEBHOOK_SECRET not set',
  );
} else {
  logger.info(
    { baseUrl: webhookConfig.baseUrl },
    'auto-playbook webhook armed',
  );
}

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;

// Dedup state: the end-time (HH:MM) of the last UW slot we successfully
// captured (e.g. "08:30" after capturing "08:20 - 08:30"). Reset to null
// when we leave the active polling window so the next trading day
// starts fresh. Used by runTick to short-circuit ticks where the
// current expected 10-min window has already been captured.
let lastCapturedWindowEnd: string | null = null;

// Consecutive scrape-returned-0-rows counter. Fires a single Sentry
// message after 3 in a row to surface UW session-logout / rendering
// outages without spamming. Resets on any non-empty scrape.
let consecutiveEmptyScrapes = 0;
const EMPTY_SCRAPE_ALERT_THRESHOLD = 3;

async function runTick(
  opts: { bypassMarketHours?: boolean } = {},
): Promise<void> {
  if (tickInFlight) {
    logger.warn('previous tick still running, skipping');
    return;
  }

  const now = new Date();
  const bypass = opts.bypassMarketHours === true;
  const inWindow = isInActivePollingWindow(now);

  // Reset dedup state on transitions out of the active window
  // (overnight, weekend, post-close). The next trading day will
  // start with a clean lastCapturedWindowEnd. Bypassed ticks
  // (FORCE_TICK / backfill) don't touch state.
  if (!bypass && !inWindow && lastCapturedWindowEnd !== null) {
    logger.info(
      { lastCapturedWindowEnd },
      'left active polling window — resetting dedup state',
    );
    lastCapturedWindowEnd = null;
  }

  if (!bypass && !inWindow) {
    logger.debug('outside active polling window, skipping tick');
    return;
  }

  // Schedule-aware skip: if the most recently CLOSED 10-min window has
  // already been captured, the next slot can't appear until the next
  // boundary closes. Skip the (expensive) Playwright scrape until then.
  if (!bypass) {
    const expected = expectedWindowEnd(now);
    if (expected != null && expected === lastCapturedWindowEnd) {
      logger.debug(
        { expected, lastCapturedWindowEnd },
        'expected window already captured — skipping scrape',
      );
      return;
    }
  }

  tickInFlight = true;
  const startedAt = Date.now();
  try {
    const rows = await scrapeAllPanels();

    if (rows.length === 0) {
      consecutiveEmptyScrapes += 1;
      logger.info(
        {
          ms: Date.now() - startedAt,
          consecutiveEmptyScrapes,
        },
        'tick: scrape returned 0 rows — retry next minute',
      );
      if (consecutiveEmptyScrapes === EMPTY_SCRAPE_ALERT_THRESHOLD) {
        // One-shot Sentry message at the threshold so a UW session
        // logout / rendering outage surfaces without flooding events.
        // Resets on the next non-empty tick.
        Sentry.captureMessage(
          `periscope-scraper: ${EMPTY_SCRAPE_ALERT_THRESHOLD} consecutive empty scrapes — UW session may be logged out`,
          {
            level: 'warning',
            tags: { service: 'periscope-scraper', stage: 'scrape-empty' },
          },
        );
      }
      return;
    }
    consecutiveEmptyScrapes = 0;

    const anchor = rows[0]!;
    const capturedEnd = parseSlotEnd(anchor.timeframe);

    // Dedup: if UW's "Latest" panel still shows the same slot we
    // already captured, UW hasn't rolled to the next window yet. Skip
    // DB insert + webhook (would just generate 422s) and retry next
    // minute. Only short-circuits when we have a previous capture AND
    // the parse succeeded; an unparseable timeframe falls through to
    // the normal insert path so nothing silently drops.
    if (
      lastCapturedWindowEnd !== null &&
      capturedEnd !== null &&
      capturedEnd === lastCapturedWindowEnd
    ) {
      logger.info(
        {
          slot: anchor.timeframe,
          ms: Date.now() - startedAt,
        },
        'tick: UW has not rolled to a new slot — retry next minute',
      );
      return;
    }

    const inserted = await insertSnapshots(rows);
    logger.info(
      {
        rows: rows.length,
        inserted,
        ms: Date.now() - startedAt,
        slot: anchor.timeframe,
      },
      'tick complete',
    );

    if (capturedEnd !== null) {
      lastCapturedWindowEnd = capturedEnd;
    } else {
      // Unparseable timeframe (UW renamed the label, leading whitespace
      // changed, etc.). Without a fallback the dedup-skip on line ~150
      // never engages and the scraper does a full Playwright run every
      // minute for the rest of the day. Anchor to wall-clock so the
      // schedule-aware skip still works; alert Sentry so we notice the
      // format change. The data did insert correctly — the parse is
      // only needed for dedup state.
      lastCapturedWindowEnd = expectedWindowEnd(new Date());
      Sentry.captureMessage(
        'periscope-scraper: unparseable timeframe label — UW format may have changed',
        {
          level: 'warning',
          tags: { service: 'periscope-scraper', stage: 'parse-timeframe' },
          extra: {
            timeframe: anchor.timeframe,
            fallbackWindowEnd: lastCapturedWindowEnd,
          },
        },
      );
      logger.warn(
        {
          timeframe: anchor.timeframe,
          fallbackWindowEnd: lastCapturedWindowEnd,
        },
        'tick: timeframe label unparseable — anchored dedup to wall clock',
      );
    }

    // Auto-playbook webhook (Phase 3 of periscope-auto-playbook spec).
    // Fires once per new-slot capture. Failures Sentry-captured but
    // never block the next tick. Skipped silently when env vars unset.
    const tradingDate = anchor.capturedAt.slice(0, 10);
    const result = await postPlaybookWebhook(
      {
        tradingDate,
        capturedAt: anchor.capturedAt,
        slotKey: anchor.timeframe,
      },
      webhookConfig,
    );
    if (result.skipped) {
      logger.debug(
        { tradingDate, slotKey: anchor.timeframe },
        'auto-playbook webhook skipped (config disabled)',
      );
    } else if (!result.ok) {
      Sentry.captureException(
        new Error(`auto-playbook webhook failed: ${result.error ?? '?'}`),
        {
          tags: {
            service: 'periscope-scraper-webhook',
            status: String(result.status ?? 'null'),
            attempts: String(result.attempts),
          },
          extra: {
            tradingDate,
            capturedAt: anchor.capturedAt,
            slotKey: anchor.timeframe,
          },
        },
      );
      logger.warn(
        {
          tradingDate,
          slotKey: anchor.timeframe,
          status: result.status,
          attempts: result.attempts,
          error: result.error,
        },
        'auto-playbook webhook failed',
      );
    } else {
      logger.info(
        {
          tradingDate,
          slotKey: anchor.timeframe,
          status: result.status,
          attempts: result.attempts,
        },
        'auto-playbook webhook posted',
      );
    }
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

const backfillDate = (process.env.BACKFILL_DATE ?? '').trim();
const backfillStart = (process.env.BACKFILL_START ?? '').trim() || '08:20';
const backfillEnd = (process.env.BACKFILL_END ?? '').trim() || '14:50';
const backfillDateStart = (process.env.BACKFILL_DATE_START ?? '').trim();
const backfillDateEnd = (process.env.BACKFILL_DATE_END ?? '').trim();

if (backfillDateStart !== '' && backfillDateEnd !== '') {
  logger.info(
    {
      backfillDateStart,
      backfillDateEnd,
      backfillStart,
      backfillEnd,
    },
    'BACKFILL_DATE_START + BACKFILL_DATE_END set — running multi-day range backfill',
  );
  const startedAt = Date.now();
  try {
    const summary = await scrapeBackfillRange(
      backfillDateStart,
      backfillDateEnd,
      backfillStart,
      backfillEnd,
    );
    logger.info(
      { ...summary, totalMs: Date.now() - startedAt },
      'backfill range complete',
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error(
      { err, ms: Date.now() - startedAt },
      'backfill range failed at top level',
    );
  }
  await Sentry.flush(2000);
  process.exit(0);
}

if (backfillDate !== '') {
  logger.info(
    { backfillDate, backfillStart, backfillEnd },
    'BACKFILL_DATE set — running historical backfill then exiting',
  );
  const startedAt = Date.now();
  try {
    const rows = await scrapeBackfill(backfillDate, backfillStart, backfillEnd);
    const inserted = await insertSnapshots(rows);
    logger.info(
      { rows: rows.length, inserted, ms: Date.now() - startedAt },
      'backfill complete',
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err, ms: Date.now() - startedAt }, 'backfill failed');
  }
  await Sentry.flush(2000);
  process.exit(0);
}

if (forceTick) {
  logger.info(
    'FORCE_TICK=true — running one tick (RTH gate bypassed) then exiting',
  );
  await runTick({ bypassMarketHours: true });
  await Sentry.flush(2000);
  process.exit(0);
}

// Fire one tick immediately so a Railway restart mid-session resumes promptly.
await runTick();

intervalHandle = setInterval(() => {
  void runTick();
}, MS_PER_TICK);
