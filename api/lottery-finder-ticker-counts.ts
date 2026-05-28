/**
 * GET /api/lottery-finder-ticker-counts
 *
 * Backs the ticker-rollup chip strip above LotteryFinderSection.
 * Returns one row per underlying symbol with the count of distinct
 * chains that fired, best realized peak%, and latest trigger time
 * across the whole day regardless of pagination / scrubber position.
 *
 * Chain-day dedup: a single hot chain (e.g. TSLA 392.5C firing 250×)
 * counts as 1 toward the ticker total, matching the row-level dedup
 * in /api/lottery-finder so the chip count equals what the user sees
 * in the list.
 *
 * Owner-or-guest. Filters validated by
 * `lotteryFinderTickerCountsQuerySchema` in api/_lib/validation.ts.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, withDbRetry } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { lotteryFinderTickerCountsQuerySchema } from './_lib/validation.js';
import { MIN_ALERT_ENTRY_PRICE } from './_lib/constants.js';
import { getETDateStr } from '../src/utils/timezone.js';

type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;

interface CountRow {
  ticker: string;
  count: number;
  peak_best_pct: DbNullableNumeric;
  latest_trigger_time_ct: DbTimestamp;
}

interface LotteryFinderTickerCountsResponse {
  date: string;
  filters: {
    optionType: 'C' | 'P' | null;
    reload: boolean | null;
    cheapCallPm: boolean | null;
    mode: 'A_intraday_0DTE' | 'B_multi_day_DTE1_3' | null;
    tod: 'AM_open' | 'MID' | 'LUNCH' | 'PM' | null;
    minScore: number | null;
    minPremium: number | null;
    minFireCount: number | null;
    minTakeitProb: number | null;
    showAll: boolean;
  };
  tickers: {
    ticker: string;
    count: number;
    peakBestPct: number | null;
    latestTriggerTimeCt: string;
  }[];
}

function toIso(v: DbTimestamp): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(v).toISOString();
}

function toNumOrNull(v: DbNullableNumeric): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number.parseFloat(v);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  const parsed = lotteryFinderTickerCountsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid query',
      details: parsed.error.issues,
    });
    return;
  }
  const q = parsed.data;
  const date = q.date ?? getETDateStr(new Date());
  // Coerce 0 / missing → null so the SQL `NULL IS NULL` short-circuit
  // skips the predicate cleanly (same convention as /api/lottery-finder).
  const minPremium =
    q.minPremium != null && q.minPremium > 0 ? q.minPremium : null;
  const minFireCount =
    q.minFireCount != null && q.minFireCount > 1 ? q.minFireCount : null;
  const minTakeitProb =
    q.minTakeitProb != null && q.minTakeitProb > 0 ? q.minTakeitProb : null;
  const showAll = q.showAll ?? false;

  try {
    const db = getDb();

    // Two-step dedup + aggregate: the CTE collapses raw fires to one
    // row per (underlying, strike, option_type, expiry) — matching the
    // chain-day dedup that /api/lottery-finder uses for the list view.
    // The outer SELECT then groups the deduped rows by ticker. Peak
    // is taken across the chain's lifetime (MAX over partition); the
    // latest trigger time is the freshest fire within the chain.
    //
    // Two filters must mirror /api/lottery-finder exactly so chip
    // totals don't overstate the visible feed:
    //   1. `entry_price >= MIN_ALERT_ENTRY_PRICE` — the system-level
    //      penny-option floor (the feed enforces this on every query).
    //   2. Phase 3 inversion-quality suppression: LEFT JOIN
    //      lottery_ticker_stats and drop chains whose ticker sits in
    //      `inversion_quintile` 1 or 2 unless `showAll=true`. NULL
    //      quintile (cold-start tickers) is never suppressed. The feed
    //      applies this post-SELECT in JS; doing it in SQL here keeps
    //      the chip totals aligned and avoids fetching ticker_stats
    //      back to the Node layer.
    const rows = (await withDbRetry(
      () => db`
      WITH ranked AS (
        -- One row per fire, decorated with per-chain aggregates +
        -- ROW_NUMBER so we can filter on the LATEST fire's
        -- takeit_prob (per-fire value; latest is what /api/lottery-finder
        -- shows on the row). Mirrors the count subquery shape there.
        SELECT
          underlying_symbol,
          strike,
          option_type,
          expiry,
          takeit_prob,
          MAX(peak_ceiling_pct) OVER (
            PARTITION BY underlying_symbol, strike, option_type, expiry
          ) AS chain_peak_pct,
          MAX(trigger_time_ct) OVER (
            PARTITION BY underlying_symbol, strike, option_type, expiry
          ) AS chain_latest_trigger,
          COUNT(*) OVER (
            PARTITION BY underlying_symbol, strike, option_type, expiry
          )::int AS fc,
          ROW_NUMBER() OVER (
            PARTITION BY underlying_symbol, strike, option_type, expiry
            ORDER BY trigger_time_ct DESC, id DESC
          ) AS rn
        FROM lottery_finder_fires
        WHERE date = ${date}::date
          AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
          AND (${q.reload ?? null}::boolean IS NULL OR reload_tagged = ${q.reload ?? false})
          AND (${q.cheapCallPm ?? null}::boolean IS NULL OR cheap_call_pm_tagged = ${q.cheapCallPm ?? false})
          AND (${q.mode ?? null}::text IS NULL OR mode = ${q.mode ?? ''})
          AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? ''})
          AND (${q.tod ?? null}::text IS NULL OR tod = ${q.tod ?? ''})
          AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? 0})
          AND (
            ${minPremium}::numeric IS NULL
            OR entry_price * trigger_window_size * 100 >= ${minPremium}::numeric
          )
      ),
      chain_day AS (
        SELECT
          underlying_symbol,
          strike,
          option_type,
          expiry,
          chain_peak_pct,
          chain_latest_trigger
        FROM ranked
        WHERE rn = 1
          AND (${minFireCount}::int IS NULL OR fc >= ${minFireCount ?? 0})
          AND (${minTakeitProb}::numeric IS NULL OR takeit_prob >= ${minTakeitProb}::numeric)
      )
      SELECT
        cd.underlying_symbol AS ticker,
        COUNT(*)::int AS count,
        MAX(cd.chain_peak_pct) AS peak_best_pct,
        MAX(cd.chain_latest_trigger) AS latest_trigger_time_ct
      FROM chain_day cd
      LEFT JOIN lottery_ticker_stats s ON s.ticker = cd.underlying_symbol
      WHERE (
        ${showAll}::boolean
        OR s.inversion_quintile IS NULL
        OR s.inversion_quintile > 2
      )
      GROUP BY cd.underlying_symbol
      ORDER BY count DESC, latest_trigger_time_ct DESC, underlying_symbol ASC
    `,
      2,
      10_000,
    )) as CountRow[];

    const response: LotteryFinderTickerCountsResponse = {
      date,
      filters: {
        optionType: q.optionType ?? null,
        reload: q.reload ?? null,
        cheapCallPm: q.cheapCallPm ?? null,
        mode: q.mode ?? null,
        tod: q.tod ?? null,
        minScore: q.minScore ?? null,
        minPremium,
        minFireCount,
        minTakeitProb,
        showAll,
      },
      tickers: rows.map((r) => ({
        ticker: r.ticker,
        count: r.count,
        peakBestPct: toNumOrNull(r.peak_best_pct),
        latestTriggerTimeCt: toIso(r.latest_trigger_time_ct),
      })),
    };

    setCacheHeaders(res, 30, 60);
    res.status(200).json(response);
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'lottery-finder-ticker-counts: unexpected error');
    res.status(500).json({ error: 'Internal error' });
  }
}
