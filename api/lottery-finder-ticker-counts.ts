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
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { lotteryFinderTickerCountsQuerySchema } from './_lib/validation.js';
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

  try {
    const db = getDb();

    // Two-step dedup + aggregate: the CTE collapses raw fires to one
    // row per (underlying, strike, option_type, expiry) — matching the
    // chain-day dedup that /api/lottery-finder uses for the list view.
    // The outer SELECT then groups the deduped rows by ticker. Peak
    // is taken across the chain's lifetime (MAX over partition); the
    // latest trigger time is the freshest fire within the chain.
    const rows = (await db`
      WITH chain_day AS (
        SELECT
          underlying_symbol,
          strike,
          option_type,
          expiry,
          MAX(peak_ceiling_pct) AS chain_peak_pct,
          MAX(trigger_time_ct) AS chain_latest_trigger
        FROM lottery_finder_fires
        WHERE date = ${date}::date
          AND (${q.reload ?? null}::boolean IS NULL OR reload_tagged = ${q.reload ?? false})
          AND (${q.cheapCallPm ?? null}::boolean IS NULL OR cheap_call_pm_tagged = ${q.cheapCallPm ?? false})
          AND (${q.mode ?? null}::text IS NULL OR mode = ${q.mode ?? ''})
          AND (${q.optionType ?? null}::text IS NULL OR option_type = ${q.optionType ?? ''})
          AND (${q.tod ?? null}::text IS NULL OR tod = ${q.tod ?? ''})
          AND (${q.minScore ?? null}::int IS NULL OR score >= ${q.minScore ?? 0})
        GROUP BY underlying_symbol, strike, option_type, expiry
      )
      SELECT
        underlying_symbol AS ticker,
        COUNT(*)::int AS count,
        MAX(chain_peak_pct) AS peak_best_pct,
        MAX(chain_latest_trigger) AS latest_trigger_time_ct
      FROM chain_day
      GROUP BY underlying_symbol
      ORDER BY count DESC, latest_trigger_time_ct DESC, underlying_symbol ASC
    `) as CountRow[];

    const response: LotteryFinderTickerCountsResponse = {
      date,
      filters: {
        optionType: q.optionType ?? null,
        reload: q.reload ?? null,
        cheapCallPm: q.cheapCallPm ?? null,
        mode: q.mode ?? null,
        tod: q.tod ?? null,
        minScore: q.minScore ?? null,
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
