/**
 * TodaysFiredStrip — focused post-hoc view of today's fired setups.
 *
 * The Phase 2A `regime_events` pipeline emits a `TRIGGER_FIRE` edge the
 * moment a named setup becomes ACTIVE. Those windows are often short
 * (5–15 min) and easy to miss if you aren't watching the widget at the
 * right moment. This strip collects every `TRIGGER_FIRE` for the day
 * currently in view, in chronological order, and exposes a per-row
 * click-to-scrub affordance so the trader can jump back to that exact
 * moment in the scrubber and review what the rest of the playbook
 * looked like when the setup fired.
 *
 * ## Scope vs. `ServerEventsStrip`
 *
 * - `ServerEventsStrip` shows ALL recent edges (regime flips, breaches,
 *   approaches, triggers, phase transitions) — it's a generic timeline.
 * - `TodaysFiredStrip` filters to `TRIGGER_FIRE` for the currently
 *   viewed date and adds scrub interactivity — it's the "did I miss
 *   anything?" view.
 *
 * Both live in the widget. Each answers a different question.
 *
 * Pure presentational — the hook (`useRegimeEventsHistory`) owns the
 * fetch + polling. Memoized so parent re-renders don't churn.
 */

import { memo, useMemo } from 'react';
import { useRegimeEventsHistory } from '../../hooks/useRegimeEventsHistory.js';
import type { RegimeEventRow } from '../../hooks/useRegimeEventsHistory.js';
import { Tooltip } from '../ui/Tooltip.js';
import { getCTTime } from '../../utils/timezone.js';
import type { TriggerId } from './triggers.js';

export interface TodaysFiredStripProps {
  marketOpen: boolean;
  /** YYYY-MM-DD in ET — today, or the scrubbed day under review. */
  selectedDate: string;
  /**
   * Optional callback invoked when the trader clicks a row's scrub
   * button. Receives the event's ISO timestamp. When omitted the row
   * still renders but the button is hidden — the strip remains useful
   * as a read-only summary even without a scrub host.
   */
  onScrubTo?: (ts: string) => void;
}

// Constants

/**
 * Bump past the hook's default of 20 so a full day of edges fits with
 * headroom. The server caps at 100 — matching that here gives the most
 * data a single request can return without pagination.
 */
const HISTORY_LIMIT = 100;

// Presentation metadata

/**
 * Mirror of the ACTIVE/ARMED palette from TriggersPanel STATUS_META.
 * A fired trigger badge uses the same sky tone as its ACTIVE state so
 * the visual association carries over between the live panel and the
 * post-hoc strip.
 */
const TRIGGER_BADGE_CLASS = 'bg-sky-500/20 text-sky-300';

const SEVERITY_CLASS: Record<string, string> = {
  urgent: 'bg-rose-500/20 text-rose-300',
  warn: 'bg-amber-500/20 text-amber-300',
  info: 'bg-sky-500/20 text-sky-300',
};

const KNOWN_TRIGGER_IDS: ReadonlySet<TriggerId> = new Set<TriggerId>([
  'fade-call-wall',
  'lift-put-wall',
  'break-call-wall',
  'break-put-wall',
  'charm-drift',
]);

const TRIGGER_LABEL: Record<TriggerId, string> = {
  'fade-call-wall': 'Fade call wall',
  'lift-put-wall': 'Lift put wall',
  'break-call-wall': 'Break call wall',
  'break-put-wall': 'Break put wall',
  'charm-drift': 'Charm drift',
};

// Helpers

/** Format an ISO timestamp as HH:MM CT using the shared timezone util. */
function formatCtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const { hour, minute } = getCTTime(d);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${hh}:${mm} CT`;
}

/**
 * Extract the trigger id from the event payload. The pure alert engine
 * builds titles as "Trigger fired: <triggerId>". Body contains a
 * wrapped form: Named setup "<triggerId>" just became active. We try
 * title first, then fall back to body — that way a future copy tweak
 * to one field does not silently break this parser.
 */
const TITLE_RE = /Trigger fired:\s*(\S+)/;
const BODY_RE = /"([^"]+)"/;

function extractTriggerId(event: RegimeEventRow): string | null {
  const titleMatch = TITLE_RE.exec(event.title);
  if (titleMatch?.[1]) return titleMatch[1];
  const bodyMatch = BODY_RE.exec(event.body);
  if (bodyMatch?.[1]) return bodyMatch[1];
  return null;
}

/** Turn a raw id into a human-friendly name, falling back to the id itself. */
function triggerLabel(id: string | null): string {
  if (id === null) return 'Unknown setup';
  if ((KNOWN_TRIGGER_IDS as ReadonlySet<string>).has(id)) {
    return TRIGGER_LABEL[id as TriggerId];
  }
  return id;
}

function severityClass(severity: string): string {
  return SEVERITY_CLASS[severity] ?? 'bg-white/5 text-muted';
}

/**
 * Convert an ISO timestamp to its YYYY-MM-DD ET calendar date. Matches
 * the convention selectedDate uses everywhere else in the widget. Uses
 * en-CA locale because it formats natively as YYYY-MM-DD.
 */
const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function etDateOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return ET_DATE_FORMATTER.format(d);
}

// Row

interface FiredRowProps {
  event: RegimeEventRow;
  onScrubTo?: (ts: string) => void;
}

const FiredRow = memo(function FiredRow({
  event,
  onScrubTo,
}: FiredRowProps) {
  const triggerId = extractTriggerId(event);
  const label = triggerLabel(triggerId);
  const time = formatCtTime(event.ts);
  return (
    <li
      className="border-edge grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 border-b py-1 last:border-b-0"
      aria-label={`${label} fired at ${time}`}
    >
      <span
        className="text-muted font-mono text-[10px] tabular-nums"
        aria-hidden="true"
      >
        {time}
      </span>
      <Tooltip content={event.body} side="bottom">
        <span
          className={`cursor-help truncate rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${TRIGGER_BADGE_CLASS}`}
        >
          {label}
        </span>
      </Tooltip>
      <span
        className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider uppercase ${severityClass(event.severity)}`}
        aria-label={`Severity ${event.severity}`}
      >
        {event.severity}
      </span>
      {onScrubTo ? (
        <button
          type="button"
          onClick={() => onScrubTo(event.ts)}
          className="border-edge text-muted hover:bg-white/5 rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
          aria-label={`Jump scrubber to ${time}`}
        >
          <span aria-hidden="true">↪ </span>jump
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
    </li>
  );
});

// Component

export const TodaysFiredStrip = memo(function TodaysFiredStrip({
  marketOpen,
  selectedDate,
  onScrubTo,
}: TodaysFiredStripProps) {
  const { events, loading, error } = useRegimeEventsHistory(
    marketOpen,
    HISTORY_LIMIT,
  );

  const firedToday = useMemo(() => {
    return events
      .filter(
        (e) =>
          e.type === 'TRIGGER_FIRE' && etDateOf(e.ts) === selectedDate,
      )
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }, [events, selectedDate]);

  return (
    <section
      role="region"
      aria-label="Today's fired setups"
      className="border-edge bg-surface-alt mb-3 rounded-lg border p-3"
    >
      <header className="mb-2 flex items-center justify-between">
        <h3
          className="font-mono text-[10px] font-semibold tracking-wider uppercase"
          style={{ color: 'var(--color-tertiary)' }}
        >
          Today's fired setups
          <span
            className="text-muted ml-2 font-normal tabular-nums"
            aria-label={`${firedToday.length} triggers fired`}
          >
            · {firedToday.length}{' '}
            {firedToday.length === 1 ? 'trigger' : 'triggers'}
          </span>
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
        <p role="alert" className="text-danger py-1 font-mono text-[11px]">
          {error.message}
        </p>
      ) : firedToday.length === 0 && !loading ? (
        <p
          className="text-muted py-1 font-mono text-[11px] italic"
          aria-live="polite"
        >
          No setups fired today yet — watching.
        </p>
      ) : (
        <ul className="max-h-32 space-y-0 overflow-y-auto" role="list">
          {firedToday.map((event) => (
            <FiredRow
              key={event.id}
              event={event}
              onScrubTo={onScrubTo}
            />
          ))}
        </ul>
      )}
    </section>
  );
});

export default TodaysFiredStrip;
