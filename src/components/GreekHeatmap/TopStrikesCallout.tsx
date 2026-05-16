/**
 * Top-5 strike callout chips — the leaderboard band above the
 * full-chain heatmap grid. Each chip shows the strike + signed net
 * gamma magnitude, colored by sign, and on click scrolls the heatmap
 * to that strike's row (and briefly highlights it).
 *
 * Mirrors the visual pattern of UW Periscope's top-strikes callouts
 * (e.g. "TSLA 430 May 15 +62.2M" above the per-strike grid).
 */

import type { GreekHeatmapTopStrike } from '../../hooks/useGreekHeatmap';
import { formatSignedShort } from '../../utils/format-magnitude';

interface TopStrikesCalloutProps {
  topStrikes: readonly GreekHeatmapTopStrike[];
  onJumpToStrike: (strike: number) => void;
}

export function TopStrikesCallout({
  topStrikes,
  onJumpToStrike,
}: TopStrikesCalloutProps) {
  if (topStrikes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] tracking-wide text-neutral-500 uppercase">
        Top GEX
      </span>
      {topStrikes.map((s, i) => {
        const positive = s.netGamma > 0;
        // Brightest treatment for the #1 strike (largest |GEX| in the
        // chain) — matches Periscope's blue/bright-green standout cell.
        const isPeak = i === 0;
        const chipClass = positive
          ? isPeak
            ? 'border-emerald-300 bg-emerald-500/30 text-emerald-50'
            : 'border-emerald-500/60 bg-emerald-950/50 text-emerald-200'
          : isPeak
            ? 'border-rose-300 bg-rose-500/30 text-rose-50'
            : 'border-rose-500/60 bg-rose-950/50 text-rose-200';
        return (
          <button
            key={s.strike}
            type="button"
            onClick={() => onJumpToStrike(s.strike)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors hover:brightness-125 ${chipClass}`}
            title={`Jump to strike ${s.strike} in the heatmap`}
            aria-label={`Jump to strike ${s.strike}`}
          >
            <span>{s.strike}</span>
            <span className="opacity-90">{formatSignedShort(s.netGamma)}</span>
          </button>
        );
      })}
    </div>
  );
}
