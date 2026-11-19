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
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import { lotteryFinderTickerCountsQuerySchema } from './_lib/validation.js';
import { readKeptTickers } from './_lib/kept-tickers.js';
import { keptSuppressionSql } from './_lib/lottery-suppression.js';
import { INVERSION_BONUS_CASE_SQL } from './_lib/lottery-inversion-bonus.js';
import { resolveMinQas } from './_lib/lottery-tier.js';
import { loadLotteryWeights } from './_lib/lottery-weights-loader.js';
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
    minTier: 'tier1' | 'tier2' | null;
    minPremium: number | null;
    minFireCount: number | null;
    maxFireCount: number | null;
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
  const maxFireCount =
    q.maxFireCount != null && q.maxFireCount >= 1 ? q.maxFireCount : null;
  const minTakeitProb =
    q.minTakeitProb != null && q.minTakeitProb > 0 ? q.minTakeitProb : null;
  const showAll = q.showAll ?? false;

  try {
    const db = getDb();

    // MONOTONIC Q1/Q2 SUPPRESSION (mirror of /api/lottery-finder). Read the
    // per-day kept-set so chips for tickers that were ever shown (quintile
    // > 2 at some point today) stay counted even after a quintile flip into
    // Q1/Q2 — keeps the chip strip aligned with the feed. Read-only here:
    // the feed endpoint owns accumulation. `showAll` skips suppression, so
    // the set is irrelevant in that path. KV-down → [] → no behavior change.
    //
    // The active weights version loads alongside it: its feed cutoffs set the
    // `minTier` floor, the same number the feed gates on. The loader never
    // throws and caches for a minute; when the store can't answer it hands
    // back the seed (and raises its own Sentry error), so the strip still
    // serves.
    const [{ active }, keptTickers] = await Promise.all([
      loadLotteryWeights(),
      showAll ? [] : readKeptTickers(date),
    ]);
    // The one score floor the qas gate below compares to: the tier's cutoff
    // for `minTier`, else `minScore` as given, else none. The schema rejects
    // both together.
    const minQas = resolveMinQas(
      q.minTier,
      q.minScore,
      active.weights.feed_cutoffs,
    );

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
        -- ROW_NUMBER. The chain is gated on chain_max_takeit (the
        -- chain's PEAK TAKE-IT, not the latest fire's prob) so the chip
        -- counts here match /api/lottery-finder's monotonic feed gating
        -- exactly — a chain that ever cleared the floor is counted all
        -- day (spec lottery-no-vanish-2026-05-29.md).
        SELECT
          underlying_symbol,
          strike,
          option_type,
          expiry,
          takeit_prob,
          -- Score carried through so the final SELECT (where the
          -- lottery_ticker_stats LEFT JOIN exposes inversion_quintile) can
          -- gate the score floor on the DISPLAYED qas, mirroring
          -- /api/lottery-finder exactly so chip totals never diverge from the
          -- feed (Fix C/D).
          score,
          MAX(takeit_prob) OVER (
            PARTITION BY underlying_symbol, strike, option_type, expiry
          ) AS chain_max_takeit,
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
          chain_latest_trigger,
          score
        FROM ranked
        WHERE rn = 1
          AND (${minFireCount}::int IS NULL OR fc >= ${minFireCount ?? 0})
          AND (${maxFireCount}::int IS NULL OR fc <= ${maxFireCount ?? 0})
          AND (${minTakeitProb}::numeric IS NULL OR chain_max_takeit >= ${minTakeitProb}::numeric)
      )
      SELECT
        cd.underlying_symbol AS ticker,
        COUNT(*)::int AS count,
        MAX(cd.chain_peak_pct) AS peak_best_pct,
        MAX(cd.chain_latest_trigger) AS latest_trigger_time_ct
      FROM chain_day cd
      LEFT JOIN lottery_ticker_stats s ON s.ticker = cd.underlying_symbol
      WHERE ${keptSuppressionSql(db, 'cd', showAll, keptTickers)}
        -- Fix C/D: the score floor (minQas: minScore, or the active version's
        -- cutoff for minTier) gates on the DISPLAYED qas (= GREATEST(0, score)
        -- + inversion bonus; no round-trip deduct, no gamma, no fire count),
        -- not raw score, so the chip count matches the qas-filtered feed. Same
        -- expression as qasExprText in api/lottery-finder.ts (pinned by
        -- api/__tests__/lottery-qas-sql.ts).
        AND (
          ${minQas ?? null}::int IS NULL
          OR (
            GREATEST(0, COALESCE(cd.score, 0))
            + ${db.unsafe(INVERSION_BONUS_CASE_SQL)}
          ) >= ${minQas ?? 0}
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
        minTier: q.minTier ?? null,
        minPremium,
        minFireCount,
        maxFireCount,
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
    sendDbErrorResponse(res, err, {
      label: 'lottery_finder_ticker_counts',
      serverErrorBody: { error: 'Internal error' },
    });
  }
}
