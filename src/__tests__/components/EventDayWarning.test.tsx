import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EventDayWarning from '../../components/EventDayWarning';
import { theme } from '../../themes';
import type { EventItem } from '../../types/api';

// Helper to build a live event
function evt(
  overrides: Partial<EventItem> & { date: string; event: string },
): EventItem {
  return {
    description: overrides.event,
    time: '8:30 AM',
    severity: 'high',
    source: 'fred',
    ...overrides,
  };
}

// ============================================================
// EventDayWarning COMPONENT
// ============================================================
describe('EventDayWarning: rendering', () => {
  it('renders nothing when no live events match the date', () => {
    const { container } = render(
      <EventDayWarning th={theme} selectedDate="2026-03-15" liveEvents={[]} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for empty date', () => {
    const { container } = render(
      <EventDayWarning th={theme} selectedDate="" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when liveEvents is undefined', () => {
    const { container } = render(
      <EventDayWarning th={theme} selectedDate="2026-01-28" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows high-impact warning for FOMC day', () => {
    const liveEvents = [
      evt({
        date: '2026-01-28',
        event: 'FOMC',
        description: 'Federal Reserve interest rate decision',
        time: '2:00 PM',
        source: 'static',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-01-28"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText(/high-impact event day/i)).toBeInTheDocument();
    expect(screen.getAllByText(/FOMC/).length).toBeGreaterThan(0);
  });

  it('shows CPI event details', () => {
    const liveEvents = [
      evt({
        date: '2026-03-11',
        event: 'CPI',
        description: 'Consumer Price Index',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-03-11"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getAllByText(/CPI/).length).toBeGreaterThan(0);
    expect(screen.getByText(/consumer price index/i)).toBeInTheDocument();
    expect(screen.getByText(/8:30 AM ET/)).toBeInTheDocument();
  });

  it('shows NFP event details', () => {
    const liveEvents = [
      evt({
        date: '2026-03-06',
        event: 'NFP',
        description: 'Nonfarm Payrolls (February data)',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-03-06"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getAllByText(/NFP/).length).toBeGreaterThan(0);
    expect(screen.getByText(/nonfarm payrolls/i)).toBeInTheDocument();
  });

  it('shows advice for high-impact events', () => {
    const liveEvents = [
      evt({
        date: '2026-01-28',
        event: 'FOMC',
        description: 'Federal Reserve interest rate decision',
        time: '2:00 PM',
        source: 'static',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-01-28"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText(/wider ranges/i)).toBeInTheDocument();
  });

  it('shows multiple events on overlap day', () => {
    const liveEvents = [
      evt({
        date: '2026-12-09',
        event: 'CPI',
        description: 'Consumer Price Index',
      }),
      evt({
        date: '2026-12-09',
        event: 'FOMC + SEP',
        description: 'Fed rate decision + dot plot',
        time: '2:00 PM',
        source: 'static',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-12-09"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getAllByText(/CPI/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/FOMC/).length).toBeGreaterThan(0);
  });

  it('shows medium severity for GDP-only day', () => {
    const liveEvents = [
      evt({
        date: '2026-04-29',
        event: 'GDP',
        description: 'Gross Domestic Product',
        severity: 'medium',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-04-29"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText(/economic event day/i)).toBeInTheDocument();
    expect(screen.getAllByText(/GDP/).length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------
  // Advice branch coverage
  // --------------------------------------------------------
  it('shows CLOSED advice for market closure', () => {
    const liveEvents = [
      evt({
        date: '2026-01-19',
        event: 'CLOSED',
        description: 'Martin Luther King Jr. Day',
        time: 'All Day',
        source: 'static',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-01-19"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText(/market closed/i)).toBeInTheDocument();
    expect(screen.getByText(/no 0dte trading possible/i)).toBeInTheDocument();
  });

  it('shows EARLY CLOSE + macro advice', () => {
    const liveEvents = [
      evt({
        date: '2026-11-27',
        event: 'EARLY CLOSE',
        description: 'Day after Thanksgiving',
        time: '1:00 PM',
        severity: 'medium',
        source: 'static',
      }),
      evt({
        date: '2026-11-27',
        event: 'CPI',
        description: 'Consumer Price Index',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
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
      evt({
        date: '2026-11-27',
        event: 'EARLY CLOSE',
        description: 'Day after Thanksgiving',
        time: '1:00 PM',
        severity: 'medium',
        source: 'static',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
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
      evt({
        date: '2026-07-15',
        event: 'AAPL Earnings',
        description: 'Apple quarterly earnings',
        time: '4:00 PM',
        source: 'finnhub',
      }),
      evt({
        date: '2026-07-15',
        event: 'CPI',
        description: 'Consumer Price Index',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-07-15"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText(/mega-cap earnings \+ macro/i)).toBeInTheDocument();
  });

  it('shows earnings-only advice', () => {
    const liveEvents = [
      evt({
        date: '2026-07-15',
        event: 'AAPL Earnings',
        description: 'Apple quarterly earnings',
        time: '4:00 PM',
        source: 'finnhub',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
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
      evt({
        date: '2026-01-19',
        event: 'CLOSED',
        description: 'Holiday',
        time: 'All Day',
        source: 'static',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-01-19"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText('Market Closed')).toBeInTheDocument();
  });

  it('shows correct header label for EARLY CLOSE events', () => {
    const liveEvents = [
      evt({
        date: '2026-11-27',
        event: 'EARLY CLOSE',
        description: 'Day after Thanksgiving',
        time: '1:00 PM',
        severity: 'medium',
        source: 'static',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-11-27"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText('Early Close Day')).toBeInTheDocument();
  });

  it('shows earnings icon for earnings events', () => {
    const liveEvents = [
      evt({
        date: '2026-07-15',
        event: 'MSFT Earnings',
        description: 'Microsoft quarterly earnings',
        time: '4:00 PM',
        source: 'finnhub',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-07-15"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText('📈')).toBeInTheDocument();
  });

  it('determines severity from live events when medium-only', () => {
    const liveEvents = [
      evt({
        date: '2026-04-29',
        event: 'GDP',
        description: 'Gross Domestic Product',
        severity: 'medium',
      }),
    ];
    render(
      <EventDayWarning
        th={theme}
        selectedDate="2026-04-29"
        liveEvents={liveEvents}
      />,
    );
    expect(screen.getByText(/economic event day/i)).toBeInTheDocument();
  });
});
