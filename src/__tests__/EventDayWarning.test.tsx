import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EventDayWarning from '../components/EventDayWarning';
import { lightTheme, darkTheme } from '../themes';
import {
  getEventsForDate,
  isHighImpactDay,
  hasEvents,
  getMaxSeverity,
  getEventSummary,
} from '../data/eventCalendar';

// ============================================================
// DATA LOOKUP FUNCTIONS
// ============================================================
describe('eventCalendar: lookup functions', () => {
  it('returns FOMC event for 2026-01-28', () => {
    const events = getEventsForDate('2026-01-28');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.event).toMatch(/FOMC/);
  });

  it('returns CPI event for 2026-03-11', () => {
    const events = getEventsForDate('2026-03-11');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.event).toBe('CPI');
  });

  it('returns NFP event for 2026-03-06', () => {
    const events = getEventsForDate('2026-03-06');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.event).toBe('NFP');
  });

  it('returns empty array for non-event date', () => {
    const events = getEventsForDate('2026-03-15');
    expect(events).toHaveLength(0);
  });

  it('returns multiple events when they overlap', () => {
    // 2026-12-09 has both FOMC and CPI
    const events = getEventsForDate('2026-12-09');
    expect(events.length).toBe(2);
    const names = events.map((e) => e.event);
    expect(names).toContain('CPI');
    expect(names.some((n) => n.includes('FOMC'))).toBe(true);
  });

  it('isHighImpactDay returns true for FOMC day', () => {
    expect(isHighImpactDay('2026-01-28')).toBe(true);
  });

  it('isHighImpactDay returns false for non-event day', () => {
    expect(isHighImpactDay('2026-03-15')).toBe(false);
  });

  it('hasEvents returns true for event day', () => {
    expect(hasEvents('2026-03-11')).toBe(true);
  });

  it('hasEvents returns false for non-event day', () => {
    expect(hasEvents('2026-03-15')).toBe(false);
  });

  it('getMaxSeverity returns high for FOMC', () => {
    expect(getMaxSeverity('2026-01-28')).toBe('high');
  });

  it('getMaxSeverity returns medium for GDP-only day', () => {
    expect(getMaxSeverity('2026-04-29')).toBe('medium');
  });

  it('getMaxSeverity returns null for non-event day', () => {
    expect(getMaxSeverity('2026-03-15')).toBeNull();
  });

  it('getEventSummary returns event names joined', () => {
    const summary = getEventSummary('2026-12-09');
    expect(summary).toMatch(/FOMC/);
    expect(summary).toMatch(/CPI/);
  });

  it('getEventSummary returns empty string for non-event day', () => {
    expect(getEventSummary('2026-03-15')).toBe('');
  });
});

// ============================================================
// DATA INTEGRITY
// ============================================================
describe('eventCalendar: data integrity', () => {
  it('has 8 FOMC meetings per year in 2026', () => {
    let count = 0;
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 31; d++) {
        const date = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const events = getEventsForDate(date);
        if (events.some((e) => e.event.includes('FOMC'))) count++;
      }
    }
    expect(count).toBe(8);
  });

  it('has 12 CPI releases in 2026', () => {
    let count = 0;
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 31; d++) {
        const date = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const events = getEventsForDate(date);
        if (events.some((e) => e.event === 'CPI')) count++;
      }
    }
    expect(count).toBe(12);
  });

  it('has 12 NFP releases in 2026', () => {
    let count = 0;
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 31; d++) {
        const date = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const events = getEventsForDate(date);
        if (events.some((e) => e.event === 'NFP')) count++;
      }
    }
    expect(count).toBe(12);
  });

  it('all events have required fields', () => {
    // Spot check a few dates
    const dates = ['2026-01-28', '2026-03-11', '2026-03-06', '2026-04-29'];
    for (const date of dates) {
      const events = getEventsForDate(date);
      for (const evt of events) {
        expect(evt.date).toBe(date);
        expect(evt.event.length).toBeGreaterThan(0);
        expect(evt.description.length).toBeGreaterThan(0);
        expect(evt.time.length).toBeGreaterThan(0);
        expect(['high', 'medium']).toContain(evt.severity);
      }
    }
  });

  it('FOMC events always have 2:00 PM time', () => {
    const fomcDates = ['2026-01-28', '2026-03-18', '2026-05-06'];
    for (const date of fomcDates) {
      const events = getEventsForDate(date);
      const fomc = events.find((e) => e.event.includes('FOMC'));
      expect(fomc?.time).toBe('2:00 PM');
    }
  });

  it('CPI and NFP events always have 8:30 AM time', () => {
    const dates = ['2026-03-11', '2026-03-06'];
    for (const date of dates) {
      const events = getEventsForDate(date);
      for (const evt of events) {
        if (evt.event === 'CPI' || evt.event === 'NFP') {
          expect(evt.time).toBe('8:30 AM');
        }
      }
    }
  });
});

// ============================================================
// EventDayWarning COMPONENT
// ============================================================
describe('EventDayWarning: rendering', () => {
  it('renders nothing for non-event date', () => {
    const { container } = render(
      <EventDayWarning th={lightTheme} selectedDate="2026-03-15" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for empty date', () => {
    const { container } = render(
      <EventDayWarning th={lightTheme} selectedDate="" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows high-impact warning for FOMC day', () => {
    render(<EventDayWarning th={lightTheme} selectedDate="2026-01-28" />);
    expect(screen.getByText(/high-impact event day/i)).toBeInTheDocument();
    expect(screen.getAllByText(/FOMC/).length).toBeGreaterThan(0);
  });

  it('shows CPI event details', () => {
    render(<EventDayWarning th={lightTheme} selectedDate="2026-03-11" />);
    expect(screen.getAllByText(/CPI/).length).toBeGreaterThan(0);
    expect(screen.getByText(/consumer price index/i)).toBeInTheDocument();
    expect(screen.getByText(/8:30 AM ET/)).toBeInTheDocument();
  });

  it('shows NFP event details', () => {
    render(<EventDayWarning th={lightTheme} selectedDate="2026-03-06" />);
    expect(screen.getAllByText(/NFP/).length).toBeGreaterThan(0);
    expect(screen.getByText(/nonfarm payrolls/i)).toBeInTheDocument();
  });

  it('shows advice for high-impact events', () => {
    render(<EventDayWarning th={lightTheme} selectedDate="2026-01-28" />);
    expect(screen.getByText(/wider ranges/i)).toBeInTheDocument();
  });

  it('shows multiple events on overlap day (2026-12-09: FOMC + CPI)', () => {
    render(<EventDayWarning th={lightTheme} selectedDate="2026-12-09" />);
    expect(screen.getAllByText(/CPI/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/FOMC/).length).toBeGreaterThan(0);
  });

  it('shows medium severity for GDP-only day', () => {
    render(<EventDayWarning th={lightTheme} selectedDate="2026-04-29" />);
    expect(screen.getByText(/economic event day/i)).toBeInTheDocument();
    expect(screen.getAllByText(/GDP/).length).toBeGreaterThan(0);
  });

  it('renders in dark mode', () => {
    render(<EventDayWarning th={darkTheme} selectedDate="2026-03-11" />);
    expect(screen.getAllByText(/CPI/).length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------
  // Advice branch coverage (lines 101-119)
  // --------------------------------------------------------
  it('shows CLOSED advice for market closure', () => {
    const liveEvents = [
      {
        date: '2026-01-19',
        event: 'CLOSED',
        description: 'Martin Luther King Jr. Day',
        time: 'All Day',
        severity: 'high' as const,
        source: 'static' as const,
      },
    ];
    render(
      <EventDayWarning
        th={lightTheme}
        selectedDate="2026-01-19"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText(/market closed/i)).toBeInTheDocument();
    expect(screen.getByText(/no 0dte trading possible/i)).toBeInTheDocument();
  });

  it('shows EARLY CLOSE + macro advice', () => {
    const liveEvents = [
      {
        date: '2026-11-27',
        event: 'EARLY CLOSE',
        description: 'Day after Thanksgiving',
        time: '1:00 PM',
        severity: 'medium' as const,
        source: 'static' as const,
      },
      {
        date: '2026-11-27',
        event: 'CPI',
        description: 'Consumer Price Index',
        time: '8:30 AM',
        severity: 'high' as const,
        source: 'fred' as const,
      },
    ];
    render(
      <EventDayWarning
        th={lightTheme}
        selectedDate="2026-11-27"
        liveEvents={liveEvents}
      />,
    );
    expect(
      screen.getByText(/early close day with macro events/i),
    ).toBeInTheDocument();
  });

  it('shows EARLY CLOSE advice without macro', () => {
    const liveEvents = [
      {
        date: '2026-11-27',
        event: 'EARLY CLOSE',
        description: 'Day after Thanksgiving',
        time: '1:00 PM',
        severity: 'medium' as const,
        source: 'static' as const,
      },
    ];
    render(
      <EventDayWarning
        th={lightTheme}
        selectedDate="2026-11-27"
        liveEvents={liveEvents}
      />,
    );
    expect(
      screen.getByText(/market closes at 1:00 PM ET/i),
    ).toBeInTheDocument();
  });

  it('shows earnings + macro advice', () => {
    const liveEvents = [
      {
        date: '2026-07-15',
        event: 'AAPL Earnings',
        description: 'Apple quarterly earnings',
        time: '4:00 PM',
        severity: 'high' as const,
        source: 'finnhub' as const,
      },
      {
        date: '2026-07-15',
        event: 'CPI',
        description: 'Consumer Price Index',
        time: '8:30 AM',
        severity: 'high' as const,
        source: 'fred' as const,
      },
    ];
    render(
      <EventDayWarning
        th={lightTheme}
        selectedDate="2026-07-15"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText(/mega-cap earnings \+ macro/i)).toBeInTheDocument();
  });

  it('shows earnings-only advice', () => {
    const liveEvents = [
      {
        date: '2026-07-15',
        event: 'AAPL Earnings',
        description: 'Apple quarterly earnings',
        time: '4:00 PM',
        severity: 'high' as const,
        source: 'finnhub' as const,
      },
    ];
    render(
      <EventDayWarning
        th={lightTheme}
        selectedDate="2026-07-15"
        liveEvents={liveEvents}
      />,
    );
    expect(
      screen.getByText(/mega-cap earnings can cause/i),
    ).toBeInTheDocument();
  });

  it('shows correct header icon/label for CLOSED events', () => {
    const liveEvents = [
      {
        date: '2026-01-19',
        event: 'CLOSED',
        description: 'Holiday',
        time: 'All Day',
        severity: 'high' as const,
        source: 'static' as const,
      },
    ];
    render(
      <EventDayWarning
        th={lightTheme}
        selectedDate="2026-01-19"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText('Market Closed')).toBeInTheDocument();
  });

  it('shows correct header label for EARLY CLOSE events', () => {
    const liveEvents = [
      {
        date: '2026-11-27',
        event: 'EARLY CLOSE',
        description: 'Day after Thanksgiving',
        time: '1:00 PM',
        severity: 'medium' as const,
        source: 'static' as const,
      },
    ];
    render(
      <EventDayWarning
        th={lightTheme}
        selectedDate="2026-11-27"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText('Early Close Day')).toBeInTheDocument();
  });

  it('shows earnings icon for earnings events', () => {
    const liveEvents = [
      {
        date: '2026-07-15',
        event: 'MSFT Earnings',
        description: 'Microsoft quarterly earnings',
        time: '4:00 PM',
        severity: 'high' as const,
        source: 'finnhub' as const,
      },
    ];
    render(
      <EventDayWarning
        th={lightTheme}
        selectedDate="2026-07-15"
        liveEvents={liveEvents}
      />,
    );
    // Earnings events use 📈 icon and show as high-impact
    expect(screen.getByText('📈')).toBeInTheDocument();
  });

  it('uses live events over static when available', () => {
    const liveEvents = [
      {
        date: '2026-03-11',
        event: 'NFP',
        description: 'Nonfarm Payrolls (live)',
        time: '8:30 AM',
        severity: 'high' as const,
        source: 'fred' as const,
      },
    ];
    render(
      <EventDayWarning
        th={lightTheme}
        selectedDate="2026-03-11"
        liveEvents={liveEvents}
      />,
    );
    // Should show the live description, not the static CPI one
    expect(screen.getByText(/nonfarm payrolls \(live\)/i)).toBeInTheDocument();
  });

  it('determines severity from live events when medium-only', () => {
    const liveEvents = [
      {
        date: '2026-04-29',
        event: 'GDP',
        description: 'Gross Domestic Product',
        time: '8:30 AM',
        severity: 'medium' as const,
        source: 'fred' as const,
      },
    ];
    render(
      <EventDayWarning
        th={lightTheme}
        selectedDate="2026-04-29"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText(/economic event day/i)).toBeInTheDocument();
  });
});
