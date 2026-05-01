/**
 * Futures context formatting for the /api/analyze endpoint.
 *
 * Queries futures_snapshots and futures_options_daily to assemble
 * a human-readable context block that Claude can use for analysis.
 * Gracefully handles missing symbols/tables during initial deployment.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { z } from 'zod';
import { fmtOI, fmtPct, fmtPrice } from './format-helpers.js';
import logger from './logger.js';
import { metrics, Sentry } from './sentry.js';

type Sql = NeonQueryFunction<false, false>;

// ── Row schemas ────────────────────────────────────────────
//
// Neon returns rows as untyped `Record<string, unknown>` arrays. Parsing
// each row through Zod catches schema drift the day it happens (column
// renames, type changes) instead of letting stale assumptions leak into
// the Claude prompt.

const futuresSnapshotSchema = z.object({
  symbol: z.string(),
  price: z.string(),
  change_1h_pct: z.string().nullable(),
  change_day_pct: z.string().nullable(),
  volume_ratio: z.string().nullable(),
});
type FuturesSnapshot = z.infer<typeof futuresSnapshotSchema>;

const esOptionsDailyRowSchema = z.object({
  strike: z.string(),
  option_type: z.string(),
  open_interest: z.string().nullable(),
  volume: z.string().nullable(),
});
type EsOptionsDailyRow = z.infer<typeof esOptionsDailyRowSchema>;

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
  return `${val.toFixed(1)}× 20-day avg — ${label}`;
}

// ── Per-symbol renderers ──────────────────────────────────
//
// Each renderer takes the snapshot map (so it can resolve cross-symbol
// references like NQ-vs-ES alignment or ZN flight-to-safety) plus the
// computed `derived` signals, and returns the lines for its section.
// Returns `null` when the symbol's snapshot is missing — the orchestrator
// drops null entries before joining sections.
//
// Cross-symbol references stay with their owning renderer rather than
// living in the orchestrator. This keeps the conditional cross-talk
// readable next to the symbol that owns the section, at the cost of
// each cross-referencing renderer reading two snapshots from the map.

type Renderer = (
  bySymbol: Map<string, FuturesSnapshot>,
  derived: DerivedSignals,
) => string[] | null;

const renderEs: Renderer = (bySymbol, derived) => {
  const es = bySymbol.get('ES');
  if (!es) return null;

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
  return lines;
};

const renderNq: Renderer = (bySymbol, derived) => {
  const nq = bySymbol.get('NQ');
  if (!nq) return null;

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
  return lines;
};

const renderVx: Renderer = (bySymbol, derived) => {
  const vxFront = bySymbol.get('VX1');
  const vxBack = bySymbol.get('VX2');
  if (!vxFront) return null;

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
      lines.push(`  Signal: Normal vol regime. Favorable for premium selling.`);
    }
  }
  return lines;
};

const renderZn: Renderer = (bySymbol) => {
  const zn = bySymbol.get('ZN');
  if (!zn) return null;

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
        `  Signal: FLIGHT TO SAFETY — bonds rallying + equities selling. Trending day likely.`,
      );
    } else if (znDay < -0.1 && esDay < -0.2) {
      lines.push(
        `  Signal: Broad liquidation — bonds and equities selling. Snapback reversal possible.`,
      );
    } else if (Math.abs(znDay) < 0.1) {
      lines.push(`  Signal: ZN flat — equity move is not macro-driven.`);
    }
  }
  return lines;
};

const renderRty: Renderer = (bySymbol) => {
  const rty = bySymbol.get('RTY');
  if (!rty) return null;

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
  return lines;
};

const renderCl: Renderer = (bySymbol) => {
  const cl = bySymbol.get('CL');
  if (!cl) return null;

  const lines = [
    `Crude Oil (/CL):`,
    `  Current: ${fmtPrice(num(cl.price))} | 1H: ${fmtPct(num(cl.change_1h_pct))} | Day: ${fmtPct(num(cl.change_day_pct))}`,
  ];
  const clDay = num(cl.change_day_pct);
  if (clDay != null) {
    if (clDay < -2) {
      lines.push(
        `  Signal: Oil weakness → inflation expectations easing → vol compression favorable`,
      );
    } else if (clDay > 2) {
      lines.push(
        `  Signal: Oil strength → inflation/geopolitical risk → vol expansion likely`,
      );
    }
  }
  return lines;
};

const renderGc: Renderer = (bySymbol) => {
  const gc = bySymbol.get('GC');
  if (!gc) return null;

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
        `  Signal: SAFE HAVEN BID — gold rising while equities fall. Fear-driven positioning.`,
      );
      if (znDay != null && znDay > 0.1) {
        lines.push(
          `  Gold + Bonds both bid = HIGH-CONVICTION flight to safety.`,
        );
      }
    } else if (gcDay < -0.5 && esDay > 0.2) {
      lines.push(
        `  Signal: Risk-on rotation — gold sold as equities rally. Favorable for premium selling.`,
      );
    }
  }
  return lines;
};

const renderDx: Renderer = (bySymbol) => {
  const dx = bySymbol.get('DX');
  if (!dx) return null;

  const lines = [
    `US Dollar Index (/DX):`,
    `  Current: ${fmtPrice(num(dx.price))} | 1H: ${fmtPct(num(dx.change_1h_pct))} | Day: ${fmtPct(num(dx.change_day_pct))}`,
  ];
  const dxDay = num(dx.change_day_pct);
  if (dxDay != null) {
    if (dxDay > 0.5) {
      lines.push(
        `  Signal: DOLLAR STRENGTH — equity headwind. Strong dollar pressures multinational earnings and risk assets.`,
      );
    } else if (dxDay < -0.5) {
      lines.push(
        `  Signal: DOLLAR WEAKNESS — equity tailwind. Weak dollar supports risk appetite.`,
      );
    }
  }
  return lines;
};

// Renderer iteration order matches the original file's section order
// (ES → NQ → VX → ZN → RTY → CL → GC → DX). Tests assert exact section
// boundaries via section index, so the ORDER here is load-bearing.
const SYMBOL_RENDERERS: ReadonlyArray<readonly [string, Renderer]> = [
  ['ES', renderEs],
  ['NQ', renderNq],
  ['VX', renderVx],
  ['ZN', renderZn],
  ['RTY', renderRty],
  ['CL', renderCl],
  ['GC', renderGc],
  ['DX', renderDx],
];

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
  const snapshots: FuturesSnapshot[] = [];
  const esOptionsRows: EsOptionsDailyRow[] = [];

  // Fetch latest snapshots — gracefully handle missing table
  try {
    const rawRows = await sql`
      SELECT DISTINCT ON (symbol)
        symbol, price, change_1h_pct, change_day_pct, volume_ratio
      FROM futures_snapshots
      WHERE trade_date = ${analysisDate}
      ORDER BY symbol, ts DESC
    `;
    for (const row of rawRows) {
      const parsed = futuresSnapshotSchema.safeParse(row);
      if (parsed.success) {
        snapshots.push(parsed.data);
      } else {
        logger.warn(
          { issues: parsed.error.issues, row },
          'futures_snapshots row failed schema validation — dropping',
        );
      }
    }
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
    const rawRows = await sql`
      SELECT strike, option_type, open_interest, volume
      FROM futures_options_daily
      WHERE underlying = 'ES'
        AND trade_date = ${analysisDate}
        AND open_interest IS NOT NULL
      ORDER BY open_interest DESC
      LIMIT 20
    `;
    for (const row of rawRows) {
      const parsed = esOptionsDailyRowSchema.safeParse(row);
      if (parsed.success) {
        esOptionsRows.push(parsed.data);
      } else {
        logger.warn(
          { issues: parsed.error.issues, row },
          'futures_options_daily row failed schema validation — dropping',
        );
      }
    }
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

  // Per-symbol sections via the renderer table.
  const sections: string[] = [];
  for (const [, renderer] of SYMBOL_RENDERERS) {
    const lines = renderer(bySymbol, derived);
    if (lines) sections.push(lines.join('\n'));
  }

  // ES Options section (uses esOptionsRows, not the snapshot map, so it
  // doesn't fit the (bySymbol, derived) Renderer signature — kept inline).
  if (esOptionsRows.length > 0) {
    const putRows = esOptionsRows.filter((r) => r.option_type === 'P');
    const callRows = esOptionsRows.filter((r) => r.option_type === 'C');
    const lines = [`ES Options Institutional Activity:`];
    if (putRows.length > 0) {
      const topPut = putRows[0]!;
      lines.push(
        `  Top Put OI: ${topPut.strike}P — ${fmtOI(Number(topPut.open_interest))} OI`,
      );
    }
    if (callRows.length > 0) {
      const topCall = callRows[0]!;
      lines.push(
        `  Top Call OI: ${topCall.strike}C — ${fmtOI(Number(topCall.open_interest))} OI`,
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
