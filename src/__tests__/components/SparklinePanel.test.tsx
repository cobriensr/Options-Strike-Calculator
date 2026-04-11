import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SparklinePanel } from '../../components/GexTarget/SparklinePanel';
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
    prevGexDollars_1m: 990_000_000,
    prevGexDollars_5m: 950_000_000,
    prevGexDollars_10m: 930_000_000,
    prevGexDollars_15m: 900_000_000,
    prevGexDollars_20m: 850_000_000,
    prevGexDollars_60m: 700_000_000,
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

describe('SparklinePanel: empty state', () => {
  it('shows No data when leaderboard is empty', () => {
    render(<SparklinePanel leaderboard={[]} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });
});

describe('SparklinePanel: strike rows', () => {
  it('renders an accessible row for each strike', () => {
    const leaderboard = [makeStrike(5800), makeStrike(5750)];
    render(<SparklinePanel leaderboard={leaderboard} />);
    expect(screen.getByLabelText('Strike 5800')).toBeInTheDocument();
    expect(screen.getByLabelText('Strike 5750')).toBeInTheDocument();
  });

  it('renders all strikes passed in (parent pre-slices to top 5)', () => {
    // SparklinePanel no longer slices — the parent (GexTarget/index.tsx)
    // pre-computes top5ByGex before passing the leaderboard down.
    const strikes = [5800, 5750, 5700, 5650, 5600].map((s) => makeStrike(s));
    render(<SparklinePanel leaderboard={strikes} />);
    expect(screen.getByLabelText('Strike 5800')).toBeInTheDocument();
    expect(screen.getByLabelText('Strike 5600')).toBeInTheDocument();
  });

  it('shows the strike number as a text label', () => {
    render(<SparklinePanel leaderboard={[makeStrike(5925)]} />);
    expect(screen.getByText('5925')).toBeInTheDocument();
  });
});

describe('SparklinePanel: 20m delta percentage', () => {
  it('shows formatted positive deltaPct_20m', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({ deltaPct_20m: 0.18, strike: 5800 }),
      }),
    ];
    render(<SparklinePanel leaderboard={leaderboard} />);
    expect(screen.getByText('+18.0%')).toBeInTheDocument();
  });

  it('shows formatted negative deltaPct_20m', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({ deltaPct_20m: -0.05, strike: 5800 }),
      }),
    ];
    render(<SparklinePanel leaderboard={leaderboard} />);
    expect(screen.getByText('-5.0%')).toBeInTheDocument();
  });

  it('shows — when deltaPct_20m is null', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({ deltaPct_20m: null, strike: 5800 }),
      }),
    ];
    render(<SparklinePanel leaderboard={leaderboard} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('SparklinePanel: SVG sparklines', () => {
  it('renders an SVG per strike row', () => {
    const leaderboard = [makeStrike(5800), makeStrike(5750)];
    const { container } = render(<SparklinePanel leaderboard={leaderboard} />);
    const svgs = container.querySelectorAll('svg[aria-hidden="true"]');
    expect(svgs.length).toBe(2);
  });

  it('renders a polyline when GEX history data is available', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({
          gexDollars: 1_000_000_000,
          prevGexDollars_5m: 950_000_000,
          prevGexDollars_10m: 930_000_000,
          prevGexDollars_15m: 900_000_000,
          prevGexDollars_20m: 850_000_000,
          strike: 5800,
        }),
      }),
    ];
    const { container } = render(<SparklinePanel leaderboard={leaderboard} />);
    expect(container.querySelector('polyline')).toBeInTheDocument();
  });

  it('renders a dashed flat line when all 5-min-grid prev GEX data is null (early session)', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({
          gexDollars: 1_000_000_000,
          prevGexDollars_5m: null,
          prevGexDollars_10m: null,
          prevGexDollars_15m: null,
          prevGexDollars_20m: null,
          strike: 5800,
        }),
      }),
    ];
    const { container } = render(<SparklinePanel leaderboard={leaderboard} />);
    // Only current value → 1 valid point → flat dashed line
    expect(container.querySelector('polyline')).not.toBeInTheDocument();
    expect(
      container.querySelector('line[stroke-dasharray]'),
    ).toBeInTheDocument();
  });

  it('renders a polyline when only prev5m is available (2 points suffice)', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({
          gexDollars: 1_100_000_000,
          prevGexDollars_5m: 1_000_000_000,
          prevGexDollars_10m: null,
          prevGexDollars_15m: null,
          prevGexDollars_20m: null,
          strike: 5800,
        }),
      }),
    ];
    const { container } = render(<SparklinePanel leaderboard={leaderboard} />);
    expect(container.querySelector('polyline')).toBeInTheDocument();
  });

  it('uses reconstructed current (prevGexDollars_5m + deltaGex_5m) instead of drifted gexDollars', () => {
    // gexDollars has drifted far below the stored scale (JOIN recalculation
    // artefact). The reconstructed current = 950M + 50M = 1000M, which is
    // above prevGexDollars_20m (850M), so a polyline should still render.
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({
          gexDollars: 100_000_000, // drifted JOIN value — would produce wrong slope
          deltaGex_5m: 50_000_000, // stored delta on correct scale
          prevGexDollars_5m: 950_000_000,
          prevGexDollars_20m: 850_000_000,
          strike: 5800,
        }),
      }),
    ];
    const { container } = render(<SparklinePanel leaderboard={leaderboard} />);
    // Reconstructed current = 1,000,000,000 — valid data point → polyline
    expect(container.querySelector('polyline')).toBeInTheDocument();
  });
});
