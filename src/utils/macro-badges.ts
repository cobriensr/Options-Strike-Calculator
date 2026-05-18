/**
 * Macro context badges rendered next to each Silent Boom / Lottery
 * Finder row.
 *
 * - `tideBadge` — market-wide NCP − NPP at fire time (display-only;
 *   per lottery's spec Appendix A this is regime context, not a
 *   selection signal).
 * - `flowBadge` — per-ticker NCP − NPP at fire time. Distinct from
 *   the live `Flow Match` badge: this chip is FROZEN at the fire
 *   moment, while `Flow Match` drifts intraday with the live tape.
 *
 * Both badges share an identical structural contract (positive ⇒
 * green, negative ⇒ red, zero ⇒ neutral, null ⇒ hidden) so the row
 * JSX can render them with the same template.
 */

export interface MacroBadgeView {
  label: string;
  cls: string;
  tooltip: string;
}

// Intentionally dimmer than `src/components/ui/filter-toolbar-tokens.ts`
// CHIP_ACTIVE palette (which uses /70 border + /40 bg). Tide and Flow
// chips are informational display-only context, not interactive
// filter chips — the lower opacity keeps them visually subordinate
// so the eye lands on score/tier/filter chips first.
const GREEN_CLS = 'border-green-500/40 bg-green-950/30 text-green-200';
const RED_CLS = 'border-red-500/40 bg-red-950/30 text-red-200';
const NEUTRAL_CLS = 'border-neutral-700 bg-neutral-900 text-neutral-300';

function arrowFor(diff: number): string {
  if (diff > 0) return '⬆';
  if (diff < 0) return '⬇';
  return '→';
}

function classFor(diff: number): string {
  if (diff > 0) return GREEN_CLS;
  if (diff < 0) return RED_CLS;
  return NEUTRAL_CLS;
}

export function tideBadge(diff: number | null): MacroBadgeView | null {
  if (diff == null) return null;
  return {
    label: `Tide ${arrowFor(diff)}`,
    cls: classFor(diff),
    tooltip: `Market Tide NCP − NPP at the spike-bucket / fire time = ${diff.toFixed(0)}. Display-only macro context, not a selection signal.`,
  };
}

export function flowBadge(diff: number | null): MacroBadgeView | null {
  if (diff == null) return null;
  return {
    label: `Flow ${arrowFor(diff)}`,
    cls: classFor(diff),
    tooltip: `Per-ticker net flow at fire time: NCP − NPP = ${diff.toFixed(0)}. Sign-only direction; used by the hide counter-flow filter. Distinct from the live Flow Match badge.`,
  };
}

/**
 * Safe NCP − NPP subtraction. Returns null whenever either input is
 * missing or non-finite so callers can render-hide the chip and the
 * counter-flow filter never accidentally drops a row whose snapshot
 * wasn't captured.
 */
export function deltaFromAtFire(
  ncp: number | null | undefined,
  npp: number | null | undefined,
): number | null {
  if (ncp == null || npp == null) return null;
  if (!Number.isFinite(ncp) || !Number.isFinite(npp)) return null;
  return ncp - npp;
}
