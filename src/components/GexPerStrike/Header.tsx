/**
 * Panel header: date picker, snapshot scrubber, live/backtest badge,
 * refresh button, and visible-count +/- stepper.
 *
 * Lives inside the GexPerStrike folder because it has quirks specific
 * to this panel — the BACKTEST badge, the unicode arrow glyphs (◀▶),
 * and the visible-count stepper — that make the shared
 * `src/components/ScrubControls.tsx` not a drop-in fit.
 */

import { theme } from '../../themes';
import { formatTime } from './formatters';

interface Props {
  /** Current displayed snapshot timestamp (ISO). */
  timestamp: string | null;
  timestamps: string[];
  selectedDate: string;
  onDateChange: (date: string) => void;
  isLive: boolean;
  isToday: boolean;
  isScrubbed: boolean;
  canScrubPrev: boolean;
  canScrubNext: boolean;
  loading: boolean;
  onScrubPrev: () => void;
  onScrubNext: () => void;
  onScrubTo: (ts: string) => void;
  onScrubLive: () => void;
  onRefresh: () => void;
  visibleCount: number;
  totalStrikes: number;
  minVisible: number;
  maxVisible: number;
  onLess: () => void;
  onMore: () => void;
}

export function Header({
  timestamp,
  timestamps,
  selectedDate,
  onDateChange,
  isLive,
  isToday,
  isScrubbed,
  canScrubPrev,
  canScrubNext,
  loading,
  onScrubPrev,
  onScrubNext,
  onScrubTo,
  onScrubLive,
  onRefresh,
  visibleCount,
  totalStrikes,
  minVisible,
  maxVisible,
  onLess,
  onMore,
}: Readonly<Props>) {
  const timestampColor = isLive
    ? theme.green
    : isScrubbed
      ? theme.accent
      : theme.caution;

  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        value={selectedDate}
        onChange={(e) => onDateChange(e.target.value)}
        aria-label="GEX per strike date"
        className="text-secondary border-edge rounded border bg-transparent px-1.5 py-0.5 font-mono text-[10px]"
      />
      <div className="border-edge flex items-center gap-0.5 rounded border">
        <button
          onClick={onScrubPrev}
          disabled={loading || !canScrubPrev}
          aria-label="Previous snapshot"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &#x25C0;
        </button>
        {timestamps.length > 1 && timestamp ? (
          <select
            value={timestamp ?? ''}
            onChange={(e) => onScrubTo(e.target.value)}
            aria-label="Jump to snapshot time"
            className="border-edge min-w-[60px] cursor-pointer rounded border bg-transparent px-1 py-0.5 text-center font-mono text-[10px] outline-none"
            style={{ color: timestampColor }}
          >
            {timestamps.map((ts) => (
              <option key={ts} value={ts}>
                {formatTime(ts)}
              </option>
            ))}
          </select>
        ) : (
          timestamp && (
            <span
              className="min-w-[44px] text-center font-mono text-[10px]"
              style={{ color: timestampColor }}
            >
              {formatTime(timestamp)}
            </span>
          )
        )}
        <button
          onClick={onScrubNext}
          disabled={loading || !canScrubNext}
          aria-label="Next snapshot"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &#x25B6;
        </button>
      </div>
      {isLive && (
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider"
          style={{
            color: theme.green,
            background: 'rgba(0,230,118,0.08)',
            border: '1px solid rgba(0,230,118,0.25)',
          }}
        >
          LIVE
        </span>
      )}
      {(isScrubbed || !isToday) && !isLive && (
        <button
          onClick={onScrubLive}
          aria-label="Resume live snapshot"
          className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider transition-colors"
          style={{
            color: '#00e676',
            background: 'rgba(0,230,118,0.08)',
            border: '1px solid rgba(0,230,118,0.25)',
          }}
        >
          LIVE
        </button>
      )}
      {!isLive && !isScrubbed && !isToday && (
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider"
          style={{
            color: theme.caution,
            background: 'rgba(255,193,7,0.08)',
            border: '1px solid rgba(255,193,7,0.25)',
          }}
        >
          BACKTEST
        </span>
      )}
      <button
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh GEX data"
        className="text-accent hover:text-primary disabled:text-muted cursor-pointer font-sans text-[10px] font-semibold transition-colors disabled:cursor-default"
      >
        &#x21bb;
      </button>
      <div className="border-edge flex items-center gap-0.5 rounded border">
        <button
          onClick={onLess}
          disabled={visibleCount <= minVisible}
          aria-label="Show fewer strikes"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &minus;
        </button>
        <span className="text-secondary min-w-[20px] text-center font-mono text-[10px]">
          {visibleCount}
        </span>
        <button
          onClick={onMore}
          disabled={visibleCount >= maxVisible || visibleCount >= totalStrikes}
          aria-label="Show more strikes"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          +
        </button>
      </div>
    </div>
  );
}
