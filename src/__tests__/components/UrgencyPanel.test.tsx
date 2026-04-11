import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UrgencyPanel } from '../../components/GexTarget/UrgencyPanel';
import type { StrikeScore, MagnetFeatures } from '../../utils/gex-target';

// ── Fixture helpers ───────────────────────────────────────────────────

function makeFeatures(overrides: Partial<MagnetFeatures> = {}): MagnetFeatures {
  return {
    strike: 5800,
    spot: 5795,
    distFromSpot: 5,
    gexDollars: 1_000_000_000,
    callGexDollars: 600_000_000,
    putGexDollars: 400_000_000,
    callDelta: null,
    putDelta: null,
    deltaGex_1m: null,
    deltaGex_5m: null,
    deltaGex_20m: null,
    deltaGex_60m: null,
    prevGexDollars_1m: null,
    prevGexDollars_5m: null,
    prevGexDollars_20m: null,
    prevGexDollars_60m: null,
    deltaPct_1m: 0.01,
    deltaPct_5m: 0.053,
    deltaPct_20m: 0.18,
    deltaPct_60m: 0.43,
    callRatio: 0.2,
    charmNet: 1e7,
    deltaNet: 5e8,
    vannaNet: 1e7,
    minutesAfterNoonCT: 60,
    ...overrides,
  };
}

function makeStrike(
  strike: number,
  overrides: Partial<StrikeScore> = {},
): StrikeScore {
  return {
    strike,
    features: makeFeatures({ strike }),
    components: {
      flowConfluence: 0.6,
      priceConfirm: 0.4,
      charmScore: 0.3,
      dominance: 0.7,
      clarity: 0.8,
      proximity: 0.9,
    },
    finalScore: 0.55,
    tier: 'HIGH',
    wallSide: 'CALL',
    rankByScore: 1,
    rankBySize: 1,
    isTarget: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('UrgencyPanel: empty state', () => {
  it('shows No data when leaderboard is empty', () => {
    render(<UrgencyPanel leaderboard={[]} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });
});

describe('UrgencyPanel: strike rendering', () => {
  it('renders strike prices from the leaderboard', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({ strike: 5800, deltaPct_5m: 0.01 }),
      }),
      makeStrike(5750, {
        features: makeFeatures({ strike: 5750, deltaPct_5m: -0.02 }),
      }),
    ];
    render(<UrgencyPanel leaderboard={leaderboard} />);
    expect(screen.getByText('5800')).toBeInTheDocument();
    expect(screen.getByText('5750')).toBeInTheDocument();
  });

  it('limits output to top 5 strikes', () => {
    const strikes = [5800, 5750, 5700, 5650, 5600, 5550, 5500].map((s) =>
      makeStrike(s, {
        features: makeFeatures({ strike: s, deltaPct_5m: 0.01 }),
      }),
    );
    render(<UrgencyPanel leaderboard={strikes} />);
    expect(screen.getByText('5800')).toBeInTheDocument();
    expect(screen.getByText('5600')).toBeInTheDocument();
    expect(screen.queryByText('5550')).not.toBeInTheDocument();
    expect(screen.queryByText('5500')).not.toBeInTheDocument();
  });
});

describe('UrgencyPanel: delta formatting', () => {
  it('shows formatted positive deltaPct_5m', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({ strike: 5800, deltaPct_5m: 0.053 }),
      }),
    ];
    render(<UrgencyPanel leaderboard={leaderboard} />);
    expect(screen.getByText('+5.3%')).toBeInTheDocument();
  });

  it('shows formatted negative deltaPct_5m', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({ strike: 5800, deltaPct_5m: -0.12 }),
      }),
    ];
    render(<UrgencyPanel leaderboard={leaderboard} />);
    expect(screen.getByText('-12.0%')).toBeInTheDocument();
  });

  it('shows — when deltaPct_5m is null', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({ strike: 5800, deltaPct_5m: null }),
      }),
    ];
    render(<UrgencyPanel leaderboard={leaderboard} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows zero-valued delta as +0.0%', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({ strike: 5800, deltaPct_5m: 0 }),
      }),
    ];
    render(<UrgencyPanel leaderboard={leaderboard} />);
    expect(screen.getByText('+0.0%')).toBeInTheDocument();
  });
});

describe('UrgencyPanel: bar rendering', () => {
  it('renders progress bars for each strike', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({ strike: 5800, deltaPct_5m: 0.05 }),
      }),
      makeStrike(5750, {
        features: makeFeatures({ strike: 5750, deltaPct_5m: -0.03 }),
      }),
    ];
    const { container } = render(<UrgencyPanel leaderboard={leaderboard} />);
    // Each row has a background track div + fill bar div with rounded-full
    const bars = container.querySelectorAll('.rounded-full');
    expect(bars.length).toBeGreaterThanOrEqual(2);
  });

  it('renders bars with zero width when all deltas are zero', () => {
    // maxAbs is 0 → clamped to 1. All bars get pct=0 → width=0%
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({ strike: 5800, deltaPct_5m: 0 }),
      }),
    ];
    const { container } = render(<UrgencyPanel leaderboard={leaderboard} />);
    const fillBars = container.querySelectorAll<HTMLElement>(
      '.rounded-full .absolute',
    );
    for (const bar of fillBars) {
      expect(bar.style.width).toBe('0%');
    }
  });
});
