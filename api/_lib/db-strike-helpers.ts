// ── Per-Strike Greek Exposure (0DTE naive gamma/charm profile) ──

import { getDb } from './db.js';

// Re-export Claude-facing formatters from their new home
// (api/_lib/db-strike-formatters.ts). Kept here as a barrel so existing
// callers and tests don't churn — see Phase 5f of
// docs/superpowers/specs/api-refactor-2026-05-02.md.
export {
  formatAllExpiryStrikesForClaude,
  formatGreekFlowForClaude,
  formatNetGexHeatmapForClaude,
  formatStrikeExposuresForClaude,
  formatZeroGammaForClaude,
} from './db-strike-formatters.js';

/**
 * Sentinel value for all-expiry aggregate rows in strike_exposures.
 * Distinguishes rows that aggregate across all expirations from
 * rows for a specific expiry date.
 */
const ALL_EXPIRY_SENTINEL = '1970-01-01';

export interface StrikeExposureRow {
  strike: number;
  price: number;
  timestamp: string;
  netGamma: number;
  netCharm: number;
  netDelta: number;
  callGammaOi: number;
  putGammaOi: number;
  callCharmOi: number;
  putCharmOi: number;
  // Directionalized (ask/bid) — approximates confirmed MM exposure
  dirGamma: number; // sum of call_gamma_ask + call_gamma_bid + put_gamma_ask + put_gamma_bid
  dirCharm: number;
}

/** Map a raw DB row to a StrikeExposureRow. */
function mapStrikeRow(r: Record<string, unknown>): StrikeExposureRow {
  const callGOi = Number(r.call_gamma_oi) || 0;
  const putGOi = Number(r.put_gamma_oi) || 0;
  const callCOi = Number(r.call_charm_oi) || 0;
  const putCOi = Number(r.put_charm_oi) || 0;

  return {
    strike: Number(r.strike),
    price: Number(r.price),
    timestamp: r.timestamp as string,
    netGamma: callGOi + putGOi,
    netCharm: callCOi + putCOi,
    netDelta: (Number(r.call_delta_oi) || 0) + (Number(r.put_delta_oi) || 0),
    callGammaOi: callGOi,
    putGammaOi: putGOi,
    callCharmOi: callCOi,
    putCharmOi: putCOi,
    dirGamma:
      (Number(r.call_gamma_ask) || 0) +
      (Number(r.call_gamma_bid) || 0) +
      (Number(r.put_gamma_ask) || 0) +
      (Number(r.put_gamma_bid) || 0),
    dirCharm:
      (Number(r.call_charm_ask) || 0) +
      (Number(r.call_charm_bid) || 0) +
      (Number(r.put_charm_ask) || 0) +
      (Number(r.put_charm_bid) || 0),
  };
}

export interface FlowDataRow {
  timestamp: string;
  ncp: number;
  npp: number;
  netVolume: number | null;
  // OTM variants — only populated for the `zero_dte_greek_flow` source.
  // Null for all other flow sources. See migration #48.
  otmNcp: number | null;
  otmNpp: number | null;
}

/**
 * Get the most recent per-strike exposure snapshot for a given date.
 * Returns strikes ordered by strike price ascending.
 * Uses the latest timestamp available for that date.
 */
export async function getStrikeExposures(
  date: string,
  ticker: string = 'SPX',
  asOf?: string,
): Promise<StrikeExposureRow[]> {
  const db = getDb();

  // Find the latest timestamp for this date (optionally capped by asOf)
  const tsRows = asOf
    ? await db`
        SELECT MAX(timestamp) as latest_ts
        FROM strike_exposures
        WHERE date = ${date} AND ticker = ${ticker}
          AND expiry != ${ALL_EXPIRY_SENTINEL}
          AND timestamp <= ${asOf}
      `
    : await db`
        SELECT MAX(timestamp) as latest_ts
        FROM strike_exposures
        WHERE date = ${date} AND ticker = ${ticker} AND expiry != ${ALL_EXPIRY_SENTINEL}
      `;
  const latestTs = tsRows[0]?.latest_ts;
  if (!latestTs) return [];

  const rows = await db`
    SELECT strike, price, timestamp,
           call_gamma_oi, put_gamma_oi,
           call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
           call_charm_oi, put_charm_oi,
           call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
           call_delta_oi, put_delta_oi,
           call_vanna_oi, put_vanna_oi
    FROM strike_exposures
    WHERE date = ${date} AND ticker = ${ticker} AND timestamp = ${latestTs} AND expiry != ${ALL_EXPIRY_SENTINEL}
    ORDER BY strike ASC
  `;

  return rows.map(mapStrikeRow);
}

/**
 * Get the most recent per-strike exposure snapshot for a specific DTE.
 * @param date - Trading date (YYYY-MM-DD)
 * @param expiryMode - '0dte' filters to expiry = date; '1dte' filters to expiry > date and expiry <= date + 3 days
 */
export async function getStrikeExposuresByExpiry(
  date: string,
  expiryMode: '0dte' | '1dte',
  ticker: string = 'SPX',
): Promise<StrikeExposureRow[]> {
  const db = getDb();

  // Find the latest timestamp for this date + expiry filter
  const tsRows =
    expiryMode === '0dte'
      ? await db`
          SELECT MAX(timestamp) as latest_ts
          FROM strike_exposures
          WHERE date = ${date} AND ticker = ${ticker} AND expiry = ${date}
        `
      : await db`
          SELECT MAX(timestamp) as latest_ts
          FROM strike_exposures
          WHERE date = ${date} AND ticker = ${ticker}
            AND expiry > ${date}
            AND expiry <= (${date}::date + INTERVAL '3 days')::date
        `;
  const latestTs = tsRows[0]?.latest_ts;
  if (!latestTs) return [];

  const rows =
    expiryMode === '0dte'
      ? await db`
          SELECT strike, price, timestamp,
                 call_gamma_oi, put_gamma_oi,
                 call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
                 call_charm_oi, put_charm_oi,
                 call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
                 call_delta_oi, put_delta_oi,
                 call_vanna_oi, put_vanna_oi
          FROM strike_exposures
          WHERE date = ${date} AND ticker = ${ticker}
            AND timestamp = ${latestTs} AND expiry = ${date}
          ORDER BY strike ASC
        `
      : await db`
          SELECT strike, price, timestamp,
                 call_gamma_oi, put_gamma_oi,
                 call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
                 call_charm_oi, put_charm_oi,
                 call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
                 call_delta_oi, put_delta_oi,
                 call_vanna_oi, put_vanna_oi
          FROM strike_exposures
          WHERE date = ${date} AND ticker = ${ticker}
            AND timestamp = ${latestTs}
            AND expiry > ${date}
            AND expiry <= (${date}::date + INTERVAL '3 days')::date
          ORDER BY strike ASC
        `;

  return rows.map(mapStrikeRow);
}

// ── All-Expiry Strike Exposure Helpers ───────────────────────

// Uses the same StrikeExposureRow interface as the 0DTE helpers.

/**
 * Get the most recent all-expiry per-strike exposure snapshot for a given date.
 * Returns strikes ordered by strike price ascending.
 */
export async function getAllExpiryStrikeExposures(
  date: string,
  ticker: string = 'SPX',
  asOf?: string,
): Promise<StrikeExposureRow[]> {
  const db = getDb();

  // Find the latest timestamp for all-expiry rows on this date (optionally capped by asOf)
  const tsRows = asOf
    ? await db`
        SELECT MAX(timestamp) as latest_ts
        FROM strike_exposures
        WHERE date = ${date} AND ticker = ${ticker}
          AND expiry = ${ALL_EXPIRY_SENTINEL}
          AND timestamp <= ${asOf}
      `
    : await db`
        SELECT MAX(timestamp) as latest_ts
        FROM strike_exposures
        WHERE date = ${date} AND ticker = ${ticker} AND expiry = ${ALL_EXPIRY_SENTINEL}
      `;
  const latestTs = tsRows[0]?.latest_ts;
  if (!latestTs) return [];

  const rows = await db`
    SELECT strike, price, timestamp,
           call_gamma_oi, put_gamma_oi,
           call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
           call_charm_oi, put_charm_oi,
           call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
           call_delta_oi, put_delta_oi,
           call_vanna_oi, put_vanna_oi
    FROM strike_exposures
    WHERE date = ${date} AND ticker = ${ticker}
      AND timestamp = ${latestTs}
      AND expiry = ${ALL_EXPIRY_SENTINEL}
    ORDER BY strike ASC
  `;

  return rows.map((r) => {
    const callGOi = Number(r.call_gamma_oi) || 0;
    const putGOi = Number(r.put_gamma_oi) || 0;
    const callCOi = Number(r.call_charm_oi) || 0;
    const putCOi = Number(r.put_charm_oi) || 0;

    return {
      strike: Number(r.strike),
      price: Number(r.price),
      timestamp: r.timestamp as string,
      netGamma: callGOi + putGOi,
      netCharm: callCOi + putCOi,
      netDelta: (Number(r.call_delta_oi) || 0) + (Number(r.put_delta_oi) || 0),
      callGammaOi: callGOi,
      putGammaOi: putGOi,
      callCharmOi: callCOi,
      putCharmOi: putCOi,
      dirGamma:
        (Number(r.call_gamma_ask) || 0) +
        (Number(r.call_gamma_bid) || 0) +
        (Number(r.put_gamma_ask) || 0) +
        (Number(r.put_gamma_bid) || 0),
      dirCharm:
        (Number(r.call_charm_ask) || 0) +
        (Number(r.call_charm_bid) || 0) +
        (Number(r.put_charm_ask) || 0) +
        (Number(r.put_charm_bid) || 0),
    };
  });
}

// ── Net GEX Heatmap (strike_exposures — live spot data) ─────────────────────

export interface NetGexRow {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
  absGex: number;
  callGexFraction: number | null;
  netDelta: number;
  netCharm: number;
}

function mapNetGexRow(r: Record<string, unknown>): NetGexRow {
  const callGex = Number(r.call_gamma_oi) || 0;
  const putGex = Number(r.put_gamma_oi) || 0;
  const netGex = callGex + putGex;
  const absGex = Math.abs(callGex) + Math.abs(putGex);
  return {
    strike: Number(r.strike),
    callGex,
    putGex,
    netGex,
    absGex,
    callGexFraction: absGex > 0 ? callGex / absGex : null,
    netDelta: (Number(r.call_delta_oi) || 0) + (Number(r.put_delta_oi) || 0),
    netCharm: (Number(r.call_charm_oi) || 0) + (Number(r.put_charm_oi) || 0),
  };
}

/**
 * Fetch the latest 0DTE per-strike net GEX snapshot from strike_exposures.
 * Uses the most recent intraday timestamp for the given date (same pattern
 * as getStrikeExposures). Derived fields (netGex, absGex, callGexFraction)
 * are computed from the raw call_gamma_oi / put_gamma_oi columns.
 */
export async function getNetGexHeatmap(date: string): Promise<NetGexRow[]> {
  const db = getDb();

  const tsRows = await db`
    SELECT MAX(timestamp) AS latest_ts
    FROM strike_exposures
    WHERE date = ${date} AND ticker = 'SPX' AND expiry = ${date}
  `;
  const latestTs = tsRows[0]?.latest_ts;
  if (!latestTs) return [];

  const rows = await db`
    SELECT strike, call_gamma_oi, put_gamma_oi,
           call_delta_oi, put_delta_oi,
           call_charm_oi, put_charm_oi
    FROM strike_exposures
    WHERE date = ${date} AND ticker = 'SPX'
      AND expiry = ${date} AND timestamp = ${latestTs}
    ORDER BY strike ASC
  `;
  return rows.map(mapNetGexRow);
}
