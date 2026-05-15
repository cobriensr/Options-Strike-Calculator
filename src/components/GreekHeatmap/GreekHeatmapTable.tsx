/**
 * Per-strike Greek heatmap grid (ATM ± 50 strikes).
 *
 * Three columns (Gamma / Charm / Vanna) × one row per strike. Each
 * cell's background is shaded green (positive) or rose (negative) with
 * alpha scaled by `|value| / max-per-column`, so the eye finds the
 * walls instantly. Brightest cell per column gets a ring outline to
 * mark the column's peak. Matches the Periscope visual idiom for
 * "find the dealer wall at a glance".
 *
 * ATM row (closest of the chain to spot) gets a left-border accent +
 * "ATM" badge + bolder text. `highlightedStrike` is a transient state
 * the parent toggles when the user clicks a top-strikes chip; the
 * matched row gets a fading amber ring so the eye locks onto it.
 *
 * Each row has `id={\`heatmap-strike-${strike}\`}` so the parent can
 * `document.getElementById(...).scrollIntoView()` after a chip click.
 *
 * Hover tooltips on every Greek cell come from `./tooltipText.ts`.
 */

import { useMemo } from 'react';

import type { GreekHeatmapTopStrike } from '../../hooks/useGreekHeatmap';

import { tooltipFor } from './tooltipText';

interface GreekHeatmapTableProps {
  chainStrikes: readonly GreekHeatmapTopStrike[];
  atmStrike: number | null;
  highlightedStrike: number | null;
}

function formatGreek(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1_000_000_000)
    return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

/**
 * Build the inline `backgroundColor` + the matching text class for a
 * heatmap cell as a single unit. Alpha scales with `|value| / max`
 * (green for positive, rose for negative; floor 0.08 so non-zero
 * cells stay visibly tinted even when far below the column max).
 *
 * Text color flips to near-black above alpha ≈ 0.45 to keep WCAG-AA
 * contrast (4.5:1+) — the saturated emerald/rose at high alpha
 * washes out white text on a neutral-900 surface. Below the
 * crossover, the dark surface dominates and white reads cleanly.
 *
 * Combined into one helper so the crossover and the alpha formula
 * can't drift out of sync if either is edited.
 */
function cellStyle(
  value: number,
  max: number,
): { bg: string | undefined; textClass: string } {
  if (max === 0 || value === 0) {
    return { bg: undefined, textClass: 'text-neutral-100' };
  }
  const intensity = Math.min(1, Math.abs(value) / max);
  const alpha = 0.08 + intensity * 0.7;
  const bg =
    value > 0
      ? `rgba(34, 197, 94, ${alpha.toFixed(3)})` // emerald-500
      : `rgba(244, 63, 94, ${alpha.toFixed(3)})`; // rose-500
  const textClass = alpha > 0.45 ? 'text-neutral-950' : 'text-neutral-100';
  return { bg, textClass };
}

/** Replace the literal `.` in non-integer strikes (e.g. 562.5) with
 *  `_` so the DOM id is selector-safe. `document.getElementById` is
 *  fine with dots, but any future `querySelector('#heatmap-strike-...')`
 *  would parse the dot as a class separator and silently fail. */
function strikeRowId(strike: number): string {
  return `heatmap-strike-${String(strike).replace('.', '_')}`;
}

export function GreekHeatmapTable({
  chainStrikes,
  atmStrike,
  highlightedStrike,
}: GreekHeatmapTableProps) {
  // Per-column scaling — gamma's billions and vanna's thousands need
  // independent color scales or vanna would look uniformly white.
  const maxAbs = useMemo(() => {
    let g = 0;
    let c = 0;
    let v = 0;
    for (const s of chainStrikes) {
      g = Math.max(g, Math.abs(s.netGamma));
      c = Math.max(c, Math.abs(s.netCharm));
      v = Math.max(v, Math.abs(s.netVanna));
    }
    return { gamma: g, charm: c, vanna: v };
  }, [chainStrikes]);

  if (chainStrikes.length === 0) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-4 text-center text-xs text-neutral-500">
        No strike data for this ticker / date.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-neutral-800">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-neutral-900/95 text-[10px] tracking-wide text-neutral-500 uppercase">
          <tr>
            <th scope="col" className="px-3 py-2 text-left">
              Strike
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Gamma
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Charm
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Vanna
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800/70">
          {chainStrikes.map((s) => {
            const isAtm = atmStrike !== null && s.strike === atmStrike;
            const isHighlighted = highlightedStrike === s.strike;
            const rowClass = isHighlighted
              ? 'ring-2 ring-amber-400 ring-inset'
              : isAtm
                ? 'border-l-2 border-l-amber-400 bg-amber-500/5'
                : 'border-l-2 border-l-transparent';
            const strikeClass = isAtm
              ? 'font-semibold text-amber-200'
              : 'font-medium text-neutral-200';
            const gammaStyle = cellStyle(s.netGamma, maxAbs.gamma);
            const charmStyle = cellStyle(s.netCharm, maxAbs.charm);
            const vannaStyle = cellStyle(s.netVanna, maxAbs.vanna);
            return (
              <tr
                key={s.strike}
                id={strikeRowId(s.strike)}
                className={rowClass}
              >
                <td className={`px-3 py-1.5 tabular-nums ${strikeClass}`}>
                  {s.strike}
                  {isAtm && (
                    <span
                      className="ml-1.5 rounded bg-amber-400/15 px-1 text-[9px] tracking-wide text-amber-300/90 uppercase"
                      aria-label="At-the-money"
                    >
                      ATM
                    </span>
                  )}
                </td>
                <td
                  className={`px-3 py-1.5 text-right tabular-nums ${gammaStyle.textClass}`}
                  style={{ backgroundColor: gammaStyle.bg }}
                  title={tooltipFor('gamma', s.netGamma)}
                  aria-label={`Gamma ${formatGreek(s.netGamma)}`}
                >
                  {formatGreek(s.netGamma)}
                </td>
                <td
                  className={`px-3 py-1.5 text-right tabular-nums ${charmStyle.textClass}`}
                  style={{ backgroundColor: charmStyle.bg }}
                  title={tooltipFor('charm', s.netCharm)}
                  aria-label={`Charm ${formatGreek(s.netCharm)}`}
                >
                  {formatGreek(s.netCharm)}
                </td>
                <td
                  className={`px-3 py-1.5 text-right tabular-nums ${vannaStyle.textClass}`}
                  style={{ backgroundColor: vannaStyle.bg }}
                  title={tooltipFor('vanna', s.netVanna)}
                  aria-label={`Vanna ${formatGreek(s.netVanna)}`}
                >
                  {formatGreek(s.netVanna)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
