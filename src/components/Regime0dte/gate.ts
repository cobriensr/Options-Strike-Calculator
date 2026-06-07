/**
 * Gate presentation metadata for the 0DTE Gamma Regime panel. Kept in a
 * non-component module so the panel file only exports a component (satisfies
 * Vite's react-refresh/only-export-components rule).
 *
 * Maps the graded gamma `Gate` to a human label and a Tailwind colour family:
 *   - calm      → emerald / neutral ("positive gamma, mean-revert")
 *   - big_move  → amber           ("two-sided, direction unconfirmed")
 *   - lean_down → red             ("deep negative gamma, downside lean")
 *   - unknown   → slate           (insufficient data)
 */

import type { Gate } from '../../hooks/useRegime0dte';

export interface GateMeta {
  /** Short human label shown in the chip. */
  label: string;
  /** Screen-reader description so state is conveyed by text, not colour alone. */
  ariaLabel: string;
  /** Tailwind classes for the chip (bg + border + text). */
  chipClass: string;
}

const GATE_META: Record<Gate, GateMeta> = {
  calm: {
    label: 'Calm / mean-revert',
    ariaLabel: 'Gamma gate: calm — positive gamma, mean-revert / tight range',
    chipClass: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
  },
  big_move: {
    label: 'Big move likely',
    ariaLabel: 'Gamma gate: big move likely, direction unconfirmed',
    chipClass: 'border-amber-500/40 bg-amber-500/15 text-amber-200',
  },
  lean_down: {
    label: 'Lean down',
    ariaLabel: 'Gamma gate: lean down — deep negative gamma, downside risk',
    chipClass: 'border-red-500/40 bg-red-500/15 text-red-200',
  },
  unknown: {
    label: '—',
    ariaLabel: 'Gamma gate: unknown — insufficient data',
    chipClass: 'border-slate-600/50 bg-slate-700/30 text-slate-300',
  },
};

export function gateMeta(gate: Gate): GateMeta {
  return GATE_META[gate] ?? GATE_META.unknown;
}
