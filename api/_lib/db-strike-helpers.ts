// ── Per-Strike Greek Exposure (0DTE naive gamma/charm profile) ──

import { getDb } from './db.js';

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

/**
 * Get the most recent per-strike exposure snapshot for a given date.
 * Returns strikes ordered by strike price ascending.
 * Uses the latest timestamp available for that date.
 */
export async function getStrikeExposures(
  date: string,
  ticker: string = 'SPX',
): Promise<StrikeExposureRow[]> {
  const db = getDb();

  // Find the latest timestamp for this date
  const tsRows = await db`
    SELECT MAX(timestamp) as latest_ts
    FROM strike_exposures
    WHERE date = ${date} AND ticker = ${ticker}
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
    WHERE date = ${date} AND ticker = ${ticker} AND timestamp = ${latestTs}
    ORDER BY strike ASC
  `;

  return rows.map((r: Record<string, unknown>) => {
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

/**
 * Format per-strike exposure data as a structured text block for Claude's context.
 * Identifies key structural features: gamma walls, charm floors/ceilings, acceleration zones.
 * Presents a compact strike table around ATM.
 *
 * @param rows - Strike exposure rows ordered by strike ascending
 * @returns Formatted text block, or null if no data
 */
export function formatStrikeExposuresForClaude(
  rows: StrikeExposureRow[],
): string | null {
  if (rows.length === 0) return null;

  const price = rows[0]!.price;
  const timestamp = rows[0]!.timestamp;

  const time = new Date(timestamp).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const lines: string[] = [];

  lines.push(
    `SPX 0DTE Per-Strike Greek Profile (from API, ${time} ET):`,
    `  ATM: ${price}`,
    '',
  );

  // ── Identify key structural features ──────────────────────

  // Sort by net gamma to find walls and danger zones
  const positiveGamma = rows
    .filter((r) => r.netGamma > 0)
    .sort((a, b) => b.netGamma - a.netGamma);
  const negativeGamma = rows
    .filter((r) => r.netGamma < 0)
    .sort((a, b) => a.netGamma - b.netGamma);

  // Top gamma walls (positive)
  const topWalls = positiveGamma.slice(0, 5);
  // Worst acceleration zones (negative)
  const topDanger = negativeGamma.slice(0, 5);

  // Charm extremes
  const sortedByCharm = [...rows].sort((a, b) => b.netCharm - a.netCharm);
  const charmFloors = sortedByCharm.slice(0, 3); // highest positive charm
  const charmCeilings = sortedByCharm.slice(-3).reverse(); // deepest negative charm

  // Charm slope analysis
  const belowAtm = rows.filter((r) => r.strike < price - 10);
  const aboveAtm = rows.filter((r) => r.strike > price + 10);
  const avgCharmBelow =
    belowAtm.length > 0
      ? belowAtm.reduce((s, r) => s + r.netCharm, 0) / belowAtm.length
      : 0;
  const avgCharmAbove =
    aboveAtm.length > 0
      ? aboveAtm.reduce((s, r) => s + r.netCharm, 0) / aboveAtm.length
      : 0;

  let charmPattern: string;
  if (avgCharmBelow > 0 && avgCharmAbove < 0) {
    charmPattern =
      'CCS-CONFIRMING — positive charm below ATM (walls strengthen), negative above (walls decay)';
  } else if (avgCharmBelow < 0 && avgCharmAbove > 0) {
    charmPattern =
      'PCS-CONFIRMING — negative charm below ATM (walls decay), positive above (walls strengthen)';
  } else if (avgCharmBelow < 0 && avgCharmAbove < 0) {
    charmPattern =
      'ALL-NEGATIVE — trending day, no structural anchor holds. Morning-only trading.';
  } else if (avgCharmBelow > 0 && avgCharmAbove > 0) {
    charmPattern =
      'ALL-POSITIVE — unusual, all walls strengthening. Strongly favors IC.';
  } else {
    charmPattern = 'MIXED — no clear directional charm pattern';
  }

  // ── Key Features section ──────────────────────────────────

  lines.push('  Key Structural Features:');

  if (topWalls.length > 0) {
    lines.push('    Gamma Walls (positive — price suppression):');
    for (const w of topWalls) {
      const loc =
        w.strike < price
          ? `${Math.round(price - w.strike)} pts below`
          : `${Math.round(w.strike - price)} pts above`;
      lines.push(
        `      ${w.strike} (${loc}): γ ${fmtStrike(w.netGamma)} | charm ${fmtStrike(w.netCharm)} (${w.netCharm > 0 ? 'strengthens' : 'decays'})`,
      );
    }
  }

  if (topDanger.length > 0) {
    lines.push('    Acceleration Zones (negative gamma — price acceleration):');
    for (const d of topDanger) {
      const loc =
        d.strike < price
          ? `${Math.round(price - d.strike)} pts below`
          : `${Math.round(d.strike - price)} pts above`;
      lines.push(
        `      ${d.strike} (${loc}): γ ${fmtStrike(d.netGamma)} | charm ${fmtStrike(d.netCharm)}`,
      );
    }
  }

  lines.push('', `  Charm Pattern: ${charmPattern}`);

  if (charmFloors.length > 0) {
    const floor = charmFloors[0]!;
    lines.push(
      `  Charm Floor: ${floor.strike} at ${fmtStrike(floor.netCharm)} — strongest time-based support`,
    );
  }
  if (charmCeilings.length > 0) {
    const ceil = charmCeilings[0]!;
    lines.push(
      `  Charm Ceiling: ${ceil.strike} at ${fmtStrike(ceil.netCharm)} — strongest time-based resistance`,
    );
  }

  // ── Strike Table (±100 pts from ATM, every row) ───────────

  const nearAtm = rows.filter(
    (r) => r.strike >= price - 100 && r.strike <= price + 100,
  );

  if (nearAtm.length > 0) {
    lines.push(
      '',
      '  Per-Strike Profile (ATM ±100 pts):',
      '    Strike | Net Gamma    | Net Charm    | Dir Gamma    | Dir Charm',
    );

    for (const r of nearAtm) {
      const marker = Math.abs(r.strike - price) < 3 ? ' ← ATM' : '';
      lines.push(
        `    ${r.strike.toString().padStart(6)} | ${fmtStrike(r.netGamma).padStart(12)} | ${fmtStrike(r.netCharm).padStart(12)} | ${fmtStrike(r.dirGamma).padStart(12)} | ${fmtStrike(r.dirCharm).padStart(12)}${marker}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Format a per-strike Greek value for display.
 * These can range from tiny to billions depending on the Greek and scale.
 */
function fmtStrike(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1_000_000_000)
    return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `${sign}${abs.toFixed(0)}`;
  return `${sign}${abs.toFixed(2)}`;
}
