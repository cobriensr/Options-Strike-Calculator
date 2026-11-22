/**
 * Compact number formatter for the Greek-flow panel: the chart's axis
 * labels and the flip and cliff badges' magnitudes read the same way.
 * Cumulative Greek flow values range from ~1e2 to ~1e7+, so Intl's
 * short compact form (`1.2K`, `123.5M`) keeps the label legible without
 * per-magnitude branching. A value that is not finite shows as an em dash.
 *
 * Its own module, not a function exported from `FlowChart.tsx`, so the
 * component files keep exporting only components (Fast Refresh).
 */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
}
