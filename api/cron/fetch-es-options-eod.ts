/**
 * GET /api/cron/fetch-es-options-eod
 *
 * Runs at 5:00 PM CT (22:00 UTC) on weekdays. Verifies that the sidecar
 * has written EOD Statistics data (OI, settlement, IV, delta) into
 * futures_options_daily for today. Computes derived metrics: ES options
 * max pain and OI concentration ratios. Alerts via Sentry if data is
 * missing.
 *
 * The sidecar writes Statistics data to futures_options_daily as it
 * arrives from Databento. This cron job does NOT fetch data itself --
 * it validates the sidecar's output and computes derived metrics.
 *
 * Schedule: 0 22 * * 1-5
 *
 * Environment: CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

// ── Max pain computation ────────────────────────────────────

interface StrikeOI {
  strike: number;
  callOi: number;
  putOi: number;
}

/**
 * Compute max pain: the strike price where total option holder
 * losses are maximized (i.e., where most options expire worthless).
 */
function computeMaxPain(strikes: StrikeOI[]): number | null {
  if (strikes.length === 0) return null;

  let minPain = Infinity;
  let maxPainStrike = strikes[0]!.strike;

  for (const candidate of strikes) {
    let totalPain = 0;

    for (const s of strikes) {
      // Call holders lose when price < strike
      if (candidate.strike < s.strike) {
        totalPain += s.callOi * (s.strike - candidate.strike);
      }
      // Put holders lose when price > strike
      if (candidate.strike > s.strike) {
        totalPain += s.putOi * (candidate.strike - s.strike);
      }
    }

    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = candidate.strike;
    }
  }

  return maxPainStrike;
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-es-options-eod',
  async (ctx): Promise<CronResult> => {
    const { logger } = ctx;
    const tradeDate = ctx.today;
    const sql = getDb();

    // 1. Verify data arrived from the sidecar
    const countRows = await sql`
      SELECT
        COUNT(*)                                           AS total_rows,
        COUNT(*) FILTER (WHERE open_interest IS NOT NULL)  AS with_oi,
        COUNT(*) FILTER (WHERE implied_vol IS NOT NULL)    AS with_iv,
        COUNT(*) FILTER (WHERE delta IS NOT NULL)          AS with_delta,
        COUNT(DISTINCT strike)                             AS unique_strikes,
        COUNT(DISTINCT option_type)                        AS option_types
      FROM futures_options_daily
      WHERE underlying = 'ES'
        AND trade_date = ${tradeDate}
    `;

    const stats = countRows[0]!;
    const totalRows = Number.parseInt(String(stats.total_rows), 10);

    if (totalRows === 0) {
      Sentry.captureMessage(
        `ES options EOD data missing for ${tradeDate}: no rows in futures_options_daily`,
        'warning',
      );
      logger.warn(
        { tradeDate },
        'No ES options EOD data found -- sidecar may not have delivered',
      );
      return {
        status: 'skipped',
        message: 'No EOD data from sidecar',
        metadata: {
          job: 'fetch-es-options-eod',
          skipped: true,
          reason: 'No EOD data from sidecar',
          tradeDate,
        },
      };
    }

    // 2. Compute OI concentration ratios
    const oiByStrike = await sql`
      SELECT
        strike,
        option_type,
        COALESCE(open_interest, 0) AS oi
      FROM futures_options_daily
      WHERE underlying = 'ES'
        AND trade_date = ${tradeDate}
        AND open_interest IS NOT NULL
      ORDER BY strike
    `;

    // Aggregate call and put OI by strike
    const strikeMap = new Map<number, { callOi: number; putOi: number }>();
    let totalCallOi = 0;
    let totalPutOi = 0;

    for (const row of oiByStrike) {
      const strike = Number.parseFloat(String(row.strike));
      const oi = Number.parseInt(String(row.oi), 10);
      const entry = strikeMap.get(strike) ?? { callOi: 0, putOi: 0 };

      if (row.option_type === 'C') {
        entry.callOi += oi;
        totalCallOi += oi;
      } else {
        entry.putOi += oi;
        totalPutOi += oi;
      }
      strikeMap.set(strike, entry);
    }

    // Build strike array for max pain
    const strikes: StrikeOI[] = Array.from(strikeMap.entries()).map(
      ([strike, oi]) => ({
        strike,
        callOi: oi.callOi,
        putOi: oi.putOi,
      }),
    );

    const maxPain = computeMaxPain(strikes);

    // OI concentration: max single-strike OI / total OI
    let maxCallStrike = 0;
    let maxCallOi = 0;
    let maxPutStrike = 0;
    let maxPutOi = 0;

    for (const [strike, oi] of strikeMap) {
      if (oi.callOi > maxCallOi) {
        maxCallOi = oi.callOi;
        maxCallStrike = strike;
      }
      if (oi.putOi > maxPutOi) {
        maxPutOi = oi.putOi;
        maxPutStrike = strike;
      }
    }

    const callConcentration = totalCallOi > 0 ? maxCallOi / totalCallOi : 0;
    const putConcentration = totalPutOi > 0 ? maxPutOi / totalPutOi : 0;

    logger.info(
      {
        tradeDate,
        totalRows,
        withOi: Number.parseInt(String(stats.with_oi), 10),
        withIv: Number.parseInt(String(stats.with_iv), 10),
        withDelta: Number.parseInt(String(stats.with_delta), 10),
        uniqueStrikes: Number.parseInt(String(stats.unique_strikes), 10),
        maxPain,
        maxCallStrike,
        callConcentration: callConcentration.toFixed(4),
        maxPutStrike,
        putConcentration: putConcentration.toFixed(4),
        totalCallOi,
        totalPutOi,
      },
      'ES options EOD verification complete',
    );

    const uniqueStrikes = Number.parseInt(String(stats.unique_strikes), 10);
    const oiConcentration = {
      call: {
        strike: maxCallStrike,
        oi: maxCallOi,
        ratio: Number.parseFloat(callConcentration.toFixed(4)),
      },
      put: {
        strike: maxPutStrike,
        oi: maxPutOi,
        ratio: Number.parseFloat(putConcentration.toFixed(4)),
      },
    };

    return {
      status: 'success',
      metadata: {
        tradeDate,
        totalRows,
        uniqueStrikes,
        maxPain,
        oiConcentration,
        totalCallOi,
        totalPutOi,
      },
    };
  },
  { marketHours: false, requireApiKey: false },
);
