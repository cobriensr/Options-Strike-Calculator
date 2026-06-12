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
import { getDb, isRetryableDbError, withDbRetry } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { readLastGood, writeLastGood } from './_lib/last-good-cache.js';
import { readKeptTickers, addKeptTickers } from './_lib/kept-tickers.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import { lotteryFinderQuerySchema } from './_lib/validation.js';
import {
  gammaScoreAdjustment,
  type LotteryScoreTier,
} from './_lib/lottery-score-weights.js';
import {
  qualityAdjustedScore,
  INVERSION_BONUS_CASE_SQL,
} from './_lib/lottery-inversion-bonus.js';
import { tierFromQualityScore } from './_lib/lottery-tier.js';
import { avgHoldMinutesFor } from './_lib/lottery-hold.js';
import {
  DB_RETRY_ATTEMPTS,
  DB_RETRY_TIMEOUT_MS,
  KEPT_RETENTION_DAYS,
  MACRO_WINDOW_MS,
  MEGA_CLUSTER_MIN_DISTINCT_TICKERS,
  MIN_ALERT_ENTRY_PRICE,
  REIGNITION_MIN_FIRES,
  REIGNITION_MIN_GAP_MIN,
  REIGNITION_MIN_POST_GAP_FIRES,
  REIGNITION_TOP_N_PER_DAY,
} from './_lib/constants.js';
import { keptSuppressionSql } from './_lib/lottery-suppression.js';
import { getETDateStr } from '../src/utils/timezone.js';
import {
  computeSuspiciousClusters,
  clusterKey,
  type ClusterCandidateRow,
} from './_lib/suspicious-cluster.js';

// Module-load invariant: the diff-skip below only re-inserts NEWLY-qualifying
// tickers, relying on the retention prune (enrich-lottery-outcomes.ts) never
// deleting today's rows. That holds only while KEPT_RETENTION_DAYS >= 1.
if (KEPT_RETENTION_DAYS < 1) {
  throw new Error(
    `KEPT_RETENTION_DAYS must be >= 1 (got ${KEPT_RETENTION_DAYS}); ` +
      `the lottery never-vanish diff-skip requires today's kept rows to survive the prune.`,
  );
}

type DbId = number | string;
type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;
type DbOptionType = 'C' | 'P';

/** Minimal row shape returned by the day-scoped cluster-candidate query. */
interface ClusterCandidateDbRow {
  underlying_symbol: string;
  option_type: 'C' | 'P';
  strike: string | number;
  dte: number;
  entry_price: DbNullableNumeric;
  spot_at_first: DbNullableNumeric;
  trigger_ask_pct: DbNullableNumeric;
}

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
  spot_at_trigger: DbNullableNumeric;
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

  // GexBot context snapshot at fire time (migration #181). NULL when
  // ticker is outside the 16-ticker GexBot universe (single stocks
  // beyond the index/ETF set) or when the snapshot lookup missed its
  // 2-minute freshness window. Mirrors silent_boom_alerts.gex_* (#180).
  gex_one_cvroflow: DbNullableNumeric;
  gex_net_put_dex: DbNullableNumeric;
  gex_one_dexoflow: DbNullableNumeric;
  gex_one_gexoflow: DbNullableNumeric;
  gex_zcvr: DbNullableNumeric;
  gex_zero_gamma: DbNullableNumeric;
  gex_spot: DbNullableNumeric;
  gex_captured_at: DbTimestamp | null;

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
  // rather than at API read time. Folded into the displayed `score`
  // field below; NOT used in the feed's ORDER BY (which sorts on the
  // raw `f.score` column to keep fire positions frozen post-fire).
  // Still part of the (now-unused) `combined_score` GENERATED column.
  fire_count_score_adjustment: number;
  // Gamma at trigger time (migration #168). Captured by the detect
  // cron from raw_payload->>'gamma'. NULL on rows inserted before
  // migration #168 lands. Folded into the displayed `score` field
  // and surfaced via the UI HIGH-Γ chip.
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
  ticker_inversion_blend: DbNullableNumeric;
  ticker_inversion_quintile: DbNullableNumeric;
  ticker_inversion_n_21d: DbNullableNumeric;
  ticker_inversion_n_90d: DbNullableNumeric;

  // Per-(date, ticker, strike, option_type, expiry) aggregate count
  // from the chain-day dedup CTE. Hot chains stay genuinely hot for
  // hours — TSLA 392.5C fired 315 times in a single 6.5-hour session.
  // We collapse to one row per chain per day with the LATEST fire as
  // the rep (freshest macro / score / exit policy), surfacing the
  // cluster size and the first-fire timestamp so the UI can render
  // "×315 · since 13:30" for a still-hot chain.
  fire_count: number;
  first_fire_time_ct: DbTimestamp;

  // Chain-level peak TAKE-IT probability + the trigger time of the fire
  // that hit it (spec lottery-no-vanish-2026-05-29.md). The feed gates a
  // chain on chain_max_takeit — not the latest rep row's takeit_prob —
  // so a chain that ever cleared the floor stays visible for the rest of
  // the day (monotonic, never disappears intraday). NULL when every fire
  // in the chain has a NULL takeit_prob.
  chain_max_takeit: DbNullableNumeric;
  peak_takeit_at: DbTimestamp | null;

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
  fires_json: Array<{
    triggerTimeCt: string;
    entryPrice: DbNumeric;
    spotAtTrigger: DbNullableNumeric;
  }> | null;
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

/**
 * Build the DISPLAYED quality-adjusted score (qas) SQL EXPRESSION TEXT that
 * the row badge derives via {@link qualityAdjustedScore} + tierFromQualityScore.
 *
 *   qas = GREATEST(0, <p>score + <p>round_trip_score_deduct + <p>fire_count_score_adjustment)
 *         + INVERSION_BONUS_CASE(s.inversion_quintile)
 *
 * This is the EFFECTIVE pre-inversion score POST-Fix-B (read-time gamma
 * double-count removed — gamma is already credited via the V2 gamma-quintile
 * weight baked into the stored score) PLUS the inversion bonus. The
 * pre-inversion term equals GREATEST(0, score + round_trip_score_deduct +
 * fire_count_score_adjustment); note this is the combined_score GENERATED
 * column MINUS its gamma CASE term (the read-time gamma was dropped here but
 * the stored column still carries it — see the Fix-B note in toLotteryFire).
 *
 * `fireAlias` is the raw column prefix (`f.`, `ranked.`, or `''` for the count
 * CTE), whitelisted + spliced as a raw identifier prefix (never free
 * interpolation). The CASE hardcodes the `s.` lottery_ticker_stats alias via
 * {@link INVERSION_BONUS_CASE_SQL}. Returned as a raw string spliced via
 * `db.unsafe` at the call site — it contains NO bound params, so injection is
 * impossible (every component is a constant or a whitelisted identifier).
 */
const QAS_FIRE_ALIAS_WHITELIST = ['f.', 'ranked.', ''] as const;
type QasFireAlias = (typeof QAS_FIRE_ALIAS_WHITELIST)[number];

// Whitelisted ORDER BY clauses for the lottery feed, keyed on the validated
// `sort` enum (validation/lottery.ts). neon tagged templates can't bind ORDER
// BY through ${}, so the clause is spliced as a raw fragment via db.unsafe —
// the same mechanism as qasExprText below. Each value is a constant identifier
// list (injection-safe), producing SQL byte-identical to the prior per-sort
// copies. (AUD-L3)
const LOTTERY_FEED_ORDER_BY: Record<
  'chronological' | 'score' | 'peak',
  string
> = {
  score: 'f.score DESC NULLS LAST, f.trigger_time_ct DESC, f.id DESC',
  peak: 'f.peak_ceiling_pct DESC NULLS LAST, f.trigger_time_ct DESC, f.id DESC',
  chronological: 'f.trigger_time_ct DESC, f.id DESC',
};

function qasExprText(fireAlias: QasFireAlias): string {
  if (!(QAS_FIRE_ALIAS_WHITELIST as readonly string[]).includes(fireAlias)) {
    throw new Error(`qasExprText: invalid fire alias "${fireAlias}"`);
  }
  return (
    `(GREATEST(0, COALESCE(${fireAlias}score, 0) ` +
    `+ COALESCE(${fireAlias}round_trip_score_deduct, 0) ` +
    `+ COALESCE(${fireAlias}fire_count_score_adjustment, 0)) ` +
    `+ ${INVERSION_BONUS_CASE_SQL})`
  );
}

// Last-good cache TTL. 6h covers a full trading day; the target date is
// baked into every cache key so there is no cross-day leak (a stale prior
// day's value can never be served for today — the key won't match).
const DEFAULT_LAST_GOOD_TTL_SEC = 6 * 3600;

/**
 * Run a "nice-to-have" SQL query under `withDbRetry`, but on a
 * retryable failure (timeout, fetch failed, etc. — see
 * `isRetryableDbError`) degrade gracefully to a typed fallback
 * value instead of propagating the rejection up to the outer
 * `Promise.all`. Non-retryable errors (SQL syntax, type mismatch)
 * still throw so genuine bugs surface as 500s.
 *
 * Used to keep the lottery-finder feed responsive when Neon is
 * under load: the load-bearing `rows` + `totalRows` queries stay on
 * plain `withDbRetry` (failure → 500), while the secondary signals
 * (reignition flag, mega-cluster badge, SilentBoom cofire indicator,
 * pinned reignited rows) degrade to empty arrays so the panel still
 * renders. Every degradation hits Sentry as a warning so we can see
 * what fraction of requests are running in degraded mode — explicit
 * observability, not a silent `.catch(() => [])`.
 *
 * Spec: docs/superpowers/specs/ (no dedicated spec — hotfix to
 * SENTRY-EMERALD-DESERT-7J 2026-05-19).
 *
 * ── Last-good cache (2026-06-07, fix/feed-never-vanish) ────────────────
 * When `cacheKey` is supplied, the helper participates in the server-side
 * "last-good" cache (api/_lib/last-good-cache.ts):
 *   - On SUCCESS  → OVERWRITE the cache with the fresh result, even when
 *                   it is `[]`. A legit-empty result resolves successfully,
 *                   so this path always wins and `readLastGood` is never
 *                   consulted for it.
 *   - On RETRYABLE ERROR → after the existing Sentry warning, READ
 *                   last-good and, if present, serve it (distinct Sentry
 *                   fingerprint so the served-last-good rate is observable)
 *                   instead of `fallback`. If absent → existing `fallback`.
 *
 * SAFETY INVARIANT: last-good is read ONLY on the error branch. A
 * genuinely-empty result RESOLVES (does not reject), so it can never reach
 * the read path — this is what prevents resurrecting a row that legitimately
 * left the result set. See the doc comment in last-good-cache.ts.
 */
/**
 * Options for {@link degradeOnTimeout}.
 *
 * - `retries` / `timeout` default to the shared {@link DB_RETRY_ATTEMPTS} /
 *   {@link DB_RETRY_TIMEOUT_MS} budget (the per-attempt 20s cap was tuned for
 *   the slowest reignition CTEs — window funcs over 5k+ daily fires —
 *   SENTRY-EMERALD-DESERT-9J/9H; don't push the user-path timeout past 20s).
 * - `cacheKey` opts the call into the server-side last-good cache; when
 *   omitted the helper behaves exactly as before (no cache read or write).
 */
export interface DegradeOnTimeoutOptions {
  /** Last-good cache key. Omit to disable cache participation. */
  cacheKey?: string;
  /** Last-good TTL (seconds). Defaults to {@link DEFAULT_LAST_GOOD_TTL_SEC}. */
  cacheTtlSec?: number;
  /** Retries in addition to the first attempt. Defaults to {@link DB_RETRY_ATTEMPTS}. */
  retries?: number;
  /** Per-attempt timeout (ms). Defaults to {@link DB_RETRY_TIMEOUT_MS}. */
  timeout?: number;
}

export async function degradeOnTimeout<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: string,
  options: DegradeOnTimeoutOptions = {},
): Promise<T> {
  const {
    cacheKey,
    cacheTtlSec,
    retries = DB_RETRY_ATTEMPTS,
    timeout = DB_RETRY_TIMEOUT_MS,
  } = options;
  try {
    const fresh = await withDbRetry(fn, retries, timeout);
    // SUCCESS: overwrite last-good with the fresh result — even when `[]`.
    // Fire-and-forget; never blocks or throws into the request path.
    if (cacheKey) {
      void writeLastGood(
        cacheKey,
        fresh,
        cacheTtlSec ?? DEFAULT_LAST_GOOD_TTL_SEC,
      );
    }
    return fresh;
  } catch (err) {
    // Only swallow retryable-class failures. SQL syntax or type
    // errors mean the query is broken — those must surface as 500.
    if (!isRetryableDbError(err)) throw err;
    Sentry.captureMessage(`lottery-finder: ${context} degraded to fallback`, {
      level: 'warning',
      extra: {
        context,
        errMessage: err instanceof Error ? err.message : String(err),
      },
    });
    // RETRYABLE ERROR only: try to serve the last successful result so the
    // "Hot Right Now" section / badges don't blank for this poll. This
    // branch is unreachable for a legit-empty result (that RESOLVES above),
    // so a genuinely-removed row can never be resurrected here.
    if (cacheKey) {
      const lastGood = await readLastGood<T>(cacheKey);
      if (lastGood != null) {
        Sentry.captureMessage(`lottery-finder: ${context} served last-good`, {
          level: 'warning',
          // DISTINCT fingerprint from the 'degraded to fallback' message
          // above so the served-last-good rate is independently
          // observable in Sentry.
          fingerprint: ['lottery-finder', 'served-last-good', context],
          tags: { degrade_mode: 'served-last-good', context },
          extra: { context },
        });
        return lastGood;
      }
    }
    return fallback;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/lottery-finder');
  const guarded = await guardOwnerOrGuestEndpoint(req, res, done);
  if (guarded) return;

  try {
    const parsed = lotteryFinderQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      done({ status: 400 });
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
      minFireCount,
      maxFireCount,
      showAll,
    } = parsed.data;

    // TAKE-IT calibrated P(peak >= +20%) floor. 0/null = no floor.
    // Filtered server-side so pagination reflects the post-filter
    // total — the prior client-side filter at LotteryFinder/index.tsx
    // stripped 40+ of 50 rows per page when the default 0.70 floor
    // was active and made "page 1 of N" meaningless. NULL takeit
    // values are excluded when the floor is on (matches the prior
    // client-side `(f) => f.takeitProb != null && f.takeitProb >= floor`).
    const minTakeitProb =
      parsed.data.minTakeitProb != null && parsed.data.minTakeitProb > 0
        ? parsed.data.minTakeitProb
        : null;

    // Premium floor — entry_price * trigger_window_size * 100, in
    // dollars. null = no floor. Filtered server-side so pagination
    // reflects the post-filter count. Mirrors SilentBoom's
    // `minPremium` (which uses spike_volume) — lottery's analogous
    // rolling window volume is `trigger_window_size`.
    const minPremium =
      parsed.data.minPremium != null && parsed.data.minPremium > 0
        ? parsed.data.minPremium
        : null;

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

    // MONOTONIC Q1/Q2 SUPPRESSION (defense-in-depth for the server feed).
    // `inversion_quintile` on lottery_ticker_stats is recomputed by the
    // detect-lottery-fires cron and can FLIP mid-session, so a ticker shown
    // earlier (quintile > 2) can suddenly be suppressed — its chains vanish
    // from the feed. We keep a per-day DB record (lottery_kept_tickers) of
    // every ever-shown ticker and also un-suppress those. `showAll`
    // short-circuits suppression entirely, so there's no need to read the set
    // in that path. DB-down → `[]` → predicate's `= ANY('{}'::text[])` term
    // matches nothing → exact pre-existing live behavior (zero regression).
    // See api/_lib/kept-tickers.ts.
    //
    // (#6) This is now a DB read, not Redis. The kept-set is bound into the
    // `rows` + `total` query predicates, so it MUST be resolved before those
    // templates are built — and the feed's query DISPATCH order is itself a
    // tested invariant (rows=call[0], total=call[1], chainExtras=call[2], …),
    // which rules out resolving it concurrently inside the query thunks (that
    // would reorder dispatch). We therefore start the round-trip here and
    // await it just before the Promise.all. It is a single PK point-lookup on
    // (trade_date) — not a serial heavy round-trip — and `showAll`
    // short-circuits it away entirely.
    const keptTickers = showAll ? [] : await readKeptTickers(targetDate);

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
    // The score sort uses the raw `f.score` column (migration #126's
    // (date DESC, score DESC) index) to keep fire positions FROZEN at
    // detect time. We deliberately do NOT sort by `combined_score` (the
    // GENERATED column that folds in round_trip_score_deduct) because
    // that would reshuffle the feed mid-session whenever the
    // evaluate-round-trip cron writes a deduct 60-75min post-fire — the
    // user's mental map of which alerts were near the top at fire time
    // would silently drift. Deducted fires now render dimmed in-place via
    // LotteryRow's round-tripped pill, preserving the EV signal without
    // mutating sort position. The peak sort relies on
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
      clusterCandidateRows,
    ] = (await Promise.all([
      withDbRetry(
        () => db`
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
            ) AS rn,
            -- Chain-level peak TAKE-IT + the timestamp of the fire that
            -- hit it. The chain is gated on chain_max_takeit (NOT the
            -- rep row's takeit_prob) so a chain that ever cleared the
            -- floor stays visible for the rest of the day — monotonic,
            -- never disappears (spec lottery-no-vanish-2026-05-29.md).
            -- peak_takeit_at feeds the "peak TAKE-IT 0.XX @ HH:MM" badge.
            MAX(f.takeit_prob) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
            ) AS chain_max_takeit,
            FIRST_VALUE(f.trigger_time_ct) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
              ORDER BY f.takeit_prob DESC NULLS LAST, f.trigger_time_ct ASC
            ) AS peak_takeit_at
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
            AND f.entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
            AND (${minPremium}::numeric IS NULL OR f.entry_price * f.trigger_window_size * 100 >= ${minPremium}::numeric)
        )
        SELECT
          f.id, f.date, f.trigger_time_ct, f.entry_time_ct, f.option_chain_id,
          f.underlying_symbol, f.option_type, f.strike, f.expiry, f.dte,
          f.trigger_vol_to_oi_window, f.trigger_vol_to_oi_cum,
          f.trigger_iv, f.trigger_delta, f.trigger_ask_pct,
          f.trigger_window_size, f.trigger_window_prints,
          f.entry_price, f.open_interest, f.spot_at_first, f.spot_at_trigger,
          f.alert_seq, f.minutes_since_prev_fire,
          f.flow_quad, f.tod, f.mode,
          f.reload_tagged, f.cheap_call_pm_tagged,
          f.burst_ratio_vs_prev, f.entry_drop_pct_vs_prev,
          f.mkt_tide_ncp, f.mkt_tide_npp, f.mkt_tide_diff, f.mkt_tide_otm_diff,
          f.spx_flow_diff, f.spy_etf_diff, f.qqq_etf_diff, f.zero_dte_diff,
          f.spx_spot_gamma_oi, f.spx_spot_gamma_vol, f.spx_spot_charm_oi, f.spx_spot_vanna_oi,
          f.gex_strike_call_minus_put, f.gex_strike_call_ask_minus_bid,
          f.gex_strike_put_ask_minus_bid, f.gex_strike_actual_strike,
          f.gex_one_cvroflow, f.gex_net_put_dex, f.gex_one_dexoflow,
          f.gex_one_gexoflow, f.gex_zcvr, f.gex_zero_gamma, f.gex_spot,
          f.gex_captured_at,
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
          f.chain_max_takeit, f.peak_takeit_at,
          s.n_fires AS ticker_n_fires,
          s.high_peak_rate AS ticker_high_peak_rate,
          s.ci_lower AS ticker_ci_lower,
          s.ci_upper AS ticker_ci_upper,
          s.ci_width AS ticker_ci_width,
          s.tier AS ticker_tier,
          s.inversion_blend       AS ticker_inversion_blend,
          s.inversion_quintile    AS ticker_inversion_quintile,
          s.inversion_n_21d       AS ticker_inversion_n_21d,
          s.inversion_n_90d       AS ticker_inversion_n_90d,
          f.cum_ncp_at_fire AS fire_time_cum_ncp,
          f.cum_npp_at_fire AS fire_time_cum_npp
        FROM filtered f
        LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol
        WHERE f.rn = 1
          AND (${minFireCount ?? null}::int IS NULL OR f.fire_count >= ${minFireCount ?? 0})
          AND (${maxFireCount ?? null}::int IS NULL OR f.fire_count <= ${maxFireCount ?? 0})
          AND (${minTakeitProb}::numeric IS NULL OR f.chain_max_takeit >= ${minTakeitProb}::numeric)
          -- Fix C: minScore gates on the DISPLAYED qas (the value the tier
          -- badge uses), not the raw score. qas = GREATEST(0, score + rt +
          -- fc) + inversion bonus (NO gamma, post-Fix-B). Applied at the rep
          -- row (rn=1, post-LEFT JOIN s) alongside the other rep-level gates
          -- so it reads s.inversion_quintile; identical expression in the
          -- count query so pagination/total stay coherent.
          AND (${minScore ?? null}::int IS NULL OR ${db.unsafe(qasExprText('f.'))} >= ${minScore ?? 0})
          AND ${keptSuppressionSql(db, 'f', showAll, keptTickers)}
        ORDER BY ${db.unsafe(LOTTERY_FEED_ORDER_BY[sort])}
        LIMIT ${limit}
        OFFSET ${offset}
      `,
        2,
        10000,
      ),
      // Total counts the collapsed shape (one row per chain per day:
      // ticker × strike × option_type × expiry) so pagination math
      // matches the dedup'd CTE above.
      withDbRetry(
        () => db`
        WITH ranked AS (
          SELECT
            underlying_symbol, strike, option_type, expiry,
            takeit_prob,
            score, round_trip_score_deduct, fire_count_score_adjustment,
            ROW_NUMBER() OVER (
              PARTITION BY underlying_symbol, strike, option_type, expiry
              ORDER BY trigger_time_ct DESC, id DESC
            ) AS rn,
            COUNT(*) OVER (
              PARTITION BY underlying_symbol, strike, option_type, expiry
            )::int AS fc,
            MAX(takeit_prob) OVER (
              PARTITION BY underlying_symbol, strike, option_type, expiry
            ) AS chain_max_takeit
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
            AND entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
            AND (${minPremium}::numeric IS NULL OR entry_price * trigger_window_size * 100 >= ${minPremium}::numeric)
        ),
        -- rep rows (rn=1) for the STRUCTURAL day set: date + ticker/type/
        -- mode/tod/reload+cheapCallPm tags + entry-price floor + minPremium
        -- ONLY (no burst/takeit/minScore). LEFT JOIN s so qas + the quintile
        -- predicate are available here. passes_user_filters carries the
        -- minFireCount/maxFireCount/minTakeitProb/qas-minScore gate per rep
        -- so total/suppressed FILTER on it while ever_qualifying does NOT —
        -- decoupling the accumulation from those user filters (Fix A).
        eligible AS (
          SELECT
            ranked.underlying_symbol,
            s.inversion_quintile,
            ${keptSuppressionSql(db, 'ranked', showAll, keptTickers)} AS kept,
            (
              (${minFireCount ?? null}::int IS NULL OR ranked.fc >= ${minFireCount ?? 0})
              AND (${maxFireCount ?? null}::int IS NULL OR ranked.fc <= ${maxFireCount ?? 0})
              AND (${minTakeitProb}::numeric IS NULL OR ranked.chain_max_takeit >= ${minTakeitProb}::numeric)
              -- Fix C: qas-based minScore (identical expression to the row
              -- queries). qas = GREATEST(0, score + rt + fc) + inversion bonus.
              AND (${minScore ?? null}::int IS NULL OR ${db.unsafe(qasExprText('ranked.'))} >= ${minScore ?? 0})
            ) AS passes_user_filters
          FROM ranked
          LEFT JOIN lottery_ticker_stats s ON s.ticker = ranked.underlying_symbol
          WHERE ranked.rn = 1
        )
        -- total = REACHABLE chains: pass the user filters AND survive Q1/Q2
        -- suppression (chain-max TAKE-IT gating already folded into
        -- passes_user_filters). suppressed = matched-but-quality-hidden, for
        -- the UI hint. ever_qualifying = PAGE- AND USER-FILTER-INDEPENDENT
        -- accumulation source (Fix A): every currently-qualifying ticker
        -- (inversion_quintile > 2) over the full structural day set, WITHOUT
        -- inheriting minFireCount/maxFireCount/minTakeitProb/minScore — so a
        -- ticker that qualifies (quintile > 2) but whose chains fall under the
        -- active burst/takeit/score filters is still recorded into the kept-set
        -- and can never later flip Q1/Q2 and vanish. NULL quintile excluded by
        -- > 2 (mirrors the old quintile != null AND > 2).
        SELECT
          COUNT(*) FILTER (WHERE passes_user_filters AND kept)::int AS total,
          COUNT(*) FILTER (WHERE passes_user_filters AND NOT kept)::int AS suppressed,
          COALESCE(
            array_agg(DISTINCT underlying_symbol)
              FILTER (WHERE inversion_quintile > 2),
            '{}'::text[]
          ) AS ever_qualifying
        FROM eligible
      `,
        2,
        10000,
      ),
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
      degradeOnTimeout(
        () => db`
        WITH ordered AS (
          SELECT
            underlying_symbol, strike, option_type, expiry,
            trigger_time_ct, entry_price, spot_at_trigger,
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
                'entryPrice', o.entry_price,
                'spotAtTrigger', o.spot_at_trigger
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
        [] as ChainExtrasRow[],
        'chainExtras',
        { cacheKey: `lf:lg:chainExtras:${targetDate}` },
      ),
      // Per-minute distinct-ticker count — fuels the MEGA-CLUSTER
      // badge. Truncates trigger_time_ct to the 1-min bucket and
      // counts unique tickers per bucket across the date. Filtered
      // by date + entry_price floor only (NOT user filters) so the
      // count reflects the WHOLE market's minute concentration, not
      // a filtered subset — same stable-semantics decision as the
      // chainExtras reignition flag.
      degradeOnTimeout(
        () => db`
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
        [] as ClusterByMinuteRow[],
        'clusterByMinute',
        { cacheKey: `lf:lg:cluster:${targetDate}` },
      ),
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
      degradeOnTimeout(
        () => db`
        SELECT DISTINCT option_chain_id
        FROM silent_boom_alerts
        WHERE date = ${targetDate}::date
      `,
        [] as { option_chain_id: string }[],
        'sbChains',
        { cacheKey: `lf:lg:sbChains:${targetDate}` },
      ),
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
      degradeOnTimeout(
        () => db`
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
            ) AS rn,
            -- Chain-level peak TAKE-IT + the timestamp of the fire that
            -- hit it. The chain is gated on chain_max_takeit (NOT the
            -- rep row's takeit_prob) so a chain that ever cleared the
            -- floor stays visible for the rest of the day — monotonic,
            -- never disappears (spec lottery-no-vanish-2026-05-29.md).
            -- peak_takeit_at feeds the "peak TAKE-IT 0.XX @ HH:MM" badge.
            MAX(f.takeit_prob) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
            ) AS chain_max_takeit,
            FIRST_VALUE(f.trigger_time_ct) OVER (
              PARTITION BY f.underlying_symbol, f.strike, f.option_type, f.expiry
              ORDER BY f.takeit_prob DESC NULLS LAST, f.trigger_time_ct ASC
            ) AS peak_takeit_at
          FROM lottery_finder_fires f
          INNER JOIN top_reignited t USING (underlying_symbol, strike, option_type, expiry)
          -- FLOOR-BLIND (spec hot-right-now-floorblind-2026-05-29.md):
          -- Hot Right Now respects only STRUCTURAL scoping (date / ticker /
          -- type / mode / tod / reload+cheapCallPm tags), NOT the quality
          -- floors. minScore + minPremium are intentionally absent here (and
          -- the TAKE-IT + Q1/Q2 quintile gates are absent from the outer
          -- WHERE) so the section surfaces the day's most re-ignited chains
          -- by cadence even when the model scored them below the floor —
          -- the case that hid SNDK 1670C (+1974%, chain_max_takeit 0.685).
          WHERE f.date = ${targetDate}::date
            AND f.trigger_time_ct < ${reignitionWindowEnd}::timestamptz
            AND (${ticker ?? null}::text IS NULL OR f.underlying_symbol = ${ticker ?? ''})
            AND (${reload ?? null}::boolean IS NULL OR f.reload_tagged = ${reload ?? false})
            AND (${cheapCallPm ?? null}::boolean IS NULL OR f.cheap_call_pm_tagged = ${cheapCallPm ?? false})
            AND (${mode ?? null}::text IS NULL OR f.mode = ${mode ?? ''})
            AND (${optionType ?? null}::text IS NULL OR f.option_type = ${optionType ?? ''})
            AND (${tod ?? null}::text IS NULL OR f.tod = ${tod ?? ''})
            AND f.entry_price >= ${MIN_ALERT_ENTRY_PRICE}::numeric
        )
        SELECT
          f.id, f.date, f.trigger_time_ct, f.entry_time_ct, f.option_chain_id,
          f.underlying_symbol, f.option_type, f.strike, f.expiry, f.dte,
          f.trigger_vol_to_oi_window, f.trigger_vol_to_oi_cum,
          f.trigger_iv, f.trigger_delta, f.trigger_ask_pct,
          f.trigger_window_size, f.trigger_window_prints,
          f.entry_price, f.open_interest, f.spot_at_first, f.spot_at_trigger,
          f.alert_seq, f.minutes_since_prev_fire,
          f.flow_quad, f.tod, f.mode,
          f.reload_tagged, f.cheap_call_pm_tagged,
          f.burst_ratio_vs_prev, f.entry_drop_pct_vs_prev,
          f.mkt_tide_ncp, f.mkt_tide_npp, f.mkt_tide_diff, f.mkt_tide_otm_diff,
          f.spx_flow_diff, f.spy_etf_diff, f.qqq_etf_diff, f.zero_dte_diff,
          f.spx_spot_gamma_oi, f.spx_spot_gamma_vol, f.spx_spot_charm_oi, f.spx_spot_vanna_oi,
          f.gex_strike_call_minus_put, f.gex_strike_call_ask_minus_bid,
          f.gex_strike_put_ask_minus_bid, f.gex_strike_actual_strike,
          f.gex_one_cvroflow, f.gex_net_put_dex, f.gex_one_dexoflow,
          f.gex_one_gexoflow, f.gex_zcvr, f.gex_zero_gamma, f.gex_spot,
          f.gex_captured_at,
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
          f.chain_max_takeit, f.peak_takeit_at,
          s.n_fires AS ticker_n_fires,
          s.high_peak_rate AS ticker_high_peak_rate,
          s.ci_lower AS ticker_ci_lower,
          s.ci_upper AS ticker_ci_upper,
          s.ci_width AS ticker_ci_width,
          s.tier AS ticker_tier,
          s.inversion_blend       AS ticker_inversion_blend,
          s.inversion_quintile    AS ticker_inversion_quintile,
          s.inversion_n_21d       AS ticker_inversion_n_21d,
          s.inversion_n_90d       AS ticker_inversion_n_90d,
          f.cum_ncp_at_fire AS fire_time_cum_ncp,
          f.cum_npp_at_fire AS fire_time_cum_npp
        FROM filtered f
        LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol
        WHERE f.rn = 1
        -- Floor-blind: no TAKE-IT / Q1-Q2 quintile gate here (see CTE
        -- comment above). The cadence-top-N chains show regardless of the
        -- quality floors the main feed applies.
        ORDER BY f.trigger_time_ct DESC, f.id DESC
      `,
        [] as FireRow[],
        'reignitedRows',
        {
          // Filter-scoped key: the reignitedRows payload applies the user's
          // structural filters, so last-good must be partitioned by them to
          // avoid serving one filter view's rows under another. windowEnd /
          // at / minute are DELIBERATELY omitted — they're a cumulative,
          // moving cutoff; keying on them would near-guarantee cache misses
          // and is wrong for "last good".
          cacheKey: `lf:lg:reignited:${targetDate}:${ticker ?? ''}:${reload ?? ''}:${cheapCallPm ?? ''}:${mode ?? ''}:${optionType ?? ''}:${tod ?? ''}`,
        },
      ),
      // Day-scoped cluster-candidate query — ALL 0DTE fires for the date,
      // minimal columns. Fed to computeSuspiciousClusters to detect
      // (ticker, side) pairs with ≥3 distinct cheap OTM ask-side strikes.
      // Must be a full-day scan (not page-scoped) because the paginated
      // row slice doesn't contain all of a ticker's strikes.
      //
      // MUST remain the LAST element in this Promise.all: its position must
      // align with `clusterCandidateRows` in the destructuring above.
      // Adding a new query here without updating BOTH the array and the
      // destructuring will silently assign the wrong rows to the wrong
      // variable — the `as [...]` cast suppresses the type error. See the
      // ordering bug fixed during the original Task 2 work.
      withDbRetry(
        () => db`
        SELECT underlying_symbol, option_type, strike, dte, entry_price,
               spot_at_first, trigger_ask_pct
        FROM lottery_finder_fires
        WHERE date = ${targetDate}::date AND dte = 0
      `,
        2,
        10000,
      ),
    ])) as [
      FireRow[],
      { total: number; suppressed: number; ever_qualifying: string[] }[],
      ChainExtrasRow[],
      ClusterByMinuteRow[],
      { option_chain_id: string }[],
      FireRow[],
      ClusterCandidateDbRow[],
    ];

    const total = totalRows[0]?.total ?? 0;
    const suppressedCount = totalRows[0]?.suppressed ?? 0;

    // MONOTONIC ACCUMULATION (#1, page-independent): remember every ticker
    // that is CURRENTLY shown BY the live quintile gate (quintile > 2) so a
    // future quintile flip into Q1/Q2 can't hide it.
    //
    // The source is the COUNT query's `ever_qualifying` column —
    // `array_agg(DISTINCT ranked.underlying_symbol) FILTER (WHERE
    // s.inversion_quintile > 2)` over the FULL `ranked` set (no LIMIT/OFFSET).
    // This fixes the prior bug where the set was derived from `rows` (the
    // page-0 LIMIT/OFFSET slice): a ticker that flipped Q1/Q2 while sitting
    // past row 50 was never recorded and still vanished. Now a single request
    // captures EVERY currently-qualifying ticker for the day.
    //
    // The predicate matches the old page-scoped derivation EXACTLY:
    //   - quintile > 2 → recorded (the live qualification gate).
    //   - NULL-quintile cold-start tickers → excluded (`> 2` is false for
    //     NULL); never suppressed anyway, so nothing to protect.
    //   - tickers kept ONLY because they're already in the set → NOT recorded
    //     off the kept-set (the predicate reads the LIVE quintile, never the
    //     kept-set itself), so accumulation is non-circular.
    // Fire-and-forget; never blocks or throws into the response path.
    //
    // (#1) Write-amplification fix: INSERT only the SET DIFFERENCE of the
    // currently-qualifying set vs. the kept-set we already read at request
    // start (`keptTickers`, line ~518). In mid-session steady state the whole
    // universe was persisted earlier today, so the old unconditional write of
    // the full `everQualifying` set was ~100% no-op `ON CONFLICT DO NOTHING`
    // churn on the Neon primary every poll. Skipping already-persisted tickers
    // is SAFE because today's kept rows are durable and never pruned
    // intraday: the retention prune in enrich-lottery-outcomes.ts only deletes
    // rows with `trade_date < today - KEPT_RETENTION_DAYS` (>= 1), so today's
    // rows always persist. A ticker already in `keptTickers` therefore cannot
    // be lost by skipping its re-insert.
    // ⚠️ This diff-skip is correct ONLY while KEPT_RETENTION_DAYS >= 1 AND the
    // prune cutoff stays a strict `<`. If a future change ever prunes today's
    // rows mid-session, this diff-skip must be revisited — re-inserting on
    // every poll would be the only way to self-heal a same-day deletion. The
    // module-load assertion above binds the KEPT_RETENTION_DAYS >= 1 half of
    // that invariant (a tightening to 0 throws at boot); the cron's prune test
    // binds the matching strict-`<` cutoff on the other side.
    if (!showAll) {
      const everQualifying = totalRows[0]?.ever_qualifying ?? [];
      const keptSet = new Set(keptTickers);
      const newlyQualifying = everQualifying.filter((t) => !keptSet.has(t));
      if (newlyQualifying.length > 0) {
        void addKeptTickers(targetDate, newlyQualifying);
      }
    }

    // Build the suspicious-cluster lookup from the day-scoped 0DTE scan.
    // clusterLookup is keyed by clusterKey(symbol, side) with value =
    // distinct qualifying strike count. Empty Map is the common case
    // (most days have no clustering (ticker, side) pairs).
    const clusterCandidates: ClusterCandidateRow[] = clusterCandidateRows.map(
      (r) => ({
        underlyingSymbol: r.underlying_symbol,
        optionType: r.option_type,
        strike: Number(r.strike),
        dte: Number(r.dte),
        entryPrice:
          r.entry_price == null
            ? Number.POSITIVE_INFINITY
            : Number(r.entry_price),
        spot: r.spot_at_first == null ? null : Number(r.spot_at_first),
        askPct: r.trigger_ask_pct == null ? 0 : Number(r.trigger_ask_pct),
      }),
    );
    const clusterLookup = computeSuspiciousClusters(clusterCandidates);

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
        historicalFires: Array<{
          triggerTimeCt: string;
          entryPrice: number;
          spotAtTrigger: number | null;
        }>;
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
        spotAtTrigger: f.spotAtTrigger != null ? Number(f.spotAtTrigger) : null,
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
      const windowEnd = new Date(maxTrigger.getTime() + MACRO_WINDOW_MS);
      const eventRows = (await withDbRetry(
        () => db`
        SELECT event_time
        FROM economic_events
        WHERE event_type IN ('FOMC', 'CPI', 'PCE', 'JOBS')
          AND event_time IS NOT NULL
          AND event_time >= ${minTrigger.toISOString()}::timestamptz
          AND event_time <= ${windowEnd.toISOString()}::timestamptz
        ORDER BY event_time ASC
      `,
        2,
        10000,
      )) as { event_time: string | Date }[];
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
    // (chainExtraByKey, megaClusterByMinute, sbChainSet, clusterLookup) and
    // the hoursToNextMacroEvent helper, so the same logic powers both the
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
      // maintains it on every INSERT. Folded into the displayed `score`
      // below alongside rtDeduct + gammaAdj.
      //
      // NOTE — displayed score ≠ SQL sort key, BY DESIGN (2026-05-28).
      // We intentionally reopened the divergence that commit 4fc7ec99
      // closed: the feed now sorts on the raw `f.score` column so a
      // fire's position is FROZEN at detect time. The `combined_score`
      // GENERATED column (migrations #159/#167/#168) still exists and
      // its index still exists, but the ORDER BY no longer consumes
      // them — see api/lottery-finder.ts:417-433 for the rationale.
      // Deducted/adjusted fires render dimmed in-place via LotteryRow's
      // round-tripped pill rather than reshuffling in the feed.
      const fireCountAdj = Number(r.fire_count_score_adjustment ?? 0);
      // Gamma at trigger time + the derived V1-era flat +1 bonus.
      // Surfaced ONLY for the HIGH-Γ display chip (gamma-sign indicator)
      // — NOT folded into `score` anymore.
      //
      // Fix B (read-time gamma double-count removed, owner decision):
      // under V2 scoring gamma is already credited via the V2
      // gamma-quintile weight baked into the stored `score`
      // (computeLotteryScoreV2 → GAMMA_QUINTILE_WEIGHTS). The old code
      // ALSO added this V1-era flat +1 here at read time, double-counting
      // gamma. We now count gamma ONCE (in `score`) and drop gammaAdj from
      // the effective-score composition. The effective pre-inversion score
      // is therefore GREATEST(0, score + round_trip_score_deduct +
      // fire_count_score_adjustment) — the SAME expression the qas SQL
      // filter (qasSql) gates minScore on, so the feed's displayed score,
      // its qas filter, and the SQL all agree.
      //
      // ⚠️ This is NOT equal to the stored `combined_score` GENERATED column
      // (migration #168), which STILL carries a +1 gamma CASE term. The
      // "zero tier-1" monitor in detect-lottery-fires.ts reads
      // combined_score, so post-Fix-B the feed (no gamma) and the monitor
      // (combined_score WITH gamma) can differ by up to +1 on a high-gamma
      // non-SPY/USO row near a tier boundary. See the report for the
      // recommended monitor/combined_score follow-up. Do NOT re-add gammaAdj
      // here to "fix" the monitor — that re-introduces the double count.
      const gammaAtTrigger =
        r.gamma_at_trigger != null ? Number(r.gamma_at_trigger) : null;
      const gammaAdj = gammaScoreAdjustment(
        gammaAtTrigger,
        r.underlying_symbol,
      );
      const score =
        rawScore == null
          ? null
          : Math.max(0, rawScore + rtDeduct + fireCountAdj);
      const roundTripNetPct =
        r.round_trip_net_pct == null ? null : Number(r.round_trip_net_pct);
      // Phase 4 direction-gate override (spec:
      // silent-boom-direction-gate-and-trail-ui-2026-05-14.md). Lottery
      // does not mutate score on insert; the feed forces the displayed
      // tier to 'tier3' when the row was flagged counter-trend so the
      // UI badge + tier filters agree with the demoted semantics.
      const directionGated = r.direction_gated === true;
      // Phase 3 inversion-quality filter: tier is derived from
      // qualityAdjustedScore (combined_score + per-ticker inversion
      // bonus) using V2 cutoffs (Tier 1 >= 13 / Tier 2 >= 10,
      // recalibrated 2026-06-03 — spec
      // lottery-feed-tier-recalibration-2026-06-03.md). Raw `score` stays
      // as the combined_score value; `qualityAdjustedScore` is exposed as
      // an additional field on the row.
      const inversionQuintile =
        r.ticker_inversion_quintile != null
          ? Number(r.ticker_inversion_quintile)
          : null;
      const qas = qualityAdjustedScore(score ?? 0, inversionQuintile);
      const rawTier: LotteryScoreTier = tierFromQualityScore(qas);
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
      // Suspicious-cluster lookup key — cached so we hit the Map once
      // for `.has` and once for `.get` without rebuilding the string.
      const ck = clusterKey(r.underlying_symbol, r.option_type);
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
        // Gamma at trigger time (migration #168) + the V1-era per-row +1
        // indicator when gamma >= 0.025 AND ticker ∉ {'SPY','USO'}. Fix B:
        // this is NO LONGER folded into `score` (gamma is counted once via
        // the V2 gamma-quintile weight in the stored `score`). It is kept
        // ONLY to drive the UI HIGH-Γ chip + tooltip (a gamma-sign
        // indicator, gated on gammaScoreAdjustment > 0 in LotteryRow).
        gammaAtTrigger,
        gammaScoreAdjustment: gammaAdj,
        takeitProb: r.takeit_prob == null ? null : Number(r.takeit_prob),
        takeitTopFeatures:
          r.takeit_top_features == null
            ? null
            : (r.takeit_top_features as Record<string, unknown>),
        takeitModelVersion: r.takeit_model_version,
        // Chain-level peak TAKE-IT + when it occurred. The chain is
        // gated on this peak (not the latest fire's prob) so it never
        // disappears intraday; the UI badges it as "peak TAKE-IT 0.XX @
        // HH:MM" when the latest fire is below the peak.
        peakTakeitProb: num(r.chain_max_takeit),
        peakTakeitAt: r.peak_takeit_at == null ? null : toIso(r.peak_takeit_at),
        // Phase 3 inversion-quality filter outputs. `qualityAdjustedScore`
        // is `score + inversionQualityBonus(quintile)`; `scoreTier` above
        // is derived from it. The four `inversion*` fields surface the
        // raw refit columns from lottery_ticker_stats so the UI can show
        // the per-ticker quintile pill + sample-size hover.
        qualityAdjustedScore: qas,
        inversionQuintile,
        inversionBlend:
          r.ticker_inversion_blend != null
            ? Number(r.ticker_inversion_blend)
            : null,
        inversionN21d:
          r.ticker_inversion_n_21d != null
            ? Number(r.ticker_inversion_n_21d)
            : null,
        inversionN90d:
          r.ticker_inversion_n_90d != null
            ? Number(r.ticker_inversion_n_90d)
            : null,
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
        // SUSPICIOUS CLUSTER — (ticker, side) had ≥3 distinct cheap OTM
        // ask-side 0DTE strikes co-firing on the same day. Descriptive
        // attention-flag only — this cohort is net negative-expectancy
        // (spec: 2026-05-27-suspicious-flow-and-takeit-floor-design.md).
        suspiciousCluster: clusterLookup.has(ck),
        clusterStrikeCount: clusterLookup.get(ck) ?? 0,

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
          spotAtTrigger:
            r.spot_at_trigger != null ? Number(r.spot_at_trigger) : null,
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

        gex: {
          oneCvroflow: num(r.gex_one_cvroflow),
          netPutDex: num(r.gex_net_put_dex),
          oneDexoflow: num(r.gex_one_dexoflow),
          oneGexoflow: num(r.gex_one_gexoflow),
          zcvr: num(r.gex_zcvr),
          zeroGamma: num(r.gex_zero_gamma),
          spot: num(r.gex_spot),
          capturedAt:
            r.gex_captured_at == null ? null : toIso(r.gex_captured_at),
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

    // Inversion-quality (Q1/Q2) suppression now runs in SQL on BOTH the
    // row queries and the COUNT(*) totals (LEFT JOIN lottery_ticker_stats
    // + `${showAll} OR inversion_quintile IS NULL OR inversion_quintile >
    // 2`). So `total` is the reachable chain count, LIMIT/OFFSET slice
    // full pages of reachable chains, and `hasMore` matches — no more
    // "showing 35 of 66" overcount. `suppressedCount` (from the same
    // count query) reports how many otherwise-matching chains the filter
    // hid so the UI can surface a hint instead of silently dropping them.
    // NULL quintile (cold-start tickers) is never suppressed.
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
        minPremium: parsed.data.minPremium ?? null,
        minFireCount: minFireCount ?? null,
        maxFireCount: maxFireCount ?? null,
        minTakeitProb: minTakeitProb ?? null,
      },
      // count = rows returned (≤ limit). total = total matching rows
      // before LIMIT/OFFSET. UI uses (offset, limit, total) for the
      // page-N-of-M display + prev/next controls.
      count: fires.length,
      total,
      // Chains that matched every other filter but were hidden by the
      // Q1/Q2 inversion-quality suppression (0 when ?showAll=true). Lets
      // the UI show "(N hidden by quality filter)" instead of leaving the
      // user wondering why total < the raw fire count.
      suppressedCount,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      fires,
      // Pinned "Hot Right Now" payload — full LotteryFire rows for the
      // day's top-N reignited chains, independent of pagination so the
      // section stays visible on every page. Honours the same user
      // filters as `fires`; can be empty when no chains qualify.
      reignitedFires,
    });
    done({ status: 200 });
  } catch (err) {
    done({ status: 500, error: 'lottery_finder_error' });
    sendDbErrorResponse(res, err, {
      label: 'lottery_finder',
      serverErrorBody: { error: 'Internal error' },
    });
  }
}
