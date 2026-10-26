/**
 * GET /api/cron/enrich-vega-spike-returns
 *
 * Backfills the forward-return columns (fwd_return_5m, fwd_return_15m,
 * fwd_return_30m, fwd_return_eod) on vega_spike_events rows whose spike
 * timestamp is at least 30 minutes old. fwd_return_eod runs to the close
 * of the last regular-session bar of the spike's day (see enrichRow) and
 * is written only after that session has closed + 5 min: during the day a
 * row carries 5/15/30 with EoD NULL, then the run at close + 5 (or the
 * next morning's) fills the EoD in.
 *
 * Why 5-minute cadence:
 *   - The t+5 candle needs ~5 minutes to exist after the spike, so any
 *     cadence below 5 minutes is wasted invocations.
 *   - We want low end-to-end latency between "spike fires" and "frontend
 *     row shows forward returns" — 5-min cadence means worst case ~5 min
 *     after the t+30 candle lands, which is plenty for human review.
 *
 * Cost characteristics:
 *   - One SELECT per pending row (4-row IN-list lookup against
 *     etf_candles_1m via the (ticker, timestamp) unique index).
 *   - One UPDATE per row that has at least an anchor + one forward candle.
 *   - LIMIT 100 caps the per-run work at ~200 small Postgres ops, which
 *     finishes well under any reasonable Vercel timeout.
 *
 * Why a 7-day cutoff on the pending-rows query:
 *   - If a spike fires in the last ~30 min of a session, its t+30 candle
 *     falls after the last bar etf_candles_1m gets that day (about
 *     16:04 ET: the ETF cron's gate ends at close + 5) — those
 *     forward-return columns can never be populated.
 *   - Without a cutoff, every run would re-scan every permanently-
 *     unenrichable row forever, eventually swamping the LIMIT 100.
 *   - The 7-day cutoff keeps the query bounded; the partial index
 *     idx_vega_spike_events_pending_returns (migration #93, WHERE
 *     fwd_return_30m IS NULL) makes the lookup efficient. After 7 days
 *     a still-null row is treated as permanently unenrichable and is
 *     no longer a candidate for re-fetch.
 *
 * Edge cases:
 *   - Anchor candle missing: skip the row entirely; its NULL columns
 *     are left untouched. Rare but possible at first/last bar boundaries
 *     where SPY/QQQ may have no trade activity within that minute.
 *   - Partial forward candles (e.g. t+5 present, t+15/t+30 missing):
 *     write the columns we have, leave the rest NULL. Will be retried
 *     on later runs while still inside the 7-day window.
 *
 * Storage: vega_spike_events (migration #93) — uses the partial index
 *   idx_vega_spike_events_pending_returns for the pending lookup.
 *
 * Schedule: vercel.json registers `*\/5 13-21 * * 1-5` (every 5 minutes,
 * market hours).
 *
 * Environment: CRON_SECRET (no UW_API_KEY needed — DB-only).
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  deriveCronStatus,
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { etWallClockToUtcIso, getETDateStr } from '../../src/utils/timezone.js';
import {
  getMarketCloseHourET,
  isTradingDay,
} from '../../src/data/marketHours.js';

// ── Types ───────────────────────────────────────────────────

interface PendingRow {
  id: number;
  ticker: string;
  timestamp: string;
}

interface CandleRow {
  timestamp: string;
  close: string | number;
}

// ── Session close ───────────────────────────────────────────

/**
 * How long after the close fwd_return_eod waits before it is written.
 * fetch-etf-candles-1m writes a minute only once it has closed and UW has
 * opened the next bucket, so the last regular bar (15:59 ET) lands a
 * minute or two after 16:00. This cron's last run of the day is at
 * close + 5 (the market-hours gate's after-close window), so 5 minutes
 * puts the write on that run; a missed run is caught up the next morning.
 */
const EOD_SETTLE_MS = 5 * 60_000;

/**
 * UTC ISO instant of the regular-session close on the ET trading date of
 * `at`: 16:00 ET, or 13:00 ET on a half-day, DST-correct. Null on a day
 * the market is closed.
 */
function sessionCloseIso(at: Date): string | null {
  const etDate = getETDateStr(at);
  // getMarketCloseHourET knows holidays but not weekends.
  const closeHour = isTradingDay(etDate) ? getMarketCloseHourET(etDate) : null;
  return closeHour == null ? null : etWallClockToUtcIso(etDate, closeHour * 60);
}

/**
 * Spikes before this instant belong to sessions that have closed and
 * settled, so their EoD return can be written: ET midnight today while
 * today's session is open or settling, otherwise now (from today's close
 * + EOD_SETTLE_MS, or on a day with no session).
 */
function eodSettledBeforeIso(now: Date): string {
  const closeIso = sessionCloseIso(now);
  if (
    closeIso == null ||
    now.getTime() >= Date.parse(closeIso) + EOD_SETTLE_MS
  ) {
    return now.toISOString();
  }
  return etWallClockToUtcIso(getETDateStr(now), 0) ?? now.toISOString();
}

// ── Pure helper: compute forward return from two closes ─────

/**
 * Returns (closeAt - closeAnchor) / closeAnchor as a decimal, or null
 * if either input is non-finite or anchor is zero.
 */
function forwardReturn(
  anchorClose: number,
  forwardClose: number | null,
): number | null {
  if (forwardClose == null) return null;
  if (!Number.isFinite(anchorClose) || !Number.isFinite(forwardClose)) {
    return null;
  }
  if (anchorClose === 0) return null;
  return (forwardClose - anchorClose) / anchorClose;
}

// ── Per-row enrichment ──────────────────────────────────────

interface EnrichOutcome {
  enriched: boolean;
  skippedNoAnchor: boolean;
}

async function enrichRow(row: PendingRow): Promise<EnrichOutcome> {
  const sql = getDb();

  const anchor = new Date(row.timestamp);
  const anchorMs = anchor.getTime();
  const t5 = new Date(anchorMs + 5 * 60_000).toISOString();
  const t15 = new Date(anchorMs + 15 * 60_000).toISOString();
  const t30 = new Date(anchorMs + 30 * 60_000).toISOString();
  const anchorIso = anchor.toISOString();

  const candles = (await withDbRetry(
    () => sql`
      SELECT timestamp, close
      FROM etf_candles_1m
      WHERE ticker = ${row.ticker}
        AND timestamp IN (${anchorIso}, ${t5}, ${t15}, ${t30})
    `,
    2,
    10_000,
  )) as CandleRow[];

  // Index candles by their ISO timestamp for direct lookup.
  const byIso = new Map<string, number>();
  for (const c of candles) {
    const ts = new Date(c.timestamp).toISOString();
    const closeNum = Number.parseFloat(String(c.close));
    if (Number.isFinite(closeNum)) {
      byIso.set(ts, closeNum);
    }
  }

  const anchorClose = byIso.get(anchorIso);
  if (anchorClose == null) {
    // Anchor candle missing — skip this row, leave columns NULL.
    return { enriched: false, skippedNoAnchor: true };
  }

  const close5 = byIso.get(t5) ?? null;
  const close15 = byIso.get(t15) ?? null;
  const close30 = byIso.get(t30) ?? null;

  // EoD lookup: the last regular-session bar of the spike's trading day,
  // i.e. the bar starting at 15:59 ET (12:59 on a half-day), whose close
  // is the closing price. The bound is the session close, not a time
  // ceiling, because etf_candles_1m holds post-market bars too:
  // fetch-etf-candles-1m's gate runs to close + 5, so 16:00–16:04 ET bars
  // exist (and pre-market bars from 04:00 ET). Same bar as
  // ml/src/vega_spike_eda.py's `< 20:00 UTC`, but DST- and half-day-correct.
  // Written only once the session has closed and settled: until then the
  // newest bar is not the close, and a value written mid-session would
  // never be revisited (that froze EoD at about t+30 before 2026-10-26).
  // Until then it stays NULL and the row is re-selected after the close.
  const closeIso = sessionCloseIso(anchor);
  const closeMs = closeIso == null ? null : Date.parse(closeIso);
  let eodClose: number | null = null;
  if (
    closeMs != null &&
    anchorMs < closeMs &&
    Date.now() >= closeMs + EOD_SETTLE_MS
  ) {
    const eodCandles = (await withDbRetry(
      () => sql`
        SELECT close
        FROM etf_candles_1m
        WHERE ticker = ${row.ticker}
          AND timestamp >= ${anchorIso}
          AND timestamp < ${closeIso}::timestamptz
        ORDER BY timestamp DESC
        LIMIT 1
      `,
      2,
      10_000,
    )) as Array<{ close: string | number }>;
    const eodCloseRaw = eodCandles[0]?.close;
    eodClose =
      eodCloseRaw != null ? Number.parseFloat(String(eodCloseRaw)) : null;
  }

  const r5 = forwardReturn(anchorClose, close5);
  const r15 = forwardReturn(anchorClose, close15);
  const r30 = forwardReturn(anchorClose, close30);
  const rEod = forwardReturn(anchorClose, eodClose);

  await withDbRetry(
    () => sql`
      UPDATE vega_spike_events
      SET fwd_return_5m = ${r5},
          fwd_return_15m = ${r15},
          fwd_return_30m = ${r30},
          fwd_return_eod = ${rEod}
      WHERE id = ${row.id}
    `,
    2,
    10_000,
  );

  return { enriched: true, skippedNoAnchor: false };
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  'enrich-vega-spike-returns',
  async (ctx): Promise<CronResult> => {
    const { logger } = ctx;
    const sql = getDb();

    // Pending rows: fwd_return_30m still NULL, or fwd_return_eod still
    // NULL for a spike whose session has settled; spike at least 30 min
    // ago, and no older than 7 days (rows older than that with still-NULL
    // forward returns are treated as permanently unenrichable — see the
    // JSDoc above for rationale). Today's rows awaiting their EoD are kept
    // out in SQL until close + EOD_SETTLE_MS, so they can't crowd newer
    // spikes out of the LIMIT while their EoD isn't due.
    const settledBeforeIso = eodSettledBeforeIso(new Date());
    const pendingRaw = await withDbRetry(
      () => sql`
        SELECT id, ticker, timestamp
        FROM vega_spike_events
        WHERE (fwd_return_30m IS NULL
               OR (fwd_return_eod IS NULL AND timestamp < ${settledBeforeIso}::timestamptz))
          AND timestamp <= NOW() - INTERVAL '30 minutes'
          AND timestamp >= NOW() - INTERVAL '7 days'
        ORDER BY timestamp ASC
        LIMIT 100
      `,
      2,
      10_000,
    );
    const pending = pendingRaw as PendingRow[];

    let enriched = 0;
    let skippedNoCandles = 0;
    let failed = 0;
    const failedIds: number[] = [];
    let firstError: unknown;

    for (const row of pending) {
      try {
        const outcome = await enrichRow(row);
        if (outcome.enriched) {
          enriched += 1;
          metrics.increment('vega_spike.enriched');
        } else if (outcome.skippedNoAnchor) {
          skippedNoCandles += 1;
        }
      } catch (err) {
        failed += 1;
        failedIds.push(row.id);
        firstError ??= err;
        metrics.increment('vega_spike.enrich_failure');
        logger.warn(
          { err, id: row.id, ticker: row.ticker, ts: row.timestamp },
          'enrich-vega-spike-returns row failed',
        );
      }
    }

    // One Sentry event per run carrying the first error, not one per row:
    // a Neon outage fails every pending row (up to the LIMIT of 100 every
    // 5 minutes). Per-row detail stays in the warn lines and the metric.
    // (Before 2026-05-19 only the metric was emitted, so an outage never
    // became a grouped Sentry issue.)
    if (failed > 0) {
      Sentry.captureException(firstError, {
        tags: { cron: 'enrich-vega-spike-returns' },
        extra: { failed, pending: pending.length, failedIds },
      });
    }

    logger.info(
      {
        pending: pending.length,
        enriched,
        skippedNoCandles,
        failed,
      },
      'enrich-vega-spike-returns completed',
    );

    // Pre-wrapper response keys (pending/enriched/skippedNoCandles) move
    // into metadata so existing toMatchObject assertions still pass.
    return {
      // Every pending row failing is 'error' (red Sentry monitor), not
      // 'partial'; rows skipped for a missing anchor are not failures.
      status: deriveCronStatus(failed, pending.length),
      metadata: {
        pending: pending.length,
        enriched,
        skippedNoCandles,
        failed,
      },
    };
  },
  { requireApiKey: false },
);
