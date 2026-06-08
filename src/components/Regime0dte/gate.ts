/**
 * Gate presentation metadata for the 0DTE Gamma Regime panel. Kept in a
 * non-component module so the panel file only exports a component (satisfies
 * Vite's react-refresh/only-export-components rule).
 *
 * Maps the graded gamma `Gate` to a human label and a Tailwind colour family:
 *   - calm      → emerald / neutral ("positive gamma, mean-revert")
 *   - big_move  → amber           ("two-sided, direction unconfirmed")
 *   - lean_down → red             ("deep negative gamma, downside lean")
 *   - unknown   → "No read" (insufficient data / pre-open / data outage)
 *
 * `unknown` is deliberately NOT styled like the three real verdicts: it is a
 * dashed/hollow "no read" chip prefixed with a glyph, so it cannot be mistaken
 * for `calm`/neutral. For a downside-risk gate, presenting "no data" as if it
 * were a calm verdict is dangerous — the `isReal: false` flag lets the panel
 * render it distinctly (dashed border, em-dash glyph, "no read" copy).
 */

import type { Gate } from '../../hooks/useRegime0dte';

export interface GateMeta {
  /** Short human label shown in the chip. */
  label: string;
  /** Screen-reader description so state is conveyed by text, not colour alone. */
  ariaLabel: string;
  /** Tailwind classes for the chip (bg + border + text). */
  chipClass: string;
  /**
   * Whether this is a genuine regime verdict (calm/big_move/lean_down) vs the
   * `unknown` "no read" state. The panel renders the no-read chip distinctly
   * (dashed/hollow + glyph) so it is never confused with a calm verdict.
   */
  isReal: boolean;
}

const GATE_META: Record<Gate, GateMeta> = {
  calm: {
    label: 'Calm / mean-revert',
    ariaLabel: 'Gamma gate: calm — positive gamma, mean-revert / tight range',
    chipClass: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
    isReal: true,
  },
  big_move: {
    label: 'Big move likely',
    ariaLabel: 'Gamma gate: big move likely, direction unconfirmed',
    chipClass: 'border-amber-500/40 bg-amber-500/15 text-amber-200',
    isReal: true,
  },
  lean_down: {
    label: 'Lean down',
    ariaLabel: 'Gamma gate: lean down — deep negative gamma, downside risk',
    chipClass: 'border-red-500/40 bg-red-500/15 text-red-200',
    isReal: true,
  },
  unknown: {
    // Deliberately distinct from the three real verdicts: a dashed/hollow
    // "no read" chip (not a muted slate look-alike of `calm`).
    label: 'No read',
    ariaLabel: 'Gamma gate: no read — insufficient data',
    chipClass:
      'border-dashed border-slate-500/70 bg-transparent text-slate-400',
    isReal: false,
  },
};

export function gateMeta(gate: Gate): GateMeta {
  return GATE_META[gate] ?? GATE_META.unknown;
}
