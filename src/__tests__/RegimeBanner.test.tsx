import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RegimeBanner } from '../components/InstitutionalProgram/RegimeBanner';
import type { DailyProgramSummary } from '../hooks/useInstitutionalProgram';

// ============================================================
// FACTORIES
// ============================================================

function makeDay(
  overrides: Partial<DailyProgramSummary> = {},
): DailyProgramSummary {
  return {
    date: '2026-04-20',
    dominant_pair: null,
    avg_spot: 5800,
    ceiling_pct_above_spot: 0.012,
    n_blocks: 5,
    n_call_blocks: 3,
    n_put_blocks: 2,
    ...overrides,
  };
}

function days(
  count: number,
  build: (i: number) => Partial<DailyProgramSummary>,
): DailyProgramSummary[] {
  return Array.from({ length: count }, (_, i) => makeDay(build(i)));
}

// ============================================================
// RegimeBanner
// ============================================================

describe('RegimeBanner', () => {
  it('returns null when fewer than 10 days are provided', () => {
    const { container } = render(<RegimeBanner days={days(9, () => ({}))} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when all ceiling values in either window are missing', () => {
    const data = days(10, (i) => ({
      ceiling_pct_above_spot: i < 5 ? null : 0.012,
    }));
    const { container } = render(<RegimeBanner days={data} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when delta is below 0.005 and there is no direction flip', () => {
    const data = days(10, () => ({ ceiling_pct_above_spot: 0.012 }));
    const { container } = render(<RegimeBanner days={data} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows green tone when ceiling is rising', () => {
    // Prior 5 avg = 0.010, recent 5 avg = 0.020 → delta +0.010 (>0.005)
    const data = [
      ...days(5, () => ({ ceiling_pct_above_spot: 0.01 })),
      ...days(5, () => ({ ceiling_pct_above_spot: 0.02 })),
    ];
    render(<RegimeBanner days={data} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveClass('bg-green-950/30');
    expect(banner).toHaveTextContent(/Ceiling rising/);
    // 0.010 → 1.00 pp rendered as "+1.00 pp"
    expect(banner).toHaveTextContent(/\+1\.00 pp/);
  });

  it('shows amber tone when ceiling is pulling in', () => {
    const data = [
      ...days(5, () => ({ ceiling_pct_above_spot: 0.02 })),
      ...days(5, () => ({ ceiling_pct_above_spot: 0.01 })),
    ];
    render(<RegimeBanner days={data} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveClass('bg-amber-950/30');
    expect(banner).toHaveTextContent(/Ceiling pulling in/);
    expect(banner).toHaveTextContent(/-1\.00 pp/);
  });

  it('shows red tone with direction-flip message when majority flips', () => {
    // Both windows have stable ceiling so only the direction triggers.
    const sellPair = {
      low_strike: 5790,
      high_strike: 5810,
      spread_width: 20,
      total_size: 100,
      total_premium: 50000,
      direction: 'sell' as const,
    };
    const buyPair = { ...sellPair, direction: 'buy' as const };
    const data = [
      ...days(5, () => ({
        ceiling_pct_above_spot: 0.012,
        dominant_pair: sellPair,
      })),
      ...days(5, () => ({
        ceiling_pct_above_spot: 0.012,
        dominant_pair: buyPair,
      })),
    ];
    render(<RegimeBanner days={data} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveClass('bg-red-950/30');
    expect(banner).toHaveTextContent(/Direction flip/);
    expect(banner).toHaveTextContent(/from/);
    // The <code> tags carry the prior and recent majority labels.
    const codes = banner.querySelectorAll('code');
    expect(codes[0]?.textContent).toBe('sell');
    expect(codes[1]?.textContent).toBe('buy');
  });

  it('prioritizes direction-flip tone (red) over ceiling-rising tone (green)', () => {
    const sellPair = {
      low_strike: 5790,
      high_strike: 5810,
      spread_width: 20,
      total_size: 100,
      total_premium: 50000,
      direction: 'sell' as const,
    };
    const buyPair = { ...sellPair, direction: 'buy' as const };
    const data = [
      ...days(5, () => ({
        ceiling_pct_above_spot: 0.01,
        dominant_pair: sellPair,
      })),
      ...days(5, () => ({
        ceiling_pct_above_spot: 0.02,
        dominant_pair: buyPair,
      })),
    ];
    render(<RegimeBanner days={data} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveClass('bg-red-950/30');
    expect(banner).toHaveTextContent(/Direction flip/);
  });

  it('ignores days with null dominant_pair when computing majority', () => {
    // Recent has 4 buys and 1 null (majority buy); prior has all sells.
    const sellPair = {
      low_strike: 5790,
      high_strike: 5810,
      spread_width: 20,
      total_size: 100,
      total_premium: 50000,
      direction: 'sell' as const,
    };
    const buyPair = { ...sellPair, direction: 'buy' as const };
    const data = [
      ...days(5, () => ({
        ceiling_pct_above_spot: 0.012,
        dominant_pair: sellPair,
      })),
      ...days(4, () => ({
        ceiling_pct_above_spot: 0.012,
        dominant_pair: buyPair,
      })),
      makeDay({ ceiling_pct_above_spot: 0.012, dominant_pair: null }),
    ];
    render(<RegimeBanner days={data} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Direction flip/);
  });
});
