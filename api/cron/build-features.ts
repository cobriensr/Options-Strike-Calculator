/**
 * GET /api/cron/build-features
 *
 * Feature engineering cron that transforms raw intraday data into
 * daily ML feature vectors (training_features) and extracts structured
 * labels from review-mode analyses (day_labels).
 *
 * Runs ~15 min after fetch-outcomes to ensure settlement data is available.
 * On first run, backfills all historical dates. After that, only processes today.
 * Weekends and NYSE holidays are never built, whatever selects the date.
 *
 * A date's static features (VIX, regime, SPX open, ...) come from its
 * market_snapshots row nearest 10:00 AM CT (pickFeatureSnapshot) among the
 * rows that can be trusted (featureSnapshotRejection), and is_event_day is
 * true when any of its rows says so. A date with rows but none trusted stores
 * no snapshot features and feature_completeness 0, so it does not train.
 *
 * Every column keeps its stored value over a NULL, except the seven dark-pool
 * columns (DP_COLUMNS) of a date whose dark-pool read worked and whose day is
 * complete (dpDayComplete) and has an spx_open: they take the rebuilt value as
 * it is. A date with no prints, short bars or no spx_open is listed in
 * `dpKept`; a failed read lists it in `dpReadFailed` and makes the run
 * `partial`.
 *
 * Feature engineering is split into focused modules:
 *   build-features-flow.ts   - flow checkpoint NCP/NPP + agreement
 *   build-features-gex.ts    - GEX, Greek exposure, per-strike features
 *   build-features-phase2.ts - prev day, realized vol, events, max pain, dark pool, options
 *   build-features-monitor.ts - IV monitor + flow ratio monitor dynamics
 *   build-features-types.ts  - shared types, constants, and helpers
 *
 * Environment: DATABASE_URL, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, withDbRetry } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import {
  deriveCronStatus,
  withCronInstrumentation,
  type CronResult,
  type CronStatus,
} from '../_lib/cron-instrumentation.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDayOfWeekFromDateStr,
  getETDateStr,
} from '../../src/utils/timezone.js';
import {
  getMarketCloseHourET,
  isTradingDay,
} from '../../src/data/marketHours.js';
import { parseEntryTimeMinutes } from '../../src/utils/entry-time.js';
import type { FeatureRow, SnapshotRow } from '../_lib/build-features-types.js';
import { num } from '../_lib/build-features-types.js';
import { engineerFlowFeatures } from '../_lib/build-features-flow.js';
import { engineerGexFeatures } from '../_lib/build-features-gex.js';
import {
  dpDayComplete,
  engineerPhase2Features,
} from '../_lib/build-features-phase2.js';
import { engineerMonitorFeatures } from '../_lib/build-features-monitor.js';
import {
  engineerNopeFeatures,
  type NopeTickRow,
} from '../_lib/build-features-nope.js';
import {
  DP_COLUMNS,
  upsertFeatures,
  computeCompleteness,
} from '../_lib/build-features-upsert.js';
import {
  extractLabelsForDate,
  upsertLabels,
} from '../_lib/build-features-labels.js';

export const config = { maxDuration: 300 };

// Time window check

function isPostClose(): boolean {
  const now = new Date();
  const day = getETDayOfWeek(now);
  if (day === 0 || day === 6) return false;

  // Skip market holidays. getMarketCloseHourET returns null for closed days.
  // Without this check, a holiday like Good Friday 2026-04-03 would still
  // land in the post-close window and produce a phantom training_features
  // row from empty UW API responses.
  const dateStr = getETDateStr(now);
  if (getMarketCloseHourET(dateStr) == null) return false;

  const { hour, minute } = getETTime(now);
  const totalMin = hour * 60 + minute;
  // 4:30 PM = 990 min, 6:00 PM = 1080 min
  return totalMin >= 990 && totalMin <= 1080;
}

/** Normalize a Neon DATE value to YYYY-MM-DD string. */
function toDateStr(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString().split('T')[0]!;
  }
  const s = String(val);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (match) return match[1]!;
  return s;
}

// Snapshot sampling

/**
 * Every date's static features come from the snapshot nearest this clock time,
 * in minutes after midnight CT: 10:00 AM CT (owner decision 2026-11-12).
 */
const FEATURE_SAMPLE_MINUTES_CT = 600;

/**
 * A row is a candidate only when its slot is within this many minutes of the
 * sample time: 9:00 to 11:00 AM CT, both ends in (owner decision 2026-11-22).
 */
const FEATURE_SAMPLE_WINDOW_MINUTES = 60;
/**
 * A same-day save may come this many minutes before its slot (a clock a minute
 * fast) and no more.
 */
const SAME_DAY_EARLY_MINUTES = 1;
/**
 * A same-day save may come this many minutes after its slot. Live saves lag 4
 * minutes at the 90th percentile; the 2026-03-26 catch-up rows lagged 41 or
 * more.
 */
const SAME_DAY_LATE_MINUTES = 10;
/**
 * A save made on a later day within this many minutes of its slot's clock time
 * is a browser tab left open on an old date, saving the live quote under the
 * old slot. The replay repairs, saved days later mostly in the evening, are
 * kept.
 */
const STALE_TAB_MINUTES = 10;
/**
 * The row's SPX may sit this many points outside its own day's high-low range
 * as of its slot. 10 keeps out the 9:05 rows before 2026-03-05, whose range
 * cannot be trusted either; 20 would take five of them back (spec
 * 2026-11-22-feature-snapshot-trust-design.md).
 */
const SPX_RANGE_TOLERANCE = 10;

/**
 * From this moment a null RV on a slot row means "the app had no current
 * yesterday" (spec 2026-11-25-missing-yesterday-marking-design.md). Before it,
 * about 1,300 slot rows, mostly January to August, have no RV from before RV was
 * saved on every row, so a plain null test would blank their dates on a
 * rebuild. Fixed ahead of the deploy, so a delayed push is harmless: an
 * old-app row saved after it in a gap has a multiplier of 1 but a null RV, and
 * is caught. A Postgres timestamp literal, read on the database's side with
 * the zone named.
 */
const MISSING_YESTERDAY_CUTOFF = '2026-11-25 00:00 America/Chicago';

/**
 * The columns that say when a market_snapshots row was saved, as SQL text. All
 * time-zone math stays here, in Postgres. One text serves two readers: this
 * cron splices it into its snapshot read, and
 * scripts/_lib/snapshot-price-context.ts into the read behind its pick
 * report. That script's pglite test runs the same text on a real database,
 * time-zone cases included.
 * - `is_backtest`: the stored flag. It is inverted on rows saved before
 *   2026-10-28 and reliable from then on (fixed on 2026-10-27 between 20:27
 *   and 22:44 CT).
 * - `flag_reliable`: the row was first saved on or after that day, 00:00 CT.
 * - `saved_day_offset`: the CT calendar day of the first save minus the row's
 *   `date`, in days.
 * - `saved_minutes_ct`: the CT clock time of the first save, in minutes after
 *   midnight.
 * - `missing_yesterday`: the row has no `cluster_mult` (on any date), or has no
 *   `rv_annualized` and was first saved at or after `MISSING_YESTERDAY_CUTOFF`.
 *   While it has no current yesterday the app saves a null multiplier, tilts
 *   and RV, where before it saved a multiplier of 1 with a null RV. A null
 *   multiplier on any date is safe to judge: every such row in production
 *   (121, checked 2026-11-25) is a `pre-market` row, which has no slot. It
 *   also catches an old row rewritten in place without yesterday, since
 *   `created_at` is kept. A null RV is judged only from the cutoff on.
 * `created_at` is the first insert's time: an ON CONFLICT update never
 * changes it.
 */
export const SNAPSHOT_TRUST_COLUMNS_SQL = `is_backtest,
  (created_at >= TIMESTAMPTZ '2026-10-28 00:00 America/Chicago') AS flag_reliable,
  (cluster_mult IS NULL
    OR (rv_annualized IS NULL
      AND created_at >= TIMESTAMPTZ '${MISSING_YESTERDAY_CUTOFF}')) AS missing_yesterday,
  ((created_at AT TIME ZONE 'America/Chicago')::date - date) AS saved_day_offset,
  (EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Chicago')::int * 60
    + EXTRACT(MINUTE FROM created_at AT TIME ZONE 'America/Chicago')::int) AS saved_minutes_ct`;

/** The columns `SNAPSHOT_TRUST_COLUMNS_SQL` selects, as the driver returns them. */
export interface SnapshotTrustColumns {
  is_backtest: boolean | null;
  flag_reliable: boolean;
  missing_yesterday: boolean;
  saved_day_offset: number;
  saved_minutes_ct: number;
}

/** What `featureSnapshotRejection` reads from a market_snapshots row. */
export interface SnapshotTrustRow extends SnapshotTrustColumns {
  entry_time: string;
  /** NUMERIC, so text from the driver. */
  spx: string | null;
  spx_low: string | null;
  spx_high: string | null;
}

/** The fields `pickFeatureSnapshot` reads from a market_snapshots row. */
type SnapshotCandidate = Pick<SnapshotRow, 'spx_open'> & SnapshotTrustRow;

/** Why a snapshot row cannot be a date's 10:00 view. */
export type FeatureSnapshotRejection =
  | 'no-slot'
  | 'outside-window'
  | 'saved-before-date'
  | 'saved-before-slot'
  | 'saved-late'
  | 'stale-tab'
  | 'no-price-range'
  | 'spx-outside-range'
  | 'missing-yesterday';

/**
 * The first test the row fails, or null when it can be trusted as the date's
 * 10:00 view. The tests, in order:
 * 1. its `entry_time` reads as a clock time (`no-slot`);
 * 2. the slot is within an hour of 10:00 AM CT (`outside-window`);
 * 3. it was not saved before its own date (`saved-before-date`);
 * 4. saved the same day, it was not saved before its slot
 *    (`saved-before-slot`);
 * 5. and not long after it (`saved-late`);
 * 6. saved on a later day, it was not at the slot's clock time: a stale tab
 *    (`stale-tab`);
 * 7. `spx`, `spx_low` and `spx_high` are all usable numbers
 *    (`no-price-range`);
 * 8. `spx` is inside its range, give or take SPX_RANGE_TOLERANCE
 *    (`spx-outside-range`);
 * 9. it was saved with a cluster multiplier, and, from MISSING_YESTERDAY_CUTOFF
 *    on, with RV (`missing-yesterday`): without them the app had no current
 *    yesterday, and a multiplier of 1 on such a row would not be a real "no
 *    clustering" day. Every row, reliable backtests included, takes this test.
 * A reliable backtest row (`is_backtest`, first saved from 2026-10-28) skips
 * tests 3 to 5: it is built from candles for its own slot, so the time it was
 * first saved says nothing about its values, and a later replay that updated
 * it in place left that first time behind. It keeps test 6, because a tab
 * still running code from before the flag fix, left on an old date, makes
 * stale rows even with the flag set.
 */
export function featureSnapshotRejection(
  row: SnapshotTrustRow,
): FeatureSnapshotRejection | null {
  const slot = parseEntryTimeMinutes(row.entry_time);
  if (Number.isNaN(slot)) return 'no-slot';
  if (
    Math.abs(slot - FEATURE_SAMPLE_MINUTES_CT) > FEATURE_SAMPLE_WINDOW_MINUTES
  ) {
    return 'outside-window';
  }

  const offset = row.saved_day_offset;
  const lag = row.saved_minutes_ct - slot;
  const reliableBacktest = row.is_backtest === true && row.flag_reliable;
  if (!reliableBacktest) {
    if (offset < 0) return 'saved-before-date';
    if (offset === 0) {
      if (lag < -SAME_DAY_EARLY_MINUTES) return 'saved-before-slot';
      if (lag > SAME_DAY_LATE_MINUTES) return 'saved-late';
    }
  }
  if (offset > 0 && Math.abs(lag) <= STALE_TAB_MINUTES) return 'stale-tab';

  const spx = num(row.spx);
  const low = num(row.spx_low);
  const high = num(row.spx_high);
  if (spx == null || low == null || high == null) return 'no-price-range';
  if (spx < low - SPX_RANGE_TOLERANCE || spx > high + SPX_RANGE_TOLERANCE) {
    return 'spx-outside-range';
  }
  if (row.missing_yesterday) return 'missing-yesterday';
  return null;
}

/** The first of `rows` nearest the sample time; a tie goes to the earlier. */
function nearestToSampleTime<T extends { entry_time: string }>(
  rows: readonly T[],
): T | undefined {
  let best: T | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestMinutes = Number.NaN;
  for (const row of rows) {
    const minutes = parseEntryTimeMinutes(row.entry_time);
    // "pre-market" and other labels the parser cannot read have no time.
    if (Number.isNaN(minutes)) continue;
    const distance = Math.abs(minutes - FEATURE_SAMPLE_MINUTES_CT);
    if (
      distance < bestDistance ||
      (distance === bestDistance && minutes < bestMinutes)
    ) {
      best = row;
      bestDistance = distance;
      bestMinutes = minutes;
    }
  }
  return best;
}

/**
 * The snapshot a date's static features are read from. Among the trusted rows
 * (`featureSnapshotRejection`), those with a usable `spx_open` (not NULL, not
 * NaN: early snapshots store NaN before the cash open) first: the one nearest
 * 10:00 AM CT, the earlier on a tie. When none has an open, the same rule over
 * every trusted row. When no row is trusted, undefined: the date has no 10:00
 * view. `rows` must be in id order, and `entry_time` is compared as a clock
 * time: as text "10:00 AM CT" sorts before "8:30 AM CT".
 */
export function pickFeatureSnapshot<T extends SnapshotCandidate>(
  rows: readonly T[],
): T | undefined {
  const trusted = rows.filter((row) => featureSnapshotRejection(row) == null);
  const withOpen = trusted.filter((row) => num(row.spx_open) != null);
  return nearestToSampleTime(withOpen) ?? nearestToSampleTime(trusted);
}

type RejectionCounts = Partial<Record<FeatureSnapshotRejection, number>>;

/** How many of `rows` each test rejected, for the no-pick warning. */
function rejectionCounts(rows: readonly SnapshotTrustRow[]): RejectionCounts {
  const counts: RejectionCounts = {};
  for (const row of rows) {
    const reason = featureSnapshotRejection(row);
    if (reason != null) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

/** A date built with snapshot rows but no trusted one: no 10:00 view. */
interface NoPickDate {
  date: string;
  rejected: RejectionCounts;
}

/** One Sentry event per run, so a no-pick date is not visible only in pino. */
const NO_PICK_ALERT = 'build-features: no trusted snapshot row';

/**
 * How a run chose its dates: the scheduled post-close run (today), an explicit
 * `?date=`, or a backfill (`?backfill=true`, or the first run on an empty
 * training_features table).
 */
type RunMode = 'daily' | 'date' | 'backfill';

/**
 * The event's level by run mode. Only a daily run reaches the owner: a new day
 * leaving training is the silent loss this alert exists for, and the project's
 * high-priority issue rule skips warnings. `?date=` and backfill runs repair
 * and rebuild known dates (a backfill names the known no-pick ones), so they
 * stay warnings.
 */
const NO_PICK_LEVEL: Record<RunMode, 'error' | 'warning'> = {
  daily: 'error',
  date: 'warning',
  backfill: 'warning',
};

/**
 * Tell Sentry that these dates were built with no trusted snapshot row. Why it
 * is not only a log line: if live rows stopped carrying `spx_low` and
 * `spx_high`, every new day would fail `no-price-range` and silently leave
 * training. One event per run whatever the number of dates, with the dates and
 * the rejection counts summed over them. A no-pick date is a data state, not a
 * failed write, so the run stays `success`.
 *
 * Each run mode has its own fingerprint (and a `build_features.mode` tag).
 * With one shared fingerprint, the first event would come from a repair
 * rebuild, and a later live regression would land as a repeat event on that
 * open issue, which emails nobody.
 */
function reportNoPickDates(noPick: readonly NoPickDate[], mode: RunMode): void {
  const rejected: RejectionCounts = {};
  for (const { rejected: counts } of noPick) {
    for (const reason of Object.keys(counts) as FeatureSnapshotRejection[]) {
      rejected[reason] = (rejected[reason] ?? 0) + (counts[reason] ?? 0);
    }
  }
  Sentry.captureMessage(NO_PICK_ALERT, {
    level: NO_PICK_LEVEL[mode],
    fingerprint: ['build-features', 'no-trusted-snapshot-row', mode],
    tags: { 'build_features.mode': mode },
    extra: { dates: noPick.map((d) => d.date), count: noPick.length, rejected },
  });
}

/**
 * The 18 static features copied from the picked snapshot row. With no row
 * every one is an explicit null, not an absent key, so nothing downstream has
 * to tell the two apart.
 */
function snapshotFeatures(s: SnapshotRow | undefined): FeatureRow {
  return {
    vix: num(s?.vix),
    vix1d: num(s?.vix1d),
    vix9d: num(s?.vix9d),
    vvix: num(s?.vvix),
    vix1d_vix_ratio: num(s?.vix1d_vix_ratio),
    vix_vix9d_ratio: num(s?.vix_vix9d_ratio),
    regime_zone: s?.regime_zone ?? null,
    cluster_mult: num(s?.cluster_mult),
    dow_mult: num(s?.dow_mult_hl),
    dow_label: s?.dow_label ?? null,
    spx_open: num(s?.spx_open),
    sigma: num(s?.sigma),
    hours_remaining: num(s?.hours_remaining),
    ic_ceiling: num(s?.ic_ceiling),
    put_spread_ceiling: num(s?.put_spread_ceiling),
    call_spread_ceiling: num(s?.call_spread_ceiling),
    opening_range_signal: s?.opening_range_signal ?? null,
    opening_range_pct_consumed: num(s?.opening_range_pct_consumed),
  };
}

// Build features for a single date

/**
 * What the write does with a date's dark-pool columns (`dp_*`):
 * - `overwrite`: the dark-pool read worked and the day is complete
 *   (`dpDayComplete`), so the columns take the rebuilt value as it is, NULL
 *   included;
 * - `keep`: the read worked but the day has no prints or short bars, or the
 *   date has no `spx_open`. A data state, not a failure: the columns keep
 *   their stored value (the COALESCE every column has), and the date is listed
 *   in `dpKept`;
 * - `read-failed`: the dark-pool read, or the check of the day, failed. The
 *   columns keep their stored value too, and the run is `partial`.
 */
type DarkPoolWrite = 'overwrite' | 'keep' | 'read-failed';

/**
 * The dp columns' fate for `dateStr`. Nothing here throws: a rejected check of
 * the day is a failed read of the dp signal, like a failed dark-pool read.
 *
 * `hasOpen` is whether the date has an `spx_open`. Without one, the dark-pool
 * step leaves four columns unset (top-cluster distance, support, resistance
 * and their ratio, which are measured from the open), so an overwrite would
 * store NULL over their values though the day's levels are all there: a date
 * with no open keeps them, like a day with no prints.
 */
async function darkPoolWrite(
  sql: ReturnType<typeof getDb>,
  dateStr: string,
  dpReadOk: boolean,
  hasOpen: boolean,
): Promise<DarkPoolWrite> {
  if (!dpReadOk) return 'read-failed';
  if (!hasOpen) return 'keep';
  try {
    const complete = await withDbRetry(
      () => dpDayComplete(sql, dateStr),
      2,
      10_000,
    );
    return complete ? 'overwrite' : 'keep';
  } catch (err) {
    Sentry.captureException(err);
    logger.warn(
      { err, date: dateStr },
      'build-features: dark-pool completeness check failed, dp columns kept',
    );
    return 'read-failed';
  }
}

/** A date's features, and whether it was built with no trusted snapshot row. */
interface BuiltDate {
  features: FeatureRow;
  noPick: NoPickDate | null;
  dp: DarkPoolWrite;
}

async function buildFeaturesForDate(dateStr: string): Promise<BuiltDate> {
  const sql = getDb();
  const features: FeatureRow = { date: dateStr };

  // 1. Static features from market_snapshots
  // Read every row of the date (about 80 at most) and sample one in
  // TypeScript: entry_time is text, so SQL cannot order it by clock time.
  // The trust columns are the SQL text shared with the price-context script,
  // spliced in raw: it is a constant of this module.
  const snapshots = (await withDbRetry(
    () => sql`
      SELECT entry_time,
             vix, vix1d, vix9d, vvix, vix1d_vix_ratio, vix_vix9d_ratio,
             regime_zone, cluster_mult, dow_mult_hl, dow_label,
             spx_open, sigma, hours_remaining,
             ic_ceiling, put_spread_ceiling, call_spread_ceiling,
             opening_range_signal, opening_range_pct_consumed, is_event_day,
             spx, spx_low, spx_high,
             ${sql.unsafe(SNAPSHOT_TRUST_COLUMNS_SQL)}
      FROM market_snapshots
      WHERE date = ${dateStr}
      ORDER BY id ASC
    `,
    2,
    10_000,
  )) as (SnapshotRow & SnapshotTrustRow)[];

  // A date with rows but none trusted has no 10:00 view: its snapshot features
  // are null and its completeness 0 (below), so it does not train. These NULLs
  // do not replace values already stored: the upsert COALESCEs every column.
  // Clearing the stored values is the spec's one-off blanking run (2026-11-22
  // feature snapshot trust design, "Repair runs after deploy"), not this cron.
  let noPick: NoPickDate | null = null;
  if (snapshots.length > 0) {
    const s = pickFeatureSnapshot(snapshots);
    Object.assign(features, snapshotFeatures(s));
    // The flag is the date's, not the sampled row's: bool_or over every row,
    // which is NULL only when no row carries a flag. A row saved before the
    // event lookup could name the day stays false while a later one is true.
    const eventFlags = snapshots
      .map((row) => row.is_event_day)
      .filter((flag) => flag != null);
    features.is_event_day =
      eventFlags.length > 0 ? eventFlags.includes(true) : null;
    if (s == null) {
      noPick = { date: dateStr, rejected: rejectionCounts(snapshots) };
      logger.warn(
        { date: dateStr, rows: snapshots.length, rejected: noPick.rejected },
        'build-features: no trusted snapshot row, snapshot features left empty',
      );
    }
  }

  // Fall back to outcomes.day_open if snapshots didn't provide spx_open
  if (features.spx_open == null) {
    const fallback = await withDbRetry(
      () => sql`
        SELECT day_open FROM outcomes WHERE date = ${dateStr} LIMIT 1
      `,
      2,
      10_000,
    );
    if (fallback.length > 0 && fallback[0]!.day_open != null) {
      features.spx_open = num(fallback[0]!.day_open);
    }
  }

  // Day of week from date string. The dateStr is already an ET calendar
  // date, so the weekday is a pure property of that date - no TZ math
  // needed. The TZ-aware helper handles DST and any host TZ uniformly,
  // unlike the previous hardcoded -05:00 offset.
  const dow = getETDayOfWeekFromDateStr(dateStr);
  features.day_of_week = dow;
  features.is_friday = dow === 5;

  // 2. Flow checkpoint features
  await engineerFlowFeatures(sql, dateStr, features);

  // 3-5. GEX, Greek exposure, per-strike features
  await engineerGexFeatures(sql, dateStr, features);

  // 6-9. Phase 2: prev day, realized vol, events, max pain, dark pool, options
  const { dpReadOk } = await engineerPhase2Features(sql, dateStr, features);
  // The same test the dark-pool step applies before it reads the open.
  const dp = await darkPoolWrite(
    sql,
    dateStr,
    dpReadOk,
    features.spx_open != null,
  );

  // 10. Monitor features: IV dynamics + flow ratio dynamics
  await engineerMonitorFeatures(sql, dateStr, features);

  // 11. NOPE features: SPY hedging-pressure checkpoints + AM aggregates
  const nopeRows = (await withDbRetry(
    () => sql`
      SELECT timestamp, nope, call_delta, put_delta
      FROM nope_ticks
      WHERE ticker = 'SPY'
        AND (timestamp AT TIME ZONE 'America/New_York')::date = ${dateStr}
      ORDER BY timestamp ASC
    `,
    2,
    10_000,
  )) as NopeTickRow[];
  Object.assign(features, engineerNopeFeatures(nopeRows, dateStr));

  // 0, not NULL: the upsert keeps the stored value over a NULL. The ML readers
  // keep a day only at 0.80 or more, so a 0 keeps this date out of training.
  features.feature_completeness =
    noPick == null ? computeCompleteness(features) : 0;

  return { features, noPick, dp };
}

// Wrapped main cron.
//
// build-features needs the raw request to read `?backfill=` and
// `?date=` for date-list selection, so it opts into the wrapper's
// `passReq: true` escape hatch. CronContext intentionally hides `req`
// by default; this is the documented way to surface it without a
// module-scoped ref + dispatcher (which worked today only because JS
// is single-threaded — any future `await` between assignment and read
// would silently break it).

const wrappedCron = withCronInstrumentation(
  'build-features',
  async (ctx): Promise<CronResult> => {
    const { logger: log, req } = ctx;
    const backfill = req?.query.backfill === 'true';
    const dateParamRaw = req?.query.date;
    const dateParam =
      typeof dateParamRaw === 'string' ? dateParamRaw : undefined;

    const sql = getDb();

    // Diagnostic: log flow_data coverage for today before doing any work
    const today = ctx.today;
    const coverage = await withDbRetry(
      () => sql`
        SELECT source, COUNT(*) as rows
        FROM flow_data
        WHERE date = ${today}
        GROUP BY source
        ORDER BY source
      `,
      2,
      10_000,
    );
    log.info({ date: today, sources: coverage }, 'flow_data coverage');

    // Determine which dates to process, and in which mode (for the no-pick
    // alert)
    let dates: string[];
    let mode: RunMode;

    if (dateParam != null) {
      // Explicit single-date mode - highest precedence. Used for
      // refetching one day after a cron miss or freshness investigation.
      dates = [dateParam];
      mode = 'date';
      log.info({ date: dateParam }, 'build-features: single-date mode');
    } else if (backfill) {
      // Process all historical dates with flow data
      mode = 'backfill';
      const rows = await withDbRetry(
        () => sql`
          SELECT DISTINCT date FROM flow_data ORDER BY date ASC
        `,
        2,
        10_000,
      );
      dates = rows.map((r) => toDateStr(r.date));
    } else {
      // Check if table is empty (first run = automatic backfill)
      const countResult = await withDbRetry(
        () => sql`SELECT COUNT(*) AS cnt FROM training_features`,
        2,
        10_000,
      );
      const count = Number(countResult[0]!.cnt);

      if (count === 0) {
        mode = 'backfill';
        const rows = await withDbRetry(
          () => sql`
            SELECT DISTINCT date FROM flow_data ORDER BY date ASC
          `,
          2,
          10_000,
        );
        dates = rows.map((r) => toDateStr(r.date));
        log.info(
          { dates: dates.length },
          'build-features: empty table, backfilling all dates',
        );
      } else {
        mode = 'daily';
        dates = [getETDateStr(new Date())];
      }
    }

    // Keep valid YYYY-MM-DD dates that were trading days. A weekend or
    // holiday has no session to featurize: its UW responses are empty, so
    // the row would be a phantom. This one filter covers ?date=, backfill
    // and the empty-table first run.
    const wellFormed = dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    dates = wellFormed.filter(isTradingDay);
    if (dates.length < wellFormed.length) {
      log.info(
        { skipped: wellFormed.filter((d) => !isTradingDay(d)) },
        'build-features: skipped non-trading days',
      );
    }

    let featuresBuilt = 0;
    let labelsExtracted = 0;
    let errors = 0;
    let latestCompleteness: number | undefined;
    // Dates whose features row was written with no trusted snapshot row
    // (completeness 0). A date whose features write failed is an error and is
    // not here. A labels write that fails after the features row was written
    // leaves the date here and also counts in `errors`.
    const noPickDates: NoPickDate[] = [];
    // Dates written with their dp columns kept for a data state (no prints,
    // short bars, no spx_open), and dates written with them kept because a
    // read failed. As with noPickDates, a date whose features write failed is
    // in neither.
    const dpKeptDates: string[] = [];
    const dpReadFailedDates: string[] = [];

    for (const dateStr of dates) {
      try {
        const { features, noPick, dp } = await buildFeaturesForDate(dateStr);
        await upsertFeatures(features, {
          overwrite: dp === 'overwrite' ? DP_COLUMNS : [],
        });
        featuresBuilt++;
        latestCompleteness = features.feature_completeness as
          | number
          | undefined;
        if (noPick != null) noPickDates.push(noPick);
        if (dp === 'keep') dpKeptDates.push(dateStr);
        if (dp === 'read-failed') dpReadFailedDates.push(dateStr);

        const labels = await extractLabelsForDate(dateStr);
        if (labels) {
          await upsertLabels(labels);
          labelsExtracted++;
        }
      } catch (err) {
        Sentry.captureException(err);
        log.warn(
          { err, date: dateStr },
          'build-features: error processing date',
        );
        errors++;
      }
    }

    if (noPickDates.length > 0) reportNoPickDates(noPickDates, mode);

    // The run's summary is a warning when a dark-pool read failed (the status
    // is then `partial`); the failure itself is logged and captured as it
    // happens.
    const completed = {
      dates: dates.length,
      featuresBuilt,
      labelsExtracted,
      errors,
      noPickDates: noPickDates.length,
      dpKept: dpKeptDates.length,
      dpReadFailed: dpReadFailedDates.length,
    };
    if (dpReadFailedDates.length > 0) {
      log.warn(completed, 'build-features: completed');
    } else {
      log.info(completed, 'build-features: completed');
    }

    // Every date failing is 'error' (red Sentry monitor), not 'partial'; no
    // dates to process is 'success'. A no-pick date is a data state, not a
    // failure, so it never moves the status. A dark-pool read that failed
    // does: the row was written, so it is not an `errors` count (one date of
    // one would read as a failed write, and `error`), and it is set here, by
    // hand, to lower a success to 'partial' and never to lift an 'error'.
    const derived = deriveCronStatus(errors, dates.length);
    const status: CronStatus =
      derived === 'success' && dpReadFailedDates.length > 0
        ? 'partial'
        : derived;

    return {
      status,
      metadata: {
        dates: dates.length,
        featuresBuilt,
        labelsExtracted,
        errors,
        completeness: latestCompleteness,
        // Explains a completeness of 0. Not an Axiom top-level key
        // (api/_lib/axiom-fields.ts), so it is reported inside `meta`.
        noPickDates: noPickDates.length,
        // The dates whose dp columns were not overwritten because the day has
        // no prints, short bars or no spx_open. In the response too, so a
        // `?date=` rebuild says whether its date is here. Inside `meta` in
        // Axiom like the rest.
        dpKept: dpKeptDates,
        // The dates whose dark-pool read, or check of the day, failed; why the
        // status is 'partial' with no errors.
        dpReadFailed: dpReadFailedDates,
      },
    };
  },
  {
    requireApiKey: false,
    passReq: true,
    // Disable the default isMarketHours() gate; isPostClose owns the
    // window, and ?backfill=true / ?date= override it.
    marketHours: false,
    dynamicTimeCheck: (req) => {
      const backfill = req.query?.backfill === 'true';
      const dateParam = typeof req.query?.date === 'string';
      // Backfill OR explicit single-date requests bypass the time window.
      if (backfill || dateParam) return { run: true, reason: 'override' };
      return {
        run: isPostClose(),
        reason: 'Outside time window',
      };
    },
  },
);

// Top-level dispatch.
//
// The 400 path for a malformed `?date=` parameter must reject BEFORE
// any auth/time gate so the test contract { error: 'Invalid date
// param, ...' } is preserved verbatim. Everything else delegates to
// the instrumented wrapper.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const dateParamRaw = req.query.date;
  const dateParam = typeof dateParamRaw === 'string' ? dateParamRaw : undefined;
  if (dateParam != null && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return res
      .status(400)
      .json({ error: 'Invalid date param, expected YYYY-MM-DD' });
  }
  await wrappedCron(req, res);
}
