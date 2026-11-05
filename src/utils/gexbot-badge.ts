/**
 * Shared GexBot context-badge factory used by both SilentBoomRow and
 * LotteryRow. Previously this was a 53-line literal clone across both
 * components; now both feeds import the same function so any tweak to
 * the tooltip / direction logic / aria-label happens in one place.
 *
 * The badge is informational only — it does NOT participate in
 * filtering or sorting. It shows GEXBot taker-flow values captured at fire
 * time (see `docs/superpowers/specs/silent-boom-gexbot-instrumentation-2026-05-26.md`).
 */

import type { GexbotFireContext } from '../types/gexbot.js';

export interface GexbotBadgeSpec {
  label: string;
  cls: string;
  tooltip: string;
  /**
   * Terse single-line aria-label. Newlines tokenize unpredictably
   * across screen-reader engines, so the verbose multi-line `tooltip`
   * stays in the `title` attribute and the SR-facing label is one
   * sentence.
   */
  ariaLabel: string;
}

/** The three flow lines are one 1-2 s vendor step, not a per-minute rate. */
const STEP_NOTE = '(1–2 s vendor step at fire time)';

export function gexbotBadge(gex: GexbotFireContext): GexbotBadgeSpec | null {
  if (gex.capturedAt == null) return null;
  const cvr = gex.oneCvroflow;
  // Split at 0: positive up, negative down, exactly 0 a dash, no value a dot.
  const direction = cvr == null ? '·' : cvr > 0 ? '↑' : cvr < 0 ? '↓' : '—';
  const arrowWord =
    direction === '↑' ? 'up' : direction === '↓' ? 'down' : 'flat';
  const cvrStr = cvr == null ? '—' : cvr.toFixed(2);
  const zcvrStr = gex.zcvr == null ? '—' : gex.zcvr.toFixed(2);
  const dexStr = gex.netPutDex == null ? '—' : gex.netPutDex.toFixed(0);
  const dexoStr = gex.oneDexoflow == null ? '—' : gex.oneDexoflow.toFixed(2);
  const gexoStr = gex.oneGexoflow == null ? '—' : gex.oneGexoflow.toFixed(2);
  const zg =
    gex.zeroGamma != null && gex.spot != null
      ? `zero-γ ${gex.zeroGamma.toFixed(0)} vs spot ${gex.spot.toFixed(0)} (Δ ${(gex.zeroGamma - gex.spot).toFixed(0)})`
      : 'zero-γ unavailable';
  const tooltip = [
    'GEXBot taker-flow snapshot at fire time (informational; not used in score).',
    `Next-expiry cvroflow: ${cvrStr}  ${direction} ${STEP_NOTE}`,
    `Net convexity (zcvr): ${zcvrStr}`,
    `Net put DEX: ${dexStr}`,
    `Next-expiry dexoflow: ${dexoStr} ${STEP_NOTE}`,
    `Next-expiry gexoflow: ${gexoStr} ${STEP_NOTE}`,
    zg,
    `Snapshot at: ${gex.capturedAt} (UTC)`,
  ].join('\n');
  return {
    label: `GEX ${direction}${cvrStr}`,
    cls: 'border-sky-500/50 bg-sky-950/40 text-sky-200',
    tooltip,
    ariaLabel: `GexBot snapshot: next-expiry cvroflow ${cvrStr} ${arrowWord}`,
  };
}
