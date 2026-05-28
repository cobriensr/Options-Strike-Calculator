/**
 * Colour-band class lookup for the Take-It tile, split into its own file
 * so the TakeItScore component module exports only components (keeps
 * Vite's `react-refresh/only-export-components` rule happy).
 *
 * Bands per spec docs/superpowers/specs/alert-takeit-score-2026-05-16.md
 * decision #6:
 *    < 0.40    red          take with caution
 *    0.40–0.55 amber        coin-flip
 *    0.55–0.70 green        decent
 *    > 0.70    deep green   strong
 */
export function takeitProbClass(prob: number | null | undefined): string {
  if (prob == null) {
    return 'border-neutral-700 bg-neutral-900 text-neutral-400';
  }
  if (Number.isNaN(prob)) {
    return 'border-neutral-700 bg-neutral-900 text-neutral-400';
  }
  if (prob >= 0.7)
    return 'border-emerald-400/60 bg-emerald-950/50 text-emerald-200';
  if (prob >= 0.55) return 'border-green-500/40 bg-green-950/30 text-green-200';
  if (prob >= 0.4) return 'border-amber-500/40 bg-amber-950/30 text-amber-200';
  return 'border-rose-500/40 bg-rose-950/30 text-rose-200';
}
