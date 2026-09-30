/**
 * GET /api/cron/fetch-futures-snapshot
 *
 * Runs every 5 minutes while futures trade. Queries latest bars from
 * futures_bars for each symbol, computes 1H change / day change /
 * volume ratio, and upserts into futures_snapshots.
 *
 * A symbol with no bar, or whose latest bar is too old to be a current
 * price (see MAX_BAR_AGE_MS in futures-derive.ts), gets no row this run.
 * One quiet symbol is normal — CL/ZN can go 15+ min without a trade
 * overnight. ES and NQ BOTH lacking a fresh bar during the cash session
 * means the feed itself is down: the run then emits one fingerprinted
 * Sentry warning and returns 503 so the cron monitor records a failure.
 * That is what would have caught the 2026-09-03 → 09-29 frozen-ES
 * outage.
 *
 * Schedule: every 5 min, Sun-Fri (vercel.json); skipped at runtime
 * while futures are closed (isFuturesMarketOpen).
 *
 * Environment: CRON_SECRET
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { cronGuard, isMarketOpen, withRetry } from '../_lib/api-helpers.js';
import { getETDateStr, isFuturesMarketOpen } from '../../src/utils/timezone.js';
import { reportCronRun } from '../_lib/axiom.js';
import { withCronCheckin } from '../_lib/cron-instrumentation.js';
import {
  FUTURES_SYMBOLS,
  computeSnapshot,
  type FuturesSymbol,
  type SnapshotResult,
  type SnapshotRow,
} from '../_lib/futures-derive.js';

type NoFreshBar = Exclude<SnapshotResult, { kind: 'fresh' }>;

/**
 * True when the feed itself looks down: ES and NQ — the two densest
 * symbols — both lack a fresh bar while the cash session is open.
 *
 * Gated on the holiday- and early-close-aware cash session rather than
 * on isFuturesMarketOpen alone: at every 17:00 CT reopen the newest
 * ES/NQ bar is the pre-break close (~60 min old), and CME holiday halts
 * have no bars at all, so a futures-hours gate would page daily and
 * through every holiday. ES and NQ trade every minute of the cash
 * session, so there both being stale can only mean the feed stopped.
 *
 * Blind spot: an outage that starts after the cash close is first
 * reported at the next 9:30 ET open — until then the run returns 200,
 * so the cron monitor stays green too.
 */
function isFeedStale(
  noFreshBar: Partial<Record<FuturesSymbol, NoFreshBar>>,
): boolean {
  return noFreshBar.ES != null && noFreshBar.NQ != null && isMarketOpen();
}

// ── Handler ─────────────────────────────────────────────────

export default withCronCheckin('fetch-futures-snapshot', async (req, res) => {
  // Futures trade Sun 5 PM CT – Fri 5 PM CT; skip stock market hours check
  const guard = cronGuard(req, res, {
    requireApiKey: false,
    marketHours: false,
  });
  if (!guard) return;

  const startTime = Date.now();
  const now = new Date();

  // Futures are closed Sat all day, Fri 4pm-Sun 5pm CT, and the daily
  // 4-5pm CT maint window. No new bars land then, so skip the per-symbol
  // queries (every symbol would come back stale) and return 200 so
  // withCronCheckin records an `ok` status on the closed-market path.
  // See SENTRY-EMERALD-DESERT-5E.
  if (!isFuturesMarketOpen(now)) {
    logger.info(
      { ts: now.toISOString() },
      'futures market closed — skipping snapshot',
    );
    return res.status(200).json({
      job: 'fetch-futures-snapshot',
      skipped: true,
      reason: 'futures market closed',
    });
  }

  const tradeDate = getETDateStr(now);
  const sql = getDb();

  try {
    // Compute snapshots for each symbol in parallel
    const results = await Promise.allSettled(
      FUTURES_SYMBOLS.map((sym) =>
        withRetry(() => computeSnapshot(sym, tradeDate, now)),
      ),
    );

    const snapshots: SnapshotRow[] = [];
    const noFreshBar: Partial<Record<FuturesSymbol, NoFreshBar>> = {};
    const errors: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const symbol = FUTURES_SYMBOLS[i]!;
      if (result.status === 'rejected') {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : 'Unknown error';
        errors.push(`${symbol}: ${msg}`);
        logger.warn({ symbol, err: result.reason }, 'Snapshot failed');
        Sentry.captureException(result.reason);
      } else if (result.value.kind === 'fresh') {
        snapshots.push(result.value.snapshot);
      } else {
        noFreshBar[symbol] = result.value;
      }
    }

    // Upsert each snapshot
    const ts = now.toISOString();
    for (const snap of snapshots) {
      await withDbRetry(
        () => sql`
          INSERT INTO futures_snapshots (
            trade_date, ts, symbol, price,
            change_1h_pct, change_day_pct, volume_ratio
          ) VALUES (
            ${tradeDate}, ${ts}, ${snap.symbol}, ${snap.price},
            ${snap.change1hPct}, ${snap.changeDayPct}, ${snap.volumeRatio}
          )
          ON CONFLICT (symbol, ts) DO UPDATE SET
            price = EXCLUDED.price,
            change_1h_pct = EXCLUDED.change_1h_pct,
            change_day_pct = EXCLUDED.change_day_pct,
            volume_ratio = EXCLUDED.volume_ratio
        `,
        2,
        10_000,
      );
    }

    // One event per run; the fingerprint groups every run of an outage
    // into a single Sentry issue.
    const feedStale = isFeedStale(noFreshBar);
    if (feedStale) {
      logger.warn({ noFreshBar }, 'fetch-futures-snapshot: futures feed stale');
      Sentry.captureMessage(
        'fetch-futures-snapshot: no fresh ES or NQ bar during the cash session',
        {
          level: 'warning',
          fingerprint: ['futures-snapshot', 'feed-stale'],
          tags: { 'cron.anomaly': 'futures-feed-stale' },
          extra: noFreshBar,
        },
      );
    }

    if (snapshots.length === 0 && errors.length > 0) {
      return res.status(500).json({
        error: 'All symbols failed',
        errors,
      });
    }

    logger.info(
      {
        tradeDate,
        stored: snapshots.length,
        skipped: FUTURES_SYMBOLS.length - snapshots.length,
        errors: errors.length,
        symbols: snapshots.map((s) => s.symbol),
        feedStale,
      },
      'fetch-futures-snapshot completed',
    );

    const durationMs = Date.now() - startTime;

    await reportCronRun('fetch-futures-snapshot', {
      status: feedStale ? 'error' : 'ok',
      feedStale,
      stored: snapshots.length,
      skipped: FUTURES_SYMBOLS.length - snapshots.length,
      symbolsCount: FUTURES_SYMBOLS.length,
      errorsCount: errors.length,
      durationMs,
    });

    const body = {
      job: 'fetch-futures-snapshot',
      stored: snapshots.length,
      skipped: FUTURES_SYMBOLS.length - snapshots.length,
      symbols: snapshots.map((s) => ({
        symbol: s.symbol,
        price: s.price,
        change1hPct: s.change1hPct,
        changeDayPct: s.changeDayPct,
      })),
      errors: errors.length > 0 ? errors : undefined,
      durationMs,
    };

    // A 4xx/5xx status is what makes withCronCheckin record `error` on
    // the Sentry cron monitor.
    if (feedStale) {
      return res
        .status(503)
        .json({ ...body, error: 'futures feed stale', noFreshBar });
    }
    return res.status(200).json(body);
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-futures-snapshot');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-futures-snapshot failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});
