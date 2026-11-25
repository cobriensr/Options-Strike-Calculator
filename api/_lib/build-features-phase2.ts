/**
 * Phase 2 feature engineering for build-features cron.
 *
 * Extracts: previous-day stats, realized volatility, RV/IV ratio,
 * VIX term structure, VVIX percentile, economic events (FOMC/OPEX/etc.),
 * max pain, dark pool features, options volume/premium, OI change
 * features, and vol surface features.
 *
 * The orchestrator (`engineerPhase2Features`) sequences the per-phase
 * helpers below. Each helper mutates the shared `features` object in
 * place; sequential ordering matters because some helpers depend on
 * fields written by earlier ones (e.g. `addRealizedIvRatio` reads
 * `realized_vol_5d` which `addRealizedVol` writes; `addMaxPain` reads
 * `spx_open` which is written by the caller before this orchestrator).
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { FeatureRow } from './build-features-types.js';
import { getDarkPoolLevels } from './dark-pool-query.js';
import { nextEventGap, summarizeDayEvents } from './economic-event-features.js';
import { fetchMaxPain } from './max-pain.js';
import { uwFetch } from './api-helpers.js';
import logger from './logger.js';
import { Sentry } from './sentry.js';
import {
  CASH_OPEN_MIN_ET,
  cashSessionMinutes,
  getMarketCloseHourET,
  priorTradingDay,
} from '../../src/data/marketHours.js';
import { etWallClockToUtcIso, getETToday } from '../../src/utils/timezone.js';

/** UW's rolling history window, in trading days. */
const UW_WINDOW_TRADING_DAYS = 30;

/**
 * The calendar-day bound for a window of `days` trading days:
 *   ceil(trading days * 7/5) + safety buffer
 * 44 for the 30-day window. `isWithinUWWindow` and the options-volume row
 * count both come from this one expression, so they cannot drift apart.
 */
function uwWindowCalendarDays(days: number): number {
  return Math.ceil((days * 7) / 5) + 2;
}

/**
 * Check whether `dateStr` falls inside the Unusual Whales 30-trading-day
 * rolling history window. For max_pain, which takes a `date`, UW returns HTTP
 * 403 with `historic_data_access_missing` on dates older than that window;
 * pre-flighting lets us skip the fetch entirely and avoid noisy warn logs
 * during blanket backfills. For options_volume, which takes no `date`, the
 * guard bounds which dates `addOptionsVolumeFeatures` tries: its request asks
 * for as many of the newest rows as this window can hold (see
 * `OPTIONS_VOLUME_ROWS`), so an older date is skipped rather than reported as
 * a missing row.
 *
 * The calculation is a calendar-day approximation (`uwWindowCalendarDays`):
 * for 30 trading days, 44 calendar days covers the window with a small
 * over-inclusion margin. Erring generous is safe: at worst max_pain gets one
 * extra call whose 403 the surrounding try-block catches, and options_volume
 * finds no row for the date and reports it.
 *
 * Exported for direct unit testing.
 */
export function isWithinUWWindow(
  dateStr: string,
  today: Date = new Date(),
  days = UW_WINDOW_TRADING_DAYS,
): boolean {
  const parsed = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;

  // Compare using UTC midnights so DST transitions don't shift the boundary.
  const targetDay = Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  );
  const todayDay = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );

  // Future dates are always "within window" — UW will simply return no data
  // rather than a historic_data_access_missing 403.
  if (targetDay >= todayDay) return true;

  const daysAgo = Math.round((todayDay - targetDay) / (24 * 60 * 60 * 1000));
  return daysAgo <= uwWindowCalendarDays(days);
}

// ── Phase helpers ───────────────────────────────────────────────
//
// Each helper mutates `features` in place. Helpers are independently
// callable (handy for narrower unit tests), but the orchestrator calls
// them in a strict order — see `engineerPhase2Features` at the bottom.

type Sql = NeonQueryFunction<false, false>;

/** What rounds a value to the 4 decimals (the scale) of a NUMERIC(8,4): 10^4. */
const NUMERIC_8_4_SCALE_FACTOR = 10 ** 4;

/**
 * The first |value| a NUMERIC(8,4) cannot hold: its 8 digits less the 4
 * decimals leave 4 integer digits, so the limit is 10^(8 - 4) = 10,000.
 */
const NUMERIC_8_4_LIMIT = 10 ** (8 - 4);

/**
 * Round a ratio to the 4 decimals of a NUMERIC(8,4) column, or return null
 * when the rounded value has more than 4 integer digits (|value| >= 10000) or
 * is not a number (NaN, or an infinity).
 *
 * Postgres rounds to the column's scale first and then checks the range, so
 * this does the same: 9999.99996 rounds to 10000 and is out of range. An
 * out-of-range value fails the whole row's upsert, not just its own column
 * (dp_support_resistance_ratio was 35,853 on 2026-03-26 and that date's
 * features never rebuilt).
 *
 * This only prevents the overflow. A null here does not always clear the
 * stored value, because the upsert keeps the existing value over a null
 * (COALESCE(EXCLUDED.col, existing) in build-features-upsert.ts):
 * - oic_oi_change_pcr always keeps its old value over a null;
 * - dp_support_resistance_ratio keeps it too, except on a complete day whose
 *   dark-pool read succeeded: there the cron overwrites the dp columns as they
 *   are, so the null replaces the stored value (dpDayComplete, below).
 */
function roundToNumeric84(value: number): number | null {
  const rounded =
    Math.round(value * NUMERIC_8_4_SCALE_FACTOR) / NUMERIC_8_4_SCALE_FACTOR;
  return !Number.isFinite(rounded) || Math.abs(rounded) >= NUMERIC_8_4_LIMIT
    ? null
    : rounded;
}

/**
 * Previous-day features: range, direction, range category, VIX delta.
 * Reads `outcomes` for the most recent prior date and computes the VIX
 * change using the already-populated `features.vix` (set by the caller
 * via market_snapshots).
 */
export async function addPrevDayFeatures(
  sql: Sql,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  const prevDayRows = await sql`
    SELECT date, day_range_pts, close_vs_open, vix_close,
           CASE WHEN close_vs_open > 0 THEN 'UP' ELSE 'DOWN' END AS direction,
           CASE
             WHEN day_range_pts < 30 THEN 'NARROW'
             WHEN day_range_pts < 60 THEN 'NORMAL'
             WHEN day_range_pts < 100 THEN 'WIDE'
             ELSE 'EXTREME'
           END AS range_cat
    FROM outcomes
    WHERE date < ${dateStr}
    ORDER BY date DESC
    LIMIT 10
  `;

  if (prevDayRows.length > 0) {
    const prev = prevDayRows[0]!;
    features.prev_day_range_pts = num(prev.day_range_pts);
    features.prev_day_direction = prev.direction as string;
    features.prev_day_range_cat = prev.range_cat as string;

    const vixNow = typeof features.vix === 'number' ? features.vix : null;
    if (vixNow !== null && prev.vix_close != null) {
      features.prev_day_vix_change = vixNow - Number(prev.vix_close);
    }
  }
}

/**
 * Realized volatility from log returns of settlement prices. Computes
 * 5-day and 10-day annualized RV (252-trading-day basis) via population
 * variance over `n-1` (sample) — same convention as numpy.std(ddof=1).
 */
export async function addRealizedVolFeatures(
  sql: Sql,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  const settlements = await sql`
    SELECT settlement FROM outcomes
    WHERE date <= ${dateStr} AND settlement IS NOT NULL
    ORDER BY date DESC
    LIMIT 11
  `;

  const prices = settlements.map((r) => Number(r.settlement));

  if (prices.length >= 6) {
    const logReturns5: number[] = [];
    for (let i = 0; i < 5 && i + 1 < prices.length; i++) {
      logReturns5.push(Math.log(prices[i]! / prices[i + 1]!));
    }
    if (logReturns5.length >= 5) {
      const mean5 = logReturns5.reduce((a, b) => a + b, 0) / logReturns5.length;
      const variance5 =
        logReturns5.reduce((a, b) => a + (b - mean5) ** 2, 0) /
        (logReturns5.length - 1);
      features.realized_vol_5d = Math.sqrt(variance5) * Math.sqrt(252) * 100;
    }
  }

  if (prices.length >= 11) {
    const logReturns10: number[] = [];
    for (let i = 0; i < 10 && i + 1 < prices.length; i++) {
      logReturns10.push(Math.log(prices[i]! / prices[i + 1]!));
    }
    if (logReturns10.length >= 10) {
      const mean10 =
        logReturns10.reduce((a, b) => a + b, 0) / logReturns10.length;
      const variance10 =
        logReturns10.reduce((a, b) => a + (b - mean10) ** 2, 0) /
        (logReturns10.length - 1);
      features.realized_vol_10d = Math.sqrt(variance10) * Math.sqrt(252) * 100;
    }
  }
}

/**
 * RV/IV ratio: 5-day realized vol divided by VIX. Pure derived feature
 * that depends on `addRealizedVolFeatures` having run first.
 */
export function addRealizedIvRatioFeatures(features: FeatureRow): void {
  const rv5 =
    typeof features.realized_vol_5d === 'number'
      ? features.realized_vol_5d
      : null;
  const vix = typeof features.vix === 'number' ? features.vix : null;
  if (rv5 !== null && vix !== null && vix > 0) {
    features.rv_iv_ratio = rv5 / vix;
  }
}

/**
 * VIX term structure slope: (vix9d - vix1d) / vix. Pure derived feature
 * computed from the already-populated VIX/VIX1d/VIX9d columns set by
 * the caller via market_snapshots.
 */
export function addTermSlopeFeatures(features: FeatureRow): void {
  const vix = typeof features.vix === 'number' ? features.vix : null;
  const vix1d = typeof features.vix1d === 'number' ? features.vix1d : null;
  const vix9d = typeof features.vix9d === 'number' ? features.vix9d : null;
  if (vix1d !== null && vix9d !== null && vix !== null && vix > 0) {
    features.vix_term_slope = (vix9d - vix1d) / vix;
  }
}

/**
 * VVIX percentile over the trailing 20 training_features rows. Skipped
 * unless we have at least 10 prior VVIX values to rank against.
 */
export async function addVvixPercentileFeatures(
  sql: Sql,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  if (features.vvix == null) return;

  const vvixHistory = await sql`
    SELECT vvix FROM training_features
    WHERE date < ${dateStr} AND vvix IS NOT NULL
    ORDER BY date DESC LIMIT 20
  `;
  if (vvixHistory.length >= 10) {
    const vvixValues = vvixHistory.map((r) => Number(r.vvix));
    const vvixNow = typeof features.vvix === 'number' ? features.vvix : null;
    const belowCount =
      vvixNow !== null ? vvixValues.filter((v) => v <= vvixNow).length : 0;
    features.vvix_percentile = belowCount / vvixValues.length;
  }
}

/**
 * Economic event features: FOMC / OPEX / event_type / event_count /
 * days_to_next_event. Mixes a `economic_events` lookup with the Fed
 * decision-day schedule (`summarizeDayEvents`, in economic-event-features.ts)
 * and a calendar computation for OPEX (3rd Friday of month). Sets defaults so
 * even an empty calendar day still has populated fields.
 */
export async function addEventFeatures(
  sql: Sql,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  features.is_opex = false;
  features.event_count = 0;

  const eventRows = await sql`
    SELECT event_name, event_type, event_time
    FROM economic_events
    WHERE date = ${dateStr}
  `;

  features.event_count = eventRows.length;
  const { isFomc, eventType } = summarizeDayEvents(
    dateStr,
    new Set(eventRows.map((r) => r.event_type as string)),
  );
  features.is_fomc = isFomc;
  if (eventType !== null) features.event_type = eventType;

  // Check if today is OPEX (3rd Friday of month)
  const opexDate = new Date(`${dateStr}T12:00:00-05:00`);
  if (!Number.isNaN(opexDate.getTime()) && opexDate.getDay() === 5) {
    const dayOfMonth = opexDate.getDate();
    features.is_opex = dayOfMonth >= 15 && dayOfMonth <= 21;
  }

  // Days to next event: the integer calendar-day gap, computed on DATEs in
  // SQL. (DATE - DATE is an integer; each MIN is NULL with no matching row.)
  // `before_table` is true when the day precedes the first economic_events
  // row. nextEventGap leaves the field unset for a day before the table
  // existed and for a gap over MAX_PLAUSIBLE_EVENT_GAP_DAYS (missing calendar
  // data), as it does with no later row. The backfill applies the same rule.
  const nextEventRow = await sql`
    SELECT
      (SELECT MIN(date) FROM economic_events WHERE date > ${dateStr}::date)
        - ${dateStr}::date AS days_to_next,
      (SELECT MIN(date) FROM economic_events) > ${dateStr}::date AS before_table
  `;
  const rawGap = nextEventRow[0]?.days_to_next;
  const daysToNext = nextEventGap(
    rawGap == null ? null : Number(rawGap),
    nextEventRow[0]?.before_table as boolean | null | undefined,
  );
  if (daysToNext !== null) features.days_to_next_event = daysToNext;
}

/**
 * Max pain features: 0DTE max pain strike + distance from spx_open.
 * Skipped (not stamped null) when outside the UW 30-trading-day rolling
 * window — the cron sets `UW_API_KEY`; if missing, the entire phase is
 * a no-op. Errors are logged but never propagated; downstream models
 * see undefined max_pain_* (genuine NaN), not a fabricated 0.
 */
export async function addMaxPainFeatures(
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  try {
    const apiKey = process.env.UW_API_KEY;
    if (apiKey && !isWithinUWWindow(dateStr)) {
      logger.info(
        { date: dateStr },
        'Max pain: skipping UW fetch (outside 30-trading-day rolling window)',
      );
    } else if (apiKey) {
      const outcome = await fetchMaxPain(apiKey, dateStr);
      if (outcome.kind === 'error') {
        // Don't poison the feature row with placeholder zeros — leave
        // max_pain_0dte / max_pain_dist undefined so downstream models
        // see a genuine NaN rather than a fabricated 0.
        logger.warn(
          { date: dateStr, reason: outcome.reason },
          'Max pain feature extraction skipped (UW API error)',
        );
      } else if (outcome.kind === 'ok') {
        const sorted = outcome.data
          .filter((e) => e.expiry >= dateStr)
          .sort((a, b) => a.expiry.localeCompare(b.expiry));
        const best = sorted[0];
        if (best) {
          const mp = Number.parseFloat(best.max_pain);
          if (!Number.isNaN(mp)) {
            features.max_pain_0dte = mp;
            const spxOpen = features.spx_open as number | undefined;
            if (spxOpen != null && spxOpen > 0) {
              features.max_pain_dist = mp - spxOpen;
            }
          }
        }
      }
      // outcome.kind === 'empty' → no entries returned; leave features as-is
    }
  } catch (error_) {
    logger.warn({ err: error_ }, 'Max pain feature extraction failed');
    Sentry.captureException(error_);
  }
}

/**
 * Dark pool features for daily SPX clusters: total premium, cluster
 * count, top-cluster distance, support/resistance premium split
 * (around spx_open), and concentration of premium at the single top
 * level. Reads via the shared dark-pool-query helper, which aggregates
 * the uw-stream daemon's dark_pool_prints. Errors are logged but never
 * propagated.
 *
 * Returns whether the read went through: false when an error was caught (the
 * dp_* features are then left as they were, which says nothing about the day),
 * true otherwise, a read with no rows included. The cron overwrites the stored
 * dp_* columns only after a true.
 *
 * The `sql` parameter is preserved for signature compatibility with
 * the caller's transaction context, but unused — the helper opens its
 * own connection via getDb(). Acceptable because feature extraction
 * is idempotent (UPSERT downstream) and never participates in the
 * caller's transaction boundary.
 */
export async function addDarkPoolFeatures(
  _sql: Sql,
  dateStr: string,
  features: FeatureRow,
): Promise<boolean> {
  try {
    const result = await getDarkPoolLevels({ date: dateStr, symbol: 'SPX' });
    const levels = result.levels;

    if (levels.length > 0) {
      const totalPremium = levels.reduce((s, l) => s + l.totalPremium, 0);

      features.dp_total_premium = totalPremium;
      features.dp_cluster_count = levels.length;

      const spxPrice = (features.spx_open as number | undefined) ?? null;
      const topLevel = levels[0]!;

      if (spxPrice != null) {
        features.dp_top_cluster_dist = topLevel.level - spxPrice;

        // Support = premium at levels AT or BELOW SPX; resistance = above
        let support = 0;
        let resistance = 0;
        for (const l of levels) {
          if (l.level <= spxPrice) {
            support += l.totalPremium;
          } else {
            resistance += l.totalPremium;
          }
        }
        features.dp_support_premium = support;
        features.dp_resistance_premium = resistance;
        features.dp_support_resistance_ratio =
          resistance > 0 ? roundToNumeric84(support / resistance) : null;
      }

      // Concentration: how much of total premium is at the single top level
      features.dp_concentration =
        totalPremium > 0
          ? Math.round((topLevel.totalPremium / totalPremium) * 10000) / 10000
          : null;
    }
    return true;
  } catch (error_) {
    logger.warn(
      { err: error_, date: dateStr },
      'Dark pool feature extraction failed',
    );
    Sentry.captureException(error_);
    return false;
  }
}

/**
 * Whether `dateStr` has all the data the dark-pool levels read stands on, so a
 * rebuild may overwrite its stored dp_* columns, NULLs included. All three:
 * 1. at least one `dark_pool_prints` row with `symbol = 'SPY'` (the levels
 *    query reads SPY and scales it to SPX);
 * 2. `cashSessionMinutes(dateStr)` SPX bars with `market_time = 'r'` in
 *    `index_candles_1m`;
 * 3. `cashSessionMinutes(dateStr)` SPY bars in `etf_candles_1m` from 09:30 ET
 *    up to the close (13:00 ET on a half day). That table has no date or
 *    market_time column, so the window is the two instants.
 * The levels query joins both candle tables on each print's minute, so a
 * minute missing from either one drops that minute's prints from the levels.
 * A rebuild over such a day, or over one with no prints (the legacy dates),
 * would write thinner levels than the stored ones, NULLs included, so the
 * stored ones stay.
 *
 * A day with no cash session (a weekend, a holiday, no date) is not complete.
 * One query; a rejection propagates, for the caller to treat as a failed dp
 * read.
 */
export async function dpDayComplete(
  sql: Sql,
  dateStr: string,
): Promise<boolean> {
  const expectedBars = cashSessionMinutes(dateStr);
  const closeHour = getMarketCloseHourET(dateStr);
  const openIso = etWallClockToUtcIso(dateStr, CASH_OPEN_MIN_ET);
  const closeIso =
    closeHour == null ? null : etWallClockToUtcIso(dateStr, closeHour * 60);
  if (expectedBars === 0 || openIso == null || closeIso == null) return false;

  const rows = (await sql`
    SELECT
      EXISTS (
        SELECT 1 FROM dark_pool_prints
        WHERE symbol = 'SPY' AND date = ${dateStr}::date
      ) AS has_prints,
      (
        SELECT COUNT(*) FROM index_candles_1m
        WHERE symbol = 'SPX' AND date = ${dateStr}::date AND market_time = 'r'
      )::int AS spx_bars,
      (
        SELECT COUNT(*) FROM etf_candles_1m
        WHERE ticker = 'SPY'
          AND timestamp >= ${openIso}::timestamptz
          AND timestamp < ${closeIso}::timestamptz
      )::int AS spy_bars
  `) as Array<{
    has_prints: boolean;
    spx_bars: number | string;
    spy_bars: number | string;
  }>;

  const row = rows[0];
  return (
    row != null &&
    row.has_prints === true &&
    Number(row.spx_bars) >= expectedBars &&
    Number(row.spy_bars) >= expectedBars
  );
}

/**
 * How many of the newest rows to ask `/stock/SPX/options-volume` for. The
 * endpoint has no `date` parameter: it returns the newest trading days, one row
 * a day, so a date is found by its row's own `date`.
 *
 * The order is a probe observation, not something UW documents: the live reply
 * for `limit=40` on 2026-11-25 ran newest first, back to 2026-10-01. The code
 * does not rely on it, because a row is found by its own date, wherever it sits.
 * What the order does decide is which rows the limit keeps. If UW ever sent
 * oldest first, the newest days would fall outside the limit, the daily run's
 * own date would find no row, and the error-level report in
 * `addOptionsVolumeFeatures` would say so.
 *
 * `isWithinUWWindow` lets a date through up to `uwWindowCalendarDays` calendar
 * days back, which is that many plus one dates counting today. Calendar dates
 * always outnumber trading days, so asking for that many rows reaches the
 * oldest date the guard accepts, and the count follows the guard if its window
 * changes. It stays far under the endpoint's maximum of 500.
 *
 * The previous-day features need one more row, the previous trading day's of the
 * date asked for, and the count already reaches it. That row is at most a
 * weekend plus a holiday (4 days) behind the oldest date the guard accepts, so
 * 48 days back; 49 calendar days hold at most 35 weekdays, so at most 35 rows
 * lie between it and today, and the count is 45. In the window test in
 * build-features-phase2.test.ts, `oldest` equal to 44 pins the guard's width and
 * `limit >= calendarDates` pins this count; its walk to the previous row states
 * the bound above and pins the dates, but is looser than those two, so it cannot
 * fail first.
 */
const OPTIONS_VOLUME_ROWS = uwWindowCalendarDays(UW_WINDOW_TRADING_DAYS) + 1;

/**
 * A reply row's own date as `YYYY-MM-DD`, or null when the row is not an
 * object or its `date` is not a date. The live endpoint sends `"2026-11-25"`;
 * UW's docs show a full ISO timestamp (`2023-09-08T00:00:00.000Z`), which
 * names the same trading day, so both are read.
 */
function optionsVolumeRowDate(row: unknown): string | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    return null;
  }
  const date = (row as { date?: unknown }).date;
  if (typeof date !== 'string') return null;
  return /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(date)?.[1] ?? null;
}

/** Which group of options-volume features a mapped row is written to. */
export type OptionsVolumePrefix = 'opt_' | 'prev_day_opt_';

/**
 * The 15 options-volume features of one `/stock/SPX/options-volume` reply row,
 * every name starting with `prefix`: `opt_` for the day's own row, or
 * `prev_day_opt_` for the previous trading day's. Pure: the row's date is not
 * read, so the caller must have picked the right row.
 *
 * Names after the prefix: call_volume, put_volume, call_oi, put_oi,
 * call_premium, put_premium, bullish_premium, bearish_premium, call_vol_ask,
 * put_vol_bid, vol_pcr, oi_pcr, premium_ratio, call_vol_vs_avg30 and
 * put_vol_vs_avg30.
 *
 * The rules, kept from the daily build as it has always read a row:
 * - a count is read as an integer, a premium as a decimal, and a zero, a
 *   missing field or a non-number becomes null;
 * - a ratio is set only when its numerator and its denominator are finite
 *   numbers and the denominator is above 0. Otherwise it is left out of the
 *   result altogether, not set to null, and never a NaN (a field that does not
 *   parse reads as NaN, and Postgres NUMERIC would store it). A numerator of 0
 *   gives a ratio of 0;
 * - the 30-day average volumes are read as integers too, so a fractional
 *   average is truncated before it divides.
 *
 * The daily build calls it, and the history repair
 * (`scripts/_lib/options-volume-repair.ts`) does too, so the two cannot diverge.
 */
export function optionsVolumeFeaturesFromRow(
  ov: Record<string, unknown>,
  prefix: OptionsVolumePrefix,
): FeatureRow {
  const features: FeatureRow = {};

  const callVol = Number.parseInt(String(ov.call_volume ?? '0'), 10);
  const putVol = Number.parseInt(String(ov.put_volume ?? '0'), 10);
  const callOI = Number.parseInt(String(ov.call_open_interest ?? '0'), 10);
  const putOI = Number.parseInt(String(ov.put_open_interest ?? '0'), 10);

  features[`${prefix}call_volume`] = callVol || null;
  features[`${prefix}put_volume`] = putVol || null;
  features[`${prefix}call_oi`] = callOI || null;
  features[`${prefix}put_oi`] = putOI || null;

  const callPrem = Number.parseFloat(String(ov.call_premium ?? '0'));
  const putPrem = Number.parseFloat(String(ov.put_premium ?? '0'));
  const bullPrem = Number.parseFloat(String(ov.bullish_premium ?? '0'));
  const bearPrem = Number.parseFloat(String(ov.bearish_premium ?? '0'));
  features[`${prefix}call_premium`] = callPrem || null;
  features[`${prefix}put_premium`] = putPrem || null;
  features[`${prefix}bullish_premium`] = bullPrem || null;
  features[`${prefix}bearish_premium`] = bearPrem || null;

  const callAsk = Number.parseInt(String(ov.call_volume_ask_side ?? '0'), 10);
  const putBid = Number.parseInt(String(ov.put_volume_bid_side ?? '0'), 10);
  features[`${prefix}call_vol_ask`] = callAsk || null;
  features[`${prefix}put_vol_bid`] = putBid || null;

  const avg30Call = Number.parseInt(
    String(ov.avg_30_day_call_volume ?? '0'),
    10,
  );
  const avg30Put = Number.parseInt(String(ov.avg_30_day_put_volume ?? '0'), 10);

  const ratios: Array<[name: string, value: number | undefined]> = [
    ['vol_pcr', ratioOf(putVol, callVol)],
    ['oi_pcr', ratioOf(putOI, callOI)],
    ['premium_ratio', ratioOf(bullPrem, bullPrem + bearPrem)],
    ['call_vol_vs_avg30', ratioOf(callVol, avg30Call)],
    ['put_vol_vs_avg30', ratioOf(putVol, avg30Put)],
  ];
  for (const [name, value] of ratios) {
    if (value !== undefined) features[`${prefix}${name}`] = value;
  }

  return features;
}

/**
 * `numerator / denominator`, or undefined when it is not a value: either side
 * is not a finite number (a field that did not parse reads as NaN), or the
 * denominator is not above 0. A numerator of 0 is a real ratio of 0.
 */
function ratioOf(numerator: number, denominator: number): number | undefined {
  return Number.isFinite(numerator) &&
    Number.isFinite(denominator) &&
    denominator > 0
    ? numerator / denominator
    : undefined;
}

/** What a reply lacks: the date's row, its previous trading day's, or both. */
type MissingOptionsVolumeRows = 'date' | 'previous-date' | 'both';

/**
 * Tell the log and Sentry that the reply has no row for a date the build
 * needs. `date` (the date's own row is missing, the previous day's is there)
 * and `both` (neither row is there, including an empty, non-array or malformed
 * reply: one report that names both dates) go under `options-volume-no-row`;
 * `previous-date` (the date's row is there, the previous trading day's is
 * missing) goes under `options-volume-no-prev-row`. The level
 * follows `fields.date`, the date being built: an error when it is the current
 * ET date, a warning otherwise (see `addOptionsVolumeFeatures`). A live miss
 * has an issue per date, and repairs share one.
 */
function reportNoOptionsVolumeRow(
  missing: MissingOptionsVolumeRows,
  fields: { date: string; previousDate?: string; returnedDates: string[] },
): void {
  const kind =
    missing === 'previous-date'
      ? 'options-volume-no-prev-row'
      : 'options-volume-no-row';
  let logMessage =
    'Options volume: UW returned no row for the requested date, so no opt_* features are set';
  let sentryMessage = 'Options volume: no row for the requested date';
  if (missing === 'previous-date') {
    logMessage =
      'Options volume: UW returned no row for the previous trading day, so no prev_day_opt_* features are set';
    sentryMessage = 'Options volume: no row for the previous trading day';
  } else if (missing === 'both') {
    logMessage =
      'Options volume: UW returned no row for the requested date or its previous trading day, so no opt_* or prev_day_opt_* features are set';
    sentryMessage =
      'Options volume: no row for the requested date or its previous trading day';
  }
  logger.warn(fields, logMessage);
  const isLiveDate = fields.date === getETToday();
  Sentry.captureMessage(sentryMessage, {
    level: isLiveDate ? 'error' : 'warning',
    fingerprint: ['build-features', kind, isLiveDate ? fields.date : 'repair'],
    tags: { 'build_features.feature': 'options_volume' },
    extra: fields,
  });
}

/**
 * Options volume + premium + OI features from the UW
 * /stock/SPX/options-volume endpoint. Same UW-window pre-flight as
 * max pain. Two groups of 15, from one request (see
 * `optionsVolumeFeaturesFromRow` for the names and the rules):
 * - `opt_*` from the reply row dated `dateStr`: the day's own full-day totals,
 *   known only after the close, so an end-of-day record;
 * - `prev_day_opt_*` from the row dated `priorTradingDay(dateStr)`: the same 15
 *   features of the previous trading day, which a model deciding at 10:00 CT
 *   can read.
 *
 * Each row is the one whose own `date` is asked for, never one by its place in
 * the reply, and the two lookups are independent: a missing row leaves its
 * group unset and the other group as it is. When the reply has no row (UW has
 * not published the day, it is older than the rows asked for, or the reply is
 * malformed) nothing is set for that date, never another day's row: the
 * reply's dates and the one asked for are logged and sent to Sentry, a missing
 * previous-day row under its own fingerprint (`options-volume-no-prev-row`).
 * A reply with neither row (an empty, non-array or malformed one, or one of
 * other days) is one report under `options-volume-no-row` that names both
 * dates, not two. The
 * level follows the date, as
 * `reportNoPickDates` in the build-features cron follows the run mode: an
 * error when `dateStr` is the current ET date, the daily run's own (in winter
 * it tries a date once, at 21:45 UTC, so a miss would leave the day empty and
 * unheard); a warning otherwise, for the older dates of backfills and `?date=`
 * repairs. This helper cannot see the run mode, only the date, so
 * `?date=<today ET>` and a backfill whose dates include today count as live
 * too and report at `error`. A live miss has an issue per date, repairs share
 * one. A feature left unset is not a clean slate downstream: the upsert keeps
 * the stored value, so a value written earlier stays until it is repaired.
 */
export async function addOptionsVolumeFeatures(
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  try {
    const apiKey = process.env.UW_API_KEY;
    if (apiKey && !isWithinUWWindow(dateStr)) {
      logger.info(
        { date: dateStr },
        'Options volume: skipping UW fetch (outside 30-trading-day rolling window)',
      );
    } else if (apiKey) {
      const reply = await uwFetch<unknown>(
        apiKey,
        `/stock/SPX/options-volume?limit=${OPTIONS_VOLUME_ROWS}`,
      );
      // uwFetch hands back whatever `data` held; only an array is a reply.
      const rows: unknown[] = Array.isArray(reply) ? reply : [];
      const rowDated = (date: string) =>
        rows.find((row) => optionsVolumeRowDate(row) === date) as
          | Record<string, unknown>
          | undefined;
      const returnedDates = rows.flatMap((row) => {
        const date = optionsVolumeRowDate(row);
        return date == null ? [] : [date];
      });
      const previousDate = priorTradingDay(dateStr);
      const ov = rowDated(dateStr);
      const previous = rowDated(previousDate);

      if (ov == null && previous == null) {
        // Neither row is there (an empty reply, a non-array, rows with no
        // readable date, or rows of other days): one report, naming both
        // dates, not one per row.
        reportNoOptionsVolumeRow('both', {
          date: dateStr,
          previousDate,
          returnedDates,
        });
      } else {
        // The two rows are looked up apart, each by its own date: a missing
        // one leaves its group unset and does not touch the other.
        if (ov == null) {
          reportNoOptionsVolumeRow('date', { date: dateStr, returnedDates });
        } else {
          Object.assign(features, optionsVolumeFeaturesFromRow(ov, 'opt_'));
        }

        if (previous == null) {
          reportNoOptionsVolumeRow('previous-date', {
            date: dateStr,
            previousDate,
            returnedDates,
          });
        } else {
          Object.assign(
            features,
            optionsVolumeFeaturesFromRow(previous, 'prev_day_opt_'),
          );
        }
      }
    }
  } catch (error_) {
    logger.warn({ err: error_ }, 'Options volume feature extraction failed');
    Sentry.captureException(error_);
  }
}

/**
 * OI change features from the daily `oi_changes` snapshot: net OI
 * change (calls + puts), per-side breakdown, premium aggregates,
 * ask/bid ratio, multi-leg pct, top-strike distance, and top-5
 * concentration. Errors logged, never propagated.
 */
export async function addOiChangeFeatures(
  sql: Sql,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  try {
    const oicRows = await sql`
      SELECT option_symbol, strike, is_call, oi_diff,
             prev_ask_volume, prev_bid_volume,
             prev_multi_leg_volume, prev_total_premium
      FROM oi_changes
      WHERE date = ${dateStr}
    `;

    if (oicRows.length > 0) {
      let callOiChange = 0;
      let putOiChange = 0;
      let callPremium = 0;
      let putPremium = 0;
      let totalAskVol = 0;
      let totalBidVol = 0;
      let totalMultiLeg = 0;
      const absChanges: { strike: number; absDiff: number }[] = [];

      for (const r of oicRows) {
        const diff = Number(r.oi_diff) || 0;
        const premium = Number(r.prev_total_premium) || 0;
        const askVol = Number(r.prev_ask_volume) || 0;
        const bidVol = Number(r.prev_bid_volume) || 0;
        const multiLeg = Number(r.prev_multi_leg_volume) || 0;
        const strike = Number(r.strike) || 0;
        const isCall = r.is_call === true;

        if (isCall) {
          callOiChange += diff;
          callPremium += premium;
        } else {
          putOiChange += diff;
          putPremium += premium;
        }

        totalAskVol += askVol;
        totalBidVol += bidVol;
        totalMultiLeg += multiLeg;
        absChanges.push({ strike, absDiff: Math.abs(diff) });
      }

      features.oic_net_oi_change = callOiChange + putOiChange;
      features.oic_call_oi_change = callOiChange || null;
      features.oic_put_oi_change = putOiChange || null;
      features.oic_oi_change_pcr =
        callOiChange !== 0
          ? roundToNumeric84(putOiChange / callOiChange)
          : null;
      features.oic_net_premium = callPremium + putPremium || null;
      features.oic_call_premium = callPremium || null;
      features.oic_put_premium = putPremium || null;

      const totalVol = totalAskVol + totalBidVol;
      features.oic_ask_ratio =
        totalVol > 0
          ? Math.round((totalAskVol / totalVol) * 10000) / 10000
          : null;

      const allVol = totalAskVol + totalBidVol + totalMultiLeg;
      features.oic_multi_leg_pct =
        allVol > 0
          ? Math.round((totalMultiLeg / allVol) * 10000) / 10000
          : null;

      // Top strike distance from SPX open
      absChanges.sort((a, b) => b.absDiff - a.absDiff);
      const spxOpen = features.spx_open as number | undefined;
      if (absChanges[0] && spxOpen && absChanges[0].strike > 0) {
        features.oic_top_strike_dist = absChanges[0].strike - spxOpen;
      }

      // Concentration: top 5 as fraction of total absolute OI change
      const totalAbsDiff = absChanges.reduce((s, c) => s + c.absDiff, 0);
      const top5AbsDiff = absChanges
        .slice(0, 5)
        .reduce((s, c) => s + c.absDiff, 0);
      features.oic_concentration =
        totalAbsDiff > 0
          ? Math.round((top5AbsDiff / totalAbsDiff) * 10000) / 10000
          : null;
    }
  } catch (error_) {
    logger.warn({ err: error_ }, 'OI change feature extraction failed');
    Sentry.captureException(error_);
  }
}

/**
 * Vol surface features: 0DTE→30D term structure slope/spread/contango
 * pulled from `vol_term_structure` + `iv_monitor`, plus realized vol +
 * IV rank from `vol_realized`. Errors logged, never propagated.
 *
 * Term-structure source quirk: the UW /volatility/term-structure
 * endpoint only returns monthly+ expiries (min DTE ~15). For the 0DTE
 * end we use iv_monitor (from /interpolated-iv which includes 0DTE).
 * Combining the two gives the full 0DTE-to-30D slope that defines
 * contango/inversion.
 */
export async function addVolSurfaceFeatures(
  sql: Sql,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  try {
    const tsRows = await sql`
      SELECT days, volatility FROM vol_term_structure
      WHERE date = ${dateStr}
      ORDER BY days ASC
    `;

    // Get 0DTE IV from iv_monitor (first reading of the day)
    const ivMonRow = await sql`
      SELECT volatility FROM iv_monitor
      WHERE date = ${dateStr}
      ORDER BY timestamp ASC
      LIMIT 1
    `;
    const zeroDteVol =
      ivMonRow.length > 0 ? num(ivMonRow[0]!.volatility) : null;

    if (tsRows.length >= 1) {
      const vols = tsRows.map((r) => ({
        days: Number(r.days),
        vol: Number(r.volatility),
      }));

      // Find ~30D point (closest to 30 DTE on the term structure)
      const thirtyD = vols.reduce(
        (best, v) =>
          Math.abs(v.days - 30) < Math.abs(best.days - 30) ? v : best,
        vols[0]!,
      );

      if (zeroDteVol != null && thirtyD) {
        const spread = zeroDteVol - thirtyD.vol;
        features.iv_ts_spread = Math.round(spread * 10000) / 10000;
        features.iv_ts_contango = zeroDteVol < thirtyD.vol;
        features.iv_ts_slope_0d_30d =
          thirtyD.vol > 0
            ? Math.round(((zeroDteVol - thirtyD.vol) / thirtyD.vol) * 10000) /
              10000
            : null;
      }
    }

    // Realized vol + IV rank from vol_realized table
    const rvRow = await sql`
      SELECT rv_30d, iv_rv_spread, iv_overpricing_pct, iv_rank
      FROM vol_realized
      WHERE date = ${dateStr}
      LIMIT 1
    `;

    if (rvRow.length > 0) {
      const rv = rvRow[0]!;
      features.uw_rv_30d = num(rv.rv_30d);
      features.uw_iv_rv_spread = num(rv.iv_rv_spread);
      features.uw_iv_overpricing_pct = num(rv.iv_overpricing_pct);
      features.iv_rank = num(rv.iv_rank);
    }
  } catch (error_) {
    logger.warn({ err: error_ }, 'Vol surface feature extraction failed');
    Sentry.captureException(error_);
  }
}

// ── Orchestrator ────────────────────────────────────────────────

/** What `engineerPhase2Features` returns besides the features it fills in. */
export interface Phase2Result {
  /**
   * True when the dark-pool read resolved with no caught error (no rows is
   * still true). It sits here and not in `features` because a FeatureRow key
   * would count in `computeCompleteness`.
   */
  dpReadOk: boolean;
}

/**
 * Engineer Phase 2 features by sequencing the per-phase helpers above.
 * Order matters: realized_vol must precede rv/iv ratio; spx_open must be
 * already populated (caller writes it from market_snapshots) before max
 * pain / dark pool / OI change run.
 *
 * Mutates `features` in place. Output is identical to the legacy
 * monolithic implementation — verified by the orchestrator tests.
 */
export async function engineerPhase2Features(
  sql: Sql,
  dateStr: string,
  features: FeatureRow,
): Promise<Phase2Result> {
  await addPrevDayFeatures(sql, dateStr, features);
  await addRealizedVolFeatures(sql, dateStr, features);
  addRealizedIvRatioFeatures(features);
  addTermSlopeFeatures(features);
  await addVvixPercentileFeatures(sql, dateStr, features);
  await addEventFeatures(sql, dateStr, features);
  await addMaxPainFeatures(dateStr, features);
  const dpReadOk = await addDarkPoolFeatures(sql, dateStr, features);
  await addOptionsVolumeFeatures(dateStr, features);
  await addOiChangeFeatures(sql, dateStr, features);
  await addVolSurfaceFeatures(sql, dateStr, features);
  return { dpReadOk };
}

// ── Internals ───────────────────────────────────────────────────

// Local num helper (avoids importing full types module just for this)
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
