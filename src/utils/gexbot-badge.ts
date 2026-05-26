/**
 * Shared GexBot context-badge factory used by both SilentBoomRow and
 * LotteryRow. Previously this was a 53-line literal clone across both
 * components; now both feeds import the same function so any tweak to
 * the tooltip / direction logic / aria-label happens in one place.
 *
 * The badge is informational only — it does NOT participate in
 * filtering or sorting until the takeit retrain absorbs the gex_*
 * features (target: 2026-06-16 re-probe, see
 * `docs/superpowers/specs/silent-boom-gexbot-instrumentation-2026-05-26.md`).
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

export function gexbotBadge(gex: GexbotFireContext): GexbotBadgeSpec | null {
  if (gex.capturedAt == null) return null;
  const cvr = gex.oneCvroflow;
  const direction = cvr == null ? '·' : cvr > 1 ? '↑' : cvr < 1 ? '↓' : '·';
  const arrowWord =
    direction === '↑' ? 'up' : direction === '↓' ? 'down' : 'flat';
  const cvrStr = cvr == null ? '—' : cvr.toFixed(2);
  const zcvrStr = gex.zcvr == null ? '—' : gex.zcvr.toFixed(2);
  const dexStr =
    gex.netPutDex == null ? '—' : (gex.netPutDex / 1e6).toFixed(1) + 'M';
  const dexoStr = gex.oneDexoflow == null ? '—' : gex.oneDexoflow.toFixed(2);
  const gexoStr = gex.oneGexoflow == null ? '—' : gex.oneGexoflow.toFixed(2);
  const zg =
    gex.zeroGamma != null && gex.spot != null
      ? `zero-γ ${gex.zeroGamma.toFixed(0)} vs spot ${gex.spot.toFixed(0)} (Δ ${(gex.zeroGamma - gex.spot).toFixed(0)})`
      : 'zero-γ unavailable';
  const tooltip = [
    'GexBot snapshot at fire time (informational; not used in score yet).',
    `1DTE+ cvroflow: ${cvrStr}  ${direction}  — +0.20 r vs hit-30 in 2026-05-26 probe`,
    `0DTE cvroflow (zcvr): ${zcvrStr}`,
    `Net put DEX: ${dexStr}  — +0.17 r vs hit-50`,
    `1DTE+ dexoflow: ${dexoStr}  — +0.19 r vs hit-30`,
    `1DTE+ gexoflow: ${gexoStr}  — −0.16 r (anti-signal)`,
    zg,
    `Snapshot at: ${gex.capturedAt} (UTC)`,
  ].join('\n');
  return {
    label: `GEX ${direction}${cvrStr}`,
    cls: 'border-sky-500/50 bg-sky-950/40 text-sky-200',
    tooltip,
    ariaLabel: `GexBot snapshot: 1DTE+ cvroflow ${cvrStr} ${arrowWord}`,
  };
}
