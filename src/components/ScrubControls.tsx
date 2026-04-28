/**
 * ScrubControls — reusable time scrubber, date picker, live/scrubbed badge,
 * and manual refresh button. Designed for SectionBox `headerRight` slots.
 *
 * Extracted from GexLandscape/HeaderControls so that any panel with
 * historical snapshot browsing can reuse the same controls.
 */

import { theme } from '../themes';
import { tint } from '../utils/ui-utils';
import { DateInputET } from './ui/DateInputET';

export interface ScrubControlsProps {
  timestamp: string | null;
  timestamps: string[];
  selectedDate: string;
  onDateChange: (date: string) => void;
  isLive: boolean;
  isScrubbed: boolean;
  canScrubPrev: boolean;
  canScrubNext: boolean;
  onScrubPrev: () => void;
  onScrubNext: () => void;
  onScrubTo: (ts: string) => void;
  onScrubLive: () => void;
  onRefresh: () => void;
  loading: boolean;
  /** Used in the refresh button's aria-label, e.g. "Refresh GEX landscape" */
  sectionLabel: string;
  /**
   * Age of the latest data point in milliseconds. When provided and the
   * panel is in live mode, the LIVE pill flips to a "DELAYED Nm" indicator
   * once data is older than `staleThresholdMs` (default 5 min). This makes
   * data freshness honest when an upstream feed goes quiet.
   */
  lastDataAgeMs?: number | null;
  /** Threshold above which live data is considered stale. Default 5 min. */
  staleThresholdMs?: number;
}

const DEFAULT_STALE_THRESHOLD_MS = 5 * 60_000;

/** Format an ISO timestamp to "HH:MM AM/PM CT" in Central Time. */
function fmtTimeCT(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

export function ScrubControls({
  timestamp,
  timestamps,
  selectedDate,
  onDateChange,
  isLive,
  isScrubbed,
  canScrubPrev,
  canScrubNext,
  onScrubPrev,
  onScrubNext,
  onScrubTo,
  onScrubLive,
  onRefresh,
  loading,
  sectionLabel,
  lastDataAgeMs,
  staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
}: ScrubControlsProps) {
  const isStale =
    isLive && lastDataAgeMs != null && lastDataAgeMs >= staleThresholdMs;
  const staleMinutes =
    isStale && lastDataAgeMs != null ? Math.floor(lastDataAgeMs / 60_000) : 0;

  const timestampColor = isLive
    ? isStale
      ? '#ffd740'
      : theme.statusLive
    : isScrubbed
      ? '#ffd740'
      : 'var(--color-secondary)';

  return (
    <div className="flex items-center gap-2">
      {/* Scrubber */}
      <div className="flex items-center gap-1">
        <button
          onClick={onScrubPrev}
          disabled={!canScrubPrev}
          className="border-edge text-secondary hover:text-primary disabled:text-muted inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:cursor-default lg:min-h-0 lg:min-w-0"
          aria-label="Previous snapshot"
        >
          ‹
        </button>
        {timestamps.length > 1 && timestamp ? (
          <select
            value={timestamp ?? ''}
            onChange={(e) => onScrubTo(e.target.value)}
            aria-label="Jump to snapshot time"
            className="border-edge min-w-[72px] cursor-pointer rounded border bg-transparent px-1 py-0.5 text-center font-mono text-[11px] outline-none"
            style={{ color: timestampColor }}
          >
            {timestamps.map((ts) => (
              <option key={ts} value={ts}>
                {fmtTimeCT(ts)} CT
              </option>
            ))}
          </select>
        ) : (
          timestamp && (
            <span
              className="font-mono text-[11px]"
              style={{ color: timestampColor }}
            >
              {fmtTimeCT(timestamp)} CT
            </span>
          )
        )}
        <button
          onClick={onScrubNext}
          disabled={!canScrubNext}
          className="border-edge text-secondary hover:text-primary disabled:text-muted inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:cursor-default lg:min-h-0 lg:min-w-0"
          aria-label="Next snapshot"
        >
          ›
        </button>
        {isScrubbed && (
          <button
            onClick={onScrubLive}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center px-2 font-mono text-[10px] font-bold transition-opacity hover:opacity-80 lg:min-h-0 lg:min-w-0 lg:px-0"
            style={{ color: theme.statusLive }}
            aria-label="Resume live"
          >
            LIVE
          </button>
        )}
      </div>

      {/* Date picker */}
      <DateInputET
        value={selectedDate}
        onChange={onDateChange}
        label="Select date"
        labelVisible={false}
        className="border-edge bg-surface text-secondary min-h-[44px] rounded border px-1.5 py-0.5 font-mono text-[11px] lg:min-h-0"
      />

      {/* Status badge */}
      {isLive && !isStale && (
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
          style={{
            background: tint(theme.statusLive, '26'),
            color: theme.statusLive,
          }}
        >
          LIVE
        </span>
      )}
      {isLive && isStale && (
        <span
          className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-400"
          title={`Latest data is ${staleMinutes}m old — upstream feed has not emitted new alerts`}
        >
          DELAYED {staleMinutes}m
        </span>
      )}
      {isScrubbed && (
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-400">
          SCRUBBED
        </span>
      )}

      {/* Refresh */}
      <button
        onClick={onRefresh}
        disabled={loading}
        className={`text-secondary hover:text-primary disabled:text-muted inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-base transition-colors disabled:cursor-default lg:min-h-0 lg:min-w-0 ${loading ? 'animate-spin' : ''}`}
        title="Refresh"
        aria-label={`Refresh ${sectionLabel}`}
      >
        ↻
      </button>
    </div>
  );
}
