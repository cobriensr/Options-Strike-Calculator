/**
 * GET /api/cron/enrich-vega-spike-returns
 *
 * Backfills the forward-return columns (fwd_return_5m, fwd_return_15m,
 * fwd_return_30m) on vega_spike_events rows whose spike timestamp is at
 * least 30 minutes old.
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
 *   - If a spike fires in the last 30 min of a session, its t+30 candle
 *     falls AFTER market close where there is no candle data — those
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

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';

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

  const candles = (await sql`
    SELECT timestamp, close
    FROM etf_candles_1m
    WHERE ticker = ${row.ticker}
      AND timestamp IN (${anchorIso}, ${t5}, ${t15}, ${t30})
  `) as CandleRow[];

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

  // EoD lookup: the last 1-min candle of the spike's trading day for
  // this ticker. The 7-hour ceiling covers a full regular session
  // (9:30 → 16:00 ET) plus margin, while staying within the
  // (ticker, timestamp DESC) index range — etf_candles_1m has no
  // afterhours/futures bars so this can't bleed into the next day.
  const eodCandles = (await sql`
    SELECT close
    FROM etf_candles_1m
    WHERE ticker = ${row.ticker}
      AND timestamp >= ${anchorIso}
      AND timestamp <= ${anchorIso}::timestamptz + INTERVAL '7 hours'
    ORDER BY timestamp DESC
    LIMIT 1
  `) as Array<{ close: string | number }>;
  const eodCloseRaw = eodCandles[0]?.close;
  const eodClose =
    eodCloseRaw != null ? Number.parseFloat(String(eodCloseRaw)) : null;

  const r5 = forwardReturn(anchorClose, close5);
  const r15 = forwardReturn(anchorClose, close15);
  const r30 = forwardReturn(anchorClose, close30);
  const rEod = forwardReturn(anchorClose, eodClose);

  await sql`
    UPDATE vega_spike_events
    SET fwd_return_5m = ${r5},
        fwd_return_15m = ${r15},
        fwd_return_30m = ${r30},
        fwd_return_eod = ${rEod}
    WHERE id = ${row.id}
  `;

  return { enriched: true, skippedNoAnchor: false };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, { requireApiKey: false });
  if (!guard) return;

  const startTime = Date.now();

  try {
    const sql = getDb();

    // Pending rows: fwd_return_30m still NULL, spike at least 30 min ago,
    // and no older than 7 days (rows older than that with still-NULL
    // forward returns are treated as permanently unenrichable — see
    // the JSDoc above for rationale).
    const pendingRaw = await sql`
      SELECT id, ticker, timestamp
      FROM vega_spike_events
      WHERE fwd_return_30m IS NULL
        AND timestamp <= NOW() - INTERVAL '30 minutes'
        AND timestamp >= NOW() - INTERVAL '7 days'
      ORDER BY timestamp ASC
      LIMIT 100
    `;
    const pending = pendingRaw as PendingRow[];

    let enriched = 0;
    let skippedNoCandles = 0;
    let failed = 0;

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
        metrics.increment('vega_spike.enrich_failure');
        logger.warn(
          { err, id: row.id, ticker: row.ticker, ts: row.timestamp },
          'enrich-vega-spike-returns row failed',
        );
      }
    }

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        pending: pending.length,
        enriched,
        skippedNoCandles,
        failed,
        durationMs,
      },
      'enrich-vega-spike-returns completed',
    );

    await reportCronRun('enrich-vega-spike-returns', {
      status: failed > 0 ? 'partial' : 'ok',
      pending: pending.length,
      enriched,
      skippedNoCandles,
      failed,
      durationMs,
    });

    return res.status(200).json({
      job: 'enrich-vega-spike-returns',
      pending: pending.length,
      enriched,
      skippedNoCandles,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'enrich-vega-spike-returns');
    Sentry.captureException(err);
    logger.error({ err }, 'enrich-vega-spike-returns error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
