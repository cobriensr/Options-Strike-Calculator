/**
 * Shared on-screen height (CSS px) for the two expanded-row chart
 * panels — ContractTapeChart (left) and TickerNetFlowChart (right) —
 * in LotteryRow / SilentBoomRow / IntervalBARow.
 *
 * Guest feedback 2026-06-12: the left SVG scaled with column width
 * (~450px+ tall on a maximized window) while the right chart was fixed
 * at 220px. Pin both to one height; tune here only.
 */
export const EXPANDED_ROW_CHART_HEIGHT = 280;

/**
 * ViewBox height for a fixed-pixel-height SVG render: keeps SVG units
 * square by matching the viewBox aspect to the rendered CSS box.
 * Returns `fallback` until the container has a real measured width
 * (e.g. jsdom, pre-mount).
 */
export function viewBoxHeightFor(
  viewW: number,
  pixelHeight: number,
  measuredWidth: number | null,
  fallback: number,
): number {
  if (measuredWidth == null || measuredWidth <= 0) return fallback;
  return (viewW * pixelHeight) / measuredWidth;
}
