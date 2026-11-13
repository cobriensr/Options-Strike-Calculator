import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EventDayWarning from '../../components/EventDayWarning';
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
      <EventDayWarning selectedDate="2026-03-15" liveEvents={[]} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for empty date', () => {
    const { container } = render(<EventDayWarning selectedDate="" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when liveEvents is undefined', () => {
    const { container } = render(<EventDayWarning selectedDate="2026-01-28" />);
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
      <EventDayWarning selectedDate="2026-01-28" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-03-11" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-03-06" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-01-28" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-12-09" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-04-29" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-01-19" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-11-27" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-11-27" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-07-15" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-07-15" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-01-19" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-11-27" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-07-15" liveEvents={liveEvents} />,
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
      <EventDayWarning selectedDate="2026-04-29" liveEvents={liveEvents} />,
    );
    expect(screen.getByText(/economic event day/i)).toBeInTheDocument();
  });
});

// ============================================================
// EventDayWarning: a date whose events could not load
// ============================================================
describe('EventDayWarning: events that could not load', () => {
  const LOAD_FAILED = "Events for this date couldn't load.";

  it('says the events could not load, with a Retry button', () => {
    render(
      <EventDayWarning
        selectedDate="2026-11-10"
        failed
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText(LOAD_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows no Retry button when it has nothing to call', () => {
    render(<EventDayWarning selectedDate="2026-11-10" failed />);

    expect(screen.getByText(LOAD_FAILED)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onRetry once when Retry is clicked', async () => {
    const onRetry = vi.fn();
    render(
      <EventDayWarning selectedDate="2026-11-10" failed onRetry={onRetry} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while the events are loading: not known, not failed', () => {
    const { container } = render(
      <EventDayWarning
        selectedDate="2026-11-10"
        failed={false}
        onRetry={() => undefined}
      />,
    );

    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing for an empty date, even when failed', () => {
    const { container } = render(
      <EventDayWarning selectedDate="" failed onRetry={() => undefined} />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('shows the line when the events held are for other dates', () => {
    render(
      <EventDayWarning
        selectedDate="2026-11-10"
        liveEvents={[evt({ date: '2026-11-12', event: 'CPI' })]}
        failed
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText(LOAD_FAILED)).toBeInTheDocument();
  });

  it('shows the events, and no failure line, when the date has events', () => {
    render(
      <EventDayWarning
        selectedDate="2026-11-10"
        liveEvents={[evt({ date: '2026-11-10', event: 'CPI' })]}
        failed
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText(/high-impact event day/i)).toBeInTheDocument();
    expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('still renders nothing for a known empty list that did not fail', () => {
    const { container } = render(
      <EventDayWarning
        selectedDate="2026-11-10"
        liveEvents={[]}
        failed={false}
      />,
    );

    expect(container.innerHTML).toBe('');
  });
});
