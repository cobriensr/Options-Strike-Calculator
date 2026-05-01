/**
 * GET /api/cron/build-features
 *
 * Feature engineering cron that transforms raw intraday data into
 * daily ML feature vectors (training_features) and extracts structured
 * labels from review-mode analyses (day_labels).
 *
 * Runs ~15 min after fetch-outcomes to ensure settlement data is available.
 * On first run, backfills all historical dates. After that, only processes today.
 *
 * Feature engineering is split into focused modules:
 *   build-features-flow.ts   — flow checkpoint NCP/NPP + agreement
 *   build-features-gex.ts    — GEX, Greek exposure, per-strike features
 *   build-features-phase2.ts — prev day, realized vol, events, max pain, dark pool, options
 *   build-features-monitor.ts — IV monitor + flow ratio monitor dynamics
 *   build-features-types.ts  — shared types, constants, and helpers
 *
 * Environment: DATABASE_URL, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard } from '../_lib/api-helpers.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDayOfWeekFromDateStr,
  getETDateStr,
} from '../../src/utils/timezone.js';
import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import type {
  FeatureRow,
  SnapshotRow,
} from '../_lib/build-features-types.js';
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
import { reportCronRun } from '../_lib/axiom.js';

export const config = { maxDuration: 300 };

// ── Time window check ──────────────────────────────────────

function isPostClose(): boolean {
  const now = new Date();
  const day = getETDayOfWeek(now);
  if (day === 0 || day === 6) return false;

  // Skip market holidays — getMarketCloseHourET returns null for closed days.
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

// ── Build features for a single date ───────────────────────

async function buildFeaturesForDate(
  dateStr: string,
): Promise<FeatureRow | null> {
  const sql = getDb();
  const features: FeatureRow = { date: dateStr };

  // 1. Static features from market_snapshots
  // Prefer the earliest entry that has spx_open populated (many early/
  // pre-market snapshots store NaN before cash open). Fall back to the
  // absolute earliest if no snapshot has spx_open.
  const snapshots = await sql`
    SELECT vix, vix1d, vix9d, vvix, vix1d_vix_ratio, vix_vix9d_ratio,
           regime_zone, cluster_mult, dow_mult_hl, dow_label,
           spx_open, sigma, hours_remaining,
           ic_ceiling, put_spread_ceiling, call_spread_ceiling,
           opening_range_signal, opening_range_pct_consumed, is_event_day
    FROM market_snapshots
    WHERE date = ${dateStr}
    ORDER BY (spx_open IS NULL OR spx_open = 'NaN') ASC,
             entry_time ASC
    LIMIT 1
  `;

  if (snapshots.length > 0) {
    const s = snapshots[0] as SnapshotRow;
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
    features.is_event_day = s.is_event_day;
  }

  // Fall back to outcomes.day_open if snapshots didn't provide spx_open
  if (features.spx_open == null) {
    const fallback = await sql`
      SELECT day_open FROM outcomes WHERE date = ${dateStr} LIMIT 1
    `;
    if (fallback.length > 0 && fallback[0]!.day_open != null) {
      features.spx_open = num(fallback[0]!.day_open);
    }
  }

  // Day of week from date string. The dateStr is already an ET calendar
  // date, so the weekday is a pure property of that date — no TZ math
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
  const nopeRows = (await sql`
    SELECT timestamp, nope, call_delta, put_delta
    FROM nope_ticks
    WHERE ticker = 'SPY'
      AND (timestamp AT TIME ZONE 'America/New_York')::date = ${dateStr}
    ORDER BY timestamp ASC
  `) as NopeTickRow[];
  Object.assign(features, engineerNopeFeatures(nopeRows, dateStr));

  features.feature_completeness = computeCompleteness(features);

  return features;
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const backfill = req.query.backfill === 'true';

  // Optional `?date=YYYY-MM-DD` — process only the named date, skipping the
  // time-window check. Useful for refetching a single day after a cron miss
  // or to test freshness lag without running a blanket backfill that risks
  // hitting rolling-window API failures on older dates.
  const dateParamRaw = req.query.date;
  const dateParam = typeof dateParamRaw === 'string' ? dateParamRaw : undefined;
  if (dateParam != null && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return res
      .status(400)
      .json({ error: 'Invalid date param, expected YYYY-MM-DD' });
  }

  // Time window is bypassed for backfill OR explicit single-date requests.
  const skipTimeCheck = backfill || dateParam != null;
  const guard = cronGuard(req, res, {
    timeCheck: skipTimeCheck ? () => true : isPostClose,
    requireApiKey: false,
  });
  if (!guard) return;

  const startTime = Date.now();
  const sql = getDb();
  // Single-date and current-day runs use the tighter timeout; only blanket
  // backfill needs the long one.
  if (backfill && dateParam == null) {
    await sql`SET statement_timeout = '120000'`; // 120s per statement for backfill
  } else {
    await sql`SET statement_timeout = '30000'`; // 30s per statement
  }

  // Diagnostic: log flow_data coverage for today before doing any work
  const today = guard.today;
  const coverage = await sql`
    SELECT source, COUNT(*) as rows
    FROM flow_data
    WHERE date = ${today}
    GROUP BY source
    ORDER BY source
  `;
  logger.info({ date: today, sources: coverage }, 'flow_data coverage');

  try {
    // Determine which dates to process
    let dates: string[];

    if (dateParam != null) {
      // Explicit single-date mode — highest precedence. Used for refetching
      // one day after a cron miss or freshness investigation.
      dates = [dateParam];
      logger.info({ date: dateParam }, 'build-features: single-date mode');
    } else if (backfill) {
      // Process all historical dates with flow data
      const rows = await sql`
        SELECT DISTINCT date FROM flow_data ORDER BY date ASC
      `;
      dates = rows.map((r) => toDateStr(r.date));
    } else {
      // Check if table is empty (first run = automatic backfill)
      const countResult =
        await sql`SELECT COUNT(*) AS cnt FROM training_features`;
      const count = Number(countResult[0]!.cnt);

      if (count === 0) {
        const rows = await sql`
          SELECT DISTINCT date FROM flow_data ORDER BY date ASC
        `;
        dates = rows.map((r) => toDateStr(r.date));
        logger.info(
          { dates: dates.length },
          'build-features: empty table, backfilling all dates',
        );
      } else {
        dates = [getETDateStr(new Date())];
      }
    }

    // Filter to valid YYYY-MM-DD dates only
    dates = dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

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
        logger.warn(
          { err, date: dateStr },
          'build-features: error processing date',
        );
        errors++;
      }
    }

    logger.info(
      { dates: dates.length, featuresBuilt, labelsExtracted, errors },
      'build-features: completed',
    );

    await reportCronRun('build-features', {
      status: errors > 0 ? 'partial' : 'ok',
      dates: dates.length,
      featuresBuilt,
      labelsExtracted,
      errors,
      completeness: latestCompleteness,
      durationMs: Date.now() - startTime,
    });

    return res.status(200).json({
      job: 'build-features',
      dates: dates.length,
      featuresBuilt,
      labelsExtracted,
      errors,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'build-features');
    Sentry.captureException(err);
    logger.error({ err }, 'build-features error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
