/**
 * BWB Live Calculator — pure math functions.
 *
 * Standalone module with zero dependencies on the rest of the app.
 * Supports both call and put BWBs with real trade prices.
 */

export type BWBSide = 'calls' | 'puts';

export interface BWBMetrics {
  /** Positive = credit received, negative = debit paid (points) */
  net: number;
  narrowWidth: number;
  wideWidth: number;
  /** Max profit at the sweet spot (points) */
  maxProfit: number;
  /** P&L on the safe side = net (points) */
  safePnl: number;
  /** P&L on the risk side (points, typically negative) */
  riskPnl: number;
  /** Lower breakeven SPX level, null if no BE in range */
  lowerBE: number | null;
  /** Upper breakeven SPX level, null if no BE in range */
  upperBE: number | null;
  /** Sweet spot = mid strike */
  sweetSpot: number;
}

export interface PnlRow {
  spx: number;
  /** P&L in points (per contract) */
  pnlPts: number;
  /** P&L in dollars (per contract, ×$100) */
  pnlPerContract: number;
  /** P&L in dollars (total, ×$100 × contracts) */
  pnlTotal: number;
  /** Label for key levels */
  label: string;
  /** Whether this is a key level (bold in UI) */
  isKey: boolean;
}

/**
 * Net credit/debit per contract (points).
 * Positive = credit received, negative = debit paid.
 */
export function calcNet(
  lowPrice: number,
  midPrice: number,
  highPrice: number,
): number {
  return 2 * midPrice - lowPrice - highPrice;
}

/**
 * P&L at a given SPX price at expiry (per contract, points).
 *
 * Call BWB: Buy 1 low call, Sell 2 mid calls, Buy 1 high call
 * Put BWB: Buy 1 low put, Sell 2 mid puts, Buy 1 high put
 */
export function calcPnl(
  side: BWBSide,
  low: number,
  mid: number,
  high: number,
  net: number,
  spx: number,
): number {
  if (side === 'calls') {
    return (
      Math.max(spx - low, 0) -
      2 * Math.max(spx - mid, 0) +
      Math.max(spx - high, 0) +
      net
    );
  }
  return (
    Math.max(low - spx, 0) -
    2 * Math.max(mid - spx, 0) +
    Math.max(high - spx, 0) +
    net
  );
}

/**
 * Compute all key BWB metrics from strikes and net credit/debit.
 *
 * For calls: narrow = mid−low, wide = high−mid, safe side = below low
 * For puts:  narrow = high−mid, wide = mid−low, safe side = above high
 */
export function calcMetrics(
  side: BWBSide,
  low: number,
  mid: number,
  high: number,
  net: number,
): BWBMetrics {
  const narrowWidth = side === 'calls' ? mid - low : high - mid;
  const wideWidth = side === 'calls' ? high - mid : mid - low;
  const maxProfit = narrowWidth + net;
  const safePnl = net;
  const riskPnl = -(wideWidth - narrowWidth) + net;

  let lowerBE: number | null;
  let upperBE: number | null;

  if (side === 'calls') {
    // Lower BE: between low and mid → S = low − net
    const lb = low - net;
    lowerBE = lb > low && lb < mid ? lb : null;
    // Upper BE: between mid and high → S = 2×mid − low + net
    const ub = 2 * mid - low + net;
    upperBE = ub > mid && ub < high ? ub : null;
  } else {
    // Upper BE: between mid and high → S = high + net
    const ub = high + net;
    upperBE = ub > mid && ub < high ? ub : null;
    // Lower BE: between low and mid → S = 2×mid − high − net
    const lb = 2 * mid - high - net;
    lowerBE = lb > low && lb < mid ? lb : null;
  }

  return {
    net,
    narrowWidth,
    wideWidth,
    maxProfit,
    safePnl,
    riskPnl,
    lowerBE,
    upperBE,
    sweetSpot: mid,
  };
}

/**
 * Generate P&L profile rows at 5-pt intervals plus exact breakevens.
 */
export function generatePnlRows(
  side: BWBSide,
  low: number,
  mid: number,
  high: number,
  net: number,
  contracts: number,
): PnlRow[] {
  const metrics = calcMetrics(side, low, mid, high, net);
  const mult = 100 * contracts;
  const step = 5;
  const padding = Math.max(
    20,
    Math.ceil(((high - low) * 0.3) / step) * step,
  );
  const start = Math.floor((low - padding) / step) * step;
  const end = Math.ceil((high + padding) / step) * step;

  // Deduplicate by rounded key
  const levelMap = new Map<string, number>();
  for (let s = start; s <= end; s += step) {
    levelMap.set(s.toFixed(2), s);
  }
  if (metrics.lowerBE !== null) {
    levelMap.set(metrics.lowerBE.toFixed(2), metrics.lowerBE);
  }
  if (metrics.upperBE !== null) {
    levelMap.set(metrics.upperBE.toFixed(2), metrics.upperBE);
  }

  const sorted = [...levelMap.values()].sort((a, b) => a - b);

  return sorted.map((spx) => {
    const pnl = calcPnl(side, low, mid, high, net, spx);
    const isLowerBE =
      metrics.lowerBE !== null && Math.abs(spx - metrics.lowerBE) < 0.001;
    const isUpperBE =
      metrics.upperBE !== null && Math.abs(spx - metrics.upperBE) < 0.001;
    const isSweetSpot = Math.abs(spx - mid) < 0.001;

    let label = '';
    if (isSweetSpot) {
      label = 'Max profit';
    } else if (isLowerBE || isUpperBE) {
      label = 'Breakeven';
    } else if (
      (side === 'calls' && spx <= start) ||
      (side === 'puts' && spx >= end)
    ) {
      label = net >= 0 ? 'Credit kept' : 'Debit lost';
    } else if (
      (side === 'calls' && spx >= end) ||
      (side === 'puts' && spx <= start)
    ) {
      label = 'Max loss (capped)';
    }

    return {
      spx,
      pnlPts: pnl,
      pnlPerContract: Math.round(pnl * 100),
      pnlTotal: Math.round(pnl * mult),
      label,
      isKey: isSweetSpot || isLowerBE || isUpperBE,
    };
  });
}

/** Format a SPX level for display (e.g. 6481.50 or 6500) */
export function fmtSpx(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

/** Format dollar amount with sign and commas */
export function fmtPnl(dollars: number): string {
  const abs = Math.abs(dollars);
  const formatted =
    abs >= 100 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(0);
  if (dollars > 0.5) return '+$' + formatted;
  if (dollars < -0.5) return '-$' + formatted;
  return '$0';
}
