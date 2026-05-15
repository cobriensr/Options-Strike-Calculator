/**
 * Top-5 strikes table with Gamma / Charm / Vanna columns.
 *
 * Each row shows one strike's net Greek (call + put OI) for the
 * selected ticker on the 0DTE expiry. Green when positive, rose when
 * negative — color signals direction of dealer hedging pressure.
 *
 * The row whose `strike === atmStrike` (closest of top-5 to spot) gets
 * a left-border accent and slightly bolder weight so the trader can
 * locate the spot-nearest wall at a glance.
 *
 * Hover tooltips on every Greek cell are defined in `./tooltipText.ts`
 * — the trader-facing copy is intentionally extracted there so the UI
 * scaffolding can land independently of the wording.
 */

import type { GreekHeatmapTopStrike } from '../../hooks/useGreekHeatmap';

import { tooltipFor } from './tooltipText';

interface GreekHeatmapTableProps {
  topStrikes: readonly GreekHeatmapTopStrike[];
  atmStrike: number | null;
}

function formatGreek(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function valueClass(value: number): string {
  if (value === 0) return 'text-neutral-500';
  return value > 0 ? 'text-emerald-400' : 'text-rose-400';
}

export function GreekHeatmapTable({
  topStrikes,
  atmStrike,
}: GreekHeatmapTableProps) {
  if (topStrikes.length === 0) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-4 text-center text-xs text-neutral-500">
        No 0DTE strike data yet for this ticker.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-neutral-800">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-neutral-900/80 text-[10px] tracking-wide text-neutral-500 uppercase">
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
          {topStrikes.map((s) => {
            const isAtm = atmStrike !== null && s.strike === atmStrike;
            const rowClass = isAtm
              ? 'border-l-2 border-l-amber-400 bg-amber-500/5'
              : 'border-l-2 border-l-transparent';
            const strikeClass = isAtm
              ? 'font-semibold text-amber-200'
              : 'font-medium text-neutral-200';
            return (
              <tr key={s.strike} className={rowClass}>
                <td className={`px-3 py-2 tabular-nums ${strikeClass}`}>
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
                  className={`px-3 py-2 text-right tabular-nums ${valueClass(s.netGamma)}`}
                  title={tooltipFor('gamma', s.netGamma)}
                >
                  {formatGreek(s.netGamma)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${valueClass(s.netCharm)}`}
                  title={tooltipFor('charm', s.netCharm)}
                >
                  {formatGreek(s.netCharm)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${valueClass(s.netVanna)}`}
                  title={tooltipFor('vanna', s.netVanna)}
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
