/**
 * HeaderControls — scrub prev/next, live timestamp badge, date picker,
 * live/scrubbed status badges, and manual refresh button.
 *
 * Rendered inside SectionBox via the `headerRight` slot.
 */

import { fmtTime } from './formatters';

export interface HeaderControlsProps {
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
}

export function HeaderControls({
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
}: HeaderControlsProps) {
  return (
    <div className="flex items-center gap-2">
      {/* Scrubber */}
      <div className="flex items-center gap-1">
        <button
          onClick={onScrubPrev}
          disabled={!canScrubPrev}
          className="border-edge text-secondary hover:text-primary disabled:text-muted rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:cursor-default"
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
            style={{
              color: isLive
                ? '#00e676'
                : isScrubbed
                  ? '#ffd740'
                  : 'var(--color-secondary)',
            }}
          >
            {timestamps.map((ts) => (
              <option key={ts} value={ts}>
                {fmtTime(ts)} CT
              </option>
            ))}
          </select>
        ) : (
          timestamp && (
            <span
              className="font-mono text-[11px]"
              style={{
                color: isLive
                  ? '#00e676'
                  : isScrubbed
                    ? '#ffd740'
                    : 'var(--color-secondary)',
              }}
            >
              {fmtTime(timestamp)} CT
            </span>
          )
        )}
        <button
          onClick={onScrubNext}
          disabled={!canScrubNext}
          className="border-edge text-secondary hover:text-primary disabled:text-muted rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:cursor-default"
          aria-label="Next snapshot"
        >
          ›
        </button>
        {isScrubbed && (
          <button
            onClick={onScrubLive}
            className="font-mono text-[10px] font-bold transition-opacity hover:opacity-80"
            style={{ color: '#00e676' }}
            aria-label="Resume live"
          >
            LIVE
          </button>
        )}
      </div>

      {/* Date picker */}
      <input
        type="date"
        value={selectedDate}
        onChange={(e) => onDateChange(e.target.value)}
        className="border-edge bg-surface text-secondary rounded border px-1.5 py-0.5 font-mono text-[11px]"
        aria-label="Select date"
      />

      {/* Status badge */}
      {isLive && (
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
          style={{ background: 'rgba(0,230,118,0.15)', color: '#00e676' }}
        >
          LIVE
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
        className={`text-secondary hover:text-primary disabled:text-muted text-base transition-colors disabled:cursor-default${loading ? 'animate-spin' : ''}`}
        title="Refresh"
        aria-label="Refresh GEX landscape"
      >
        ↻
      </button>
    </div>
  );
}
