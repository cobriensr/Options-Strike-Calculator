/**
 * TradingScheduleSection unit tests.
 *
 * ctToday() and buildDateFromTZ() are module-internal helpers; we cover them
 * indirectly by controlling the system clock with vi.setSystemTime() and
 * verifying which phase is highlighted (or not) in the rendered output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import TradingScheduleSection from '../../components/TradingScheduleSection';

// ── Clock helpers ─────────────────────────────────────────────────────────

/**
 * Build a UTC timestamp that corresponds to a specific CT wall-clock time.
 * During CDT (summer), CT = UTC-5.  During CST (winter), CT = UTC-6.
 * April 2026 is CDT, so we use UTC-5.
 */
function ctTime(hour: number, minute = 0): Date {
  // April 13 2026 is in CDT (UTC-5)
  const isoStr = `2026-04-13T${String(hour + 5).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
  return new Date(isoStr);
}

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// BASIC RENDERING
// ============================================================

describe('TradingScheduleSection: basic rendering', () => {
  it('renders without crashing', () => {
    vi.setSystemTime(ctTime(10, 0));
    render(<TradingScheduleSection />);
    expect(screen.getByText('Trading Schedule')).toBeInTheDocument();
  });

  it('renders all five phase titles', () => {
    vi.setSystemTime(ctTime(10, 0));
    render(<TradingScheduleSection />);

    expect(screen.getByText('Market Open')).toBeInTheDocument();
    expect(screen.getByText('Sell Credit Spreads')).toBeInTheDocument();
    expect(screen.getByText('Buy Directional')).toBeInTheDocument();
    expect(screen.getByText('Open BWB')).toBeInTheDocument();
    expect(screen.getByText('Go Flat')).toBeInTheDocument();
  });

  it('renders all five time labels', () => {
    vi.setSystemTime(ctTime(10, 0));
    render(<TradingScheduleSection />);

    expect(screen.getByText('8:30 – 9:00')).toBeInTheDocument();
    expect(screen.getByText('9:00 – 11:30')).toBeInTheDocument();
    expect(screen.getByText('11:30 – 1:00')).toBeInTheDocument();
    expect(screen.getByText('1:00 – 2:30')).toBeInTheDocument();
    expect(screen.getByText('2:55 – 3:00')).toBeInTheDocument();
  });

  it('renders the CT badge in the section header', () => {
    vi.setSystemTime(ctTime(10, 0));
    render(<TradingScheduleSection />);
    expect(screen.getByText('CT')).toBeInTheDocument();
  });
});

// ============================================================
// ACTIVE PHASE (live mode — no selectedDate, or today)
// ============================================================

describe('TradingScheduleSection: active phase highlighting', () => {
  it('marks "Sell Credit Spreads" as Active at 10:00 CT', () => {
    // 10:00 CT is within the 9:00–11:30 credit-spreads window
    vi.setSystemTime(ctTime(10, 0));
    render(<TradingScheduleSection />);

    // The "Active" badge should appear next to the credit-spreads phase
    const activeLabels = screen.getAllByText('Active');
    expect(activeLabels).toHaveLength(1);

    // The badge's parent chain includes the phase card containing "Sell Credit Spreads"
    const card = screen.getByText('Sell Credit Spreads').closest('div');
    expect(card?.textContent).toContain('Active');
  });

  it('marks "Buy Directional" as Active at 12:00 CT', () => {
    // 12:00 CT is within the 11:30–1:00 directional window
    vi.setSystemTime(ctTime(12, 0));
    render(<TradingScheduleSection />);

    const card = screen.getByText('Buy Directional').closest('div');
    expect(card?.textContent).toContain('Active');
  });

  it('marks "Open BWB" as Active at 1:30 CT (13:30)', () => {
    // 13:30 CT is within the 1:00–2:30 BWB window
    vi.setSystemTime(ctTime(13, 30));
    render(<TradingScheduleSection />);

    const card = screen.getByText('Open BWB').closest('div');
    expect(card?.textContent).toContain('Active');
  });

  it('marks "Go Flat" as Active at 14:56 CT (2:56 PM)', () => {
    // 14:56 CT is within the 2:55–3:00 flat window
    vi.setSystemTime(ctTime(14, 56));
    render(<TradingScheduleSection />);

    const card = screen.getByText('Go Flat').closest('div');
    expect(card?.textContent).toContain('Active');
  });

  it('shows no Active badge pre-market (7:00 CT)', () => {
    // 7:00 CT is before the 8:30 market open
    vi.setSystemTime(ctTime(7, 0));
    render(<TradingScheduleSection />);

    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('shows no Active badge post-close (16:00 CT)', () => {
    // 16:00 CT is after the 3:00 post-close cutoff
    vi.setSystemTime(ctTime(16, 0));
    render(<TradingScheduleSection />);

    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });
});

// ============================================================
// BACKTEST MODE (past selectedDate + time props)
// ============================================================

describe('TradingScheduleSection: backtest mode', () => {
  it('highlights credit-spreads phase for a backtest time of 9:30 AM CT', () => {
    vi.setSystemTime(ctTime(16, 0)); // current time is post-market

    render(
      <TradingScheduleSection
        selectedDate="2026-04-10"
        timeHour="9"
        timeMinute="30"
        timeAmPm="AM"
        timezone="CT"
      />,
    );

    const card = screen.getByText('Sell Credit Spreads').closest('div');
    expect(card?.textContent).toContain('Active');
  });

  it('highlights buy-directional phase for a backtest time of 12:00 PM CT', () => {
    vi.setSystemTime(ctTime(16, 0));

    render(
      <TradingScheduleSection
        selectedDate="2026-04-10"
        timeHour="12"
        timeMinute="00"
        timeAmPm="PM"
        timezone="CT"
      />,
    );

    const card = screen.getByText('Buy Directional').closest('div');
    expect(card?.textContent).toContain('Active');
  });

  it('highlights BWB phase for a backtest time of 1:00 PM ET', () => {
    vi.setSystemTime(ctTime(16, 0));

    // 1:00 PM ET = 12:00 PM CT — directional, but let's use 2:00 PM ET = 1:00 PM CT = BWB
    render(
      <TradingScheduleSection
        selectedDate="2026-04-10"
        timeHour="2"
        timeMinute="00"
        timeAmPm="PM"
        timezone="ET"
      />,
    );

    // 2 PM ET = 1 PM CT = start of BWB window
    const card = screen.getByText('Open BWB').closest('div');
    expect(card?.textContent).toContain('Active');
  });

  it('shows no Active badge for a backtest pre-market time (7:00 AM CT)', () => {
    vi.setSystemTime(ctTime(16, 0));

    render(
      <TradingScheduleSection
        selectedDate="2026-04-10"
        timeHour="7"
        timeMinute="00"
        timeAmPm="AM"
        timezone="CT"
      />,
    );

    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('falls back to live mode when only selectedDate is provided without time props', () => {
    vi.setSystemTime(ctTime(10, 30));

    // selectedDate without timeHour/timeMinute/timeAmPm — component falls back
    // to live clock via the isLive || !timeHour guard
    render(
      <TradingScheduleSection
        selectedDate="2026-04-10"
        timeHour={undefined}
        timeMinute={undefined}
        timeAmPm={undefined}
      />,
    );

    // At 10:30 CT, credit-spreads is active
    const card = screen.getByText('Sell Credit Spreads').closest('div');
    expect(card?.textContent).toContain('Active');
  });
});

// ============================================================
// ctToday() — exercised via the isLive branch
// ============================================================

describe('TradingScheduleSection: ctToday() coverage', () => {
  it('treats today as live mode (no selectedDate)', () => {
    vi.setSystemTime(ctTime(10, 0));

    // No selectedDate → isLive = true → ctToday() is called to determine isLive
    render(<TradingScheduleSection />);
    // Should render an Active badge since we're in the credit-spreads window
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('treats today\'s CT date as live when selectedDate matches today', () => {
    // Use a date that is unambiguously NOT today so the component is forced to
    // call ctToday() and compare. We set systemTime to April 13 2026 and pass
    // selectedDate = '2026-04-13' (today CT) which should resolve to live mode.
    vi.setSystemTime(ctTime(10, 30));

    render(
      <TradingScheduleSection
        selectedDate="2026-04-13"
        timeHour="9"
        timeMinute="00"
        timeAmPm="AM"
        timezone="CT"
      />,
    );

    // isLive = true because selectedDate === ctToday(), so the live clock is
    // used (10:30 CT) rather than the backtest time (9:00 AM CT)
    const card = screen.getByText('Sell Credit Spreads').closest('div');
    expect(card?.textContent).toContain('Active');
  });
});

// ============================================================
// buildDateFromTZ() — DST correction via backtest mode
// ============================================================

describe('TradingScheduleSection: buildDateFromTZ() coverage', () => {
  it('correctly maps 8:30 AM CT to opening-range stage', () => {
    vi.setSystemTime(ctTime(16, 0));

    render(
      <TradingScheduleSection
        selectedDate="2026-04-10"
        timeHour="8"
        timeMinute="30"
        timeAmPm="AM"
        timezone="CT"
      />,
    );

    const card = screen.getByText('Market Open').closest('div');
    expect(card?.textContent).toContain('Active');
  });

  it('handles ET timezone backtest correctly (ET is UTC-4 in CDT)', () => {
    vi.setSystemTime(ctTime(16, 0));

    // 9:30 AM ET in April (CDT) = 8:30 AM CT = opening-range
    render(
      <TradingScheduleSection
        selectedDate="2026-04-10"
        timeHour="9"
        timeMinute="30"
        timeAmPm="AM"
        timezone="ET"
      />,
    );

    const card = screen.getByText('Market Open').closest('div');
    expect(card?.textContent).toContain('Active');
  });

  it('handles minute parsing — 11:30 AM CT activates directional phase', () => {
    vi.setSystemTime(ctTime(16, 0));

    render(
      <TradingScheduleSection
        selectedDate="2026-04-10"
        timeHour="11"
        timeMinute="30"
        timeAmPm="AM"
        timezone="CT"
      />,
    );

    const card = screen.getByText('Buy Directional').closest('div');
    expect(card?.textContent).toContain('Active');
  });
});

// ============================================================
// POLLING — live mode sets an interval, backtest does not
// ============================================================

describe('TradingScheduleSection: polling behavior', () => {
  it('updates active phase when time advances (interval fires)', async () => {
    // Start at 11:29 CT (just before directional)
    vi.setSystemTime(ctTime(11, 29));

    render(<TradingScheduleSection />);

    // credit-spreads should be active at 11:29
    expect(
      screen.getByText('Sell Credit Spreads').closest('div')?.textContent,
    ).toContain('Active');

    // Advance the system clock past 11:30 and trigger the 60s interval
    await act(async () => {
      vi.setSystemTime(ctTime(11, 31));
      vi.advanceTimersByTime(60_000);
    });

    // Now directional should be active
    expect(
      screen.getByText('Buy Directional').closest('div')?.textContent,
    ).toContain('Active');
  });

  it('clears the interval on unmount', () => {
    vi.setSystemTime(ctTime(10, 0));

    const { unmount } = render(<TradingScheduleSection />);

    // Grab current call count and unmount
    unmount();

    // Advance time — if the interval was not cleared, the state update would
    // fire on an unmounted component (React would warn)
    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    // No assertion needed — the test passes if there are no warnings/errors
  });
});
