/**
 * ScrubControls — reusable time scrubber, date picker, live/scrubbed badge,
 * and manual refresh button. Designed for SectionBox `headerRight` slots.
 *
 * Extracted from GexLandscape/HeaderControls so that any panel with
 * historical snapshot browsing can reuse the same controls.
 */

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
}

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
}: ScrubControlsProps) {
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
                {fmtTimeCT(ts)} CT
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
              {fmtTimeCT(timestamp)} CT
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
        className={`text-secondary hover:text-primary disabled:text-muted text-base transition-colors disabled:cursor-default${loading ? ' animate-spin' : ''}`}
        title="Refresh"
        aria-label={`Refresh ${sectionLabel}`}
      >
        ↻
      </button>
    </div>
  );
}
