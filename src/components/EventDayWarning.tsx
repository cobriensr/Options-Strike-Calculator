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
    <div style={{
      marginTop: 12,
      padding: '12px 16px',
      borderRadius: 10,
      backgroundColor: bg,
      border: '1.5px solid ' + border,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
      }}>
        <span style={{ fontSize: 16 }}>{isHigh ? '\u26A0\uFE0F' : '\uD83D\uDCC5'}</span>
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
          letterSpacing: '0.10em', color,
          fontFamily: "'Outfit', sans-serif",
        }}>
          {isHigh ? 'High-Impact Event Day' : 'Economic Event Day'}
        </span>
      </div>

      {/* Event list */}
      {events.map((evt, i) => (
        <EventRow key={i} th={th} event={evt} />
      ))}

      {/* Advice */}
      <div style={{
        marginTop: 10, paddingTop: 8,
        borderTop: '1px solid ' + border,
        fontSize: 11, color: th.textSecondary,
        fontFamily: "'Outfit', sans-serif", lineHeight: 1.6,
      }}>
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
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '6px 0',
    }}>
      <span style={{
        fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
        backgroundColor: tagColor + '18', color: tagColor,
        fontFamily: "'DM Mono', monospace",
        textTransform: 'uppercase' as const,
        letterSpacing: '0.06em',
        flexShrink: 0,
      }}>
        {event.event}
      </span>
      <span style={{
        fontSize: 12, color: th.text,
        fontFamily: "'Outfit', sans-serif", fontWeight: 500,
      }}>
        {event.description}
      </span>
      <span style={{
        fontSize: 11, color: th.textMuted,
        fontFamily: "'DM Mono', monospace",
        marginLeft: 'auto', flexShrink: 0,
      }}>
        {event.time} ET
      </span>
    </div>
  );
}
