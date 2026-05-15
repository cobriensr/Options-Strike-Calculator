/**
 * Hover-tooltip strings for the Greek heatmap cells.
 *
 * These render on hover over each cell in `<GreekHeatmapTable>`. Keep
 * strings short (target ≤120 chars per tooltip) and trader-facing — the
 * goal is "what does this value mean for my exit-timing decision?", not
 * a textbook definition.
 *
 * Owner-customized copy lives here. The strings below are a working
 * default that renders cleanly so the heatmap ships without blocking
 * on wording — they are intentionally generic and meant to be replaced
 * with the owner's own trader-facing phrasing as the read patterns
 * settle. See spec section "User contribution (learning mode)" in
 * docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md.
 */

export const GREEK_TOOLTIPS = {
  /** Net (call + put) gamma OI at this strike is positive. */
  gammaPositive:
    '+Γ wall — dealer is long gamma here. Hedging is suppressive: sells rallies, buys dips. Price tends to pin or mean-revert.',
  /** Net gamma OI is negative. */
  gammaNegative:
    '-Γ pocket — dealer is short gamma. Hedging is procyclical: buys rallies, sells dips. Expect breakouts to extend.',
  /** Net charm OI is positive. */
  charmPositive:
    '+Charm — delta decays toward 0 as time passes. Dealers must sell into rallies as expiry approaches. EoD drift down for OTM calls.',
  /** Net charm OI is negative. */
  charmNegative:
    '-Charm — delta builds toward ±1 as time passes. Dealers must buy into rallies. EoD drift up for ITM calls / down for ITM puts.',
  /** Net vanna OI is positive. */
  vannaPositive:
    '+Vanna — delta rises as IV rises. If vol spikes here, dealers must buy underlying to hedge. Bullish on vol expansion.',
  /** Net vanna OI is negative. */
  vannaNegative:
    '-Vanna — delta falls as IV rises. If vol spikes here, dealers must sell underlying to hedge. Bearish on vol expansion.',
  /** No data (zero or null). */
  zero: 'No measurable exposure at this strike.',
} as const;

export type GreekTooltipKey = keyof typeof GREEK_TOOLTIPS;

/**
 * Pick the right tooltip for a (greek, value) pair. Treats exact 0 as
 * "zero"; any non-zero value picks the positive/negative variant.
 */
export function tooltipFor(
  greek: 'gamma' | 'charm' | 'vanna',
  value: number | null,
): string {
  if (value === null || value === 0) return GREEK_TOOLTIPS.zero;
  if (value > 0) {
    if (greek === 'gamma') return GREEK_TOOLTIPS.gammaPositive;
    if (greek === 'charm') return GREEK_TOOLTIPS.charmPositive;
    return GREEK_TOOLTIPS.vannaPositive;
  }
  if (greek === 'gamma') return GREEK_TOOLTIPS.gammaNegative;
  if (greek === 'charm') return GREEK_TOOLTIPS.charmNegative;
  return GREEK_TOOLTIPS.vannaNegative;
}
