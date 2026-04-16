/**
 * Flow and Greek exposure database operations.
 *
 * Handles flow_data, greek_exposure, and spot_exposures queries
 * plus formatting functions for Claude's context.
 */

import { getDb } from './db.js';

// ============================================================
// FLOW DATA (UW API time series)
// ============================================================

/**
 * Get all flow data rows for a given date and source.
 * Returns rows ordered by timestamp ascending (oldest first).
 *
 * The otmNcp/otmNpp fields are only populated for the
 * `zero_dte_greek_flow` source, where they represent OTM-only
 * variants of the total delta flow. For all other sources they
 * will be null. See migration #48 and fetch-greek-flow.ts.
 */
export async function getFlowData(
  date: string,
  source: string,
  asOf?: string,
): Promise<
  Array<{
    timestamp: string;
    ncp: number;
    npp: number;
    netVolume: number;
    otmNcp: number | null;
    otmNpp: number | null;
  }>
> {
  const sql = getDb();
  const rows = asOf
    ? await sql`
        SELECT timestamp, ncp, npp, net_volume, otm_ncp, otm_npp
        FROM flow_data
        WHERE date = ${date} AND source = ${source} AND timestamp <= ${asOf}
        ORDER BY timestamp ASC
      `
    : await sql`
        SELECT timestamp, ncp, npp, net_volume, otm_ncp, otm_npp
        FROM flow_data
        WHERE date = ${date} AND source = ${source}
        ORDER BY timestamp ASC
      `;

  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    ncp: Number(r.ncp),
    npp: Number(r.npp),
    netVolume: r.net_volume as number,
    otmNcp: r.otm_ncp == null ? null : Number(r.otm_ncp),
    otmNpp: r.otm_npp == null ? null : Number(r.otm_npp),
  }));
}

/**
 * Format flow data as a structured text block for Claude's context.
 * Includes the time series, computed direction, and divergence pattern.
 *
 * @param rows - Flow data rows (ordered by timestamp ascending)
 * @param label - Display name (e.g., "Market Tide", "Market Tide OTM")
 * @returns Formatted text block, or null if no data
 */
export function formatFlowDataForClaude(
  rows: Array<{
    timestamp: string;
    ncp: number;
    npp: number;
    netVolume: number;
  }>,
  label: string,
): string | null {
  if (rows.length === 0) return null;

  const lines: string[] = [`${label} (5-min intervals):`];

  // Format each row
  for (const row of rows) {
    const time = new Date(row.timestamp).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    const ncpStr = formatPremium(row.ncp);
    const nppStr = formatPremium(row.npp);
    const volStr =
      row.netVolume != null
        ? `${row.netVolume >= 0 ? '+' : ''}${row.netVolume.toLocaleString()}`
        : 'N/A';
    lines.push(`  ${time} ET — NCP: ${ncpStr}, NPP: ${nppStr}, Vol: ${volStr}`);
  }

  // Compute direction summary from first and last rows
  if (rows.length >= 2) {
    const first = rows[0]!;
    const last = rows.at(-1)!;
    const ncpChange = last.ncp - first.ncp;
    const nppChange = last.npp - first.npp;
    const minutes = Math.round(
      (new Date(last.timestamp).getTime() -
        new Date(first.timestamp).getTime()) /
        60000,
    );

    const ncpDir =
      ncpChange > 0 ? 'rising' : ncpChange < 0 ? 'falling' : 'flat';
    const nppDir =
      nppChange > 0 ? 'rising' : nppChange < 0 ? 'falling' : 'flat';

    lines.push(
      `  Direction (${minutes} min): NCP ${ncpDir} (${formatPremium(ncpChange)}), NPP ${nppDir} (${formatPremium(nppChange)})`,
    );

    // Divergence pattern
    const gap = last.ncp - last.npp;
    const prevGap = first.ncp - first.npp;
    if (Math.abs(gap) > Math.abs(prevGap)) {
      const direction = gap > 0 ? 'bullish' : 'bearish';
      lines.push(`  Pattern: ${direction} divergence widening`);
    } else if (Math.abs(gap) < Math.abs(prevGap) * 0.5) {
      lines.push('  Pattern: NCP/NPP converging');
    } else {
      lines.push('  Pattern: Lines roughly parallel');
    }
  }

  return lines.join('\n');
}

/**
 * Format a premium value for display (e.g., -140000000 -> "-$140M")
 */
function formatPremium(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ── Greek Exposure (MM gamma/charm/delta/vanna by expiry) ───

export interface GreekExposureRow {
  expiry: string;
  dte: number;
  callGamma: number | null;
  putGamma: number | null;
  netGamma: number | null;
  callCharm: number;
  putCharm: number;
  netCharm: number;
  callDelta: number;
  putDelta: number;
  netDelta: number;
  callVanna: number;
  putVanna: number;
}

/**
 * Get all Greek exposure rows for a given date and ticker.
 * Returns rows ordered by DTE ascending (aggregate at dte=-1 first, then 0DTE, etc).
 */
export async function getGreekExposure(
  date: string,
  ticker: string = 'SPX',
): Promise<GreekExposureRow[]> {
  const db = getDb();
  const rows = await db`
    SELECT expiry, dte, call_gamma, put_gamma, call_charm, put_charm,
           call_delta, put_delta, call_vanna, put_vanna
    FROM greek_exposure
    WHERE date = ${date} AND ticker = ${ticker}
    ORDER BY dte ASC
  `;

  return rows.map((r) => {
    const cg = r.call_gamma != null ? Number(r.call_gamma) : null;
    const pg = r.put_gamma != null ? Number(r.put_gamma) : null;

    return {
      expiry: r.expiry as string,
      dte: r.dte as number,
      callGamma: cg,
      putGamma: pg,
      netGamma: cg != null && pg != null ? cg + pg : null,
      callCharm: Number(r.call_charm),
      putCharm: Number(r.put_charm),
      netCharm: Number(r.call_charm) + Number(r.put_charm),
      callDelta: Number(r.call_delta),
      putDelta: Number(r.put_delta),
      netDelta: Number(r.call_delta) + Number(r.put_delta),
      callVanna: Number(r.call_vanna),
      putVanna: Number(r.put_vanna),
    };
  });
}

/**
 * Format Greek exposure data as a structured text block for Claude's context.
 * Uses aggregate row (dte=-1) for OI Net Gamma (Rule 16) and 0DTE row for charm/delta breakdown.
 *
 * @param rows - Greek exposure rows (ordered by DTE ascending)
 * @param date - Analysis date (to identify 0DTE expiry)
 * @returns Formatted text block, or null if no data
 */
export function formatGreekExposureForClaude(
  rows: GreekExposureRow[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _date: string,
): string | null {
  if (rows.length === 0) return null;

  // Find aggregate row (dte=-1)
  const aggregate = rows.find((r) => r.dte === -1);

  // Find 0DTE row (dte=0)
  const zeroDte = rows.find((r) => r.dte === 0);

  // Non-aggregate, non-0DTE expiries sorted by charm magnitude
  const otherExpiries = rows
    .filter((r) => r.dte > 0)
    .sort((a, b) => Math.abs(b.netCharm) - Math.abs(a.netCharm))
    .slice(0, 3);

  const lines: string[] = [];

  lines.push('SPX Greek Exposure (OI-based, from API):');

  // Aggregate section (has gamma from the aggregate endpoint)
  if (aggregate?.netGamma != null) {
    const gex = aggregate.netGamma;
    let regime: string;
    if (gex > 50_000) {
      regime = 'POSITIVE — Normal management. Periscope walls reliable.';
    } else if (gex > 0) {
      regime = 'MILDLY POSITIVE — Walls mostly reliable. Standard management.';
    } else if (gex > -50_000) {
      regime = 'MILDLY NEGATIVE — Tighten CCS time exits by 30 min.';
    } else if (gex > -150_000) {
      regime =
        'MODERATELY NEGATIVE — Close CCS by 12:00 PM ET. Target 40% profit.';
    } else {
      regime =
        'DEEPLY NEGATIVE — Close CCS by 11:30 AM ET. Reduce size 10%. Walls compromised.';
    }

    lines.push(
      `  OI Net Gamma Exposure (all expiries): ${formatGreekValue(gex)}`,
      `  Rule 16 Regime: ${regime}`,
      `  Net Charm (all expiries): ${formatGreekValue(aggregate.netCharm)}`,
      `  Net Delta (all expiries): ${formatGreekValue(aggregate.netDelta)}`,
    );
  }

  // 0DTE section (charm/delta — gamma is null on basic tier)
  if (zeroDte) {
    lines.push(
      '',
      '  0DTE Breakdown:',
      `    Net Charm: ${formatGreekValue(zeroDte.netCharm)}`,
      `    Call Charm: ${formatGreekValue(zeroDte.callCharm)} | Put Charm: ${formatGreekValue(zeroDte.putCharm)}`,
      `    Net Delta: ${formatGreekValue(zeroDte.netDelta)}`,
      `    Call Delta: ${formatGreekValue(zeroDte.callDelta)} | Put Delta: ${formatGreekValue(zeroDte.putDelta)}`,
    );

    if (aggregate && aggregate.netCharm !== 0) {
      const charmPct = ((zeroDte.netCharm / aggregate.netCharm) * 100).toFixed(
        1,
      );
      lines.push(`    0DTE Charm as % of total: ${charmPct}%`);
    }
  }

  // Top non-0DTE expiries by charm magnitude
  if (otherExpiries.length > 0) {
    lines.push('', '  Largest Non-0DTE Charm Concentrations:');
    for (const r of otherExpiries) {
      lines.push(
        `    ${r.expiry} (${r.dte}DTE): Net Charm ${formatGreekValue(r.netCharm)}, Net Delta ${formatGreekValue(r.netDelta)}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Format a Greek exposure value for display (e.g., -12337386 -> "-12.3M")
 */
function formatGreekValue(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1_000_000_000)
    return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

// ── Market Internals (NYSE breadth indicators) ───────────────

/**
 * Get all market internals bars for a given date.
 * Returns rows ordered by timestamp ascending (oldest first).
 */
export async function getMarketInternalsToday(date: string): Promise<
  Array<{
    ts: string;
    symbol: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }>
> {
  const sql = getDb();
  const rows = await sql`
    SELECT ts, symbol, open, high, low, close
    FROM market_internals
    WHERE ts::date = ${date}::date
    ORDER BY ts ASC
  `;

  return rows.map((r) => ({
    ts: r.ts as string,
    symbol: r.symbol as string,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));
}

// ── Spot GEX Exposures (intraday panel data) ────────────────

export interface SpotExposureRow {
  timestamp: string;
  price: number;
  gammaOi: number;
  gammaVol: number;
  gammaDir: number;
  charmOi: number;
  charmVol: number;
  charmDir: number;
  vannaOi: number;
  vannaVol: number;
  vannaDir: number;
}

/**
 * Get all spot GEX exposure rows for a given date.
 * Returns rows ordered by timestamp ascending (oldest first).
 */
export async function getSpotExposures(
  date: string,
  ticker: string = 'SPX',
  asOf?: string,
): Promise<SpotExposureRow[]> {
  const db = getDb();
  const rows = asOf
    ? await db`
        SELECT timestamp, price,
               gamma_oi, gamma_vol, gamma_dir,
               charm_oi, charm_vol, charm_dir,
               vanna_oi, vanna_vol, vanna_dir
        FROM spot_exposures
        WHERE date = ${date} AND ticker = ${ticker} AND timestamp <= ${asOf}
        ORDER BY timestamp ASC
      `
    : await db`
        SELECT timestamp, price,
               gamma_oi, gamma_vol, gamma_dir,
               charm_oi, charm_vol, charm_dir,
               vanna_oi, vanna_vol, vanna_dir
        FROM spot_exposures
        WHERE date = ${date} AND ticker = ${ticker}
        ORDER BY timestamp ASC
      `;

  return rows.map((r) => ({
    timestamp: r.timestamp as string,
    price: Number(r.price),
    gammaOi: Number(r.gamma_oi),
    gammaVol: Number(r.gamma_vol),
    gammaDir: Number(r.gamma_dir),
    charmOi: Number(r.charm_oi),
    charmVol: Number(r.charm_vol),
    charmDir: Number(r.charm_dir),
    vannaOi: Number(r.vanna_oi),
    vannaVol: Number(r.vanna_vol),
    vannaDir: Number(r.vanna_dir),
  }));
}

/**
 * Format spot GEX exposure data as a structured text block for Claude's context.
 *
 * IMPORTANT SCALE NOTE: The API returns dollar values per 1% move (billions).
 * The Aggregate GEX screenshot shows these same values divided by ~1,000,000.
 * Example: API returns -67,369,292,795 -> screenshot shows -67,385.
 * This formatter divides by 1,000,000 to match the screenshot scale that
 * Rule 16 thresholds are calibrated against.
 *
 * @param rows - Spot exposure rows (ordered by timestamp ascending)
 * @returns Formatted text block, or null if no data
 */
export function formatSpotExposuresForClaude(
  rows: SpotExposureRow[],
): string | null {
  if (rows.length === 0) return null;

  const latest = rows.at(-1)!;
  const first = rows[0]!;

  // Convert to screenshot scale (÷ 1,000,000)
  const oiGex = latest.gammaOi / 1_000_000;
  const volGex = latest.gammaVol / 1_000_000;
  const dirGex = latest.gammaDir / 1_000_000;

  // Rule 16 regime classification (using screenshot-scale values)
  let regime: string;
  if (oiGex > 50_000) {
    regime = 'POSITIVE — Normal management. Periscope walls reliable.';
  } else if (oiGex > 0) {
    regime = 'MILDLY POSITIVE — Walls mostly reliable. Standard management.';
  } else if (oiGex > -50_000) {
    regime = 'MILDLY NEGATIVE — Tighten CCS time exits by 30 min.';
  } else if (oiGex > -150_000) {
    regime =
      'MODERATELY NEGATIVE — Close CCS by 12:00 PM ET. Target 40% profit.';
  } else {
    regime =
      'DEEPLY NEGATIVE — Close CCS by 11:30 AM ET. Reduce size 10%. Walls compromised.';
  }

  const lines: string[] = [];

  // Latest snapshot
  const latestTime = new Date(latest.timestamp).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  lines.push(
    'SPX Aggregate GEX Panel (from API — intraday):',
    `  Latest (${latestTime} ET) — SPX at ${latest.price}:`,
    `    OI Net Gamma Exposure: ${fmtGex(oiGex)}`,
    `    Volume Net Gamma Exposure: ${fmtGex(volGex)}`,
    `    Directionalized Volume Net Gamma: ${fmtGex(dirGex)}`,
    `    Rule 16 Regime: ${regime}`,
  );

  // Volume GEX interpretation
  if (volGex !== 0) {
    if (oiGex < 0 && volGex > 0) {
      lines.push(
        `    Note: Volume GEX positive while OI GEX negative — today's trading adds suppression. Session may be calmer than OI suggests, but don't extend past OI-based time limits.`,
      );
    } else if (oiGex < 0 && volGex < 0) {
      lines.push(
        `    Note: Volume GEX ALSO negative — today's trading is WORSENING the acceleration regime. Walls are less reliable than OI alone suggests.`,
      );
    }
  }

  // Charm snapshot
  const oiCharm = latest.charmOi / 1_000_000;
  const volCharm = latest.charmVol / 1_000_000;
  lines.push(
    '',
    `    OI Net Charm: ${fmtGex(oiCharm)}`,
    `    Volume Net Charm: ${fmtGex(volCharm)}`,
  );

  // Vanna snapshot
  const oiVanna = latest.vannaOi / 1_000_000;
  const volVanna = latest.vannaVol / 1_000_000;
  const dirVanna = latest.vannaDir / 1_000_000;
  lines.push(
    '',
    `    OI Net Vanna: ${fmtGex(oiVanna)}`,
    `    Volume Net Vanna: ${fmtGex(volVanna)}`,
    `    Directionalized Vanna: ${fmtGex(dirVanna)}`,
  );
  if (oiVanna > 0) {
    lines.push(
      `    Vanna Signal: POSITIVE — if VIX drops 1+ pt, expect mechanical SPX upward drift (Rule 17). CCS: tighten stops. PCS: structural support.`,
    );
  } else if (oiVanna < 0) {
    lines.push(
      `    Vanna Signal: NEGATIVE — if VIX rises, selloff acceleration beyond gamma. PCS: tighten exits.`,
    );
  }

  // Intraday trend
  if (rows.length >= 2) {
    const oiChange = (latest.gammaOi - first.gammaOi) / 1_000_000;
    const minutes = Math.round(
      (new Date(latest.timestamp).getTime() -
        new Date(first.timestamp).getTime()) /
        60000,
    );

    const gammaDir2 =
      oiChange > 0
        ? 'improving (toward positive)'
        : oiChange < 0
          ? 'deteriorating (toward negative)'
          : 'stable';

    lines.push(
      '',
      `  Intraday Trend (${minutes} min):`,
      `    OI Gamma: ${gammaDir2} (${fmtGex(oiChange)} change)`,
      `    Price: ${first.price} → ${latest.price} (${latest.price >= first.price ? '+' : ''}${(latest.price - first.price).toFixed(0)} pts)`,
    );
  }

  // Recent time series (last 6 data points)
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
      lines.push(
        `    ${time} ET — SPX: ${row.price} | OI: ${fmtGex(row.gammaOi / 1_000_000)} | Vol: ${fmtGex(row.gammaVol / 1_000_000)} | Dir: ${fmtGex(row.gammaDir / 1_000_000)}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Format a GEX value in screenshot scale for display.
 * Values are already divided by 1M, so they're in the range of +/-1K to +/-300K.
 */
function fmtGex(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000).toFixed(0)}K`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  if (abs === 0) return '0';
  return `${sign}${abs.toFixed(0)}`;
}
