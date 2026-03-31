import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import TradingScheduleSection from '../components/TradingScheduleSection';

// ============================================================
// HELPERS
// ============================================================

/** Set system clock to a specific CT time on a weekday (Mon = 1) */
function mockCT(hour: number, minute: number, weekday = 1) {
  // CT = UTC-6 (standard) or UTC-5 (DST). Build a UTC date that
  // toLocaleString('en-US', { timeZone: 'America/Chicago' }) resolves
  // to the desired hour/minute. Using a fixed date in CDT (UTC-5).
  // 2026-03-31 is a Tuesday in CDT.
  const dayOffset = weekday - 2; // Tue = 2, so offset adjusts
  const utc = new Date(
    Date.UTC(2026, 2, 31 + dayOffset, hour + 5, minute, 0),
  );
  vi.setSystemTime(utc);
}

function mockWeekend() {
  // Saturday 2026-03-28, 10:00 CT (CDT = UTC-5)
  vi.setSystemTime(new Date(Date.UTC(2026, 2, 28, 15, 0, 0)));
}

// ============================================================
// TESTS
// ============================================================

describe('TradingScheduleSection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Rendering ──────────────────────────────────────────

  it('renders the section with all 5 phase titles', () => {
    mockCT(7, 0); // pre-market, no phase active
    render(<TradingScheduleSection />);

    expect(
      screen.getByRole('region', { name: 'Trading Schedule' }),
    ).toBeInTheDocument();

    expect(screen.getByText('Market Open')).toBeInTheDocument();
    expect(screen.getByText('Sell Credit Spreads')).toBeInTheDocument();
    expect(screen.getByText('Buy Directional')).toBeInTheDocument();
    expect(screen.getByText('Open BWB')).toBeInTheDocument();
    expect(screen.getByText('Go Flat')).toBeInTheDocument();
  });

  it('renders all time labels', () => {
    mockCT(7, 0);
    render(<TradingScheduleSection />);

    expect(screen.getByText('8:30 – 9:00')).toBeInTheDocument();
    expect(screen.getByText('9:00 – 11:30')).toBeInTheDocument();
    expect(screen.getByText('11:30 – 1:00')).toBeInTheDocument();
    expect(screen.getByText('1:00 – 2:30')).toBeInTheDocument();
    expect(screen.getByText('2:55 – 3:00')).toBeInTheDocument();
  });

  it('renders subtitles with strategy details', () => {
    mockCT(7, 0);
    render(<TradingScheduleSection />);

    expect(
      screen.getByText('Establishing opening range — do not trade'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/collect premium, let theta decay/),
    ).toBeInTheDocument();
    expect(screen.getByText(/7 DTE ~50Δ ATM/)).toBeInTheDocument();
    expect(screen.getByText(/broken wing butterfly/)).toBeInTheDocument();
    expect(screen.getByText(/no overnight risk/)).toBeInTheDocument();
  });

  it('shows CT badge', () => {
    mockCT(7, 0);
    render(<TradingScheduleSection />);
    expect(screen.getByText('CT')).toBeInTheDocument();
  });

  // ── Active phase detection ─────────────────────────────

  it('shows Active badge during Market Open (8:30–9:00)', () => {
    mockCT(8, 45);
    render(<TradingScheduleSection />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows Active badge during credit spread window (9:00–11:30)', () => {
    mockCT(10, 0);
    render(<TradingScheduleSection />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows Active badge during directional window (11:30–1:00)', () => {
    mockCT(12, 0);
    render(<TradingScheduleSection />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows Active badge during BWB window (1:00–2:30)', () => {
    mockCT(13, 30);
    render(<TradingScheduleSection />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows Active badge during Go Flat window (2:55–3:00)', () => {
    mockCT(14, 57);
    render(<TradingScheduleSection />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows no Active badge before market open', () => {
    mockCT(7, 0);
    render(<TradingScheduleSection />);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('shows no Active badge in the gap between BWB and Go Flat', () => {
    mockCT(14, 40); // 2:40 CT — between 2:30 and 2:55
    render(<TradingScheduleSection />);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('shows no Active badge after market close', () => {
    mockCT(15, 30);
    render(<TradingScheduleSection />);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  // ── Weekend ────────────────────────────────────────────

  it('shows no Active badge on weekends', () => {
    mockWeekend();
    render(<TradingScheduleSection />);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  // ── Timer updates ──────────────────────────────────────

  it('updates active phase when the interval fires', () => {
    mockCT(8, 59); // last minute of Market Open
    render(<TradingScheduleSection />);
    expect(screen.getByText('Active')).toBeInTheDocument();

    // Advance clock into credit spread window
    mockCT(9, 1);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    // Active badge should still exist (now on credit spreads)
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('cleans up interval on unmount', () => {
    mockCT(10, 0);
    const { unmount } = render(<TradingScheduleSection />);

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
