/**
 * GET /api/lottery-finder
 *
 * Owner-or-guest read endpoint backing the LotteryFinder component.
 * Returns recent v4 trigger fires from `lottery_finder_fires` with
 * derived discriminators (RE-LOAD, cheap-call-PM), the macro snapshot
 * captured at fire time (display-only, see spec Appendix A), and the
 * realized-exit outcomes under each policy when the enrich cron has
 * filled them in.
 *
 * Query params: ?date= ?at= ?ticker= ?reload= ?cheapCallPm= ?mode= ?limit=
 * Validated by `lotteryFinderQuerySchema` in api/_lib/validation.ts.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { lotteryFinderQuerySchema } from './_lib/validation.js';
import {
  gammaScoreAdjustment,
  lotteryScoreTier,
  type LotteryScoreTier,
} from './_lib/lottery-score-weights.js';
import { avgHoldMinutesFor } from './_lib/lottery-hold.js';
import {
  MEGA_CLUSTER_MIN_DISTINCT_TICKERS,
  MIN_ALERT_ENTRY_PRICE,
  REIGNITION_MIN_FIRES,
  REIGNITION_MIN_GAP_MIN,
  REIGNITION_MIN_POST_GAP_FIRES,
  REIGNITION_TOP_N_PER_DAY,
} from './_lib/constants.js';
import { getETDateStr } from '../src/utils/timezone.js';

type DbId = number | string;
type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;
type DbOptionType = 'C' | 'P';

interface FireRow {
  id: DbId;
  // neon serverless returns DATE columns as Date objects (not strings)
  // unless `arrayMode`/`fullResults` is configured otherwise. Type
  // accordingly and normalise via toIso() at the boundary.
  date: DbTimestamp;
  trigger_time_ct: DbTimestamp;
  entry_time_ct: DbTimestamp;
  option_chain_id: string;
  underlying_symbol: string;
  option_type: DbOptionType;
  strike: DbNumeric;
  expiry: string;
  dte: number;

  trigger_vol_to_oi_window: DbNumeric;
  trigger_vol_to_oi_cum: DbNumeric;
  trigger_iv: DbNumeric;
  trigger_delta: DbNumeric;
  trigger_ask_pct: DbNumeric;
  trigger_window_size: DbNumeric;
  trigger_window_prints: number;

  entry_price: DbNumeric;
  open_interest: number;
  spot_at_first: DbNumeric;
  alert_seq: number;
  minutes_since_prev_fire: DbNumeric;

  flow_quad: string;
  tod: string;
  mode: string;
  reload_tagged: boolean;
  cheap_call_pm_tagged: boolean;
  burst_ratio_vs_prev: DbNullableNumeric;
  entry_drop_pct_vs_prev: DbNullableNumeric;

  mkt_tide_ncp: DbNullableNumeric;
  mkt_tide_npp: DbNullableNumeric;
  mkt_tide_diff: DbNullableNumeric;
  mkt_tide_otm_diff: DbNullableNumeric;
  spx_flow_diff: DbNullableNumeric;
  spy_etf_diff: DbNullableNumeric;
  qqq_etf_diff: DbNullableNumeric;
  zero_dte_diff: DbNullableNumeric;
  spx_spot_gamma_oi: DbNullableNumeric;
  spx_spot_gamma_vol: DbNullableNumeric;
  spx_spot_charm_oi: DbNullableNumeric;
  spx_spot_vanna_oi: DbNullableNumeric;
  gex_strike_call_minus_put: DbNullableNumeric;
  gex_strike_call_ask_minus_bid: DbNullableNumeric;
  gex_strike_put_ask_minus_bid: DbNullableNumeric;
  gex_strike_actual_strike: DbNullableNumeric;

  realized_trail30_10_pct: DbNullableNumeric;
  realized_hard30m_pct: DbNullableNumeric;
  realized_tier50_holdeod_pct: DbNullableNumeric;
  realized_flow_inversion_pct: DbNullableNumeric;
  realized_eod_pct: DbNullableNumeric;
  peak_ceiling_pct: DbNullableNumeric;
  minutes_to_peak: DbNullableNumeric;
  inserted_at: DbTimestamp;
  enriched_at: DbTimestamp | null;

  // Tiered scoring (migration #126). `score` is computed at insert
  // time from ticker × mode × entry-price × TOD × option-type. The
  // ticker_* columns come from the LEFT JOIN on lottery_ticker_stats.
  score: number | null;
  // Phase 4 direction gate (migration #151, spec
  // silent-boom-direction-gate-and-trail-ui-2026-05-14.md). TRUE when
  // the fire was counter-trend per Market Tide OTM at fire time. The
  // raw `score` is preserved on the row; the feed overrides the
  // displayed `scoreTier` to 'tier3' when this flag is set.
  direction_gated: boolean;
  // Range Kill (migration #153). Position of spot_at_first within the
  // underlying's session range at trigger_time_ct ∈ [0, 1]. NULL on
  // pre-#153 fires + new fires where the UW candle fetch failed.
  range_pos_at_trigger: DbNullableNumeric;
  // Round-trip score deduct (migration #154, spec
  // round-trip-score-deduct-production-2026-05-16.md). Computed 60-75
  // min post-fire by the evaluate-round-trip cron from ws_option_trades.
  // round_trip_net_pct in [-1, +1]; deduct is a stepped bracket: < -0.50
  // → -3, [-0.50, -0.30) → -2, [-0.30, -0.10) → -1, else 0. Applied to
  // the displayed score at read time so a strong-tier alert that
  // round-tripped within an hour gets demoted in the panel.
  round_trip_net_pct: DbNullableNumeric;
  round_trip_score_deduct: number | null;
  // Fire-count score adjustment (migration #167). Stored column
  // maintained by trigger on INSERT — the per-chain-day bucket map
  // (1→-3, 2-3→-1, 4-7→0, 8-15→+1, ≥16→+2) is applied at SQL level
  // rather than at API read time. Included in combined_score's
  // GENERATED expression so the score-sort ORDER BY picks it up.
  fire_count_score_adjustment: number;
  // Gamma at trigger time (migration #168). Captured by the detect
  // cron from raw_payload->>'gamma'. NULL on rows inserted before
  // migration #168 lands. Feeds combined_score's gamma bonus CASE
  // expression and the UI HIGH-Γ chip.
  gamma_at_trigger: DbNullableNumeric;
  // Take-It calibrated win probability + bundle version (migration #155,
  // spec takeit-phase3-production-scoring-2026-05-16.md). Populated at
  // detect time via api/_lib/takeit-score.ts walking the XGBoost JSON
  // bundle fetched from Vercel Blob. NULL when the bundle was unreachable
  // at detect time (fail-open). takeit_top_features is JSONB; null until
  // the Phase 3d SHAP fill cron back-populates it.
  takeit_prob: DbNullableNumeric;
  takeit_top_features: unknown;
  takeit_model_version: string | null;
  ticker_n_fires: number | null;
  ticker_high_peak_rate: DbNullableNumeric;
  ticker_ci_lower: DbNullableNumeric;
  ticker_ci_upper: DbNullableNumeric;
  ticker_ci_width: DbNullableNumeric;
  ticker_tier: string | null;

  // Per-(date, ticker, strike, option_type, expiry) aggregate count
  // from the chain-day dedup CTE. Hot chains stay genuinely hot for
  // hours — TSLA 392.5C fired 315 times in a single 6.5-hour session.
  // We collapse to one row per chain per day with the LATEST fire as
  // the rep (freshest macro / score / exit policy), surfacing the
  // cluster size and the first-fire timestamp so the UI can render
  // "×315 · since 13:30" for a still-hot chain.
  fire_count: number;
  first_fire_time_ct: DbTimestamp;

  // Ticker net flow snapshotted at trigger_time_ct via LATERAL.
  // NULL when the ws/REST tables hold no rows for this ticker at or
  // before the fire (older fires pre-WS-daemon, or universes not yet
  // subscribed). The client uses these to detect flow-inversion vs.
  // the live snapshot from /api/ticker-net-flow-current.
  fire_time_cum_ncp: DbNullableNumeric;
  fire_time_cum_npp: DbNullableNumeric;
}

/**
 * Per-minute distinct-ticker aggregate row returned by the
 * clusterByMinute parallel query. Drives MEGA-CLUSTER badge — when
 * a CT-minute has ≥MEGA_CLUSTER_MIN_DISTINCT_TICKERS distinct
 * underlying tickers firing, every fire in that minute gets the flag.
 */
interface ClusterByMinuteRow {
  minute_bucket_ct: string | Date;
  distinct_tickers: number;
}

/**
 * Per-chain aggregate row returned by the chainExtras parallel query.
 * Phase 1 of lottery-reignition-ui-2026-05-17 — fuels the
 * `historicalFires` array on the chart panel and the `reignited` flag
 * driving the pinned "Hot Right Now" section.
 *
 * `fires_json` is a jsonb_agg result; the Neon driver returns it as a
 * parsed JS array. Embedded timestamps come back as strings (Postgres
 * serialises timestamptz inside JSON to ISO 8601). `expiry` is a DATE
 * column so it may be a Date OR a string depending on driver config.
 */
interface ChainExtrasRow {
  underlying_symbol: string;
  strike: DbNumeric;
  option_type: DbOptionType;
  expiry: string | Date;
  fires_json: Array<{ triggerTimeCt: string; entryPrice: DbNumeric }> | null;
  reignited: boolean;
}

/** Predicted peak-return range string for a given score tier. */
function forecastForTier(tier: LotteryScoreTier): string {
  if (tier === 'tier1') return '30-50%';
  if (tier === 'tier2') return '15-30%';
  return '0-15%';
}

const toIso = (v: DbTimestamp): string =>
  typeof v === 'string' ? v : v.toISOString();

const num = (v: DbNullableNumeric): number | null =>
  v == null ? null : Number(v);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const parsed = lotteryFinderQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid query',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    const {
      ticker,
      reload,
      cheapCallPm,
      mode,
      optionType,
      tod,
      date,
      at,
      minute,
      limit,
      offset,
      sort,
      minScore,
    } = parsed.data;

    // Bound the result set to one trading day. `date` defaults to
    // ET-today; the trading day rolls in CT/ET, not UTC. We filter on
    // the `date` column (which the cron stamps from ctx.today, also
    // ET-anchored) — exact equality, no TZ-bound math required.
    const targetDate = date ?? getETDateStr(new Date());

    // Time-window resolution: `minute` (point-in-time bucket) wins
    // over `at` (cumulative cutoff). When neither is set, the whole
    // day is in scope. Sentinel pair lets the SQL stay one shape:
    // [windowStart, windowEnd) covers minute-bucket; for cutoff/full-day
    // we set windowStart to the dawn of time and windowEnd to the
    // requested upper bound.
    let windowStart: string;
    let windowEnd: string;
    if (minute) {
      // 1-minute bucket: [minute, minute + 1 min)
      windowStart = minute;
      windowEnd = new Date(Date.parse(minute) + 60_000).toISOString();
    } else if (at) {
      // Cumulative cutoff: (-∞, at]. Use a far-past sentinel for the
      // lower bound and `at + 1 ms` for the upper so `< windowEnd`
      // matches the historical `<= at` semantic.
      windowStart = '1970-01-01T00:00:00.000Z';
      windowEnd = new Date(Date.parse(at) + 1).toISOString();
    } else {
      // Whole day for `targetDate`.
      windowStart = '1970-01-01T00:00:00.000Z';
      windowEnd = `${targetDate}T23:59:59.999Z`;
    }

    // Reignition ranking + fire-history aggregation are cumulative
    // through the requested cutoff, not bounded to the minute slice the
    // main row payload uses. A chain that fired earlier in the day
    // should keep its REIGNITED badge whether the timeline slider is
    // parked on a quiet minute or the moment of the latest fire. The
    // cutoff matches the main `windowEnd` for `at` + default modes; in
    // `minute` mode we extend back to start-of-day so the rank reflects
    // the chain's full session shape up through the bucket.
    const reignitionWindowEnd = windowEnd;

    const db = getDb();

    // Two queries in parallel: (1) the row payload bounded by LIMIT,
    // and (2) the total matching count BEFORE limit so the UI can
    // surface "showing N of M" when the limit truncates the day.
    //
    // Chain-day dedup CTE: a single hot chain (e.g. TSLA 392.5C) can
    // fire 100-300+ times in one session because high-vol/OI activity
    // legitimately persists for hours. We collapse to one row per
    // (date, underlying_symbol, strike, option_type, expiry) — the
    // LATEST fire wins (freshest macro / score / exit policy),
    // `fire_count` carries the cluster size, and `first_fire_time_ct`
    // marks the burst start so the UI can render "×N · since HH:MM".
    // Pagination math (LIMIT/OFFSET, total) operates on the collapsed
    // shape. Date is already filter-bound to one day, so the partition
    // doesn't need to include it — but expiry is required because the
    // same strike can have multiple expiries listed on the same date.
    //
    // Sort modes (mutually exclusive ORDER BYs — neon's tagged
    // templates can't bind ORDER BY through `${}`, so we branch on
    // the validated `sort` enum):
    //   - chronological: most-recent first (default; preserves prior UX)
    //   - score: Tier-1 fires float to the top, score-tied chronological
    //   - peak: highest realized peak first (post-hoc browsing)
    // The score sort uses migration #159's `combined_score` STORED
    // generated column + (date DESC, combined_score DESC NULLS LAST)
    // index — restores the indexed early-LIMIT path that commit 4fc7ec99
    // lost when it changed ORDER BY to a computed expression on
    // (score + round_trip_score_deduct). The peak sort relies on
    // (date DESC, trigger_time_ct DESC) for the date prefix.
    // Per-row cum_ncp / cum_npp at fire time come straight off the row
    // (migration #158 cum_ncp_at_fire / cum_npp_at_fire columns,
    // populated at detect time by api/_lib/ticker-flow-snapshot.ts);
    // previously these were computed via a LEFT JOIN LATERAL that
    // dominated wall time at ~30s/page (spec:
    // docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md).
    const [
      rows,
      totalRows,
      chainExtras,
      clusterByMinute,
      sbChains,
      reignitedRows,
    ] = (await Promise.all([
      sort === 'score'
        ? db`
        WITH filtered AS (
          SELECT
            f.*,
            COUNT(*) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
            )::int AS fire_count,
            MIN(f.trigger_time_ct) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
            ) AS first_fire_time_ct,
            ROW_NUMBER() OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
              ORDER BY f.trigger_time_ct DESC, f.id DESC
            ) AS rn
          FROM lottery_finder_fires f
          WHERE f.date = ${targetDate}::date
            AND f.trigger_time_ct >= ${windowStart}::timestamptz
            AND f.trigger_time_ct < ${windowEnd}::timestamptz
            AND (${ticker ?? null}::text IS NULL OR f.underlying_symbol = ${ticker ?? ''})
            AND (${reload ?? null}::boolean IS NULL OR f.reload_tagged = ${reload ?? false})
            AND (${cheapCallPm ?? null}::boolean IS NULL OR f.cheap_call_pm_tagged = ${cheapCallPm ?? false})
            AND (${mode ?? null}::text IS NULL OR f.mode = ${mode ?? ''})
            AND (${optionType ?? null}::text IS NULL OR f.option_type = ${optionType ?? ''})
            AND (${tod ?? null}::text IS NULL OR f.tod = ${tod ?? ''})
            AND (${minScore ?? null}::int IS NULL OR f.score >= ${minScore ?? 0})
            AND f.entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
        )
        SELECT
          f.id, f.date, f.trigger_time_ct, f.entry_time_ct, f.option_chain_id,
          f.underlying_symbol, f.option_type, f.strike, f.expiry, f.dte,
          f.trigger_vol_to_oi_window, f.trigger_vol_to_oi_cum,
          f.trigger_iv, f.trigger_delta, f.trigger_ask_pct,
          f.trigger_window_size, f.trigger_window_prints,
          f.entry_price, f.open_interest, f.spot_at_first,
          f.alert_seq, f.minutes_since_prev_fire,
          f.flow_quad, f.tod, f.mode,
          f.reload_tagged, f.cheap_call_pm_tagged,
          f.burst_ratio_vs_prev, f.entry_drop_pct_vs_prev,
          f.mkt_tide_ncp, f.mkt_tide_npp, f.mkt_tide_diff, f.mkt_tide_otm_diff,
          f.spx_flow_diff, f.spy_etf_diff, f.qqq_etf_diff, f.zero_dte_diff,
          f.spx_spot_gamma_oi, f.spx_spot_gamma_vol, f.spx_spot_charm_oi, f.spx_spot_vanna_oi,
          f.gex_strike_call_minus_put, f.gex_strike_call_ask_minus_bid,
          f.gex_strike_put_ask_minus_bid, f.gex_strike_actual_strike,
          f.realized_trail30_10_pct, f.realized_hard30m_pct,
          f.realized_tier50_holdeod_pct, f.realized_flow_inversion_pct,
          f.realized_eod_pct,
          f.peak_ceiling_pct, f.minutes_to_peak,
          f.inserted_at, f.enriched_at,
          f.score, f.direction_gated, f.range_pos_at_trigger,
          f.round_trip_net_pct, f.round_trip_score_deduct,
          f.fire_count_score_adjustment,
          f.gamma_at_trigger,
          f.takeit_prob, f.takeit_top_features, f.takeit_model_version,
          f.fire_count, f.first_fire_time_ct,
          s.n_fires AS ticker_n_fires,
          s.high_peak_rate AS ticker_high_peak_rate,
          s.ci_lower AS ticker_ci_lower,
          s.ci_upper AS ticker_ci_upper,
          s.ci_width AS ticker_ci_width,
          s.tier AS ticker_tier,
          f.cum_ncp_at_fire AS fire_time_cum_ncp,
          f.cum_npp_at_fire AS fire_time_cum_npp
        FROM filtered f
        LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol
        WHERE f.rn = 1
        ORDER BY f.combined_score DESC NULLS LAST, f.trigger_time_ct DESC, f.id DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `
        : sort === 'peak'
          ? db`
        WITH filtered AS (
          SELECT
            f.*,
            COUNT(*) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
            )::int AS fire_count,
            MIN(f.trigger_time_ct) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
            ) AS first_fire_time_ct,
            ROW_NUMBER() OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
              ORDER BY f.trigger_time_ct DESC, f.id DESC
            ) AS rn
          FROM lottery_finder_fires f
          WHERE f.date = ${targetDate}::date
            AND f.trigger_time_ct >= ${windowStart}::timestamptz
            AND f.trigger_time_ct < ${windowEnd}::timestamptz
            AND (${ticker ?? null}::text IS NULL OR f.underlying_symbol = ${ticker ?? ''})
            AND (${reload ?? null}::boolean IS NULL OR f.reload_tagged = ${reload ?? false})
            AND (${cheapCallPm ?? null}::boolean IS NULL OR f.cheap_call_pm_tagged = ${cheapCallPm ?? false})
            AND (${mode ?? null}::text IS NULL OR f.mode = ${mode ?? ''})
            AND (${optionType ?? null}::text IS NULL OR f.option_type = ${optionType ?? ''})
            AND (${tod ?? null}::text IS NULL OR f.tod = ${tod ?? ''})
            AND (${minScore ?? null}::int IS NULL OR f.score >= ${minScore ?? 0})
            AND f.entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
        )
        SELECT
          f.id, f.date, f.trigger_time_ct, f.entry_time_ct, f.option_chain_id,
          f.underlying_symbol, f.option_type, f.strike, f.expiry, f.dte,
          f.trigger_vol_to_oi_window, f.trigger_vol_to_oi_cum,
          f.trigger_iv, f.trigger_delta, f.trigger_ask_pct,
          f.trigger_window_size, f.trigger_window_prints,
          f.entry_price, f.open_interest, f.spot_at_first,
          f.alert_seq, f.minutes_since_prev_fire,
          f.flow_quad, f.tod, f.mode,
          f.reload_tagged, f.cheap_call_pm_tagged,
          f.burst_ratio_vs_prev, f.entry_drop_pct_vs_prev,
          f.mkt_tide_ncp, f.mkt_tide_npp, f.mkt_tide_diff, f.mkt_tide_otm_diff,
          f.spx_flow_diff, f.spy_etf_diff, f.qqq_etf_diff, f.zero_dte_diff,
          f.spx_spot_gamma_oi, f.spx_spot_gamma_vol, f.spx_spot_charm_oi, f.spx_spot_vanna_oi,
          f.gex_strike_call_minus_put, f.gex_strike_call_ask_minus_bid,
          f.gex_strike_put_ask_minus_bid, f.gex_strike_actual_strike,
          f.realized_trail30_10_pct, f.realized_hard30m_pct,
          f.realized_tier50_holdeod_pct, f.realized_flow_inversion_pct,
          f.realized_eod_pct,
          f.peak_ceiling_pct, f.minutes_to_peak,
          f.inserted_at, f.enriched_at,
          f.score, f.direction_gated, f.range_pos_at_trigger,
          f.round_trip_net_pct, f.round_trip_score_deduct,
          f.fire_count_score_adjustment,
          f.gamma_at_trigger,
          f.takeit_prob, f.takeit_top_features, f.takeit_model_version,
          f.fire_count, f.first_fire_time_ct,
          s.n_fires AS ticker_n_fires,
          s.high_peak_rate AS ticker_high_peak_rate,
          s.ci_lower AS ticker_ci_lower,
          s.ci_upper AS ticker_ci_upper,
          s.ci_width AS ticker_ci_width,
          s.tier AS ticker_tier,
          f.cum_ncp_at_fire AS fire_time_cum_ncp,
          f.cum_npp_at_fire AS fire_time_cum_npp
        FROM filtered f
        LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol
        WHERE f.rn = 1
        ORDER BY f.peak_ceiling_pct DESC NULLS LAST, f.trigger_time_ct DESC, f.id DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `
          : db`
        WITH filtered AS (
          SELECT
            f.*,
            COUNT(*) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
            )::int AS fire_count,
            MIN(f.trigger_time_ct) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
            ) AS first_fire_time_ct,
            ROW_NUMBER() OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
              ORDER BY f.trigger_time_ct DESC, f.id DESC
            ) AS rn
          FROM lottery_finder_fires f
          WHERE f.date = ${targetDate}::date
            AND f.trigger_time_ct >= ${windowStart}::timestamptz
            AND f.trigger_time_ct < ${windowEnd}::timestamptz
            AND (${ticker ?? null}::text IS NULL OR f.underlying_symbol = ${ticker ?? ''})
            AND (${reload ?? null}::boolean IS NULL OR f.reload_tagged = ${reload ?? false})
            AND (${cheapCallPm ?? null}::boolean IS NULL OR f.cheap_call_pm_tagged = ${cheapCallPm ?? false})
            AND (${mode ?? null}::text IS NULL OR f.mode = ${mode ?? ''})
            AND (${optionType ?? null}::text IS NULL OR f.option_type = ${optionType ?? ''})
            AND (${tod ?? null}::text IS NULL OR f.tod = ${tod ?? ''})
            AND (${minScore ?? null}::int IS NULL OR f.score >= ${minScore ?? 0})
            AND f.entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
        )
        SELECT
          f.id, f.date, f.trigger_time_ct, f.entry_time_ct, f.option_chain_id,
          f.underlying_symbol, f.option_type, f.strike, f.expiry, f.dte,
          f.trigger_vol_to_oi_window, f.trigger_vol_to_oi_cum,
          f.trigger_iv, f.trigger_delta, f.trigger_ask_pct,
          f.trigger_window_size, f.trigger_window_prints,
          f.entry_price, f.open_interest, f.spot_at_first,
          f.alert_seq, f.minutes_since_prev_fire,
          f.flow_quad, f.tod, f.mode,
          f.reload_tagged, f.cheap_call_pm_tagged,
          f.burst_ratio_vs_prev, f.entry_drop_pct_vs_prev,
          f.mkt_tide_ncp, f.mkt_tide_npp, f.mkt_tide_diff, f.mkt_tide_otm_diff,
          f.spx_flow_diff, f.spy_etf_diff, f.qqq_etf_diff, f.zero_dte_diff,
          f.spx_spot_gamma_oi, f.spx_spot_gamma_vol, f.spx_spot_charm_oi, f.spx_spot_vanna_oi,
          f.gex_strike_call_minus_put, f.gex_strike_call_ask_minus_bid,
          f.gex_strike_put_ask_minus_bid, f.gex_strike_actual_strike,
          f.realized_trail30_10_pct, f.realized_hard30m_pct,
          f.realized_tier50_holdeod_pct, f.realized_flow_inversion_pct,
          f.realized_eod_pct,
          f.peak_ceiling_pct, f.minutes_to_peak,
          f.inserted_at, f.enriched_at,
          f.score, f.direction_gated, f.range_pos_at_trigger,
          f.round_trip_net_pct, f.round_trip_score_deduct,
          f.fire_count_score_adjustment,
          f.gamma_at_trigger,
          f.takeit_prob, f.takeit_top_features, f.takeit_model_version,
          f.fire_count, f.first_fire_time_ct,
          s.n_fires AS ticker_n_fires,
          s.high_peak_rate AS ticker_high_peak_rate,
          s.ci_lower AS ticker_ci_lower,
          s.ci_upper AS ticker_ci_upper,
          s.ci_width AS ticker_ci_width,
          s.tier AS ticker_tier,
          f.cum_ncp_at_fire AS fire_time_cum_ncp,
          f.cum_npp_at_fire AS fire_time_cum_npp
        FROM filtered f
        LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol
        WHERE f.rn = 1
        ORDER BY f.trigger_time_ct DESC, f.id DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      // Total counts the collapsed shape (one row per chain per day:
      // ticker × strike × option_type × expiry) so pagination math
      // matches the dedup'd CTE above.
      db`
        SELECT COUNT(*)::int AS total
        FROM (
          SELECT 1
          FROM lottery_finder_fires
          WHERE date = ${targetDate}::date
            AND trigger_time_ct >= ${windowStart}::timestamptz
            AND trigger_time_ct < ${windowEnd}::timestamptz
            AND (${ticker ?? null}::text IS NULL OR underlying_symbol = ${ticker ?? ''})
            AND (${reload ?? null}::boolean IS NULL OR reload_tagged = ${reload ?? false})
            AND (${cheapCallPm ?? null}::boolean IS NULL OR cheap_call_pm_tagged = ${cheapCallPm ?? false})
            AND (${mode ?? null}::text IS NULL OR mode = ${mode ?? ''})
            AND (${optionType ?? null}::text IS NULL OR option_type = ${optionType ?? ''})
            AND (${tod ?? null}::text IS NULL OR tod = ${tod ?? ''})
            AND (${minScore ?? null}::int IS NULL OR score >= ${minScore ?? 0})
            AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
          GROUP BY underlying_symbol, strike, option_type, expiry
        ) collapsed
      `,
      // Chain-extras query (Phase 1 of lottery-reignition-ui-2026-05-17):
      // returns per-chain fire history (jsonb array of all fires today,
      // ordered chronologically) + the REIGNITION top-N flag. Joined to
      // the row payload below by (ticker × strike × option_type × expiry).
      //
      // Reignition criteria — gap math uses trigger_time_ct differences
      // directly, NOT the broken `minutes_since_prev_fire` column (NULL/0
      // on the QQQ 708P 2026-05-15 anchor despite 21 distinct fires).
      // The per-day rank is computed GLOBALLY (ignoring user filters
      // beyond date + system-level entry_price floor) so the badge has
      // stable semantics across filter views — a chain that's #3 of
      // the day stays #3 whether the user is filtered to QQQ-only or
      // showing all tickers.
      db`
        WITH ordered AS (
          SELECT
            underlying_symbol, strike, option_type, expiry,
            trigger_time_ct, entry_price,
            EXTRACT(EPOCH FROM trigger_time_ct - LAG(trigger_time_ct) OVER w) / 60.0 AS gap_min,
            ROW_NUMBER() OVER w AS fire_seq,
            COUNT(*) OVER w_total AS fire_count
          FROM lottery_finder_fires
          WHERE date = ${targetDate}::date
            AND trigger_time_ct < ${reignitionWindowEnd}::timestamptz
            AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
          WINDOW
            w AS (PARTITION BY underlying_symbol, strike, option_type, expiry ORDER BY trigger_time_ct ASC),
            w_total AS (PARTITION BY underlying_symbol, strike, option_type, expiry)
        ),
        max_gap_by_chain AS (
          SELECT DISTINCT ON (underlying_symbol, strike, option_type, expiry)
            underlying_symbol, strike, option_type, expiry,
            gap_min AS max_gap_min,
            fire_seq AS post_gap_start_seq
          FROM ordered
          WHERE gap_min IS NOT NULL
          ORDER BY underlying_symbol, strike, option_type, expiry, gap_min DESC
        ),
        per_chain AS (
          SELECT
            o.underlying_symbol,
            o.strike,
            o.option_type,
            o.expiry,
            MAX(o.fire_count)::int AS fire_count,
            COALESCE(MAX(g.max_gap_min), 0)::numeric AS max_gap_min,
            COALESCE(MAX(o.fire_count) - (MAX(g.post_gap_start_seq) - 1), 0)::int AS post_gap_fires,
            jsonb_agg(
              jsonb_build_object(
                'triggerTimeCt', o.trigger_time_ct,
                'entryPrice', o.entry_price
              ) ORDER BY o.trigger_time_ct ASC
            ) AS fires_json
          FROM ordered o
          LEFT JOIN max_gap_by_chain g USING (underlying_symbol, strike, option_type, expiry)
          GROUP BY o.underlying_symbol, o.strike, o.option_type, o.expiry
        ),
        qualified AS (
          SELECT
            underlying_symbol, strike, option_type, expiry,
            ROW_NUMBER() OVER (
              ORDER BY post_gap_fires DESC, fire_count DESC
            ) AS rn
          FROM per_chain
          WHERE fire_count >= ${REIGNITION_MIN_FIRES}
            AND max_gap_min >= ${REIGNITION_MIN_GAP_MIN}::numeric
            AND post_gap_fires >= ${REIGNITION_MIN_POST_GAP_FIRES}
        )
        SELECT
          pc.underlying_symbol,
          pc.strike,
          pc.option_type,
          pc.expiry,
          pc.fires_json,
          (q.rn IS NOT NULL AND q.rn <= ${REIGNITION_TOP_N_PER_DAY}) AS reignited
        FROM per_chain pc
        LEFT JOIN qualified q USING (underlying_symbol, strike, option_type, expiry)
        WHERE pc.fire_count > 1
      `,
      // Per-minute distinct-ticker count — fuels the MEGA-CLUSTER
      // badge. Truncates trigger_time_ct to the 1-min bucket and
      // counts unique tickers per bucket across the date. Filtered
      // by date + entry_price floor only (NOT user filters) so the
      // count reflects the WHOLE market's minute concentration, not
      // a filtered subset — same stable-semantics decision as the
      // chainExtras reignition flag.
      db`
        SELECT
          date_trunc('minute', trigger_time_ct) AS minute_bucket_ct,
          COUNT(DISTINCT underlying_symbol)::int AS distinct_tickers
        FROM lottery_finder_fires
        WHERE date = ${targetDate}::date
          AND trigger_time_ct < ${reignitionWindowEnd}::timestamptz
          AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
        GROUP BY date_trunc('minute', trigger_time_ct)
        HAVING COUNT(DISTINCT underlying_symbol) >= ${MEGA_CLUSTER_MIN_DISTINCT_TICKERS}
      `,
      // Silent Boom chain-IDs for the date — drives the DUAL FLAG
      // badge. When the same chain-day appears in BOTH
      // lottery_finder_fires AND silent_boom_alerts, the cohort is
      // the highest-conviction surface in the alert stack — 81% win
      // rate on best fire / median best peak 64% (vs 72% / 35% for
      // LF-only). Empirical basis:
      // docs/tmp/lf-vs-sb-backtest-findings-2026-05-17.md (25-day
      // window, 981 BOTH chain-days, ~39/day). Cross-table check
      // wrapped in try/catch at execution because silent_boom_alerts
      // started 2026-04-13; for older dates the table may have no
      // matching rows but the query is still cheap.
      db`
        SELECT DISTINCT option_chain_id
        FROM silent_boom_alerts
        WHERE date = ${targetDate}::date
      `,
      // Pinned "Hot Right Now" rows — full row payload (same SELECT
      // shape as the main fires query) for the day's top-N reignited
      // chains, surfaced INDEPENDENT of pagination. Lets the UI keep
      // the pinned section visible on every page even when the
      // qualifying chains naturally sort onto a later page slice.
      //
      // Ranking math mirrors the chainExtras CTEs above (post_gap_fires
      // DESC, fire_count DESC, top-N) and runs unfiltered — a chain's
      // #N rank is global per day. The row payload SELECT applies the
      // same user filters the main query uses so the pinned section
      // honours the user's filter view; chains that qualify but don't
      // match filters drop out at the payload step (the rank itself
      // stays stable). Returns ≤ REIGNITION_TOP_N_PER_DAY rows; usually
      // 0–5 — no LIMIT/OFFSET needed.
      //
      // Spec: docs/superpowers/specs/lottery-reignition-ui-2026-05-17.md
      // Phase 3 ("REIGNITED section is always visible on every page").
      db`
        WITH ordered AS (
          SELECT
            underlying_symbol, strike, option_type, expiry,
            trigger_time_ct,
            EXTRACT(EPOCH FROM trigger_time_ct - LAG(trigger_time_ct) OVER w) / 60.0 AS gap_min,
            ROW_NUMBER() OVER w AS fire_seq,
            COUNT(*) OVER w_total AS fire_count
          FROM lottery_finder_fires
          WHERE date = ${targetDate}::date
            AND trigger_time_ct < ${reignitionWindowEnd}::timestamptz
            AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
          WINDOW
            w AS (PARTITION BY underlying_symbol, strike, option_type, expiry ORDER BY trigger_time_ct ASC),
            w_total AS (PARTITION BY underlying_symbol, strike, option_type, expiry)
        ),
        max_gap_by_chain AS (
          SELECT DISTINCT ON (underlying_symbol, strike, option_type, expiry)
            underlying_symbol, strike, option_type, expiry,
            gap_min AS max_gap_min,
            fire_seq AS post_gap_start_seq
          FROM ordered
          WHERE gap_min IS NOT NULL
          ORDER BY underlying_symbol, strike, option_type, expiry, gap_min DESC
        ),
        per_chain AS (
          SELECT
            o.underlying_symbol,
            o.strike,
            o.option_type,
            o.expiry,
            MAX(o.fire_count)::int AS chain_fire_count,
            COALESCE(MAX(g.max_gap_min), 0)::numeric AS max_gap_min,
            COALESCE(MAX(o.fire_count) - (MAX(g.post_gap_start_seq) - 1), 0)::int AS post_gap_fires
          FROM ordered o
          LEFT JOIN max_gap_by_chain g USING (underlying_symbol, strike, option_type, expiry)
          GROUP BY o.underlying_symbol, o.strike, o.option_type, o.expiry
        ),
        top_reignited AS (
          SELECT underlying_symbol, strike, option_type, expiry
          FROM per_chain
          WHERE chain_fire_count >= ${REIGNITION_MIN_FIRES}
            AND max_gap_min >= ${REIGNITION_MIN_GAP_MIN}::numeric
            AND post_gap_fires >= ${REIGNITION_MIN_POST_GAP_FIRES}
          ORDER BY post_gap_fires DESC, chain_fire_count DESC
          LIMIT ${REIGNITION_TOP_N_PER_DAY}
        ),
        filtered AS (
          SELECT
            f.*,
            COUNT(*) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
            )::int AS fire_count,
            MIN(f.trigger_time_ct) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
            ) AS first_fire_time_ct,
            ROW_NUMBER() OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
              ORDER BY f.trigger_time_ct DESC, f.id DESC
            ) AS rn
          FROM lottery_finder_fires f
          INNER JOIN top_reignited t USING (underlying_symbol, strike, option_type, expiry)
          WHERE f.date = ${targetDate}::date
            AND f.trigger_time_ct < ${reignitionWindowEnd}::timestamptz
            AND (${ticker ?? null}::text IS NULL OR f.underlying_symbol = ${ticker ?? ''})
            AND (${reload ?? null}::boolean IS NULL OR f.reload_tagged = ${reload ?? false})
            AND (${cheapCallPm ?? null}::boolean IS NULL OR f.cheap_call_pm_tagged = ${cheapCallPm ?? false})
            AND (${mode ?? null}::text IS NULL OR f.mode = ${mode ?? ''})
            AND (${optionType ?? null}::text IS NULL OR f.option_type = ${optionType ?? ''})
            AND (${tod ?? null}::text IS NULL OR f.tod = ${tod ?? ''})
            AND (${minScore ?? null}::int IS NULL OR f.score >= ${minScore ?? 0})
            AND f.entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
        )
        SELECT
          f.id, f.date, f.trigger_time_ct, f.entry_time_ct, f.option_chain_id,
          f.underlying_symbol, f.option_type, f.strike, f.expiry, f.dte,
          f.trigger_vol_to_oi_window, f.trigger_vol_to_oi_cum,
          f.trigger_iv, f.trigger_delta, f.trigger_ask_pct,
          f.trigger_window_size, f.trigger_window_prints,
          f.entry_price, f.open_interest, f.spot_at_first,
          f.alert_seq, f.minutes_since_prev_fire,
          f.flow_quad, f.tod, f.mode,
          f.reload_tagged, f.cheap_call_pm_tagged,
          f.burst_ratio_vs_prev, f.entry_drop_pct_vs_prev,
          f.mkt_tide_ncp, f.mkt_tide_npp, f.mkt_tide_diff, f.mkt_tide_otm_diff,
          f.spx_flow_diff, f.spy_etf_diff, f.qqq_etf_diff, f.zero_dte_diff,
          f.spx_spot_gamma_oi, f.spx_spot_gamma_vol, f.spx_spot_charm_oi, f.spx_spot_vanna_oi,
          f.gex_strike_call_minus_put, f.gex_strike_call_ask_minus_bid,
          f.gex_strike_put_ask_minus_bid, f.gex_strike_actual_strike,
          f.realized_trail30_10_pct, f.realized_hard30m_pct,
          f.realized_tier50_holdeod_pct, f.realized_flow_inversion_pct,
          f.realized_eod_pct,
          f.peak_ceiling_pct, f.minutes_to_peak,
          f.inserted_at, f.enriched_at,
          f.score, f.direction_gated, f.range_pos_at_trigger,
          f.round_trip_net_pct, f.round_trip_score_deduct,
          f.fire_count_score_adjustment,
          f.gamma_at_trigger,
          f.takeit_prob, f.takeit_top_features, f.takeit_model_version,
          f.fire_count, f.first_fire_time_ct,
          s.n_fires AS ticker_n_fires,
          s.high_peak_rate AS ticker_high_peak_rate,
          s.ci_lower AS ticker_ci_lower,
          s.ci_upper AS ticker_ci_upper,
          s.ci_width AS ticker_ci_width,
          s.tier AS ticker_tier,
          f.cum_ncp_at_fire AS fire_time_cum_ncp,
          f.cum_npp_at_fire AS fire_time_cum_npp
        FROM filtered f
        LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol
        WHERE f.rn = 1
        ORDER BY f.trigger_time_ct DESC, f.id DESC
      `,
    ])) as [
      FireRow[],
      { total: number }[],
      ChainExtrasRow[],
      ClusterByMinuteRow[],
      { option_chain_id: string }[],
      FireRow[],
    ];

    const total = totalRows[0]?.total ?? 0;

    // Build a Map keyed on (ticker | strike | option_type | expiry) for
    // O(1) lookup when assembling the row payload. expiry comes back as
    // a Date from the Neon driver (per the project's neon_date_columns
    // convention) — normalise to YYYY-MM-DD so the key shape is stable
    // regardless of the wire format.
    // Silent Boom dual-flag lookup: Set of option_chain_ids that also
    // fired on the Silent Boom detector for the same date. O(1)
    // membership check during row mapping. Empty Set is the common
    // case on dates before silent_boom_alerts started populating
    // (2026-04-13 onward).
    const sbChainSet = new Set<string>();
    for (const sb of sbChains) {
      sbChainSet.add(sb.option_chain_id);
    }

    // Mega-cluster lookup: minute-bucket ISO → distinct-ticker count.
    // Only minute buckets with >= MEGA_CLUSTER_MIN_DISTINCT_TICKERS
    // distinct tickers are present in the result set — the SQL HAVING
    // clause filters out the long tail of normal minutes. Empty Map
    // is the common case (most days have no qualifying minutes).
    const megaClusterByMinute = new Map<string, number>();
    for (const cm of clusterByMinute) {
      const bucketIso =
        typeof cm.minute_bucket_ct === 'string'
          ? cm.minute_bucket_ct
          : cm.minute_bucket_ct.toISOString();
      // Normalize to whole-minute precision so the row-time lookup
      // (date_trunc'd to the minute) matches regardless of seconds.
      const minuteKey = bucketIso.slice(0, 16); // "YYYY-MM-DDTHH:MM"
      megaClusterByMinute.set(minuteKey, Number(cm.distinct_tickers));
    }

    const chainExtraByKey = new Map<
      string,
      {
        historicalFires: Array<{ triggerTimeCt: string; entryPrice: number }>;
        reignited: boolean;
      }
    >();
    for (const ce of chainExtras) {
      const expiryStr =
        typeof ce.expiry === 'string'
          ? ce.expiry.slice(0, 10)
          : ce.expiry.toISOString().slice(0, 10);
      const rawFires = Array.isArray(ce.fires_json) ? ce.fires_json : [];
      // fires_json is sorted ASC by trigger_time_ct from the SQL ORDER BY;
      // the LAST element is the latest fire (which is already represented
      // on the row by `triggerTimeCt` + `entry.price`), so we slice it
      // off here — `historicalFires` carries past fires only.
      const past = rawFires.slice(0, -1).map((f) => ({
        triggerTimeCt:
          typeof f.triggerTimeCt === 'string'
            ? f.triggerTimeCt
            : new Date(f.triggerTimeCt as string).toISOString(),
        entryPrice: Number(f.entryPrice),
      }));
      const key = `${ce.underlying_symbol}|${Number(ce.strike)}|${ce.option_type}|${expiryStr}`;
      chainExtraByKey.set(key, {
        historicalFires: past,
        reignited: ce.reignited === true,
      });
    }

    // Macro Window lookup (spec: lottery-silentboom-eda-impl-2026-05-16.md
    // Finding 4). Pull every high-impact economic event whose event_time
    // falls between the earliest fire's trigger_time and 7 days after
    // the latest fire's trigger_time, then per-fire compute hours-to-
    // next-event in JS. Cheap because economic_events is small
    // (~1 row/day) and the EDA found 1.32× win50 / 1.56× win100 lift
    // for fires 24-72h before a high-impact event.
    const macroEventTimes: Date[] = await (async () => {
      // Compute the lookup window from the UNION of (page slice + pinned
      // reignited rows) — pinned rows can carry trigger_time_ct outside
      // the page slice's range, and we still need their macro-window
      // badges to render. Empty when BOTH sources are empty.
      const macroSources = [...rows, ...reignitedRows];
      if (macroSources.length === 0) return [];
      const triggerTimes = macroSources.map((r) =>
        r.trigger_time_ct instanceof Date
          ? r.trigger_time_ct
          : new Date(r.trigger_time_ct),
      );
      const minTrigger = new Date(
        Math.min(...triggerTimes.map((d) => d.getTime())),
      );
      const maxTrigger = new Date(
        Math.max(...triggerTimes.map((d) => d.getTime())),
      );
      const windowEnd = new Date(maxTrigger.getTime() + 7 * 24 * 3600 * 1000);
      const eventRows = (await db`
        SELECT event_time
        FROM economic_events
        WHERE event_type IN ('FOMC', 'CPI', 'PCE', 'JOBS')
          AND event_time IS NOT NULL
          AND event_time >= ${minTrigger.toISOString()}::timestamptz
          AND event_time <= ${windowEnd.toISOString()}::timestamptz
        ORDER BY event_time ASC
      `) as { event_time: string | Date }[];
      return eventRows.map((r) =>
        r.event_time instanceof Date ? r.event_time : new Date(r.event_time),
      );
    })();

    /** Hours from trigger to the next high-impact event, or null if
     *  none falls within the lookup window. */
    function hoursToNextMacroEvent(
      triggerTimeCt: Date | string,
    ): number | null {
      const triggerMs =
        triggerTimeCt instanceof Date
          ? triggerTimeCt.getTime()
          : new Date(triggerTimeCt).getTime();
      for (const ev of macroEventTimes) {
        const diffHrs = (ev.getTime() - triggerMs) / 3_600_000;
        if (diffHrs > 0) return diffHrs;
      }
      return null;
    }

    // Shared FireRow → API payload mapper. Closes over the lookup maps
    // (chainExtraByKey, megaClusterByMinute, sbChainSet) and the
    // hoursToNextMacroEvent helper, so the same logic powers both the
    // paginated page slice (`fires`) and the pinned reignited rows
    // (`reignitedFires`). Keeping a single mapper guarantees the two
    // surfaces never drift.
    const toLotteryFire = (r: FireRow) => {
      const rawScore = r.score == null ? null : Number(r.score);
      // Round-trip score deduct (migration #154 / Phase 2C of
      // round-trip-score-deduct-production-2026-05-16.md). Read-time
      // adjustment: a -3 deduct applied to a tier1-edge score can
      // demote it to tier2 or tier3. Raw `score` stays on the row;
      // `score` field below carries the displayed/effective value.
      const rtDeduct =
        r.round_trip_score_deduct == null
          ? 0
          : Number(r.round_trip_score_deduct);
      // Fire-count adjustment — promoted to a stored DB column in
      // migration #167. The trigger update_lottery_fire_count_score_adj
      // maintains it on every INSERT, and the `combined_score` STORED
      // generated column now sums score + round_trip_score_deduct +
      // fire_count_score_adjustment. The previous read-time TS
      // computation (commit 254c94ed) is retired here — the displayed
      // score now equals the SQL sort key, eliminating the divergence
      // documented in that commit. Read both `fire_count_score_adj`
      // and `combined_score` straight from the SELECT.
      const fireCountAdj = Number(r.fire_count_score_adjustment ?? 0);
      // Gamma at trigger time + the derived bonus (mirrors the SQL
      // CASE expression in combined_score, kept in sync via the
      // helper). Tooltip on the UI chip uses the value; the SQL sort
      // already includes the bonus via combined_score.
      const gammaAtTrigger =
        r.gamma_at_trigger != null ? Number(r.gamma_at_trigger) : null;
      const gammaAdj = gammaScoreAdjustment(
        gammaAtTrigger,
        r.underlying_symbol,
      );
      const score =
        rawScore == null
          ? null
          : Math.max(0, rawScore + rtDeduct + fireCountAdj + gammaAdj);
      const roundTripNetPct =
        r.round_trip_net_pct == null ? null : Number(r.round_trip_net_pct);
      // Phase 4 direction-gate override (spec:
      // silent-boom-direction-gate-and-trail-ui-2026-05-14.md). Lottery
      // does not mutate score on insert; the feed forces the displayed
      // tier to 'tier3' when the row was flagged counter-trend so the
      // UI badge + tier filters agree with the demoted semantics.
      const directionGated = r.direction_gated === true;
      const rawTier: LotteryScoreTier = lotteryScoreTier(score);
      const tier: LotteryScoreTier = directionGated ? 'tier3' : rawTier;
      const tickerStats =
        r.ticker_n_fires == null
          ? null
          : {
              nFires: Number(r.ticker_n_fires),
              highPeakRate: Number(r.ticker_high_peak_rate ?? 0),
              ciLower: Number(r.ticker_ci_lower ?? 0),
              ciUpper: Number(r.ticker_ci_upper ?? 0),
              ciWidth: Number(r.ticker_ci_width ?? 0),
              tier: (r.ticker_tier ?? '') as 'reliable' | 'uncertain' | '',
            };

      // Chain-extras lookup — same key shape as the map population
      // above so single-fire chains (which the chainExtras query skips
      // via WHERE fire_count > 1) miss the lookup and surface as
      // undefined `historicalFires` + falsy `reignited`.
      const expiryKey =
        typeof r.expiry === 'string'
          ? r.expiry.slice(0, 10)
          : toIso(r.expiry).slice(0, 10);
      const chainKey = `${r.underlying_symbol}|${Number(r.strike)}|${r.option_type}|${expiryKey}`;
      const chainExtra = chainExtraByKey.get(chainKey);
      // Mega-cluster lookup: truncate the fire's trigger_time_ct to
      // the minute and check whether that minute had ≥12 distinct
      // tickers fire. Misses are the common case (`size === undefined`
      // → not a mega-cluster).
      const triggerIso = toIso(r.trigger_time_ct);
      const minuteKey = triggerIso.slice(0, 16);
      const clusterSize = megaClusterByMinute.get(minuteKey);
      return {
        id: Number(r.id),
        date: toIso(r.date).slice(0, 10),
        triggerTimeCt: toIso(r.trigger_time_ct),
        entryTimeCt: toIso(r.entry_time_ct),
        optionChainId: r.option_chain_id,
        underlyingSymbol: r.underlying_symbol,
        optionType: r.option_type,
        strike: Number(r.strike),
        expiry:
          typeof r.expiry === 'string'
            ? r.expiry.slice(0, 10)
            : toIso(r.expiry).slice(0, 10),
        dte: Number(r.dte),

        score,
        // Pre-deduct score so the UI can show "was X, deducted to Y".
        // Equals `score` when no deduct or score was null.
        rawScore,
        roundTripNetPct,
        roundTripScoreDeduct: rtDeduct,
        // Read-time score adjustment from the chain's fire_count.
        // Single-fire chains carry -3, ≥16 fires carry +2. Mirrors the
        // round-trip deduct's read-time-only nature — not stored in
        // the DB, recomputed every request. Surfaced so the UI can
        // render a "+N burst" tooltip on the score badge.
        fireCountScoreAdjustment: fireCountAdj,
        // Gamma at trigger time (migration #168) + the per-row +1
        // bonus when gamma >= 0.025 AND ticker ∉ {'SPY','USO'}. The
        // bonus is included in `score` above; the raw value is
        // surfaced for the UI HIGH-Γ chip + tooltip.
        gammaAtTrigger,
        gammaScoreAdjustment: gammaAdj,
        takeitProb: r.takeit_prob == null ? null : Number(r.takeit_prob),
        takeitTopFeatures:
          r.takeit_top_features == null
            ? null
            : (r.takeit_top_features as Record<string, unknown>),
        takeitModelVersion: r.takeit_model_version,
        scoreTier: tier,
        directionGated,
        forecastHighPeakPct: forecastForTier(tier),
        // Cohort-derived "typical exit window" hint — historical P75
        // of minutes_to_peak among winners for this (tier, ticker)
        // pair. Surfaced as a "~Nmin" chip on the row. See
        // api/_lib/lottery-hold.ts for the lookup constants.
        avgHoldMinutes: avgHoldMinutesFor({
          tier,
          ticker: r.underlying_symbol,
        }),
        tickerStats,
        // Daily cluster size on the chain (ticker × strike × type ×
        // expiry). 1 = single fire today; higher means the row is the
        // LATEST of N fires on this chain through the day. Hot chains
        // routinely hit 50-300+ fires.
        fireCount: Number(r.fire_count ?? 1),
        firstFireTimeCt: toIso(r.first_fire_time_ct),
        // Phase 1 of lottery-reignition-ui-2026-05-17. Both fields are
        // additive: legacy clients ignoring them keep working.
        // `historicalFires` is omitted entirely (rather than emitted
        // as []) for single-fire chains to keep the response compact.
        ...(chainExtra && chainExtra.historicalFires.length > 0
          ? { historicalFires: chainExtra.historicalFires }
          : {}),
        reignited: chainExtra?.reignited === true,
        // MEGA-CLUSTER flag — true when this fire's CT-minute had at
        // least MEGA_CLUSTER_MIN_DISTINCT_TICKERS distinct tickers
        // firing. `megaClusterSize` carries the actual count so the
        // UI can render "MEGA CLUSTER · N tickers" instead of a bare
        // badge. Empirical basis: 12+ ticker minutes have +16.3%
        // median realized trail vs +6-7% in the 5-11 middle range
        // (cluster-2026-05-15-1205ct-findings.md).
        megaCluster: clusterSize != null,
        ...(clusterSize != null ? { megaClusterSize: clusterSize } : {}),
        // DUAL FLAG — chain appears in both lottery_finder_fires AND
        // silent_boom_alerts for the same date. 2.9% Jaccard overlap
        // / 81% win rate on best fire / median best peak 64%
        // (docs/tmp/lf-vs-sb-backtest-findings-2026-05-17.md, 25-day
        // window). Highest-conviction cohort in the alert stack.
        dualFlag: sbChainSet.has(r.option_chain_id),

        trigger: {
          volToOiWindow: Number(r.trigger_vol_to_oi_window),
          volToOiCum: Number(r.trigger_vol_to_oi_cum),
          iv: Number(r.trigger_iv),
          delta: Number(r.trigger_delta),
          askPct: Number(r.trigger_ask_pct),
          windowSize: Number(r.trigger_window_size),
          windowPrints: Number(r.trigger_window_prints),
        },

        entry: {
          price: Number(r.entry_price),
          openInterest: Number(r.open_interest),
          spotAtFirst: Number(r.spot_at_first),
          alertSeq: Number(r.alert_seq),
          minutesSincePrevFire: Number(r.minutes_since_prev_fire),
        },

        tags: {
          flowQuad: r.flow_quad,
          tod: r.tod,
          mode: r.mode,
          reload: r.reload_tagged,
          cheapCallPm: r.cheap_call_pm_tagged,
          burstRatioVsPrev: num(r.burst_ratio_vs_prev),
          entryDropPctVsPrev: num(r.entry_drop_pct_vs_prev),
        },

        macro: {
          mktTideNcp: num(r.mkt_tide_ncp),
          mktTideNpp: num(r.mkt_tide_npp),
          mktTideDiff: num(r.mkt_tide_diff),
          mktTideOtmDiff: num(r.mkt_tide_otm_diff),
          // Ticker-level flow snapshot at trigger_time_ct. Distinct
          // from mktTide* (which is SPY-wide market tide) — these are
          // the cumulative NCP / NPP for THIS ticker through the fire.
          tickerCumNcpAtFire: num(r.fire_time_cum_ncp),
          tickerCumNppAtFire: num(r.fire_time_cum_npp),
          spxFlowDiff: num(r.spx_flow_diff),
          spyEtfDiff: num(r.spy_etf_diff),
          qqqEtfDiff: num(r.qqq_etf_diff),
          zeroDteDiff: num(r.zero_dte_diff),
          spxSpotGammaOi: num(r.spx_spot_gamma_oi),
          spxSpotGammaVol: num(r.spx_spot_gamma_vol),
          spxSpotCharmOi: num(r.spx_spot_charm_oi),
          spxSpotVannaOi: num(r.spx_spot_vanna_oi),
          gexStrikeCallMinusPut: num(r.gex_strike_call_minus_put),
          gexStrikeCallAskMinusBid: num(r.gex_strike_call_ask_minus_bid),
          gexStrikePutAskMinusBid: num(r.gex_strike_put_ask_minus_bid),
          gexStrikeActualStrike: num(r.gex_strike_actual_strike),
        },

        outcomes: {
          realizedTrail30_10Pct: num(r.realized_trail30_10_pct),
          realizedHard30mPct: num(r.realized_hard30m_pct),
          realizedTier50HoldEodPct: num(r.realized_tier50_holdeod_pct),
          realizedFlowInversionPct: num(r.realized_flow_inversion_pct),
          realizedEodPct: num(r.realized_eod_pct),
          peakCeilingPct: num(r.peak_ceiling_pct),
          minutesToPeak: num(r.minutes_to_peak),
          enrichedAt: r.enriched_at != null ? toIso(r.enriched_at) : null,
        },

        // Hours from this fire's trigger to the next high-impact
        // economic event (FOMC/CPI/PCE/JOBS). Null when no such event
        // is within 7 days. The UI flags fires in the 24-72h window
        // with a "MACRO" badge — 2026-05-15 EDA found 1.32× win50 /
        // 1.56× win100 lift on N=17,465 in that bucket.
        hoursToNextMacroEvent: hoursToNextMacroEvent(r.trigger_time_ct),

        // Position of spot at trigger time within the underlying's
        // session range ∈ [0, 1]. The UI uses this for the Range Kill
        // filter chip (hide bottom-10%) and the top-range badge.
        // Null for pre-#153 rows + new fires whose UW candle fetch
        // failed; the score-bonus -3 penalty applies only when the
        // value is < 0.10, so null rows score with their original
        // weights.
        rangePosAtTrigger: num(r.range_pos_at_trigger),

        insertedAt: toIso(r.inserted_at),
      };
    };

    const fires = rows.map(toLotteryFire);
    // Pinned reignited rows ride alongside the page slice, independent
    // of pagination. The SQL already orders by trigger_time_ct DESC, so
    // the array is freshest-first ready for ReignitionSection.
    const reignitedFires = reignitedRows.map(toLotteryFire);

    // No CDN cache — the feed is an alert surface and the UI polls
    // every 30s. Caching at the edge means most polls land on a stale
    // copy and never see a just-inserted fire. The bot-protected GET
    // is cheap; the per-call DB scan is one indexed query.
    setCacheHeaders(res, 0, 0);
    res.status(200).json({
      date: targetDate,
      asOf: at ?? null,
      minute: minute ?? null,
      filters: {
        ticker,
        reload,
        cheapCallPm,
        mode,
        optionType,
        tod,
        sort,
        minScore,
      },
      // count = rows returned (≤ limit). total = total matching rows
      // before LIMIT/OFFSET. UI uses (offset, limit, total) for the
      // page-N-of-M display + prev/next controls.
      count: fires.length,
      total,
      limit,
      offset,
      hasMore: offset + fires.length < total,
      fires,
      // Pinned "Hot Right Now" payload — full LotteryFire rows for the
      // day's top-N reignited chains, independent of pagination so the
      // section stays visible on every page. Honours the same user
      // filters as `fires`; can be empty when no chains qualify.
      reignitedFires,
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'lottery-finder error');
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
