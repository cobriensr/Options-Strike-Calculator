/**
 * MinuteScrubber — CT-time slider + prev/next stepper buttons that drive
 * the Strike Battle Map's `at` query parameter for snapshot-mode reads.
 *
 * `value === null` semantics:
 *   - today + market open  → live polling (label: "LIVE")
 *   - today + market closed → latest available (label: "Latest")
 *   - past date            → latest available for that day (label: "Latest")
 *
 * `value` is minutes-past-midnight in Central Time, range 510 (8:30 CT)
 * to 900 (15:00 CT) — matching the regular cash-session window we
 * already enforce upstream in the daemon and CSV ingest filters. The
 * parent converts the minute to a UTC ISO via ctWallClockToUtcIso() so
 * the API receives a timezone-correct `at` regardless of where the
 * browser is running.
 *
 * Stepper behaviour:
 *   - If `availableMinutes` is provided + non-empty, prev/next walk
 *     through those discrete minutes (the actual data points). Lands
 *     always on a slot with rows.
 *   - Otherwise, prev/next step by 1 minute and let the API's
 *     at-or-before resolution land on the closest available slot.
 *   - Keyboard ArrowLeft / ArrowRight on the stepper-group focus
 *     trigger prev / next so the user can flip without clicking.
 */

import { memo, useCallback } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const MIN_MINUTE = 8 * 60 + 30;
const MAX_MINUTE = 15 * 60;

interface MinuteScrubberProps {
  value: number | null;
  onChange: (m: number | null) => void;
  /** When true, null-value renders as "LIVE" and the reset button reads
   *  "LIVE". Otherwise both render as "Latest". */
  liveAvailable: boolean;
  /**
   * Ascending list of CT minutes-past-midnight (510..900) that actually
   * have data on the current (date, ticker) view. When non-empty, the
   * prev/next stepper walks this list discretely rather than ±1 minute.
   * Empty / omitted = stepper falls back to ±1 minute continuous walk.
   */
  availableMinutes?: readonly number[];
}

function formatLabel(m: number): string {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const period = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${mm.toString().padStart(2, '0')} ${period} CT`;
}

/**
 * Given the current minute and an ascending list of available data
 * minutes, return the next-smaller minute in the list (or null when
 * we're already at-or-before the first). When `available` is empty,
 * falls back to `current - 1` clamped to MIN_MINUTE.
 */
function pickPrev(
  current: number | null,
  available: readonly number[],
): number | null {
  if (available.length > 0) {
    const cur = current ?? available.at(-1) ?? MAX_MINUTE;
    // Find the largest available minute that is STRICTLY less than cur.
    let best: number | null = null;
    for (const m of available) {
      if (m < cur) best = m;
      else break;
    }
    return best;
  }
  // Continuous fallback: step by 1 minute, clamp at MIN_MINUTE.
  const cur = current ?? MAX_MINUTE;
  if (cur <= MIN_MINUTE) return null;
  return cur - 1;
}

function pickNext(
  current: number | null,
  available: readonly number[],
): number | null {
  if (available.length > 0) {
    const cur = current ?? available.at(-1) ?? MAX_MINUTE;
    // Smallest available minute strictly greater than cur.
    for (const m of available) {
      if (m > cur) return m;
    }
    return null;
  }
  const cur = current ?? MAX_MINUTE;
  if (cur >= MAX_MINUTE) return null;
  return cur + 1;
}

function MinuteScrubberInner({
  value,
  onChange,
  liveAvailable,
  availableMinutes = [],
}: MinuteScrubberProps) {
  const display = value ?? MAX_MINUTE;
  const nullLabel = liveAvailable ? 'LIVE' : 'Latest';
  const label = value == null ? nullLabel : formatLabel(value);

  const prev = pickPrev(value, availableMinutes);
  const next = pickNext(value, availableMinutes);
  const canPrev = prev !== null;
  const canNext = next !== null;

  const onPrev = useCallback(() => {
    if (prev !== null) onChange(prev);
  }, [prev, onChange]);
  const onNext = useCallback(() => {
    if (next !== null) onChange(next);
  }, [next, onChange]);

  // ArrowLeft / ArrowRight on the stepper-group's focused button.
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft' && canPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowRight' && canNext) {
        e.preventDefault();
        onNext();
      }
    },
    [canPrev, canNext, onPrev, onNext],
  );

  return (
    <div className="border-edge bg-surface mb-3 flex items-center gap-2 rounded-md border px-2 py-1.5">
      <span className="text-secondary w-24 text-right font-mono text-[10px]">
        {label}
      </span>
      <div
        role="group"
        aria-label="Snapshot stepper"
        onKeyDown={onKeyDown}
        className="border-edge flex items-center gap-0.5 rounded border"
      >
        <button
          type="button"
          onClick={onPrev}
          disabled={!canPrev}
          aria-label="Previous minute"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &#x25C0;
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          aria-label="Next minute"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &#x25B6;
        </button>
      </div>
      <input
        type="range"
        min={MIN_MINUTE}
        max={MAX_MINUTE}
        step={1}
        value={display}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
        aria-label="Snapshot minute (Central Time)"
        className="flex-1 cursor-pointer accent-emerald-400"
      />
      {value != null && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-secondary hover:text-primary border-edge cursor-pointer rounded border bg-transparent px-2 py-0.5 font-mono text-[10px]"
        >
          {nullLabel}
        </button>
      )}
    </div>
  );
}

export const MinuteScrubber = memo(MinuteScrubberInner);
