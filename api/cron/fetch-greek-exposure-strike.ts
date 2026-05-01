/**
 * GET /api/cron/fetch-greek-exposure-strike
 *
 * Fetches per-strike Greek Exposure for SPX 0DTE from Unusual Whales API.
 * One call per invocation:
 *   1. By-strike-expiry endpoint → call/put GEX, delta, charm, vanna per strike
 *
 * Computed columns stored alongside raw values:
 *   net_gex   = call_gex + put_gex
 *   net_delta = call_delta + put_delta
 *   net_charm = call_charm + put_charm
 *   net_vanna = call_vanna + put_vanna
 *   abs_gex   = |call_gex| + |put_gex|
 *   call_gex_fraction = abs_gex > 0 ? call_gex / abs_gex : null
 *
 * Strikes with both call_gex = '0.0000' AND put_gex = '0.0000' are
 * filtered (zero-OI, no useful signal).
 *
 * UNIQUE constraint: (date, expiry, strike) — uses ON CONFLICT DO UPDATE.
 *
 * Total API calls per invocation: 1
 *
 * Schedule: once daily at 13:30 UTC (8:30 AM CT, market open) — static
 * endpoint returns a frozen daily snapshot that does not tick intraday.
 * For live intraday GEX, see fetch-strike-exposure.ts (spot-exposures).
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

// ── Types ────────────────────────────────────────────────────

interface StrikeRow {
  date: string;
  expiry: string;
  strike: string;
  dte: number;
  call_gex: string;
  put_gex: string;
  call_delta: string;
  put_delta: string;
  call_charm: string;
  put_charm: string;
  call_vanna: string;
  put_vanna: string;
}

// ── Computed columns ─────────────────────────────────────────

function computeColumns(row: StrikeRow) {
  const callGex = Number.parseFloat(row.call_gex);
  const putGex = Number.parseFloat(row.put_gex);
  const netGex = callGex + putGex;
  const netDelta =
    Number.parseFloat(row.call_delta) + Number.parseFloat(row.put_delta);
  const netCharm =
    Number.parseFloat(row.call_charm) + Number.parseFloat(row.put_charm);
  const netVanna =
    Number.parseFloat(row.call_vanna) + Number.parseFloat(row.put_vanna);
  const absGex = Math.abs(callGex) + Math.abs(putGex);
  const callGexFraction = absGex > 0 ? callGex / absGex : null;

  return { netGex, netDelta, netCharm, netVanna, absGex, callGexFraction };
}

// ── Store helper ─────────────────────────────────────────────

async function storeStrikeRows(
  rows: StrikeRow[],
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const { netGex, netDelta, netCharm, netVanna, absGex, callGexFraction } =
        computeColumns(row);

      const result = await sql`
        INSERT INTO greek_exposure_strike (
          date, expiry, strike, dte,
          call_gex, put_gex, call_delta, put_delta,
          call_charm, put_charm, call_vanna, put_vanna,
          net_gex, net_delta, net_charm, net_vanna,
          abs_gex, call_gex_fraction
        )
        VALUES (
          ${row.date}, ${row.expiry}, ${row.strike}, ${row.dte},
          ${row.call_gex}, ${row.put_gex},
          ${row.call_delta}, ${row.put_delta},
          ${row.call_charm}, ${row.put_charm},
          ${row.call_vanna}, ${row.put_vanna},
          ${netGex}, ${netDelta}, ${netCharm}, ${netVanna},
          ${absGex}, ${callGexFraction}
        )
        ON CONFLICT (date, expiry, strike) DO UPDATE SET
          dte               = EXCLUDED.dte,
          call_gex          = EXCLUDED.call_gex,
          put_gex           = EXCLUDED.put_gex,
          call_delta        = EXCLUDED.call_delta,
          put_delta         = EXCLUDED.put_delta,
          call_charm        = EXCLUDED.call_charm,
          put_charm         = EXCLUDED.put_charm,
          call_vanna        = EXCLUDED.call_vanna,
          put_vanna         = EXCLUDED.put_vanna,
          net_gex           = EXCLUDED.net_gex,
          net_delta         = EXCLUDED.net_delta,
          net_charm         = EXCLUDED.net_charm,
          net_vanna         = EXCLUDED.net_vanna,
          abs_gex           = EXCLUDED.abs_gex,
          call_gex_fraction = EXCLUDED.call_gex_fraction
        RETURNING strike
      `;
      if (result.length > 0) stored++;
      else skipped++;
    } catch (err) {
      logger.warn(
        { err, strike: row.strike },
        'Greek exposure strike insert failed',
      );
      skipped++;
    }
  }

  return { stored, skipped };
}

// ── Handler ──────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-greek-exposure-strike',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today } = ctx;

    const path = `/stock/SPX/greek-exposure/strike-expiry?date=${today}&expiry=${today}`;
    const allRows = await withRetry(() =>
      uwFetch<StrikeRow>(apiKey, path, (body) => body.data as StrikeRow[]),
    );

    // Filter zero-OI strikes (no useful signal)
    const rows = allRows.filter(
      (r) => !(r.call_gex === '0.0000' && r.put_gex === '0.0000'),
    );

    const skippedZero = allRows.length - rows.length;

    ctx.logger.info(
      { fetched: allRows.length, afterFilter: rows.length, skippedZero },
      'fetch-greek-exposure-strike: rows fetched',
    );

    const { stored, skipped } = await withRetry(() => storeStrikeRows(rows));

    // Sanity check: log net GEX at largest absolute GEX strike
    if (rows.length > 0) {
      const largest = rows.reduce((best, r) => {
        const a =
          Math.abs(Number.parseFloat(r.call_gex)) +
          Math.abs(Number.parseFloat(r.put_gex));
        const b =
          Math.abs(Number.parseFloat(best.call_gex)) +
          Math.abs(Number.parseFloat(best.put_gex));
        return a > b ? r : best;
      }, rows[0]!);
      const { netGex } = computeColumns(largest);
      ctx.logger.info(
        { strike: largest.strike, netGex: Math.round(netGex) },
        'Largest-magnitude strike net GEX',
      );
    }

    ctx.logger.info(
      { fetched: allRows.length, stored, skipped },
      'fetch-greek-exposure-strike completed',
    );

    // Data quality check
    const qcRows = await getDb()`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (
               WHERE net_gex IS NOT NULL AND net_gex != 0
             ) AS nonzero
      FROM greek_exposure_strike
      WHERE date = ${today} AND expiry = ${today}
    `;
    const { total: qcTotal, nonzero: qcNonzero } = qcRows[0]!;
    await checkDataQuality({
      job: 'fetch-greek-exposure-strike',
      table: 'greek_exposure_strike',
      date: today,
      total: Number(qcTotal),
      nonzero: Number(qcNonzero),
      minRows: 10,
    });

    return {
      status: 'success',
      metadata: {
        fetched: allRows.length,
        stored,
        skipped,
      },
    };
  },
);
