import type { Theme } from '../themes';
import { getEventsForDate, getMaxSeverity, type MarketEvent } from '../data/eventCalendar';

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
      className="mt-3 p-3 sm:p-4 rounded-[10px]"
      style={{ backgroundColor: bg, border: '1.5px solid ' + border }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">{isHigh ? '\u26A0\uFE0F' : '\uD83D\uDCC5'}</span>
        <span
          className="text-[10px] font-bold uppercase tracking-widest font-sans"
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
        className="mt-2.5 pt-2 text-[11px] text-secondary font-sans leading-relaxed"
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
        className="text-[9px] font-bold py-0.5 px-2 rounded-full font-mono uppercase tracking-[0.06em] shrink-0"
        style={{ backgroundColor: tagColor + '18', color: tagColor }}
      >
        {event.event}
      </span>
      <span className="text-xs text-primary font-sans font-medium">
        {event.description}
      </span>
      <span className="text-[11px] text-muted font-mono ml-auto shrink-0">
        {event.time} ET
      </span>
    </div>
  );
}
