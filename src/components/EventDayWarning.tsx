import type { Theme } from '../themes';
import {
  getEventsForDate,
  getMaxSeverity,
  type MarketEvent,
} from '../data/eventCalendar';

interface Props {
  readonly th: Theme;
  readonly selectedDate: string; // YYYY-MM-DD
}

/**
 * Event Day Warning banner.
 * Shows a prominent warning when the selected date has scheduled
 * high-impact economic events (FOMC, CPI, NFP, GDP).
 * Renders nothing when no events are scheduled.
 */
export default function EventDayWarning({ th, selectedDate }: Props) {
  if (!selectedDate) return null;

  const events = getEventsForDate(selectedDate);
  if (events.length === 0) return null;

  const severity = getMaxSeverity(selectedDate);
  const isHigh = severity === 'high';

  const color = isHigh ? th.red : '#E8A317';
  const bg = isHigh ? th.red + '12' : '#E8A31712';
  const border = isHigh ? th.red + '35' : '#E8A31735';

  return (
    <div
      className="mt-3 rounded-[10px] p-3 sm:p-4"
      style={{ backgroundColor: bg, border: '1.5px solid ' + border }}
    >
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
        <span className="text-base">
          {isHigh ? '\u26A0\uFE0F' : '\uD83D\uDCC5'}
        </span>
        <span
          className="font-sans text-[10px] font-bold tracking-widest uppercase"
          style={{ color }}
        >
          {isHigh ? 'High-Impact Event Day' : 'Economic Event Day'}
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
        {isHigh
          ? 'CPI, NFP, and FOMC days historically produce wider ranges than VIX alone predicts. Consider widening deltas 1\u20132\u0394 beyond the guide ceiling, reducing position size, or sitting out until after the release.'
          : 'GDP releases can cause moderate volatility. Follow the delta guide but consider slightly tighter sizing.'}
      </div>
    </div>
  );
}

function EventRow({ th, event }: { th: Theme; event: MarketEvent }) {
  const tagColor = event.severity === 'high' ? th.red : '#E8A317';

  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span
        className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] font-bold tracking-[0.06em] uppercase"
        style={{ backgroundColor: tagColor + '18', color: tagColor }}
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
