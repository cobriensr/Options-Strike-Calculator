// ── Per-Strike Greek Exposure (0DTE naive gamma/charm profile) ──

import { getDb } from './db.js';

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
): Promise<StrikeExposureRow[]> {
  const db = getDb();

  // Find the latest timestamp for this date
  const tsRows = await db`
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
): Promise<StrikeExposureRow[]> {
  const db = getDb();

  // Find the latest timestamp for all-expiry rows on this date
  const tsRows = await db`
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
