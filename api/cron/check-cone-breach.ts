/**
 * GET /api/cron/check-cone-breach
 *
 * Every minute during RTH, compares the latest SPX 1-min close against
 * today's `cone_levels` row and records the FIRST breach per direction
 * per session into `cone_breach_events`. Cron repeats are idempotent
 * via UNIQUE (date, direction) — re-runs after a breach are no-ops.
 *
 * Per UW: SPX exceeding the 0DTE straddle breakeven cone tends to
 * EXTEND, not fade — short-vol sellers facing convex losses re-hedge
 * by buying back their shorts (calls on upside breaches, puts on
 * downside breaches), and that flow extends the move beyond the
 * breakeven rather than letting it fade. So the breach event is the
 * "chase the breakout, don't fade" trigger surface for /ES execution.
 *
 * Schedule: `* 13-21 * * 1-5` — every minute during the same RTH window
 * the rest of the cron fleet uses (DST-tuned UTC, M-F).
 *
 * Idempotency:
 *   - cone_breach_events has UNIQUE (date, direction). ON CONFLICT DO
 *     NOTHING means a breach in the same direction is recorded once.
 *   - The cron silently exits if today has no cone_levels row yet
 *     (compute-cone fires at 13:32 UTC; this cron starts at 13:00 UTC
 *     so there's a 32-minute window where it correctly does nothing).
 *
 * Spec: docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md
 *       (Phase 1 — cone breach detection)
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

interface ConeRow {
  cone_upper: string | number;
  cone_lower: string | number;
}

interface SpotRow {
  close: string | number;
  timestamp: string | Date;
}

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export default withCronInstrumentation(
  'check-cone-breach',
  async (ctx): Promise<CronResult> => {
    const { today, logger } = ctx;
    const sql = getDb();

    const coneRows = (await withDbRetry(
      () => sql`
        SELECT cone_upper, cone_lower
        FROM cone_levels
        WHERE date = ${today}
        LIMIT 1
      `,
      2,
      10_000,
    )) as ConeRow[];

    if (coneRows.length === 0) {
      // compute-cone hasn't run yet today (or failed). Silent skip — the
      // pre-9:31 minutes legitimately have no cone to check against.
      return {
        status: 'skipped',
        metadata: { reason: 'no_cone_for_today' },
      };
    }

    const coneUpper = num(coneRows[0]!.cone_upper);
    const coneLower = num(coneRows[0]!.cone_lower);
    if (coneUpper == null || coneLower == null) {
      logger.warn({ today }, 'check-cone-breach: cone bounds unparseable');
      return {
        status: 'error',
        metadata: { reason: 'cone_bounds_unparseable' },
      };
    }

    const spotRows = (await withDbRetry(
      () => sql`
        SELECT close, timestamp
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND date = ${today}
        ORDER BY timestamp DESC
        LIMIT 1
      `,
      2,
      10_000,
    )) as SpotRow[];

    if (spotRows.length === 0) {
      // No SPX bar yet for today — too early in the session, or the SPX
      // candle cron hasn't filled this minute yet. Silent skip; the next
      // tick will retry.
      return {
        status: 'skipped',
        metadata: { reason: 'no_spx_bar_for_today' },
      };
    }

    const spot = num(spotRows[0]!.close);
    if (spot == null) {
      logger.warn({ today }, 'check-cone-breach: SPX close unparseable');
      return {
        status: 'error',
        metadata: { reason: 'spx_close_unparseable' },
      };
    }

    const breachTs =
      spotRows[0]!.timestamp instanceof Date
        ? spotRows[0]!.timestamp.toISOString()
        : new Date(spotRows[0]!.timestamp).toISOString();

    const round2 = (n: number): number => Math.round(n * 100) / 100;

    // Resolve which side (if any) breached. Single INSERT path keeps the
    // direction as an interpolated value, which both keeps the SQL DRY
    // and lets tests verify the chosen direction from the call args.
    let breach: {
      direction: 'upper' | 'lower';
      bound: number;
      pts: number;
    } | null = null;
    if (spot > coneUpper) {
      breach = {
        direction: 'upper',
        bound: round2(coneUpper),
        pts: round2(spot - coneUpper),
      };
    } else if (spot < coneLower) {
      breach = {
        direction: 'lower',
        bound: round2(coneLower),
        pts: round2(coneLower - spot),
      };
    }

    let recorded = false;
    if (breach != null) {
      const inserted = (await withDbRetry(
        () => sql`
          INSERT INTO cone_breach_events (
            date, direction, breach_time,
            spot_at_breach, cone_bound_at_breach, pts_past_bound
          )
          VALUES (
            ${today}, ${breach.direction}, ${breachTs},
            ${round2(spot)}, ${breach.bound}, ${breach.pts}
          )
          ON CONFLICT (date, direction) DO NOTHING
          RETURNING id
        `,
        2,
        10_000,
      )) as Array<{ id: number }>;
      if (inserted.length > 0) {
        recorded = true;
        logger.info(
          {
            today,
            direction: breach.direction,
            spot: round2(spot),
            bound: breach.bound,
            ptsPast: breach.pts,
          },
          'check-cone-breach: first breach recorded',
        );
      }
    }

    return {
      status: 'success',
      metadata: {
        date: today,
        spot: round2(spot),
        coneUpper: round2(coneUpper),
        coneLower: round2(coneLower),
        direction: breach?.direction ?? null,
        recorded,
        insideCone: breach == null,
      },
    };
  },
  { requireApiKey: false },
);
