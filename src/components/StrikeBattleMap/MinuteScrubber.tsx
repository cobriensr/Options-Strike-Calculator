/**
 * MinuteScrubber — CT-time slider that drives the Strike Battle Map's
 * `at` query parameter for snapshot-mode reads.
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
 */

import { memo } from 'react';

const MIN_MINUTE = 8 * 60 + 30;
const MAX_MINUTE = 15 * 60;

interface MinuteScrubberProps {
  value: number | null;
  onChange: (m: number | null) => void;
  /** When true, null-value renders as "LIVE" and the reset button reads
   *  "LIVE". Otherwise both render as "Latest". */
  liveAvailable: boolean;
}

function formatLabel(m: number): string {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const period = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${mm.toString().padStart(2, '0')} ${period} CT`;
}

function MinuteScrubberInner({
  value,
  onChange,
  liveAvailable,
}: MinuteScrubberProps) {
  const display = value ?? MAX_MINUTE;
  const nullLabel = liveAvailable ? 'LIVE' : 'Latest';
  const label = value == null ? nullLabel : formatLabel(value);
  return (
    <div className="border-edge bg-surface mb-3 flex items-center gap-2 rounded-md border px-2 py-1.5">
      <span className="text-secondary w-24 text-right font-mono text-[10px]">
        {label}
      </span>
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
