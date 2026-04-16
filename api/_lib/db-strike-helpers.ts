// ── Per-Strike Greek Exposure (0DTE naive gamma/charm profile) ──

import { getDb } from './db.js';
import type { ZeroGammaAnalysis } from '../../src/utils/zero-gamma.js';

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

  // Gamma asymmetry: how lopsided is gamma above vs below ATM?
  const gammaAbove = rows
    .filter((r) => r.strike > price + 5)
    .reduce((s, r) => s + Math.abs(r.netGamma), 0);
  const gammaBelow = rows
    .filter((r) => r.strike < price - 5)
    .reduce((s, r) => s + Math.abs(r.netGamma), 0);
  const gammaTotal = gammaAbove + gammaBelow;
  if (gammaTotal > 0) {
    const abovePct = (gammaAbove / gammaTotal) * 100;
    const belowPct = (gammaBelow / gammaTotal) * 100;
    let asymmetrySignal: string;
    if (abovePct > 65) {
      asymmetrySignal =
        'SKEWED ABOVE — gamma concentrated above price. Upside is well-defended; downside is exposed.';
    } else if (belowPct > 65) {
      asymmetrySignal =
        'SKEWED BELOW — gamma concentrated below price. Downside is well-defended; upside is exposed.';
    } else {
      asymmetrySignal = 'BALANCED — roughly equal gamma on both sides.';
    }
    lines.push(
      `  Gamma Asymmetry: ${abovePct.toFixed(0)}% above / ${belowPct.toFixed(0)}% below ATM — ${asymmetrySignal}`,
    );
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

// ============================================================
// ADD TO END OF db.ts — ALL-EXPIRY STRIKE EXPOSURE HELPERS
// ============================================================

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

/**
 * Format all-expiry per-strike data for Claude's context.
 * Focuses on identifying multi-day gamma anchors and comparing against 0DTE profile.
 *
 * @param allRows - All-expiry strike rows
 * @param zeroDteRows - Optional 0DTE strike rows for comparison
 * @returns Formatted text block, or null if no data
 */
export function formatAllExpiryStrikesForClaude(
  allRows: StrikeExposureRow[],
  zeroDteRows?: StrikeExposureRow[],
): string | null {
  if (allRows.length === 0) return null;

  const price = allRows[0]!.price;
  const timestamp = allRows[0]!.timestamp;

  const time = new Date(timestamp).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const lines: string[] = [];

  lines.push(
    `SPX All-Expiry Per-Strike Profile (from API, ${time} ET):`,
    `  ATM: ${price}`,
    `  Includes gamma/charm from ALL expirations (0DTE + weeklies + monthly + quarterly)`,
    '',
  );

  // ── Key structural features ───────────────────────────────

  const positiveGamma = allRows
    .filter((r) => r.netGamma > 0)
    .sort((a, b) => b.netGamma - a.netGamma);
  const negativeGamma = allRows
    .filter((r) => r.netGamma < 0)
    .sort((a, b) => a.netGamma - b.netGamma);

  const topWalls = positiveGamma.slice(0, 5);
  const topDanger = negativeGamma.slice(0, 5);

  lines.push(
    '  Multi-Day Gamma Anchors (strongest walls across all expirations):',
  );
  if (topWalls.length > 0) {
    for (const w of topWalls) {
      const loc =
        w.strike < price
          ? `${Math.round(price - w.strike)} pts below`
          : `${Math.round(w.strike - price)} pts above`;
      lines.push(
        `    ${w.strike} (${loc}): γ ${fmtStrike(w.netGamma)} | charm ${fmtStrike(w.netCharm)} (${w.netCharm > 0 ? 'strengthens' : 'decays'})`,
      );
    }
  }

  if (topDanger.length > 0) {
    lines.push('  All-Expiry Acceleration Zones:');
    for (const d of topDanger) {
      const loc =
        d.strike < price
          ? `${Math.round(price - d.strike)} pts below`
          : `${Math.round(d.strike - price)} pts above`;
      lines.push(
        `    ${d.strike} (${loc}): γ ${fmtStrike(d.netGamma)} | charm ${fmtStrike(d.netCharm)}`,
      );
    }
  }

  // ── 0DTE vs All-Expiry comparison ─────────────────────────

  if (zeroDteRows && zeroDteRows.length > 0) {
    lines.push('', '  0DTE vs All-Expiry Comparison (key strikes):');

    // Find strikes that differ significantly between 0DTE and all-expiry
    const zeroDteMap = new Map(zeroDteRows.map((r) => [r.strike, r]));

    const divergences: {
      strike: number;
      zeroDteGamma: number;
      allGamma: number;
      note: string;
    }[] = [];

    for (const all of allRows) {
      const dte = zeroDteMap.get(all.strike);
      if (!dte) continue;

      // Check if 0DTE and all-expiry disagree on sign
      if (dte.netGamma > 0 && all.netGamma < 0) {
        divergences.push({
          strike: all.strike,
          zeroDteGamma: dte.netGamma,
          allGamma: all.netGamma,
          note: '0DTE wall but all-expiry danger zone — wall may fail under sustained pressure from longer-dated gamma',
        });
      } else if (dte.netGamma < 0 && all.netGamma > 0) {
        divergences.push({
          strike: all.strike,
          zeroDteGamma: dte.netGamma,
          allGamma: all.netGamma,
          note: '0DTE danger zone but all-expiry wall — longer-dated gamma provides backstop',
        });
      }
    }

    if (divergences.length > 0) {
      for (const d of divergences.slice(0, 5)) {
        lines.push(
          `    ${d.strike}: 0DTE γ ${fmtStrike(d.zeroDteGamma)} vs All γ ${fmtStrike(d.allGamma)} — ${d.note}`,
        );
      }
    } else {
      lines.push(
        '    No major sign divergences between 0DTE and all-expiry profiles — gamma structure is consistent.',
      );
    }
  }

  return lines.join('\n');
}

/**
 * Format 0DTE Greek flow data for Claude's context.
 * This source stores total_delta_flow in the ncp column and dir_delta_flow in npp.
 * The formatter relabels these appropriately since they're NOT premium flow.
 *
 * @param rows - Flow data rows from getFlowData(date, 'zero_dte_greek_flow')
 * @returns Formatted text block, or null if no data
 */
export function formatGreekFlowForClaude(rows: FlowDataRow[]): string | null {
  if (rows.length === 0) return null;

  const latest = rows.at(-1)!;
  const first = rows[0]!;

  const lines: string[] = [];

  lines.push(
    '0DTE SPX Delta Flow (from API — 5-min intervals):',
    '  Delta flow measures directional exposure being ADDED per minute via 0DTE SPX options.',
    '  When delta flow surges while premium flow (NCP) is flat, institutions are adding',
    '  directional delta through spreads/combos — higher conviction than premium alone.',
    '',
  );

  // Latest values
  const latestTime = new Date(latest.timestamp).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  lines.push(
    `  Latest (${latestTime} ET):`,
    `    Total Delta Flow: ${formatDeltaVal(latest.ncp)}`,
    `    Directionalized Delta Flow: ${formatDeltaVal(latest.npp)}`,
  );
  if (latest.otmNcp != null) {
    lines.push(
      `    OTM Total Delta Flow: ${formatDeltaVal(latest.otmNcp)}`,
      `    OTM Directionalized Delta Flow: ${formatDeltaVal(latest.otmNpp ?? 0)}`,
    );
  }
  lines.push(`    Volume: ${latest.netVolume?.toLocaleString() ?? 'N/A'}`);

  // Direction
  const deltaDir =
    latest.ncp > first.ncp
      ? 'rising (bullish delta accumulation)'
      : latest.ncp < first.ncp
        ? 'falling (bearish delta accumulation)'
        : 'flat';
  const dirDeltaDir =
    latest.npp > first.npp
      ? 'rising (intent-weighted bullish)'
      : latest.npp < first.npp
        ? 'falling (intent-weighted bearish)'
        : 'flat';

  lines.push(
    '',
    `  Direction: Total delta ${deltaDir}`,
    `  Dir delta: ${dirDeltaDir}`,
  );

  // Divergence check: total vs directionalized
  if (latest.ncp > 0 && latest.npp < 0) {
    lines.push(
      '  DIVERGENCE: Total delta positive but directionalized negative — net delta from ask-side trades is bearish despite aggregate bullish. Institutions may be selling delta at the ask.',
    );
  } else if (latest.ncp < 0 && latest.npp > 0) {
    lines.push(
      '  DIVERGENCE: Total delta negative but directionalized positive — ask-side trades are adding bullish delta despite aggregate bearish. Possible institutional accumulation.',
    );
  }

  // OTM vs total (ATM-inclusive) divergence check.
  // The total reading sums ATM + OTM delta flow. OTM alone is closer to
  // directional conviction because ATM is dominated by hedging and gamma
  // scalping. When OTM and total disagree, trust OTM.
  //
  // Four cases, evaluated in priority order:
  //   1. Sign disagreement          → OTM DIVERGENCE (strongest signal)
  //   2. |OTM| ≥ |total|            → OTM EXCEEDS TOTAL (ATM cancellation;
  //                                    subsumes the near-zero-total edge case)
  //   3. OTM share > 70% of |total| → OTM-DOMINANT (informed conviction)
  //   4. OTM share < 30% of |total| → ATM-DOMINANT (hedging dilution)
  //
  // Thresholds are tunable after live observation.
  //
  // NEAR_ZERO_DELTA is the noise floor below which we treat a value as
  // effectively zero. Typical UW 0DTE delta flow readings are in the
  // millions; anything under $100K is rounding noise that would otherwise
  // produce meaningless ratios if used as a denominator.
  const NEAR_ZERO_DELTA = 100_000;
  if (latest.otmNcp != null) {
    const absNcp = Math.abs(latest.ncp);
    const absOtm = Math.abs(latest.otmNcp);
    const totalHasMagnitude = absNcp >= NEAR_ZERO_DELTA;
    const otmHasMagnitude = absOtm >= NEAR_ZERO_DELTA;

    // Skip entirely when both are noise.
    if (totalHasMagnitude || otmHasMagnitude) {
      // 1. Sign disagreement — both sides present, opposite directions.
      if (
        totalHasMagnitude &&
        otmHasMagnitude &&
        latest.ncp > 0 &&
        latest.otmNcp < 0
      ) {
        lines.push(
          '  OTM DIVERGENCE: Total delta positive but OTM delta negative. Informed participants are positioning bearishly in the wings while aggregate is lifted by ATM activity (likely hedging). Trust OTM for directional conviction.',
        );
      } else if (
        totalHasMagnitude &&
        otmHasMagnitude &&
        latest.ncp < 0 &&
        latest.otmNcp > 0
      ) {
        lines.push(
          '  OTM DIVERGENCE: Total delta negative but OTM delta positive. Informed participants are positioning bullishly in the wings while ATM is dominated by hedging. Trust OTM for directional conviction.',
        );
      }
      // 2. |OTM| ≥ |total| — ATM hedging is cancelling OTM directional
      // exposure. This covers both the cancellation case (real total, but
      // OTM is larger in absolute terms) AND the near-zero-total edge case
      // (total is noise but OTM has real magnitude). In either case, the
      // aggregate number understates the real directional conviction.
      else if (otmHasMagnitude && absOtm >= absNcp) {
        lines.push(
          '  OTM EXCEEDS TOTAL: ATM hedging is offsetting OTM directional exposure — the aggregate reading understates the real directional conviction in the wings. Trust OTM as the honest directional read.',
        );
      }
      // 3. Same direction, OTM carries most of the signal (conviction).
      else if (totalHasMagnitude && absOtm / absNcp > 0.7) {
        lines.push(
          '  OTM-DOMINANT: Over 70% of total delta flow is coming from OTM strikes. This signals directional conviction, not ATM hedging. Trust the directional reading.',
        );
      }
      // 4. Same direction, but the OTM share is diluted by ATM hedging.
      else if (totalHasMagnitude && absOtm / absNcp < 0.3) {
        lines.push(
          '  ATM-DOMINANT: Less than 30% of total delta flow is coming from OTM strikes. The total reading is likely diluted by ATM hedging; directional conviction is weaker than the aggregate number suggests.',
        );
      }
    }
  }

  // Time series (last 6 data points)
  if (rows.length > 1) {
    const recentRows = rows.slice(-6);
    lines.push('', '  Recent History (5-min intervals):');
    for (const row of recentRows) {
      const time = new Date(row.timestamp).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
      const otmSegment =
        row.otmNcp != null ? ` | OTM Δ: ${formatDeltaVal(row.otmNcp)}` : '';
      lines.push(
        `    ${time} ET — Total Δ: ${formatDeltaVal(row.ncp)} | Dir Δ: ${formatDeltaVal(row.npp)}${otmSegment} | Vol: ${row.netVolume?.toLocaleString() ?? 'N/A'}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Format a delta flow value for display.
 */
function formatDeltaVal(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  if (abs === 0) return '0';
  return `${sign}${abs.toFixed(0)}`;
}

/**
 * Format a zero-gamma analysis result for Claude's context.
 *
 * Returns `null` when the analysis carries no actionable data (no flip
 * strike AND unknown regime) so the caller can cleanly omit the section
 * from the prompt rather than ship an empty block.
 *
 * See ENH-SIGNAL-001 in
 * `docs/superpowers/specs/analyze-prompt-enhancements-2026-04-08.md`.
 */
export function formatZeroGammaForClaude(
  analysis: ZeroGammaAnalysis,
  spot: number,
): string | null {
  // Nothing actionable → skip the whole section.
  if (
    analysis.zeroGammaStrike == null &&
    analysis.currentRegime === 'unknown'
  ) {
    return null;
  }

  const lines: string[] = [];

  if (analysis.zeroGammaStrike != null && analysis.distancePoints != null) {
    const flipStr = analysis.zeroGammaStrike.toFixed(0);
    const distAbs = Math.abs(analysis.distancePoints).toFixed(0);
    const direction = analysis.distancePoints >= 0 ? 'above' : 'below';
    lines.push(
      `  Zero-gamma strike: ${flipStr}`,
      `  Spot distance:     ${distAbs} pts ${direction} flip`,
    );
    if (analysis.distanceConeFraction != null) {
      lines.push(
        `  Cone fraction:     ${analysis.distanceConeFraction.toFixed(2)} (${analysis.distanceConeFraction < 1 ? 'inside' : 'beyond'} expected-move half-width)`,
      );
    }
  } else {
    // No crossing observed in the strike range — the flip is outside
    // the data we have. That's itself a signal: single-regime day.
    lines.push(
      '  Zero-gamma strike: NOT OBSERVED (no cumulative-gamma crossing in the strike range — single-regime day)',
    );
  }

  // Regime line.
  if (analysis.currentRegime === 'positive') {
    lines.push(
      '  Current regime:    POSITIVE GAMMA (dealers net long; hedging is mean-reverting → suppression / pinning)',
    );
  } else if (analysis.currentRegime === 'negative') {
    lines.push(
      '  Current regime:    NEGATIVE GAMMA (dealers net short; hedging is momentum-accelerating → breakouts and trend days)',
    );
  } else {
    lines.push('  Current regime:    UNKNOWN (insufficient strike data)');
  }

  // Flag distorted profiles (multiple crossings) so Claude weights the
  // flip strike itself with lower conviction.
  if (analysis.crossingCount >= 2) {
    lines.push(
      `  Crossings detected: ${analysis.crossingCount} (DISTORTED PROFILE — the reported flip is the crossing closest to spot; gamma structure is bumpy rather than clean)`,
    );
  }

  // Spot context for anchoring.
  lines.push(`  Spot (at snapshot): ${spot.toFixed(2)}`);

  return lines.join('\n');
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

/**
 * Format the net GEX heatmap as a structured text block for Claude's context.
 *
 * Surfaces:
 *   - Top gamma walls (highest positive net_gex): mean-reverting / support zones
 *   - Top acceleration zones (most negative net_gex): momentum-amplifying zones
 *   - Total GEX balance and regime (long vs short gamma environment)
 *   - Gamma flip zone (where net_gex crosses zero — regime boundary)
 *   - Per-strike table around the flip zone (±100 pts)
 */
export function formatNetGexHeatmapForClaude(rows: NetGexRow[]): string | null {
  if (rows.length === 0) return null;

  const lines: string[] = [];
  lines.push('SPX 0DTE Net GEX Heatmap (live spot — latest intraday snapshot):');
  lines.push(
    '  Positive net_gex = net long gamma → dealers buy dips / sell rips → price suppression (pin / support / resistance)',
  );
  lines.push(
    '  Negative net_gex = net short gamma → dealers chase moves → price acceleration (breakouts / trends)',
  );
  lines.push('');

  // Sort for structural analysis
  const byDesc = [...rows].sort((a, b) => b.netGex - a.netGex);
  const byAsc = [...rows].sort((a, b) => a.netGex - b.netGex);
  const topWalls = byDesc.filter((r) => r.netGex > 0).slice(0, 5);
  const topAccel = byAsc.filter((r) => r.netGex < 0).slice(0, 5);

  function callPutLabel(r: NetGexRow): string {
    if (r.callGexFraction == null) return 'split unknown';
    const c = Math.round(r.callGexFraction * 100);
    return `${c}% call / ${100 - c}% put`;
  }

  if (topWalls.length > 0) {
    lines.push(
      '  Gamma Walls (positive net_gex — mean-reverting / dealer support or resistance):',
    );
    for (const w of topWalls) {
      lines.push(
        `    ${w.strike}: ${fmtStrike(w.netGex)} (${callPutLabel(w)})`,
      );
    }
  }

  if (topAccel.length > 0) {
    lines.push(
      '  Acceleration Zones (negative net_gex — momentum-amplifying / dealer accelerates moves):',
    );
    for (const a of topAccel) {
      lines.push(
        `    ${a.strike}: ${fmtStrike(a.netGex)} (${callPutLabel(a)})`,
      );
    }
  }

  // Total GEX regime
  const totalNetGex = rows.reduce((s, r) => s + r.netGex, 0);
  const totalAbsGex = rows.reduce((s, r) => s + r.absGex, 0);
  const balancePct =
    totalAbsGex > 0 ? Math.round((totalNetGex / totalAbsGex) * 100) : 0;
  const balanceSign = balancePct > 0 ? '+' : '';
  lines.push('');
  lines.push(
    `  Total Net GEX Balance: ${fmtStrike(totalNetGex)} (${balanceSign}${balancePct}% of gross abs GEX)`,
  );
  if (totalNetGex > 0) {
    lines.push(
      '  Session Regime: NET LONG GAMMA — aggregate suppression. IC / range-bound bias.',
    );
  } else {
    lines.push(
      '  Session Regime: NET SHORT GAMMA — aggregate amplification. Directional / trending bias.',
    );
  }

  // Gamma sign flip zone (where net_gex crosses from negative to positive going upward)
  let flipLow: number | null = null;
  let flipHigh: number | null = null;
  for (let i = 0; i < rows.length - 1; i++) {
    const curr = rows[i]!;
    const next = rows[i + 1]!;
    if (curr.netGex < 0 && next.netGex >= 0) {
      flipLow = curr.strike;
      flipHigh = next.strike;
      break;
    }
  }

  if (flipLow !== null && flipHigh !== null) {
    lines.push(
      `  Gamma Flip Zone: ${flipLow}–${flipHigh} (net_gex crosses zero — regime boundary)`,
    );
    lines.push(
      '  Above flip: positive gamma (suppression); below flip: negative gamma (acceleration)',
    );
  }

  // Per-strike table: ±100 pts of the flip zone (proxy ATM)
  const flipMid =
    flipLow !== null && flipHigh !== null
      ? (flipLow + flipHigh) / 2
      : rows[Math.floor(rows.length / 2)]!.strike;
  const tableRows = rows.filter(
    (r) => r.strike >= flipMid - 100 && r.strike <= flipMid + 100,
  );

  if (tableRows.length > 0) {
    lines.push('');
    lines.push('  Per-Strike Net GEX (flip zone ±100 pts):');
    lines.push('    Strike |  Net GEX$    | Call% | Net Delta    | Net Charm');
    for (const r of tableRows) {
      const callPct =
        r.callGexFraction != null
          ? `${Math.round(r.callGexFraction * 100)
              .toString()
              .padStart(3)}%`
          : '  ?%';
      const marker = r.strike === flipHigh ? ' ← gamma flip' : '';
      lines.push(
        `    ${r.strike.toString().padStart(6)} | ${fmtStrike(r.netGex).padStart(12)} | ${callPct} | ${fmtStrike(r.netDelta).padStart(12)} | ${fmtStrike(r.netCharm).padStart(12)}${marker}`,
      );
    }
  }

  return lines.join('\n');
}
