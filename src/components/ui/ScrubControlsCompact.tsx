/**
 * ScrubControlsCompact — shared scrubber toolbar for time-series panels
 * (DarkPoolLevels, GexTarget header).
 *
 * Renders three controls in a single bordered group:
 *   1. Previous-snapshot button (◀)
 *   2. Either a <select> over `timestamps` or a fallback <span> when there
 *      is at most one timestamp; the consumer supplies `formatLabel` so
 *      the option text matches the panel's existing convention (raw HH:MM
 *      vs `formatTimeCT(...)` ISO).
 *   3. Next-snapshot button (▶)
 *
 * A standalone LIVE button renders alongside when `showLiveButton` is true.
 *
 * Panel-specific widgets (date picker, sort cycle, status badge, refresh,
 * mode toggle, visible-count stepper) stay in each consumer — those
 * diverge enough that the abstraction would invert.
 *
 * Why "Compact": this is the inline header form used in dashboard
 * widgets. A future expanded form (e.g. the GexLandscape wide scrubber
 * with a slider) would be a separate component.
 */

import type { ReactNode } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';

export interface ScrubControlsCompactProps {
  /** Available scrub-target values; rendered as <option>s when length > 1. */
  timestamps: readonly string[];
  /** Currently selected/displayed value, or null if no scrub time yet. */
  currentTimestamp: string | null;
  /** Format the option label and the single-snapshot fallback span. */
  formatLabel: (timestamp: string) => string;
  /**
   * Color applied to the select/span text. Computed by the consumer so
   * each panel can encode its own state palette (3-state vs 4-state).
   */
  displayColor: string;
  /** Disable the prev button. */
  canScrubPrev: boolean;
  /** Disable the next button. */
  canScrubNext: boolean;
  onScrubPrev: () => void;
  onScrubNext: () => void;
  /** Optional onChange for the select; falls back to span when absent. */
  onScrubTo?: (timestamp: string) => void;
  /** Render the LIVE button (consumer chooses the trigger condition). */
  showLiveButton?: boolean;
  onScrubLive?: () => void;
  /**
   * Text shown in the fallback span when `timestamps.length <= 1` and a
   * `currentTimestamp` is unavailable. DarkPool uses `formatTimeCT(updatedAt)`;
   * GexTarget hides the span entirely (omit this prop to render nothing).
   */
  fallbackText?: ReactNode;
  prevAriaLabel?: string;
  nextAriaLabel?: string;
  selectAriaLabel?: string;
  liveAriaLabel?: string;
}

export function ScrubControlsCompact({
  timestamps,
  currentTimestamp,
  formatLabel,
  displayColor,
  canScrubPrev,
  canScrubNext,
  onScrubPrev,
  onScrubNext,
  onScrubTo,
  showLiveButton = false,
  onScrubLive,
  fallbackText,
  prevAriaLabel = 'Previous snapshot',
  nextAriaLabel = 'Next snapshot',
  selectAriaLabel = 'Jump to snapshot time',
  liveAriaLabel = 'Resume live',
}: ScrubControlsCompactProps) {
  const showSelect = timestamps.length > 1 && onScrubTo !== undefined;
  const spanText =
    currentTimestamp != null ? formatLabel(currentTimestamp) : fallbackText;

  return (
    <>
      <div className="border-edge flex items-center gap-0.5 rounded border">
        <button
          type="button"
          onClick={onScrubPrev}
          disabled={!canScrubPrev}
          aria-label={prevAriaLabel}
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &#x25C0;
        </button>
        {showSelect ? (
          <select
            value={currentTimestamp ?? timestamps.at(-1) ?? ''}
            onChange={(e) => onScrubTo!(e.target.value)}
            aria-label={selectAriaLabel}
            className="border-edge min-w-[60px] cursor-pointer rounded border bg-transparent px-1 py-0.5 text-center font-mono text-[10px] outline-none"
            style={{ color: displayColor }}
          >
            {timestamps.map((ts) => (
              <option key={ts} value={ts}>
                {formatLabel(ts)}
              </option>
            ))}
          </select>
        ) : spanText ? (
          <span
            className="min-w-[44px] text-center font-mono text-[10px]"
            style={{ color: displayColor }}
          >
            {spanText}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onScrubNext}
          disabled={!canScrubNext}
          aria-label={nextAriaLabel}
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &#x25B6;
        </button>
      </div>

      {showLiveButton && onScrubLive && (
        <button
          type="button"
          onClick={onScrubLive}
          aria-label={liveAriaLabel}
          className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider transition-colors"
          style={{
            color: theme.statusLive,
            background: tint(theme.statusLive, '14'),
            border: `1px solid ${tint(theme.statusLive, '40')}`,
          }}
        >
          LIVE
        </button>
      )}
    </>
  );
}
