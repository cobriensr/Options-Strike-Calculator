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
 * market_snapshots row nearest 10:00 AM CT (pickFeatureSnapshot), and
 * is_event_day is true when any of its rows says so.
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
import { Sentry } from '../_lib/sentry.js';
import {
  deriveCronStatus,
  withCronInstrumentation,
  type CronResult,
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
import { engineerPhase2Features } from '../_lib/build-features-phase2.js';
import { engineerMonitorFeatures } from '../_lib/build-features-monitor.js';
import {
  engineerNopeFeatures,
  type NopeTickRow,
} from '../_lib/build-features-nope.js';
import {
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

/** The two fields `pickFeatureSnapshot` reads from a market_snapshots row. */
type SnapshotCandidate = Pick<SnapshotRow, 'spx_open'> & { entry_time: string };

/** The first of `rows` nearest the sample time; a tie goes to the earlier. */
function nearestToSampleTime<T extends SnapshotCandidate>(
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
 * The snapshot a date's static features are read from. Among rows with a
 * usable `spx_open` (not NULL, not NaN: early snapshots store NaN before the
 * cash open) and a readable `entry_time`, the one nearest 10:00 AM CT, the
 * earlier on a tie. When no row qualifies, the same rule over every row with
 * a readable time, and when none has one (only "pre-market"), the first row.
 * `rows` must be in id order, and `entry_time` is compared as a clock time:
 * as text "10:00 AM CT" sorts before "8:30 AM CT".
 */
export function pickFeatureSnapshot<T extends SnapshotCandidate>(
  rows: readonly T[],
): T | undefined {
  const withOpen = rows.filter((row) => num(row.spx_open) != null);
  return nearestToSampleTime(withOpen) ?? nearestToSampleTime(rows) ?? rows[0];
}

// Build features for a single date

async function buildFeaturesForDate(
  dateStr: string,
): Promise<FeatureRow | null> {
  const sql = getDb();
  const features: FeatureRow = { date: dateStr };

  // 1. Static features from market_snapshots
  // Read every row of the date (about 80 at most) and sample one in
  // TypeScript: entry_time is text, so SQL cannot order it by clock time.
  const snapshots = (await withDbRetry(
    () => sql`
      SELECT entry_time,
             vix, vix1d, vix9d, vvix, vix1d_vix_ratio, vix_vix9d_ratio,
             regime_zone, cluster_mult, dow_mult_hl, dow_label,
             spx_open, sigma, hours_remaining,
             ic_ceiling, put_spread_ceiling, call_spread_ceiling,
             opening_range_signal, opening_range_pct_consumed, is_event_day
      FROM market_snapshots
      WHERE date = ${dateStr}
      ORDER BY id ASC
    `,
    2,
    10_000,
  )) as (SnapshotRow & { entry_time: string })[];

  const s = pickFeatureSnapshot(snapshots);
  if (s) {
    features.vix = num(s.vix);
    features.vix1d = num(s.vix1d);
    features.vix9d = num(s.vix9d);
    features.vvix = num(s.vvix);
    features.vix1d_vix_ratio = num(s.vix1d_vix_ratio);
    features.vix_vix9d_ratio = num(s.vix_vix9d_ratio);
    features.regime_zone = s.regime_zone;
    features.cluster_mult = num(s.cluster_mult);
    features.dow_mult = num(s.dow_mult_hl);
    features.dow_label = s.dow_label;
    features.spx_open = num(s.spx_open);
    features.sigma = num(s.sigma);
    features.hours_remaining = num(s.hours_remaining);
    features.ic_ceiling = num(s.ic_ceiling);
    features.put_spread_ceiling = num(s.put_spread_ceiling);
    features.call_spread_ceiling = num(s.call_spread_ceiling);
    features.opening_range_signal = s.opening_range_signal;
    features.opening_range_pct_consumed = num(s.opening_range_pct_consumed);
    // The flag is the date's, not the sampled row's: bool_or over every row,
    // which is NULL only when no row carries a flag. A row saved before the
    // event lookup could name the day stays false while a later one is true.
    const eventFlags = snapshots
      .map((row) => row.is_event_day)
      .filter((flag) => flag != null);
    features.is_event_day =
      eventFlags.length > 0 ? eventFlags.includes(true) : null;
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
  await engineerPhase2Features(sql, dateStr, features);

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

  features.feature_completeness = computeCompleteness(features);

  return features;
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

    // Determine which dates to process
    let dates: string[];

    if (dateParam != null) {
      // Explicit single-date mode - highest precedence. Used for
      // refetching one day after a cron miss or freshness investigation.
      dates = [dateParam];
      log.info({ date: dateParam }, 'build-features: single-date mode');
    } else if (backfill) {
      // Process all historical dates with flow data
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

    for (const dateStr of dates) {
      try {
        const features = await buildFeaturesForDate(dateStr);
        if (features) {
          await upsertFeatures(features);
          featuresBuilt++;
          latestCompleteness = features.feature_completeness as
            | number
            | undefined;
        }

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

    log.info(
      { dates: dates.length, featuresBuilt, labelsExtracted, errors },
      'build-features: completed',
    );

    return {
      // Every date failing is 'error' (red Sentry monitor), not 'partial';
      // no dates to process is 'success'.
      status: deriveCronStatus(errors, dates.length),
      metadata: {
        dates: dates.length,
        featuresBuilt,
        labelsExtracted,
        errors,
        completeness: latestCompleteness,
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
