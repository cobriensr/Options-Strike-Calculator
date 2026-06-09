import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionQualityBanner } from '../components/LotteryFinder/SessionQualityBanner';

// ── Helpers ──────────────────────────────────────────────────
//
// Build a UTC instant that maps to a known CT wall-clock time on a
// trading day. 2026-06-08 is a Monday in CDT (UTC-5), so 08:30 CT = 13:30Z.

/** A summer trading-day instant (CDT, UTC-5) at a given CT wall-clock. */
function cdtInstant(ctHour: number, ctMinute: number, ctSecond = 0): Date {
  return new Date(Date.UTC(2026, 5, 8, ctHour + 5, ctMinute, ctSecond));
}

// ============================================================
// PER-BUCKET RENDERING
// ============================================================

describe('SessionQualityBanner: per-bucket content', () => {
  it('AM_open (09:00 CT) → strong / emerald, label + stats', () => {
    const { container } = render(
      <SessionQualityBanner now={cdtInstant(9, 0)} />,
    );
    const banner = screen.getByTestId('lottery-session-quality');
    expect(banner).toHaveAttribute('data-quality', 'strong');
    expect(banner.className).toContain('emerald');
    expect(banner).toHaveTextContent('AM session');
    expect(banner).toHaveTextContent('40.18%');
    expect(banner).toHaveTextContent('62.1%');
    expect(banner).toHaveTextContent('🟢');
    expect(container).not.toBeEmptyDOMElement();
  });

  it('MID (10:00 CT) → moderate / amber, label + stats', () => {
    render(<SessionQualityBanner now={cdtInstant(10, 0)} />);
    const banner = screen.getByTestId('lottery-session-quality');
    expect(banner).toHaveAttribute('data-quality', 'moderate');
    expect(banner.className).toContain('amber');
    expect(banner).toHaveTextContent('Midday');
    expect(banner).toHaveTextContent('32.65%');
    expect(banner).toHaveTextContent('59.2%');
    expect(banner).toHaveTextContent('🟡');
  });

  it('LUNCH (11:45 CT) → moderate / amber, label + stats', () => {
    render(<SessionQualityBanner now={cdtInstant(11, 45)} />);
    const banner = screen.getByTestId('lottery-session-quality');
    expect(banner).toHaveAttribute('data-quality', 'moderate');
    expect(banner.className).toContain('amber');
    expect(banner).toHaveTextContent('Lunch');
    expect(banner).toHaveTextContent('29.1%');
    expect(banner).toHaveTextContent('58.2%');
    expect(banner).toHaveTextContent('🟡');
  });

  it('PM (13:30 CT) → weak / rose, label + stats', () => {
    render(<SessionQualityBanner now={cdtInstant(13, 30)} />);
    const banner = screen.getByTestId('lottery-session-quality');
    expect(banner).toHaveAttribute('data-quality', 'weak');
    expect(banner.className).toContain('rose');
    expect(banner).toHaveTextContent('PM session');
    expect(banner).toHaveTextContent('16.27%');
    expect(banner).toHaveTextContent('52.2%');
    expect(banner).toHaveTextContent('🔴');
  });
});

// ============================================================
// BOUNDARY
// ============================================================

describe('SessionQualityBanner: bucket boundary', () => {
  it('renders PM (not LUNCH) exactly at 12:30:00 CT', () => {
    render(<SessionQualityBanner now={cdtInstant(12, 30, 0)} />);
    const banner = screen.getByTestId('lottery-session-quality');
    expect(banner).toHaveAttribute('data-quality', 'weak');
    expect(banner).toHaveTextContent('PM session');
  });
});

// ============================================================
// OUT-OF-HOURS → EMPTY RENDER
// ============================================================

describe('SessionQualityBanner: out-of-hours', () => {
  it('renders nothing on a Saturday', () => {
    // 2026-06-13 is a Saturday. 10:00 CT = 15:00Z (CDT).
    const sat = new Date(Date.UTC(2026, 5, 13, 15, 0, 0));
    const { container } = render(<SessionQualityBanner now={sat} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing at 16:00 CT (post-close) on a weekday', () => {
    const { container } = render(
      <SessionQualityBanner now={cdtInstant(16, 0)} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
