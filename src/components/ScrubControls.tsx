/**
 * ScrubControls — reusable time scrubber, date picker, live/scrubbed badge,
 * and manual refresh button. Designed for SectionBox `headerRight` slots.
 *
 * Extracted from GexLandscape/HeaderControls so that any panel with
 * historical snapshot browsing can reuse the same controls.
 */

import { theme } from '../themes';
import { formatClosedLabel } from '../utils/closed-session';
import { tint } from '../utils/ui-utils';
import { DateInput } from './ui/DateInput';
import { SrHint } from './ui/SrHint';

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
  /**
   * When `true`, the date picker is not rendered. Used by panels that
   * are pinned to today by a backend contract (e.g. GexLandscape — see
   * Locked Decision #4 in
   * `docs/superpowers/specs/gex-landscape-1min-gexbot-rebuild-2026-05-26.md`)
   * so the picker can't lie to the user about cross-day navigation that
   * the endpoint will silently ignore. Defaults to `false` to preserve
   * the original behaviour for every other consumer.
   */
  hideDatePicker?: boolean;
  /**
   * The capture time (ISO) of the last session's data, for a panel that keeps
   * showing it after the close. When set and the panel is not scrubbed, the
   * badge slot reads "CLOSED · as of Fri 3:00 PM CT" in place of LIVE or
   * DELAYED. A scrubbed view keeps SCRUBBED. The time select is not touched:
   * this feeds the label only. Null or absent, the controls render as they
   * always have. So do they when the time does not parse (no label to show).
   */
  closedAsOf?: string | null;
}

const DEFAULT_STALE_THRESHOLD_MS = 5 * 60_000;

/** What the DELAYED badge means: its hover text ends with it and a screen
 *  reader hears it after the badge. */
const STALE_FEED_HINT = 'the upstream feed has not sent new data';

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
  hideDatePicker = false,
  closedAsOf,
}: ScrubControlsProps) {
  // The clock is read at render and only decides whether the label carries a
  // date (a capture more than 6 days old). An empty label (a capture time that
  // does not parse) shows no closed pill, so a bare "CLOSED · as of" never
  // dangles; the LIVE / DELAYED badge shows as it does without `closedAsOf`.
  const closedLabel =
    closedAsOf != null && !isScrubbed
      ? formatClosedLabel(closedAsOf, new Date())
      : '';
  const showClosed = closedLabel !== '';
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
    // The closed pill is long: the row may wrap, and wraps right-aligned like
    // the header it sits in, instead of running past the card on a phone.
    <div
      className={
        showClosed
          ? 'flex flex-wrap items-center justify-end gap-2'
          : 'flex items-center gap-2'
      }
    >
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

      {/* Date picker — omitted for panels with a today-only backend
          contract (see `hideDatePicker` doc on the props). */}
      {!hideDatePicker && (
        <DateInput
          value={selectedDate}
          onChange={onDateChange}
          label="Select date"
          labelVisible={false}
          className="border-edge bg-surface text-secondary min-h-[44px] rounded border px-1.5 py-0.5 font-mono text-[11px] lg:min-h-0"
        />
      )}

      {/* Status badge. The closed pill takes the LIVE / DELAYED slot, so
          neither shows beside it. Its text is its accessible name, as the
          LIVE badge's is; it is not hidden from assistive tech. The 9% tint
          is the header CLOSED badge's (StatusBadge): the muted text on it
          measures 5.06:1 in the light theme and 4.53:1 in the dark. */}
      {showClosed && (
        <span
          data-testid="scrub-closed-badge"
          className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold whitespace-nowrap"
          style={{
            background: tint(theme.textMuted, '17'),
            color: theme.textMuted,
          }}
        >
          CLOSED · as of {closedLabel}
        </span>
      )}
      {!showClosed && isLive && !isStale && (
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
      {!showClosed && isLive && isStale && (
        <span
          className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-400"
          title={`Latest data is ${staleMinutes}m old — ${STALE_FEED_HINT}`}
        >
          DELAYED {staleMinutes}m<SrHint>{STALE_FEED_HINT}</SrHint>
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
