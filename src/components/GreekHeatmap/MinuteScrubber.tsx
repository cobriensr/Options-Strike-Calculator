/**
 * Intraday 1-minute scrubber for the Greek Heatmap section.
 *
 * Replaces the prior range slider with a prev/next 1-minute stepper plus
 * a CT time picker so the user can both nudge by a single minute and
 * jump directly to a wall-clock time. Default state is LIVE — the
 * scrubber's `at` is null and the heatmap polls the live tip. Stepping
 * back or picking an earlier time flips state to SCRUBBED — polling
 * pauses, the heatmap pins to that timestamp. Stepping forward to the
 * latest available minute (or clicking "Jump to live") snaps back to
 * LIVE.
 *
 * When intradayRange.count <= 1 (historical EOD-only dates, or before
 * the WS picked up the ticker), the controls render disabled with a
 * "no intraday data" badge so the gap is visible rather than the
 * scrubber silently misbehaving.
 */

import type { GreekHeatmapIntradayRange } from '../../hooks/useGreekHeatmap';
import { ctWallClockToUtcIso, getCTTime } from '../../utils/timezone';
import { TimeInputCT } from '../ui/TimeInputCT';

interface MinuteScrubberProps {
  range: GreekHeatmapIntradayRange | null;
  /** ISO 8601 UTC of the currently selected minute, or null for LIVE. */
  at: string | null;
  /**
   * YYYY-MM-DD of the trading day in CT — anchors the time picker so
   * `HH:MM` entries resolve to the correct UTC timestamp on the day
   * whose data is in view. Must match the date the parent passed to the
   * data hook; otherwise the time-picker jumps get clamped to the
   * range and silently land on a bound.
   */
  dateStr: string;
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

function toCTHHMM(ms: number): string {
  const { hour, minute } = getCTTime(new Date(ms));
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

function clamp(ms: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, ms));
}

export function MinuteScrubber({
  range,
  at,
  dateStr,
  onChange,
}: MinuteScrubberProps) {
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

  const canPrev = valueMs > minMs;
  const canNext = valueMs < maxMs;

  const goToMs = (ms: number) => {
    const next = clamp(ms, minMs, maxMs);
    // Snap back to LIVE when the user lands on the latest available minute.
    if (next >= maxMs) {
      onChange(null);
    } else {
      onChange(isoMinute(next));
    }
  };

  const onPrev = () => {
    if (canPrev) goToMs(valueMs - 60_000);
  };
  const onNext = () => {
    if (canNext) goToMs(valueMs + 60_000);
  };

  const onTimePicked = (hhmm: string) => {
    const parts = hhmm.split(':');
    if (parts.length !== 2) return;
    const h = Number.parseInt(parts[0] ?? '', 10);
    const m = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    const iso = ctWallClockToUtcIso(dateStr, h * 60 + m);
    if (iso === null) return;
    goToMs(new Date(iso).getTime());
  };

  const stepperBtnClass =
    'cursor-pointer rounded border border-neutral-700 bg-neutral-900/60 px-2 py-0.5 font-mono text-xs text-neutral-200 hover:bg-neutral-800 disabled:cursor-default disabled:opacity-40';

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
      <div
        role="group"
        aria-label="Minute stepper"
        className="flex items-center gap-1"
      >
        <button
          type="button"
          onClick={onPrev}
          disabled={!canPrev}
          aria-label="Previous minute"
          className={stepperBtnClass}
        >
          &#x25C0;
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          aria-label="Next minute"
          className={stepperBtnClass}
        >
          &#x25B6;
        </button>
      </div>
      <TimeInputCT
        value={toCTHHMM(valueMs)}
        onChange={onTimePicked}
        label="Jump to"
        min={toCTHHMM(minMs)}
        max={toCTHHMM(maxMs)}
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
