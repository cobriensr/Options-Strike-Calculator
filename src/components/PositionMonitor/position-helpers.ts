/**
 * Shared formatting and display helpers for position table rows.
 */

import type { DailyStatement, Spread } from './types';

// ── Table cell class constants ───────────────────────────────

export const TD_CLASS = 'px-3 py-2 text-right font-mono text-sm';
export const TD_LEFT = 'px-3 py-2 text-left font-mono text-sm';

// ── Formatting ───────────────────────────────────────────────

export function formatCurrency(value: number): string {
  if (value < 0) {
    return `($${Math.abs(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })})`;
  }
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPct(value: number | null): string {
  if (value === null) return '\u2014';
  return `${value.toFixed(1)}%`;
}

export function formatTime(time: string | null): string {
  if (!time) return '\u2014';
  return time;
}

export function pnlColor(value: number | null): string {
  if (value === null) return 'text-muted';
  if (value > 0) return 'text-success';
  if (value < 0) return 'text-danger';
  return 'text-primary';
}

export function spreadStrikeLabel(s: Spread): string {
  const short = s.shortLeg.strike;
  const long = s.longLeg.strike;
  return `${short}/${long}`;
}

export function spreadTypeLabel(s: Spread): string {
  return s.spreadType === 'PUT_CREDIT_SPREAD' ? 'PCS' : 'CCS';
}

/** Cushion: distance from spot to short strike as % of spot */
export function cushionPct(s: Spread, spot: number): number | null {
  if (spot <= 0) return null;
  return s.distanceToShortStrikePct ?? null;
}

/**
 * Format a parsed DailyStatement into a clean position summary
 * for Claude analysis context. Uses the spread-builder's parsed
 * pairs (from Trade History) so Claude correctly sees defined-risk
 * spreads, not naked legs from the flat Options section.
 */
export function formatPositionSummaryForClaude(
  statement: DailyStatement,
  spotPrice: number,
): string {
  const lines: string[] = [];

  for (const ic of statement.ironCondors) {
    const putStrike = `${ic.putSpread.shortLeg.strike}/${ic.putSpread.longLeg.strike}`;
    const callStrike = `${ic.callSpread.shortLeg.strike}/${ic.callSpread.longLeg.strike}`;
    lines.push(
      `IC ${putStrike}p / ${callStrike}c x${ic.contracts} — ` +
        `credit $${ic.totalCredit.toFixed(2)}, ` +
        `max loss $${ic.maxLoss.toFixed(0)}, ` +
        `wing ${ic.putWingWidth}/${ic.callWingWidth} wide`,
    );
  }

  const sorted = [...statement.spreads].sort(
    (a, b) => a.shortLeg.strike - b.shortLeg.strike,
  );
  for (const s of sorted) {
    const type = s.spreadType === 'PUT_CREDIT_SPREAD' ? 'PCS' : 'CCS';
    const strikes = `${s.shortLeg.strike}/${s.longLeg.strike}`;
    const cushion =
      s.distanceToShortStrike != null
        ? `${s.distanceToShortStrike.toFixed(0)} pts cushion`
        : '';
    const pctMax =
      s.pctOfMaxProfit != null ? `${s.pctOfMaxProfit.toFixed(0)}% max` : '';
    lines.push(
      `${type} ${strikes} x${s.contracts} — ` +
        `credit $${s.creditReceived.toFixed(2)}, ` +
        `max loss $${s.maxLoss.toFixed(0)}, ` +
        `${s.wingWidth} wide` +
        (cushion ? `, ${cushion}` : '') +
        (pctMax ? `, ${pctMax}` : ''),
    );
  }

  for (const h of statement.hedges) {
    lines.push(
      `HEDGE: Long ${h.leg.strike} ${h.protectionSide} x${h.contracts} — ` +
        `cost $${h.entryCost.toFixed(2)}`,
    );
  }

  if (lines.length === 0) return '';

  const totalCredit =
    statement.spreads.reduce((sum, sp) => sum + sp.creditReceived, 0) +
    statement.ironCondors.reduce((sum, ic) => sum + ic.totalCredit, 0);
  const totalMaxLoss = statement.portfolioRisk.totalMaxLoss;

  const header =
    `${statement.spreads.length + statement.ironCondors.length} defined-risk positions ` +
    `(all vertical spreads, NO naked legs). ` +
    `Total credit: $${totalCredit.toFixed(2)}, ` +
    `Total max loss: $${totalMaxLoss.toFixed(0)}. ` +
    `SPX at ${spotPrice.toFixed(2)}.`;

  return header + '\n' + lines.join('\n');
}
