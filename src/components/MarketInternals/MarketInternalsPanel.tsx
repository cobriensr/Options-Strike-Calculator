/**
 * MarketInternalsPanel — regime classification + event log panel.
 *
 * Composes the existing `MarketInternalsBadge` (raw values) with a
 * regime pill (range/trend/neutral + confidence) and a scrollable
 * event log of $TICK extreme events labelled with regime context.
 *
 * Pure presentational — the parent (App.tsx) owns the single
 * `useMarketInternals` hook call and passes data down as props to
 * avoid duplicate 60-second polling loops.
 */

import { useMemo } from 'react';
import type { FC } from 'react';
import { detectExtremes } from '../../utils/extreme-detector';
import type {
  ExtremeEvent,
  RegimeResult,
  RegimeType,
} from '../../types/market-internals';
import type { UseMarketInternalsResult } from '../../hooks/useMarketInternals';
import { MarketInternalsBadge } from './MarketInternalsBadge';

// ============================================================
// PRESENTATION HELPERS
// ============================================================

function regimePillClass(regime: RegimeType, muted: boolean): string {
  if (muted) {
    return 'bg-neutral-800/50 text-neutral-500 border-neutral-700/40';
  }
  switch (regime) {
    case 'range':
      return 'bg-cyan-900/40 text-cyan-300 border-cyan-500/40';
    case 'trend':
      return 'bg-violet-900/40 text-violet-300 border-violet-500/40';
    case 'neutral':
      return 'bg-neutral-800/50 text-neutral-400 border-neutral-700/40';
    default: {
      const _exhaustive: never = regime;
      return _exhaustive;
    }
  }
}

function regimeLabel(regime: RegimeType): string {
  switch (regime) {
    case 'range':
      return 'RANGE DAY';
    case 'trend':
      return 'TREND DAY';
    case 'neutral':
      return 'NEUTRAL';
    default: {
      const _exhaustive: never = regime;
      return _exhaustive;
    }
  }
}

// ============================================================
// TIME FORMATTER
// ============================================================

/**
 * Format an ISO timestamp to ET time like "12:18 PM".
 * Falls back to the raw string on invalid input.
 */
const ET_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'America/New_York',
});

function formatEventTime(ts: string): string {
  try {
    return ET_TIME_FMT.format(new Date(ts));
  } catch {
    return ts;
  }
}

const SIGNED_INT_FMT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
  signDisplay: 'exceptZero',
});

function formatSignedTick(value: number): string {
  return SIGNED_INT_FMT.format(Math.round(value));
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function RegimePill({ result }: { result: RegimeResult }) {
  const muted = result.confidence < 0.3 || result.regime === 'neutral';

  return (
    <div data-testid="regime-pill">
      <div className="flex items-center gap-2">
        <span
          className={[
            'inline-flex items-center rounded-full border px-2.5 py-0.5 font-sans text-[11px] font-bold tracking-wider',
            regimePillClass(result.regime, muted),
          ].join(' ')}
          data-testid="regime-label"
          data-regime={result.regime}
        >
          {regimeLabel(result.regime)}
        </span>
        <span
          className={[
            'font-mono text-[10px]',
            muted ? 'text-neutral-600' : 'text-neutral-400',
          ].join(' ')}
          data-testid="regime-confidence"
        >
          {Math.round(result.confidence * 100)}%
        </span>
      </div>
      {result.evidence.length > 0 && (
        <p
          className={[
            'mt-1 line-clamp-2 font-sans text-[10px] italic',
            muted ? 'text-neutral-600' : 'text-neutral-500',
          ].join(' ')}
          data-testid="regime-evidence"
        >
          {result.evidence.slice(0, 2).join(' \u00b7 ')}
        </p>
      )}
    </div>
  );
}

function EventRow({ event }: { event: ExtremeEvent }) {
  return (
    <div
      className={[
        'flex items-center gap-2 px-3 py-1.5 font-mono text-[11px]',
        event.pinned
          ? 'border-l-2 border-l-amber-500/60'
          : 'border-l-2 border-l-transparent',
      ].join(' ')}
      data-testid="extreme-event-row"
      data-pinned={event.pinned ? 'true' : undefined}
    >
      <span className="text-neutral-500">{formatEventTime(event.ts)}</span>
      <span className="text-neutral-400">{event.symbol}</span>
      <span className="font-semibold text-neutral-200 tabular-nums">
        {formatSignedTick(event.value)}
      </span>
      <span className="text-neutral-500 italic">{event.label}</span>
      {event.pinned && (
        <span
          className="ml-auto text-[9px] text-amber-500/70"
          aria-label="Pinned extreme"
        >
          pinned
        </span>
      )}
    </div>
  );
}

// ============================================================
// MAIN
// ============================================================

export interface MarketInternalsPanelProps extends UseMarketInternalsResult {
  marketOpen: boolean;
  regime: RegimeResult;
}

export const MarketInternalsPanel: FC<MarketInternalsPanelProps> = ({
  bars,
  latestBySymbol,
  loading,
  error,
  asOf,
  marketOpen,
  regime,
}) => {
  const events = useMemo(() => {
    const raw = detectExtremes(bars, regime.regime);
    // Newest-first for the event log.
    return [...raw].reverse();
  }, [bars, regime.regime]);

  return (
    <div
      className="border-edge bg-surface overflow-hidden rounded-lg border"
      aria-label="Market internals panel"
    >
      {/* Top: regime badge + raw values */}
      <div className="flex flex-wrap items-start gap-3 px-3 pt-3 pb-2">
        <RegimePill result={regime} />
        <MarketInternalsBadge
          latestBySymbol={latestBySymbol}
          loading={loading}
          error={error}
          asOf={asOf}
          marketOpen={marketOpen}
          className="ml-auto"
        />
      </div>

      {/* Divider */}
      <div className="border-edge mx-3 border-t" />

      {/* Bottom: event log */}
      <div
        className="max-h-[150px] overflow-y-auto py-1.5"
        aria-label="Extreme events log"
        role="log"
      >
        {events.length === 0 ? (
          <p
            className="text-muted px-3 py-2 text-center font-sans text-[11px] italic"
            data-testid="no-extreme-events"
          >
            No extreme events yet
          </p>
        ) : (
          events.map((ev, i) => <EventRow key={`${ev.ts}-${i}`} event={ev} />)
        )}
      </div>
    </div>
  );
};
