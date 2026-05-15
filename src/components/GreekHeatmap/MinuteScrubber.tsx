/**
 * Intraday 1-minute scrubber for the Greek Heatmap section.
 *
 * Slider over the available ts_minute range for the selected
 * (ticker, date) pair. Default state is LIVE — the slider sits at the
 * max and the heatmap polls the live tip. Scrubbing to any earlier
 * minute flips state to SCRUBBED — polling pauses, the heatmap pins
 * to that timestamp.
 *
 * When intradayRange.count <= 1 (historical EOD-only dates, or before
 * the WS picked up the ticker), the slider renders disabled with a
 * "no intraday data" badge so the gap is visible rather than the
 * scrubber silently misbehaving.
 */

import type { GreekHeatmapIntradayRange } from '../../hooks/useGreekHeatmap';

interface MinuteScrubberProps {
  range: GreekHeatmapIntradayRange | null;
  /** ISO 8601 UTC of the currently selected minute, or null for LIVE. */
  at: string | null;
  onChange: (at: string | null) => void;
}

function isoMinute(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

function formatCTLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

export function MinuteScrubber({ range, at, onChange }: MinuteScrubberProps) {
  if (range === null || range.count <= 1) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-neutral-500">
        <span className="rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-0.5 tracking-wide uppercase">
          No intraday data
        </span>
        {range !== null && (
          <span className="tabular-nums">
            EOD snapshot · {formatCTLabel(range.max)} CT
          </span>
        )}
      </div>
    );
  }

  const minMs = new Date(range.min).getTime();
  const maxMs = new Date(range.max).getTime();
  const valueMs = at !== null ? new Date(at).getTime() : maxMs;
  const isLive = at === null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`rounded-md border px-2 py-0.5 text-[10px] tracking-wide uppercase ${
          isLive
            ? 'border-emerald-500/70 bg-emerald-950/40 text-emerald-200'
            : 'border-amber-500/70 bg-amber-950/40 text-amber-200'
        }`}
        aria-label={isLive ? 'Live' : 'Scrubbed'}
      >
        {isLive ? 'Live' : 'Scrubbed'}
      </span>
      <span className="text-[11px] text-neutral-300 tabular-nums">
        {formatCTLabel(isoMinute(valueMs))} CT
      </span>
      <input
        type="range"
        min={minMs}
        max={maxMs}
        step={60_000}
        value={valueMs}
        onChange={(e) => {
          const ms = Number.parseInt(e.target.value, 10);
          // Snap back to LIVE when the user drags to the max position.
          if (ms >= maxMs) {
            onChange(null);
          } else {
            onChange(isoMinute(ms));
          }
        }}
        className="min-w-[200px] flex-1 cursor-pointer accent-emerald-400"
        aria-label="Scrub to a past minute"
      />
      {!isLive && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="rounded border border-neutral-700 bg-neutral-900/60 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-800"
        >
          Jump to live
        </button>
      )}
    </div>
  );
}
