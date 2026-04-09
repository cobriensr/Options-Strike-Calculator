/**
 * Futures context formatting for the /api/analyze endpoint.
 *
 * Queries futures_snapshots and futures_options_daily to assemble
 * a human-readable context block that Claude can use for analysis.
 * Gracefully handles missing symbols/tables during initial deployment.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import logger from './logger.js';
import { metrics, Sentry } from './sentry.js';

type Sql = NeonQueryFunction<false, false>;

// ── Types ──────────────────────────────────────────────────

interface FuturesSnapshot {
  symbol: string;
  price: string;
  change_1h_pct: string | null;
  change_day_pct: string | null;
  volume_ratio: string | null;
}

interface EsOptionsDailyRow {
  strike: string;
  option_type: string;
  open_interest: string | null;
  volume: string | null;
}

interface DerivedSignals {
  esSpxBasis: number | null;
  nqEsRatio: number | null;
  vxTermSpread: number | null;
  vxTermSignal: 'CONTANGO' | 'BACKWARDATION' | 'FLAT' | null;
}

// ── Helpers ────────────────────────────────────────────────

function num(val: string | null | undefined): number | null {
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(val: number | null): string {
  if (val == null) return 'N/A';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

function fmtPrice(val: number | null, decimals = 2): string {
  if (val == null) return 'N/A';
  return val.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtVolRatio(val: number | null): string {
  if (val == null) return 'N/A';
  const label =
    val >= 2.0
      ? 'VERY ELEVATED'
      : val >= 1.3
        ? 'ELEVATED'
        : val >= 0.7
          ? 'NORMAL'
          : 'LOW';
  return `${val.toFixed(1)}\u00D7 20-day avg \u2014 ${label}`;
}

function fmtOI(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ── Core formatter ─────────────────────────────────────────

/**
 * Build the futures context block for Claude analysis.
 *
 * Queries:
 *   - futures_snapshots for latest data on all 7 symbols
 *   - futures_options_daily for ES options OI concentration
 *
 * Returns null if no futures data is available (tables may not
 * exist yet during initial deployment).
 */
export async function formatFuturesForClaude(
  sql: Sql,
  analysisDate: string,
  spxPrice?: number,
): Promise<string | null> {
  let snapshots: FuturesSnapshot[] = [];
  let esOptionsRows: EsOptionsDailyRow[] = [];

  // Fetch latest snapshots — gracefully handle missing table
  try {
    snapshots = (await sql`
      SELECT DISTINCT ON (symbol)
        symbol, price, change_1h_pct, change_day_pct, volume_ratio
      FROM futures_snapshots
      WHERE trade_date = ${analysisDate}
      ORDER BY symbol, ts DESC
    `) as unknown as FuturesSnapshot[];
  } catch (err) {
    logger.debug({ err }, 'futures_snapshots table not available — skipping');
    metrics.increment('futures_context.fetch_error');
    Sentry.captureException(err);
    return null;
  }

  if (snapshots.length === 0) return null;

  // Build a lookup map
  const bySymbol = new Map<string, FuturesSnapshot>();
  for (const row of snapshots) {
    bySymbol.set(row.symbol, row);
  }

  // Fetch ES options OI concentration — gracefully handle missing
  try {
    esOptionsRows = (await sql`
      SELECT strike, option_type, open_interest, volume
      FROM futures_options_daily
      WHERE underlying = 'ES'
        AND trade_date = ${analysisDate}
        AND open_interest IS NOT NULL
      ORDER BY open_interest DESC
      LIMIT 20
    `) as unknown as EsOptionsDailyRow[];
  } catch (err) {
    logger.debug(
      { err },
      'futures_options_daily table not available — skipping',
    );
    metrics.increment('futures_context.fetch_error');
    Sentry.captureException(err);
  }

  // Compute derived signals
  const derived = computeDerivedSignals(bySymbol, spxPrice);

  // Assemble sections
  const sections: string[] = [];

  // ES section
  const es = bySymbol.get('ES');
  if (es) {
    const esPrice = num(es.price);
    const lines = [
      `ES Futures (/ES):`,
      `  Current: ${fmtPrice(esPrice)} | 1H: ${fmtPct(num(es.change_1h_pct))} | Day: ${fmtPct(num(es.change_day_pct))}`,
    ];
    const volRatio = num(es.volume_ratio);
    if (volRatio != null) {
      lines.push(`  Volume Ratio: ${fmtVolRatio(volRatio)}`);
    }
    if (derived.esSpxBasis != null) {
      const basisLabel =
        Math.abs(derived.esSpxBasis) <= 2
          ? 'normal'
          : Math.abs(derived.esSpxBasis) <= 5
            ? 'slightly wide'
            : 'STRESS';
      lines.push(
        `  ES-SPX Basis: ${derived.esSpxBasis >= 0 ? '+' : ''}${derived.esSpxBasis.toFixed(2)} pts (${basisLabel})`,
      );
    }
    sections.push(lines.join('\n'));
  }

  // NQ section
  const nq = bySymbol.get('NQ');
  if (nq) {
    const lines = [
      `NQ Futures (/NQ):`,
      `  Current: ${fmtPrice(num(nq.price))} | 1H: ${fmtPct(num(nq.change_1h_pct))} | Day: ${fmtPct(num(nq.change_day_pct))}`,
    ];
    if (derived.nqEsRatio != null) {
      lines.push(`  NQ/ES Ratio: ${derived.nqEsRatio.toFixed(3)}`);
    }
    // Divergence check: compare NQ and ES day direction
    const esDay = num(bySymbol.get('ES')?.change_day_pct ?? null);
    const nqDay = num(nq.change_day_pct);
    if (esDay != null && nqDay != null) {
      const aligned = (esDay >= 0 && nqDay >= 0) || (esDay < 0 && nqDay < 0);
      lines.push(`  NQ-ES Direction: ${aligned ? 'ALIGNED' : 'DIVERGING'}`);
    }
    sections.push(lines.join('\n'));
  }

  // VIX Futures section
  const vxFront = bySymbol.get('VX1');
  const vxBack = bySymbol.get('VX2');
  if (vxFront) {
    const frontPrice = num(vxFront.price);
    const backPrice = num(vxBack?.price ?? null);
    const lines = [`VIX Futures (/VX):`];
    if (frontPrice != null && backPrice != null) {
      lines.push(
        `  Front Month: ${fmtPrice(frontPrice)} | Second Month: ${fmtPrice(backPrice)}`,
      );
    } else if (frontPrice != null) {
      lines.push(`  Front Month: ${fmtPrice(frontPrice)}`);
    }
    if (derived.vxTermSpread != null && derived.vxTermSignal) {
      lines.push(
        `  Term Structure: ${derived.vxTermSignal} (spread: ${derived.vxTermSpread >= 0 ? '+' : ''}${derived.vxTermSpread.toFixed(2)})`,
      );
      if (derived.vxTermSignal === 'BACKWARDATION') {
        lines.push(
          `  Signal: Near-term stress priced in. Straddle cones may understate range.`,
        );
      } else if (derived.vxTermSignal === 'CONTANGO') {
        lines.push(
          `  Signal: Normal vol regime. Favorable for premium selling.`,
        );
      }
    }
    sections.push(lines.join('\n'));
  }

  // ZN section
  const zn = bySymbol.get('ZN');
  if (zn) {
    const lines = [
      `10Y Treasury (/ZN):`,
      `  Current: ${fmtPrice(num(zn.price))} | 1H: ${fmtPct(num(zn.change_1h_pct))} | Day: ${fmtPct(num(zn.change_day_pct))}`,
    ];
    // Flight-to-safety check
    const znDay = num(zn.change_day_pct);
    const esDay = num(bySymbol.get('ES')?.change_day_pct ?? null);
    if (znDay != null && esDay != null) {
      if (znDay > 0.1 && esDay < -0.2) {
        lines.push(
          `  Signal: FLIGHT TO SAFETY \u2014 bonds rallying + equities selling. Trending day likely.`,
        );
      } else if (znDay < -0.1 && esDay < -0.2) {
        lines.push(
          `  Signal: Broad liquidation \u2014 bonds and equities selling. Snapback reversal possible.`,
        );
      } else if (Math.abs(znDay) < 0.1) {
        lines.push(`  Signal: ZN flat \u2014 equity move is not macro-driven.`);
      }
    }
    sections.push(lines.join('\n'));
  }

  // RTY section
  const rty = bySymbol.get('RTY');
  if (rty) {
    const lines = [
      `Russell 2000 (/RTY):`,
      `  Current: ${fmtPrice(num(rty.price))} | 1H: ${fmtPct(num(rty.change_1h_pct))} | Day: ${fmtPct(num(rty.change_day_pct))}`,
    ];
    const rtyDay = num(rty.change_day_pct);
    const esDay = num(bySymbol.get('ES')?.change_day_pct ?? null);
    if (rtyDay != null && esDay != null) {
      const aligned = (rtyDay >= 0 && esDay >= 0) || (rtyDay < 0 && esDay < 0);
      lines.push(
        `  RTY-ES Breadth: ${aligned ? 'ALIGNED (broad move)' : 'DIVERGING (narrow/fragile)'}`,
      );
    }
    sections.push(lines.join('\n'));
  }

  // CL section
  const cl = bySymbol.get('CL');
  if (cl) {
    const lines = [
      `Crude Oil (/CL):`,
      `  Current: ${fmtPrice(num(cl.price))} | 1H: ${fmtPct(num(cl.change_1h_pct))} | Day: ${fmtPct(num(cl.change_day_pct))}`,
    ];
    const clDay = num(cl.change_day_pct);
    if (clDay != null) {
      if (clDay < -2) {
        lines.push(
          `  Signal: Oil weakness \u2192 inflation expectations easing \u2192 vol compression favorable`,
        );
      } else if (clDay > 2) {
        lines.push(
          `  Signal: Oil strength \u2192 inflation/geopolitical risk \u2192 vol expansion likely`,
        );
      }
    }
    sections.push(lines.join('\n'));
  }

  // GC section
  const gc = bySymbol.get('GC');
  if (gc) {
    const lines = [
      `Gold (/GC):`,
      `  Current: ${fmtPrice(num(gc.price))} | 1H: ${fmtPct(num(gc.change_1h_pct))} | Day: ${fmtPct(num(gc.change_day_pct))}`,
    ];
    const gcDay = num(gc.change_day_pct);
    const esDay = num(bySymbol.get('ES')?.change_day_pct ?? null);
    const znDay = num(bySymbol.get('ZN')?.change_day_pct ?? null);
    if (gcDay != null && esDay != null) {
      if (gcDay > 0.5 && esDay < -0.2) {
        lines.push(
          `  Signal: SAFE HAVEN BID \u2014 gold rising while equities fall. Fear-driven positioning.`,
        );
        if (znDay != null && znDay > 0.1) {
          lines.push(
            `  Gold + Bonds both bid = HIGH-CONVICTION flight to safety.`,
          );
        }
      } else if (gcDay < -0.5 && esDay > 0.2) {
        lines.push(
          `  Signal: Risk-on rotation \u2014 gold sold as equities rally. Favorable for premium selling.`,
        );
      }
    }
    sections.push(lines.join('\n'));
  }

  // DX section
  const dx = bySymbol.get('DX');
  if (dx) {
    const lines = [
      `US Dollar Index (/DX):`,
      `  Current: ${fmtPrice(num(dx.price))} | 1H: ${fmtPct(num(dx.change_1h_pct))} | Day: ${fmtPct(num(dx.change_day_pct))}`,
    ];
    const dxDay = num(dx.change_day_pct);
    if (dxDay != null) {
      if (dxDay > 0.5) {
        lines.push(
          `  Signal: DOLLAR STRENGTH \u2014 equity headwind. Strong dollar pressures multinational earnings and risk assets.`,
        );
      } else if (dxDay < -0.5) {
        lines.push(
          `  Signal: DOLLAR WEAKNESS \u2014 equity tailwind. Weak dollar supports risk appetite.`,
        );
      }
    }
    sections.push(lines.join('\n'));
  }

  // ES Options section
  if (esOptionsRows.length > 0) {
    const putRows = esOptionsRows.filter((r) => r.option_type === 'P');
    const callRows = esOptionsRows.filter((r) => r.option_type === 'C');
    const lines = [`ES Options Institutional Activity:`];
    if (putRows.length > 0) {
      const topPut = putRows[0]!;
      lines.push(
        `  Top Put OI: ${topPut.strike}P \u2014 ${fmtOI(Number(topPut.open_interest))} OI`,
      );
    }
    if (callRows.length > 0) {
      const topCall = callRows[0]!;
      lines.push(
        `  Top Call OI: ${topCall.strike}C \u2014 ${fmtOI(Number(topCall.open_interest))} OI`,
      );
    }
    sections.push(lines.join('\n'));
  }

  if (sections.length === 0) return null;

  return '## Futures Context\n\n' + sections.join('\n\n');
}

// ── Derived signals ────────────────────────────────────────

function computeDerivedSignals(
  bySymbol: Map<string, FuturesSnapshot>,
  spxPrice?: number,
): DerivedSignals {
  const result: DerivedSignals = {
    esSpxBasis: null,
    nqEsRatio: null,
    vxTermSpread: null,
    vxTermSignal: null,
  };

  // ES-SPX basis
  const esPrice = num(bySymbol.get('ES')?.price ?? null);
  if (esPrice != null && spxPrice != null && spxPrice > 0) {
    result.esSpxBasis = esPrice - spxPrice;
  }

  // NQ/ES ratio
  const nqPrice = num(bySymbol.get('NQ')?.price ?? null);
  if (nqPrice != null && esPrice != null && esPrice > 0) {
    result.nqEsRatio = nqPrice / esPrice;
  }

  // VX term structure
  const vxFront = num(bySymbol.get('VX1')?.price ?? null);
  const vxBack = num(bySymbol.get('VX2')?.price ?? null);
  if (vxFront != null && vxBack != null) {
    result.vxTermSpread = vxFront - vxBack;
    if (result.vxTermSpread > 0.25) {
      result.vxTermSignal = 'BACKWARDATION';
    } else if (result.vxTermSpread < -0.25) {
      result.vxTermSignal = 'CONTANGO';
    } else {
      result.vxTermSignal = 'FLAT';
    }
  }

  return result;
}
