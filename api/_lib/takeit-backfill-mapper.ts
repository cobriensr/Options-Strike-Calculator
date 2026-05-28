/**
 * Take-It strict-clean backfill row mapper.
 *
 * Pure adapter: takes a raw DB row from `lottery_finder_fires` (as returned
 * by neon's tagged-template query) and produces a `LotteryAlertRow` shaped
 * exactly the way the live detect cron constructs it before calling
 * `scoreLottery()`. See `api/cron/detect-lottery-fires.ts` lines ~691-736
 * for the reference shape.
 *
 * Strict-clean policy
 * ───────────────────
 * This mapper does NOT reconstruct any missing macro field. Callers must
 * pre-filter to rows where every required macro input is present (see
 * `STRICT_CLEAN_WHERE` below — that filter belongs in the script, not
 * here). If a required macro field is missing on the input row we throw —
 * the script should never feed such a row to the mapper.
 *
 * Numeric coercion
 * ────────────────
 * `@neondatabase/serverless` returns Postgres NUMERIC as strings, INTEGER /
 * SMALLINT as numbers. We coerce uniformly so the downstream feature
 * builder sees `number` (or `null`), never a string that would silently
 * become NaN inside `Math.fround`.
 *
 * Date coercion
 * ─────────────
 * - `trigger_time_ct`: returned as a JS Date by neon for TIMESTAMPTZ.
 * - `date`: returned as a JS Date by neon for DATE (memory: feedback_neon_
 *   date_columns.md). We pass it through as-is — featuresForLottery only
 *   reads `row.date` indirectly via the sequential context, never as a
 *   string-compared value.
 */

import type { LotteryAlertRow } from './takeit-features.js';

/**
 * `@neondatabase/serverless` returns Postgres NUMERIC as strings. Some code
 * paths (or future driver versions) may surface them as numbers — accept
 * both so the mapper is robust to that.
 */
export type DbNumeric = string | number;
export type DbNullableNumeric = DbNumeric | null;

/**
 * Shape of one raw row coming back from a `SELECT * FROM
 * lottery_finder_fires` against the post-migration schema. Only the
 * columns the mapper reads are declared; extra columns (id, expiry,
 * realized_*, takeit_*, etc.) are ignored.
 *
 * Field types reflect what `@neondatabase/serverless` actually returns:
 *   - NUMERIC          → DbNumeric  (or null)
 *   - INTEGER/SMALLINT → number     (or null)
 *   - REAL/DOUBLE      → number     (or null)
 *   - BOOLEAN          → boolean    (or null)
 *   - TIMESTAMPTZ/DATE → Date       (or null)
 *   - TEXT/CHAR        → string     (or null)
 */
export interface LotteryFireDbRow {
  // identity
  trigger_time_ct: Date;
  date: Date;
  option_chain_id: string;
  underlying_symbol: string;
  option_type: 'C' | 'P';
  strike: DbNumeric;
  dte: number;

  // trigger features (NUMERIC NOT NULL)
  trigger_vol_to_oi_window: DbNumeric;
  trigger_vol_to_oi_cum: DbNumeric;
  trigger_iv: DbNumeric;
  trigger_delta: DbNumeric;
  trigger_ask_pct: DbNumeric;
  trigger_window_size: number; // INTEGER NOT NULL
  trigger_window_prints: number; // INTEGER NOT NULL

  // entry context
  entry_price: DbNumeric;
  open_interest: number; // INTEGER NOT NULL
  spot_at_first: DbNumeric;
  spot_at_trigger: DbNullableNumeric;
  alert_seq: number; // INTEGER NOT NULL
  minutes_since_prev_fire: DbNumeric; // NUMERIC NOT NULL

  // discriminators
  flow_quad: string;
  tod: string;
  mode: string;
  reload_tagged: boolean;
  cheap_call_pm_tagged: boolean;
  burst_ratio_vs_prev: DbNullableNumeric;
  entry_drop_pct_vs_prev: DbNullableNumeric;

  // macro snapshot — strict-clean filter guarantees the required ones are
  // non-null. Optional ones may legitimately be null on a strict-clean row.
  mkt_tide_ncp: DbNumeric; // strict-clean required
  mkt_tide_npp: DbNullableNumeric;
  mkt_tide_diff: DbNullableNumeric;
  mkt_tide_otm_diff: DbNullableNumeric;
  spx_flow_diff: DbNullableNumeric;
  spy_etf_diff: DbNullableNumeric;
  qqq_etf_diff: DbNullableNumeric;
  zero_dte_diff: DbNullableNumeric;
  spx_spot_gamma_oi: DbNumeric; // strict-clean required
  spx_spot_gamma_vol: DbNullableNumeric;
  spx_spot_charm_oi: DbNullableNumeric;
  spx_spot_vanna_oi: DbNullableNumeric;
  gex_strike_call_minus_put: DbNumeric; // strict-clean required
  gex_strike_call_ask_minus_bid: DbNullableNumeric;
  gex_strike_put_ask_minus_bid: DbNullableNumeric;

  // scoring outputs already persisted by the detect cron
  score: number | null; // INTEGER, nullable
  direction_gated: boolean; // NOT NULL DEFAULT FALSE

  // multileg classification (migration #160) — optional, NULL on pre-migration rows
  inferred_structure: string | null;
  is_isolated_leg: boolean | null;
  match_confidence: number | null; // REAL → number
  pattern_group_id: string | null;
}

/**
 * Strict-clean WHERE clause used by the backfill script. Exported so the
 * mapper and the script stay in lock-step about what counts as "clean".
 * Any change here must be mirrored in `LotteryFireDbRow` (which fields
 * are typed non-nullable).
 */
export const STRICT_CLEAN_WHERE = [
  'takeit_prob IS NULL',
  'mkt_tide_ncp IS NOT NULL',
  'spx_spot_gamma_oi IS NOT NULL',
  'gex_strike_call_minus_put IS NOT NULL',
] as const;

/**
 * Per-ticker prior-session win rate (expanding mean over strictly earlier
 * dates), indexed by the row's session date as `YYYY-MM-DD` (UTC).
 */
export type PerDateWinRateMap = ReadonlyMap<
  string,
  ReadonlyMap<string, number | null>
>;

/**
 * Module-level constant returned when a session date has no pre-computed
 * map. Frozen empty Map matches the `ReadonlyMap` contract — callers must
 * not mutate.
 */
const EMPTY_WIN_RATE_MAP: ReadonlyMap<string, number | null> = new Map();

/** Convert a session-date Date to the `YYYY-MM-DD` key used by `PerDateWinRateMap`. */
export function isoDateKey(date: Date): string {
  // Assumes neon returns Postgres DATE as UTC midnight (driver contract as of
  // @neondatabase/serverless 0.10). If that changes, switch to a tz-aware slice.
  if (!(date instanceof Date)) {
    throw new TypeError(
      `takeit-backfill-mapper: isoDateKey expects a Date, got ${typeof date}`,
    );
  }
  return date.toISOString().slice(0, 10);
}

/**
 * PIT-correct lookup of the per-ticker prior-session win-rate map for a
 * specific session date. Returns an empty map if that date has no entry.
 *
 * Live cron parity (api/cron/detect-lottery-fires.ts:422-443): the live
 * detect cron's `fetchPriorSessionWinRateByTicker` filters
 * `date < ${ctx.today}::date` where `ctx.today` is the cron tick's session
 * date. For backfill we re-create that semantics per row by pre-computing
 * one map per distinct candidate date and looking up by that key here —
 * NOT by a single global map (which would leak future sessions into early
 * rows; see the spec-review note on the May-5 row).
 */
export function selectPriorWinRateForDate(
  perDateMap: PerDateWinRateMap,
  rowDate: Date,
): ReadonlyMap<string, number | null> {
  const key = isoDateKey(rowDate);
  const m = perDateMap.get(key);
  return m ?? EMPTY_WIN_RATE_MAP;
}

/**
 * Coerce a Postgres NUMERIC (string from neon) or already-numeric value to
 * a JS `number`. Returns `null` for null/undefined inputs. Throws if the
 * value is present but cannot be parsed as a finite number — that's a
 * structural bug we want to surface loudly, not a silent NaN.
 */
function toNullableNumber(
  v: DbNullableNumeric | undefined,
  field: string,
): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  if (!Number.isFinite(n)) {
    throw new TypeError(
      `takeit-backfill-mapper: field "${field}" has non-finite value ${JSON.stringify(v)}`,
    );
  }
  return n;
}

/** Same as toNullableNumber but requires a value — throws on null. */
function toNumber(v: DbNullableNumeric | undefined, field: string): number {
  const n = toNullableNumber(v, field);
  if (n === null) {
    throw new TypeError(`takeit-backfill-mapper: field "${field}" is null`);
  }
  return n;
}

/**
 * Convert a raw DB row to the `LotteryAlertRow` shape the live cron passes
 * to `scoreLottery`. Strict — throws if a strict-clean required field is
 * missing, since the caller is responsible for upstream filtering.
 */
export function dbRowToLotteryAlertRow(row: LotteryFireDbRow): LotteryAlertRow {
  if (!(row.trigger_time_ct instanceof Date)) {
    throw new TypeError(
      'takeit-backfill-mapper: row.trigger_time_ct must be a Date (TIMESTAMPTZ)',
    );
  }
  if (!(row.date instanceof Date)) {
    throw new TypeError(
      'takeit-backfill-mapper: row.date must be a Date (DATE column)',
    );
  }
  if (row.option_type !== 'C' && row.option_type !== 'P') {
    throw new TypeError(
      `takeit-backfill-mapper: option_type must be 'C' or 'P', got ${JSON.stringify(row.option_type)}`,
    );
  }

  return {
    fire_time: row.trigger_time_ct,
    date: row.date,
    option_chain_id: row.option_chain_id,
    underlying_symbol: row.underlying_symbol,
    option_type: row.option_type,
    strike: toNumber(row.strike, 'strike'),
    dte: row.dte,

    // trigger features (NOT NULL in schema → assert via toNumber)
    trigger_vol_to_oi_window: toNumber(
      row.trigger_vol_to_oi_window,
      'trigger_vol_to_oi_window',
    ),
    trigger_vol_to_oi_cum: toNumber(
      row.trigger_vol_to_oi_cum,
      'trigger_vol_to_oi_cum',
    ),
    trigger_iv: toNumber(row.trigger_iv, 'trigger_iv'),
    trigger_delta: toNumber(row.trigger_delta, 'trigger_delta'),
    trigger_ask_pct: toNumber(row.trigger_ask_pct, 'trigger_ask_pct'),
    trigger_window_size: row.trigger_window_size,
    trigger_window_prints: row.trigger_window_prints,

    // entry context
    entry_price: toNumber(row.entry_price, 'entry_price'),
    open_interest: row.open_interest,
    spot_at_first: toNumber(row.spot_at_first, 'spot_at_first'),
    // spot_at_trigger added in migration #178 — may be NULL on older rows.
    spot_at_trigger: toNullableNumber(row.spot_at_trigger, 'spot_at_trigger'),
    alert_seq: row.alert_seq,
    minutes_since_prev_fire: toNumber(
      row.minutes_since_prev_fire,
      'minutes_since_prev_fire',
    ),

    // discriminators
    flow_quad: row.flow_quad,
    tod: row.tod,
    mode: row.mode,
    reload_tagged: row.reload_tagged,
    cheap_call_pm_tagged: row.cheap_call_pm_tagged,
    burst_ratio_vs_prev: toNullableNumber(
      row.burst_ratio_vs_prev,
      'burst_ratio_vs_prev',
    ),
    entry_drop_pct_vs_prev: toNullableNumber(
      row.entry_drop_pct_vs_prev,
      'entry_drop_pct_vs_prev',
    ),

    // macro
    mkt_tide_ncp: toNumber(row.mkt_tide_ncp, 'mkt_tide_ncp'),
    mkt_tide_npp: toNullableNumber(row.mkt_tide_npp, 'mkt_tide_npp'),
    mkt_tide_diff: toNullableNumber(row.mkt_tide_diff, 'mkt_tide_diff'),
    mkt_tide_otm_diff: toNullableNumber(
      row.mkt_tide_otm_diff,
      'mkt_tide_otm_diff',
    ),
    spx_flow_diff: toNullableNumber(row.spx_flow_diff, 'spx_flow_diff'),
    spy_etf_diff: toNullableNumber(row.spy_etf_diff, 'spy_etf_diff'),
    qqq_etf_diff: toNullableNumber(row.qqq_etf_diff, 'qqq_etf_diff'),
    zero_dte_diff: toNullableNumber(row.zero_dte_diff, 'zero_dte_diff'),
    spx_spot_gamma_oi: toNumber(row.spx_spot_gamma_oi, 'spx_spot_gamma_oi'),
    spx_spot_gamma_vol: toNullableNumber(
      row.spx_spot_gamma_vol,
      'spx_spot_gamma_vol',
    ),
    spx_spot_charm_oi: toNullableNumber(
      row.spx_spot_charm_oi,
      'spx_spot_charm_oi',
    ),
    spx_spot_vanna_oi: toNullableNumber(
      row.spx_spot_vanna_oi,
      'spx_spot_vanna_oi',
    ),
    gex_strike_call_minus_put: toNumber(
      row.gex_strike_call_minus_put,
      'gex_strike_call_minus_put',
    ),
    gex_strike_call_ask_minus_bid: toNullableNumber(
      row.gex_strike_call_ask_minus_bid,
      'gex_strike_call_ask_minus_bid',
    ),
    gex_strike_put_ask_minus_bid: toNullableNumber(
      row.gex_strike_put_ask_minus_bid,
      'gex_strike_put_ask_minus_bid',
    ),

    score: row.score,
    direction_gated: row.direction_gated,

    inferred_structure: row.inferred_structure,
    is_isolated_leg: row.is_isolated_leg,
    match_confidence: row.match_confidence,
    pattern_group_id: row.pattern_group_id,
  };
}
