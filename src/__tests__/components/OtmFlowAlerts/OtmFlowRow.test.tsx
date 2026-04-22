import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OtmFlowRow } from '../../../components/OtmFlowAlerts/OtmFlowRow';
import type { OtmFlowAlert } from '../../../types/otm-flow';

// ── Fixture ───────────────────────────────────────────────

function makeAlert(overrides: Partial<OtmFlowAlert> = {}): OtmFlowAlert {
  return {
    id: 1,
    option_chain: 'SPXW260422C07100000',
    strike: 7100,
    type: 'call',
    created_at: '2026-04-22T15:00:00.000Z',
    price: 2.5,
    underlying_price: 7000,
    total_premium: 125_000,
    total_size: 500,
    volume: 5000,
    open_interest: 1200,
    volume_oi_ratio: 4.17,
    ask_side_ratio: 0.82,
    bid_side_ratio: 0.1,
    distance_from_spot: 100,
    distance_pct: 0.01429,
    moneyness: 0.9859,
    dte_at_alert: 0,
    has_sweep: true,
    has_multileg: false,
    alert_rule: 'RepeatedHits',
    dominant_side: 'ask',
    ...overrides,
  };
}

const FIXED_NOW = new Date('2026-04-22T15:30:00.000Z').getTime();

// ══════════════════════════════════════════════════════════
// COLOR PALETTE (4 quadrants)
// ══════════════════════════════════════════════════════════

describe('OtmFlowRow — palette', () => {
  it('renders "Bullish load" for call + ask-heavy', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ type: 'call', dominant_side: 'ask' })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText(/Bullish load/i)).toBeInTheDocument();
  });

  it('renders "Bearish hedge" for put + ask-heavy', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ type: 'put', dominant_side: 'ask' })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText(/Bearish hedge/i)).toBeInTheDocument();
  });

  it('renders "Call unwind" for call + bid-heavy', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({
          type: 'call',
          dominant_side: 'bid',
          ask_side_ratio: 0.1,
          bid_side_ratio: 0.85,
        })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText(/Call unwind/i)).toBeInTheDocument();
  });

  it('renders "Put unwind" for put + bid-heavy', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({
          type: 'put',
          dominant_side: 'bid',
          ask_side_ratio: 0.1,
          bid_side_ratio: 0.85,
        })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText(/Put unwind/i)).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════
// FORMATTERS — premium, distance, age
// ══════════════════════════════════════════════════════════

describe('OtmFlowRow — formatters', () => {
  it('formats a sub-$1K premium as "$" + rounded integer', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ total_premium: 450 })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('$450')).toBeInTheDocument();
  });

  it('formats a $0 or non-finite premium as "$0"', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ total_premium: Number.NaN })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('$0')).toBeInTheDocument();
  });

  it('formats a >=$1K premium as "Nk"', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ total_premium: 45_000 })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('$45K')).toBeInTheDocument();
  });

  it('formats a >=$1M premium as "N.NM"', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ total_premium: 2_400_000 })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('$2.4M')).toBeInTheDocument();
  });

  it('formats distance_pct with a leading + sign for positive values', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ distance_pct: 0.0143 })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('+1.43%')).toBeInTheDocument();
  });

  it('formats distance_pct without a sign prefix for negative values', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ distance_pct: -0.0143 })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('-1.43%')).toBeInTheDocument();
  });

  it('shows "now" for sub-minute age', () => {
    const created = new Date(FIXED_NOW - 20_000).toISOString(); // 20s ago
    render(
      <OtmFlowRow
        alert={makeAlert({ created_at: created })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('now')).toBeInTheDocument();
  });

  it('shows minutes for <60m age', () => {
    const created = new Date(FIXED_NOW - 12 * 60_000).toISOString(); // 12m ago
    render(
      <OtmFlowRow
        alert={makeAlert({ created_at: created })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('12m')).toBeInTheDocument();
  });

  it('shows hours + minutes for >60m age', () => {
    const created = new Date(FIXED_NOW - (2 * 60 + 15) * 60_000).toISOString(); // 2h 15m ago
    render(
      <OtmFlowRow
        alert={makeAlert({ created_at: created })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('2h 15m')).toBeInTheDocument();
  });

  it('shows bare hours when minutes remainder is zero', () => {
    const created = new Date(FIXED_NOW - 3 * 60 * 60_000).toISOString(); // 3h 0m ago
    render(
      <OtmFlowRow
        alert={makeAlert({ created_at: created })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('3h')).toBeInTheDocument();
  });

  it('shows "—" for malformed created_at', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ created_at: 'not-a-date' })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════
// BADGES
// ══════════════════════════════════════════════════════════

describe('OtmFlowRow — badges', () => {
  it('shows the alert_rule label with "RepeatedHits" shortened to "RH"', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ alert_rule: 'RepeatedHits' })}
        nowMs={FIXED_NOW}
      />,
    );
    // The rule pill text also includes ' · sweep' in the default fixture.
    expect(screen.getByText(/RH.*sweep/)).toBeInTheDocument();
  });

  it('appends " · multi" when has_multileg is true', () => {
    render(
      <OtmFlowRow
        alert={makeAlert({ has_sweep: false, has_multileg: true })}
        nowMs={FIXED_NOW}
      />,
    );
    expect(screen.getByText(/multi/)).toBeInTheDocument();
  });

  it('applies the "new" highlight class when isNew=true', () => {
    const { container } = render(
      <OtmFlowRow alert={makeAlert()} nowMs={FIXED_NOW} isNew />,
    );
    // The outer row div has a bg class tacked on when isNew.
    expect(container.firstChild).toHaveClass('bg-surface-alt/60');
  });
});
