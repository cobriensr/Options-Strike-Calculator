import type { Theme } from '../themes';
import { tint } from '../utils/ui-utils';
import { getEventsForDate, getMaxSeverity } from '../data/eventCalendar';
import type { EventItem } from '../types/api';

interface Props {
  readonly th: Theme;
  readonly selectedDate: string; // YYYY-MM-DD
  readonly liveEvents?: readonly EventItem[]; // From FRED API
}

/**
 * Event Day Warning banner.
 * Shows a prominent warning when the selected date has scheduled
 * high-impact economic events (FOMC, CPI, NFP, GDP, PCE, PPI, etc).
 *
 * Uses live FRED API events when available, falls back to static data.
 * Renders nothing when no events are scheduled.
 */
export default function EventDayWarning({
  th,
  selectedDate,
  liveEvents,
}: Props) {
  if (!selectedDate) return null;

  // Use live events for the selected date if available, else static
  const liveForDate = liveEvents?.filter((e) => e.date === selectedDate) ?? [];
  const useStatic = liveForDate.length === 0;

  const events: readonly {
    event: string;
    description: string;
    time: string;
    severity: 'high' | 'medium';
  }[] = useStatic ? getEventsForDate(selectedDate) : liveForDate;

  if (events.length === 0) return null;

  const severity = useStatic
    ? getMaxSeverity(selectedDate)
    : events.some((e) => e.severity === 'high')
      ? 'high'
      : 'medium';
  const isHigh = severity === 'high';

  const color = isHigh ? th.red : th.caution;
  const bg = isHigh ? tint(th.red, '12') : tint(th.caution, '12');
  const border = isHigh ? tint(th.red, '35') : tint(th.caution, '35');

  return (
    <div
      className="mt-3 rounded-[10px] p-3 sm:p-4"
      style={{ backgroundColor: bg, border: '1.5px solid ' + border }}
    >
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
        <span className="text-base">
          {events.some((e) => e.event === 'CLOSED')
            ? '\uD83D\uDEAB'
            : events.some((e) => e.event === 'EARLY CLOSE')
              ? '\u23F0'
              : events.some((e) => e.event.includes('Earnings'))
                ? '\uD83D\uDCC8'
                : isHigh
                  ? '\u26A0\uFE0F'
                  : '\uD83D\uDCC5'}
        </span>
        <span
          className="font-sans text-[10px] font-bold tracking-widest uppercase"
          style={{ color }}
        >
          {events.some((e) => e.event === 'CLOSED')
            ? 'Market Closed'
            : events.some((e) => e.event === 'EARLY CLOSE')
              ? 'Early Close Day'
              : isHigh
                ? 'High-Impact Event Day'
                : 'Economic Event Day'}
        </span>
      </div>

      {/* Event list */}
      {events.map((evt, i) => (
        <EventRow key={i} th={th} event={evt} />
      ))}

      {/* Advice */}
      <div
        className="text-secondary mt-2.5 pt-2 font-sans text-[11px] leading-relaxed"
        style={{ borderTop: '1px solid ' + border }}
      >
        {(() => {
          const eventNames = events.map((e) => e.event);
          const hasClosed = eventNames.includes('CLOSED');
          const hasEarlyClose = eventNames.includes('EARLY CLOSE');
          const hasEarnings = eventNames.some((n) => n.includes('Earnings'));
          const hasMacro = eventNames.some((n) =>
            ['CPI', 'NFP', 'PCE', 'FOMC', 'FOMC + SEP'].includes(n),
          );

          if (hasClosed) {
            return 'Market is closed today. No 0DTE trading possible.';
          }
          if (hasEarlyClose && hasMacro) {
            return 'Early close day with macro events. Market closes at 1:00 PM ET \u2014 your time-to-expiry is 3 hours shorter than normal. Combined with the data release, expect compressed but potentially volatile price action. Use extreme caution.';
          }
          if (hasEarlyClose) {
            return 'Early close day \u2014 market closes at 1:00 PM ET. Your time-to-expiry is 3 hours shorter than normal, which means tighter strikes for the same delta. Premium is lower and theta decay is faster. Adjust your entry time and size accordingly.';
          }
          if (hasEarnings && hasMacro) {
            return 'Mega-cap earnings + macro data release. This combination can produce outsized moves. Consider sitting out or trading minimum size with the widest wings available.';
          }
          if (hasEarnings) {
            return 'Mega-cap earnings can cause SPX to gap at the open or move sharply intraday. If the report was after yesterday\u2019s close, check the overnight /ES move before entering. Consider wider deltas or reduced size.';
          }
          if (isHigh) {
            return 'CPI, NFP, PCE, and FOMC days historically produce wider ranges than VIX alone predicts. Consider widening deltas 1\u20132\u0394 beyond the guide ceiling, reducing position size, or sitting out until after the release.';
          }
          return 'GDP, PPI, Retail Sales, and JOLTS releases can cause moderate volatility. Follow the delta guide but consider slightly tighter sizing.';
        })()}
      </div>
    </div>
  );
}

function EventRow({
  th,
  event,
}: {
  th: Theme;
  event: {
    event: string;
    description: string;
    time: string;
    severity: 'high' | 'medium';
  };
}) {
  const tagColor = event.severity === 'high' ? th.red : th.caution;

  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span
        className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.06em] uppercase"
        style={{ backgroundColor: tint(tagColor, '18'), color: tagColor }}
      >
        {event.event}
      </span>
      <span className="text-primary font-sans text-xs font-medium">
        {event.description}
      </span>
      <span className="text-muted ml-auto shrink-0 font-mono text-[11px]">
        {event.time} ET
      </span>
    </div>
  );
}
