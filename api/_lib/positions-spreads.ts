/**
 * Spread-grouping + summary helpers for the positions endpoint.
 *
 * Pure formatting + math only — extracted from `api/positions.ts` so
 * the spread-pairing logic and the human-readable summary string can be
 * unit-tested in isolation.
 *
 * `buildPositionResponse` orchestrates the two: it groups legs into
 * spreads, builds the prose summary, and computes aggregate Greeks /
 * P&L. Returns a typed object the handler combines with CSV-specific
 * stats (closedToday, dayPnl, etc.) before responding.
 *
 * Phase 5i of docs/superpowers/specs/api-refactor-2026-05-02.md.
 */

import type { PositionLeg } from './db.js';

// ── Types ────────────────────────────────────────────────────

export type SpreadType =
  | 'CALL CREDIT SPREAD'
  | 'PUT CREDIT SPREAD'
  | 'IRON CONDOR'
  | 'SINGLE';

export interface Spread {
  type: SpreadType;
  shortLeg: PositionLeg;
  longLeg?: PositionLeg;
  credit: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  width: number;
}

// ── Spread grouping ──────────────────────────────────────────

/**
 * Group individual option legs into credit spreads.
 * Matches short legs with long legs of the same type (put/call)
 * by finding the closest strikes (≤50pt distance).
 *
 * Each unmatched short becomes a 'SINGLE' spread (naked short) so the
 * caller's risk math sees every leg even if pairing fails.
 */
export function groupIntoSpreads(legs: PositionLeg[]): Spread[] {
  const calls = legs.filter((l) => l.putCall === 'CALL');
  const puts = legs.filter((l) => l.putCall === 'PUT');
  const spreads: Spread[] = [];

  function pairLegs(group: PositionLeg[]): Spread[] {
    const shorts = group
      .filter((l) => l.quantity < 0)
      .sort((a, b) => a.strike - b.strike);
    const longs = group
      .filter((l) => l.quantity > 0)
      .sort((a, b) => a.strike - b.strike);
    const paired: Spread[] = [];
    const usedLongs = new Set<number>();

    for (const short of shorts) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < longs.length; i++) {
        if (usedLongs.has(i)) continue;
        const leg = longs[i]!;
        const dist = Math.abs(leg.strike - short.strike);
        if (dist < bestDist && dist <= 50) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        usedLongs.add(bestIdx);
        const long = longs[bestIdx]!;
        const credit =
          Math.abs(short.averagePrice) - Math.abs(long.averagePrice);
        const currentValue =
          Math.abs(short.marketValue) - Math.abs(long.marketValue);
        const pnl = credit * 100 * Math.abs(short.quantity) - currentValue;
        const width = Math.abs(long.strike - short.strike);
        const type =
          short.putCall === 'CALL' ? 'CALL CREDIT SPREAD' : 'PUT CREDIT SPREAD';
        paired.push({
          type,
          shortLeg: short,
          longLeg: long,
          credit: Math.round(credit * 100) / 100,
          currentValue: Math.round(currentValue * 100) / 100,
          pnl: Math.round(pnl * 100) / 100,
          pnlPct:
            credit > 0
              ? Math.round(
                  (pnl / (credit * 100 * Math.abs(short.quantity))) * 10000,
                ) / 100
              : 0,
          width,
        });
      } else {
        paired.push({
          type: 'SINGLE',
          shortLeg: short,
          credit: Math.abs(short.averagePrice),
          currentValue: Math.abs(short.marketValue),
          pnl:
            Math.abs(short.averagePrice) * 100 * Math.abs(short.quantity) -
            Math.abs(short.marketValue),
          pnlPct: 0,
          width: 0,
        });
      }
    }
    return paired;
  }

  spreads.push(...pairLegs(calls), ...pairLegs(puts));
  return spreads;
}

// ── Human-readable summary ───────────────────────────────────

/**
 * Generate a human-readable summary string for the Schwab GET path.
 * The CSV POST path uses buildFullSummary from csv-parser.ts instead
 * (which has trade-history + account context the live API doesn't see).
 */
export function buildSummary(
  spreads: Spread[],
  legs: PositionLeg[],
  spxPrice?: number,
): string {
  if (spreads.length === 0) return 'No open SPX 0DTE positions.';

  const callSpreads = spreads.filter((s) => s.type === 'CALL CREDIT SPREAD');
  const putSpreads = spreads.filter((s) => s.type === 'PUT CREDIT SPREAD');
  const lines: string[] = [];

  lines.push(
    `=== Open SPX 0DTE Positions (${spreads.length} spread${spreads.length > 1 ? 's' : ''}) ===`,
  );
  if (spxPrice) lines.push(`SPX at fetch time: ${spxPrice}`);
  lines.push('');

  if (callSpreads.length > 0) {
    lines.push(`CALL CREDIT SPREADS (${callSpreads.length}):`);
    for (const s of callSpreads) {
      const cushion = spxPrice
        ? Math.round(s.shortLeg.strike - spxPrice)
        : null;
      lines.push(
        `  Short ${s.shortLeg.strike}C / Long ${s.longLeg?.strike ?? '?'}C | ${Math.abs(s.shortLeg.quantity)} contracts | ` +
          `Credit: $${s.credit.toFixed(2)} | Width: ${s.width} pts` +
          (cushion != null ? ` | Cushion: ${cushion} pts above SPX` : '') +
          (s.shortLeg.delta != null
            ? ` | Delta: ${s.shortLeg.delta.toFixed(3)}`
            : ''),
      );
    }
    lines.push('');
  }

  if (putSpreads.length > 0) {
    lines.push(`PUT CREDIT SPREADS (${putSpreads.length}):`);
    for (const s of putSpreads) {
      const cushion = spxPrice
        ? Math.round(spxPrice - s.shortLeg.strike)
        : null;
      lines.push(
        `  Short ${s.shortLeg.strike}P / Long ${s.longLeg?.strike ?? '?'}P | ${Math.abs(s.shortLeg.quantity)} contracts | ` +
          `Credit: $${s.credit.toFixed(2)} | Width: ${s.width} pts` +
          (cushion != null ? ` | Cushion: ${cushion} pts below SPX` : '') +
          (s.shortLeg.delta != null
            ? ` | Delta: ${s.shortLeg.delta.toFixed(3)}`
            : ''),
      );
    }
    lines.push('');
  }

  const totalDelta = legs.reduce(
    (sum, l) => sum + (l.delta ?? 0) * l.quantity,
    0,
  );
  const totalTheta = legs.reduce(
    (sum, l) => sum + (l.theta ?? 0) * Math.abs(l.quantity),
    0,
  );
  const totalPnl = spreads.reduce((sum, s) => sum + s.pnl, 0);
  lines.push(
    'AGGREGATE:',
    `  Net delta: ${totalDelta.toFixed(3)} | Net theta: ${totalTheta.toFixed(2)}`,
    `  Total unrealized P&L: $${totalPnl.toFixed(2)}`,
  );

  const shortCalls = callSpreads
    .map((s) => s.shortLeg.strike)
    .sort((a, b) => a - b);
  const shortPuts = putSpreads
    .map((s) => s.shortLeg.strike)
    .sort((a, b) => b - a);

  if (shortCalls.length > 0) {
    const nearest = shortCalls[0]!;
    lines.push(
      `  Nearest short call: ${nearest}` +
        (spxPrice ? ` (${Math.round(nearest - spxPrice)} pts above SPX)` : ''),
    );
  }
  if (shortPuts.length > 0) {
    const nearest = shortPuts[0]!;
    lines.push(
      `  Nearest short put: ${nearest}` +
        (spxPrice ? ` (${Math.round(spxPrice - nearest)} pts below SPX)` : ''),
    );
  }

  return lines.join('\n');
}

// ── Aggregate response builder ───────────────────────────────

export interface PositionResponse {
  summary: string;
  spreads: Spread[];
  callSpreadsCount: number;
  putSpreadsCount: number;
  totalPnl: number;
  totalCredit: number;
  totalValue: number;
  netDelta: number;
  netTheta: number;
  netGamma: number;
}

/**
 * Group + summarize + aggregate. Single entry point used by both
 * handlers; each then layers handler-specific stats on top.
 */
export function buildPositionResponse(
  spxLegs: PositionLeg[],
  spxPrice?: number,
): PositionResponse {
  const spreads = groupIntoSpreads(spxLegs);
  const callSpreads = spreads.filter((s) => s.type === 'CALL CREDIT SPREAD');
  const putSpreads = spreads.filter((s) => s.type === 'PUT CREDIT SPREAD');
  const summary = buildSummary(spreads, spxLegs, spxPrice);
  const totalPnl = spreads.reduce((sum, s) => sum + s.pnl, 0);
  const totalCredit = spreads.reduce(
    (sum, s) => sum + s.credit * 100 * Math.abs(s.shortLeg.quantity),
    0,
  );
  const totalValue = spreads.reduce((sum, s) => sum + s.currentValue, 0);
  const netDelta = spxLegs.reduce(
    (sum, l) => sum + (l.delta ?? 0) * l.quantity,
    0,
  );
  const netTheta = spxLegs.reduce(
    (sum, l) => sum + (l.theta ?? 0) * Math.abs(l.quantity),
    0,
  );
  const netGamma = spxLegs.reduce(
    (sum, l) => sum + (l.gamma ?? 0) * Math.abs(l.quantity),
    0,
  );

  return {
    summary,
    spreads,
    callSpreadsCount: callSpreads.length,
    putSpreadsCount: putSpreads.length,
    totalPnl,
    totalCredit,
    totalValue,
    netDelta,
    netTheta,
    netGamma,
  };
}
