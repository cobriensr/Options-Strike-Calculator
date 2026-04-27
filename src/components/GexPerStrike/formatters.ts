/**
 * Display formatters for GEX-per-strike readouts.
 *
 * Number compaction uses K/M/B/T suffixes; flow pressure switches from
 * percent to multiplier once the ratio exceeds 100% to keep the readout
 * intelligible when standing OI gamma nets to near zero.
 *
 * CT-anchored time formatting lives in `src/utils/component-formatters.ts`
 * (`formatTimeCT`) — import from there rather than defining a local copy.
 */

export function formatNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

/**
 * Format a flow-pressure ratio for display.
 *
 * The raw metric is `|vol| / |oi| × 100`. In normal regimes this sits
 * between 0 and ~200%, but when the visible window has near-balanced OI
 * gamma (call walls canceling put walls), the denominator collapses and
 * the ratio can spike into the thousands. Showing "7269%" is technically
 * correct but not readable.
 *
 * Display rule:
 *   - ≤100%: show as percentage ("85%")
 *   - >100%: show as multiplier ("72.7×")
 */
export function formatFlowPressure(pct: number): string {
  if (pct <= 100) return `${pct.toFixed(0)}%`;
  return `${(pct / 100).toFixed(1)}\u00D7`;
}
