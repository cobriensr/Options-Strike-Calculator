/**
 * OI Change data access and Claude formatting.
 *
 * Fetches daily OI change data from the oi_changes table and formats
 * it as structured context for Claude's analysis.
 */

import { getDb } from './db.js';

// ── Types ───────────────────────────────────────────────────

export interface OiChangeRow {
  date: string;
  optionSymbol: string;
  strike: number;
  isCall: boolean;
  oiDiff: number;
  currOi: number;
  lastOi: number;
  avgPrice: number;
  prevAskVolume: number;
  prevBidVolume: number;
  prevMultiLegVolume: number;
  prevTotalPremium: number;
}

// ── Fetch ────────────────────────────────────────────────────

/**
 * Get OI change rows for a given date, ordered by absolute OI diff.
 * Returns the top 30 most significant changes.
 */
export async function getOiChangeData(date: string): Promise<OiChangeRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT date, option_symbol, strike, is_call,
           oi_diff, curr_oi, last_oi, avg_price,
           prev_ask_volume, prev_bid_volume,
           prev_multi_leg_volume, prev_total_premium
    FROM oi_changes
    WHERE date = ${date}
    ORDER BY ABS(oi_diff) DESC
    LIMIT 30
  `;

  return rows.map((r) => ({
    date: r.date as string,
    optionSymbol: r.option_symbol as string,
    strike: Number(r.strike),
    isCall: r.is_call as boolean,
    oiDiff: Number(r.oi_diff),
    currOi: Number(r.curr_oi),
    lastOi: Number(r.last_oi),
    avgPrice: Number(r.avg_price),
    prevAskVolume: Number(r.prev_ask_volume),
    prevBidVolume: Number(r.prev_bid_volume),
    prevMultiLegVolume: Number(r.prev_multi_leg_volume),
    prevTotalPremium: Number(r.prev_total_premium),
  }));
}

// ── Format for Claude ────────────────────────────────────────

/**
 * Format OI change data as a structured text block for Claude's context.
 *
 * Includes summary stats, aggressor direction, multi-leg percentage,
 * and a top-10 contracts table with distance from ATM when available.
 *
 * @param rows - OI change rows (ordered by absolute OI diff descending)
 * @param currentSpx - Current SPX price for distance calculation
 * @returns Formatted text block, or null if no rows
 */
export function formatOiChangeForClaude(
  rows: OiChangeRow[],
  currentSpx?: number,
): string | null {
  if (rows.length === 0) return null;

  const lines: string[] = [];

  // ── Summary stats ──────────────────────────────────────
  let netCallOi = 0;
  let netPutOi = 0;
  let callPremium = 0;
  let putPremium = 0;
  let totalAskVol = 0;
  let totalBidVol = 0;
  let totalMultiLeg = 0;
  let totalVolume = 0;

  for (const row of rows) {
    if (row.isCall) {
      netCallOi += row.oiDiff;
      callPremium += row.prevTotalPremium;
    } else {
      netPutOi += row.oiDiff;
      putPremium += row.prevTotalPremium;
    }
    totalAskVol += row.prevAskVolume;
    totalBidVol += row.prevBidVolume;
    totalMultiLeg += row.prevMultiLegVolume;
    totalVolume +=
      row.prevAskVolume + row.prevBidVolume + row.prevMultiLegVolume;
  }

  const netPremium = callPremium + putPremium;

  lines.push(
    `SPX OI Change Analysis (from API — prior day positioning):`,
    `  Total: ${rows.length} contracts with meaningful OI changes`,
    `  Net OI Change: ${fmtSigned(netCallOi)} calls, ${fmtSigned(netPutOi)} puts`,
    `  Net Premium: ${fmtPremium(netPremium)} (calls ${fmtPremium(callPremium)}, puts ${fmtPremium(putPremium)})`,
  );

  // ── Aggressor direction ────────────────────────────────
  let aggressorLabel: string;
  let aggressorNote: string;
  if (totalBidVol > 0 && totalAskVol / totalBidVol > 1.5) {
    aggressorLabel = 'ASK-DOMINATED';
    aggressorNote = 'new positions opened aggressively';
  } else if (totalAskVol > 0 && totalBidVol / totalAskVol > 1.5) {
    aggressorLabel = 'BID-DOMINATED';
    aggressorNote = 'defensive or closing activity';
  } else {
    aggressorLabel = 'BALANCED';
    aggressorNote = 'no clear aggressor bias';
  }

  const askBidRatio =
    totalBidVol > 0 ? (totalAskVol / totalBidVol).toFixed(1) : 'INF';
  lines.push(
    `  Aggressor: ${aggressorLabel} (${askBidRatio}x ask/bid) — ${aggressorNote}`,
  );

  // ── Multi-leg percentage ───────────────────────────────
  const multiLegPct =
    totalVolume > 0 ? ((totalMultiLeg / totalVolume) * 100).toFixed(0) : '0';
  let multiLegNote: string;
  if (Number(multiLegPct) > 50) {
    multiLegNote = 'heavy institutional spread activity';
  } else if (Number(multiLegPct) > 25) {
    multiLegNote = 'moderate institutional spread activity';
  } else {
    multiLegNote = 'mostly directional or single-leg activity';
  }
  lines.push(
    `  Multi-leg: ${multiLegPct}% of volume — ${multiLegNote}`,
    '',
    '  Top Contracts by Absolute OI Change:',
  );

  const top10 = rows.slice(0, 10);
  for (const row of top10) {
    const tag = row.isCall ? 'C' : 'P';
    const oiStr = fmtSigned(row.oiDiff);
    const premStr = fmtPremium(row.prevTotalPremium);

    let askBid: string;
    if (row.prevBidVolume > 0) {
      const ratio = row.prevAskVolume / row.prevBidVolume;
      if (ratio > 1.5) {
        askBid = `ask-heavy (${ratio.toFixed(1)}x)`;
      } else if (ratio < 0.67) {
        askBid = `bid-heavy (${ratio.toFixed(1)}x)`;
      } else {
        askBid = `balanced (${ratio.toFixed(1)}x)`;
      }
    } else if (row.prevAskVolume > 0) {
      askBid = 'ask-only';
    } else {
      askBid = 'no vol data';
    }

    let distStr = '';
    if (currentSpx != null) {
      const dist = row.strike - currentSpx;
      if (Math.abs(dist) < 3) {
        distStr = ' (ATM)';
      } else if (dist > 0) {
        distStr = ` (${Math.round(dist)} pts above)`;
      } else {
        distStr = ` (${Math.round(Math.abs(dist))} pts below)`;
      }
    }

    lines.push(
      `    SPX ${row.strike}${tag}${distStr}: ${oiStr} OI | ${premStr} premium | ${askBid}`,
    );
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────

/** Format a number with +/- sign and commas. */
function fmtSigned(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toLocaleString()}`;
}

/** Format a premium value for display (e.g., 142500000 -> "$142.5M"). */
function fmtPremium(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(0)}K`;
  return `$${abs.toFixed(0)}`;
}
