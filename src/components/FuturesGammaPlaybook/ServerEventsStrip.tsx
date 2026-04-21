/**
 * ServerEventsStrip — compact list of the last server-detected alert
 * edges for the FuturesGammaPlaybook.
 *
 * Renders the most recent `regime_events` rows (fetched via
 * `useRegimeEventsHistory`) as a timeline. Each row shows:
 *   - the timestamp in HH:MM CT,
 *   - a type badge (REGIME_FLIP / LEVEL_BREACH / etc),
 *   - the alert title, and
 *   - the delivery count (devices reached) when non-zero.
 *
 * Pure presentational — the hook does the fetch + polling. Memoized
 * so parent re-renders don't churn it. Owner-only by transitivity
 * through the hook (which stops on 401).
 *
 * ## Why this is separate from the AlertConfigPanel
 *
 * The AlertConfig panel controls *subscription* (can this device
 * receive pushes?). The ServerEventsStrip displays *history* (what
 * has the server fired?). Both live on the same page but answer
 * orthogonal questions — conflating them would make the UI hard to
 * explain.
 */

import { memo } from 'react';
import { useRegimeEventsHistory } from '../../hooks/useRegimeEventsHistory';
import type { RegimeEventRow } from '../../hooks/useRegimeEventsHistory';

export interface ServerEventsStripProps {
  marketOpen: boolean;
}

// ── Presentation metadata ────────────────────────────────────────────

const SEVERITY_CLASS: Record<string, string> = {
  urgent: 'text-rose-300',
  warn: 'text-amber-300',
  info: 'text-sky-300',
};

const TYPE_LABEL: Record<string, string> = {
  REGIME_FLIP: 'REGIME',
  LEVEL_APPROACH: 'APPROACH',
  LEVEL_BREACH: 'BREACH',
  TRIGGER_FIRE: 'TRIGGER',
  PHASE_TRANSITION: 'PHASE',
};

// ── Helpers ──────────────────────────────────────────────────────────

/** Format an ISO timestamp as `HH:MM CT`. */
function formatCtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // America/Chicago renders both CST and CDT as locale-appropriate.
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  }).format(d);
  return `${parts} CT`;
}

function severityClass(severity: string): string {
  return SEVERITY_CLASS[severity] ?? 'text-slate-300';
}

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

// ── Row ──────────────────────────────────────────────────────────────

interface EventRowProps {
  event: RegimeEventRow;
}

const EventRow = memo(function EventRow({ event }: EventRowProps) {
  return (
    <li
      className="border-edge grid grid-cols-[auto_auto_1fr_auto] items-center gap-3 border-b py-1 last:border-b-0"
      aria-label={`${event.title} at ${formatCtTime(event.ts)}`}
    >
      <span
        className="text-muted font-mono text-[10px] tabular-nums"
        aria-hidden="true"
      >
        {formatCtTime(event.ts)}
      </span>
      <span
        className={`border-edge rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase ${severityClass(event.severity)}`}
      >
        {typeLabel(event.type)}
      </span>
      <span
        className="truncate font-mono text-[11px]"
        style={{ color: 'var(--color-secondary)' }}
        title={event.body}
      >
        {event.title}
      </span>
      {event.deliveredCount > 0 ? (
        <span
          className="text-muted font-mono text-[10px] tabular-nums"
          aria-label={`Delivered to ${event.deliveredCount} device${event.deliveredCount === 1 ? '' : 's'}`}
        >
          {event.deliveredCount}x
        </span>
      ) : (
        <span aria-hidden="true" />
      )}
    </li>
  );
});

// ── Component ────────────────────────────────────────────────────────

export const ServerEventsStrip = memo(function ServerEventsStrip({
  marketOpen,
}: ServerEventsStripProps) {
  const { events, loading, error } = useRegimeEventsHistory(marketOpen);

  return (
    <section
      className="border-edge bg-surface-alt mb-3 rounded-lg border p-3"
      aria-label="Recent server events"
    >
      <header className="mb-2 flex items-center justify-between">
        <h3
          className="font-mono text-[10px] font-semibold tracking-wider uppercase"
          style={{ color: 'var(--color-tertiary)' }}
        >
          Recent server events
        </h3>
        {loading && events.length === 0 ? (
          <span
            className="text-muted font-mono text-[10px]"
            role="status"
            aria-live="polite"
          >
            Loading…
          </span>
        ) : null}
      </header>

      {error ? (
        <p
          role="alert"
          className="text-danger py-1 font-mono text-[11px]"
        >
          {error.message}
        </p>
      ) : events.length === 0 && !loading ? (
        <p
          className="text-muted py-1 font-mono text-[11px] italic"
          aria-live="polite"
        >
          No server events fired yet today.
        </p>
      ) : (
        <ul className="space-y-0" role="list">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </ul>
      )}
    </section>
  );
});

export default ServerEventsStrip;
