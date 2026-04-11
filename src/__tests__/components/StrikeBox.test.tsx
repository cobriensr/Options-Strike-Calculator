/**
 * StrikeBox unit tests.
 *
 * Note on rank-change arrows: StrikeBox uses useState + useEffect to track
 * previous ranks. React Testing Library's act() flushes all effects before
 * each assertion, so the transient 'up'/'down' state (visible for one render
 * before prevRanks catches up) cannot be captured with standard rerender.
 * Rank-change arrow tests are therefore limited to the stable state where
 * all arrows show "Rank unchanged".
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StrikeBox } from '../../components/GexTarget/StrikeBox';
import type { StrikeScore, MagnetFeatures } from '../../utils/gex-target';

// ── Fixture helpers ───────────────────────────────────────────────────

function makeFeatures(overrides: Partial<MagnetFeatures> = {}): MagnetFeatures {
  return {
    strike: 5800,
    spot: 5795,
    distFromSpot: 5,
    gexDollars: 2_000_000_000,
    callGexDollars: 1_200_000_000,
    putGexDollars: 800_000_000,
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
    deltaPct_1m: 0.04,
    deltaPct_5m: 0.05,
    deltaPct_20m: 0.1,
    deltaPct_60m: 0.2,
    callRatio: 0.3,
    charmNet: 5e6,
    deltaNet: 2e8,
    vannaNet: 3e6,
    minutesAfterNoonCT: 90,
    ...overrides,
  };
}

function makeStrike(
  strike: number,
  overrides: Partial<StrikeScore> = {},
): StrikeScore {
  return {
    strike,
    features: makeFeatures({ strike, distFromSpot: strike - 5795 }),
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

describe('StrikeBox: empty state', () => {
  it('shows No data when leaderboard is empty', () => {
    render(<StrikeBox leaderboard={[]} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('does not render a table when leaderboard is empty', () => {
    render(<StrikeBox leaderboard={[]} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('StrikeBox: table structure', () => {
  it('renders an accessible table with a label', () => {
    render(<StrikeBox leaderboard={[makeStrike(5800)]} />);
    expect(
      screen.getByRole('table', { name: /gex strike leaderboard/i }),
    ).toBeInTheDocument();
  });

  it('renders the expected column headers', () => {
    render(<StrikeBox leaderboard={[makeStrike(5800)]} />);
    expect(screen.getByText('RK')).toBeInTheDocument();
    expect(screen.getByText('Strike')).toBeInTheDocument();
    expect(screen.getByText('Dist')).toBeInTheDocument();
    expect(screen.getByText('CHEX')).toBeInTheDocument();
    expect(screen.getByText('DEX')).toBeInTheDocument();
    expect(screen.getByText('VEX')).toBeInTheDocument();
    expect(screen.getByText('HOT%')).toBeInTheDocument();
  });
});

describe('StrikeBox: data rows', () => {
  it('renders each strike price in a table row', () => {
    const leaderboard = [
      makeStrike(5800, {
        features: makeFeatures({
          strike: 5800,
          gexDollars: 3_000_000_000,
          distFromSpot: 5,
        }),
      }),
      makeStrike(5750, {
        features: makeFeatures({
          strike: 5750,
          gexDollars: 2_000_000_000,
          distFromSpot: -45,
        }),
      }),
    ];
    render(<StrikeBox leaderboard={leaderboard} />);
    expect(screen.getByText('5800')).toBeInTheDocument();
    expect(screen.getByText('5750')).toBeInTheDocument();
  });

  it('renders all strikes passed in (parent pre-slices to top 5)', () => {
    // StrikeBox no longer slices or sorts — the parent (GexTarget/index.tsx)
    // pre-computes top5ByGex and passes it down. Verify all provided strikes
    // are rendered in the order they are received.
    const strikes = [5800, 5750, 5700, 5650, 5600].map((s, i) =>
      makeStrike(s, {
        rankBySize: i + 1,
        features: makeFeatures({
          strike: s,
          gexDollars: (5 - i) * 1_000_000_000,
          distFromSpot: s - 5795,
        }),
      }),
    );
    render(<StrikeBox leaderboard={strikes} />);
    expect(screen.getByText('5800')).toBeInTheDocument();
    expect(screen.getByText('5600')).toBeInTheDocument();
  });

  it('renders strikes in the order received (parent is responsible for sort)', () => {
    // Sorting by |gexDollars| is now done in GexTarget/index.tsx before the
    // leaderboard is passed to StrikeBox. The component renders input order.
    const leaderboard = [
      makeStrike(5700, {
        features: makeFeatures({ strike: 5700, gexDollars: 3_000_000_000 }),
      }),
      makeStrike(5800, {
        features: makeFeatures({ strike: 5800, gexDollars: 1_000_000_000 }),
      }),
    ];
    render(<StrikeBox leaderboard={leaderboard} />);
    const rows = screen.getAllByRole('row');
    // rows[0] = header; order matches input (5700 first, then 5800)
    expect(rows[1]).toHaveTextContent('5700');
    expect(rows[2]).toHaveTextContent('5800');
  });
});

describe('StrikeBox: GEX $ formatting', () => {
  it('formats GEX in billions with one decimal', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ gexDollars: 2_500_000_000, strike: 5800 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('+2.5B')).toBeInTheDocument();
  });

  it('formats GEX in millions with one decimal', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ gexDollars: 350_000_000, strike: 5800 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('+350.0M')).toBeInTheDocument();
  });

  it('formats GEX in thousands (no decimal)', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ gexDollars: 750_000, strike: 5800 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('+750K')).toBeInTheDocument();
  });

  it('formats negative GEX with minus sign', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({
              gexDollars: -1_200_000_000,
              strike: 5800,
            }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('-1.2B')).toBeInTheDocument();
  });
});

describe('StrikeBox: distance formatting', () => {
  it('shows positive distance with + sign', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({
              distFromSpot: 5,
              gexDollars: 1_000_000_000,
              strike: 5800,
            }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('+5p')).toBeInTheDocument();
  });

  it('shows negative distance without extra sign (toFixed handles it)', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5750, {
            features: makeFeatures({
              distFromSpot: -45,
              gexDollars: 1_000_000_000,
              strike: 5750,
            }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('-45p')).toBeInTheDocument();
  });
});

describe('StrikeBox: target row highlight', () => {
  it('sets aria-current on the target row', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            isTarget: true,
            features: makeFeatures({ gexDollars: 2_000_000_000, strike: 5800 }),
          }),
        ]}
      />,
    );
    const rows = screen.getAllByRole('row');
    // rows[0] = thead row, rows[1] = data row
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
  });

  it('does not set aria-current on non-target rows', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            isTarget: false,
            features: makeFeatures({ gexDollars: 2_000_000_000, strike: 5800 }),
          }),
        ]}
      />,
    );
    const rows = screen.getAllByRole('row');
    expect(rows[1]).not.toHaveAttribute('aria-current');
  });
});

describe('StrikeBox: rank arrows', () => {
  it('shows Rank unchanged arrow on initial render', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            rankBySize: 1,
            features: makeFeatures({ gexDollars: 2_000_000_000, strike: 5800 }),
          }),
        ]}
      />,
    );
    // First render: prevRanks is empty so rank is 'new', which renders
    // the same — arrow as 'same'. After the effect flushes, rank becomes
    // 'same' — still the same arrow. Both states are "Rank unchanged".
    expect(screen.getByLabelText('Rank unchanged')).toBeInTheDocument();
  });
});

describe('StrikeBox: delta percentage formatting', () => {
  it('shows — for null deltaPct_1m', () => {
    // The Δ% cell and the rank arrow both render — (em dash), so use getAllByText.
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ deltaPct_1m: null, strike: 5800 }),
          }),
        ]}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('shows formatted positive deltaPct_1m', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ deltaPct_1m: 0.025, strike: 5800 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('+2.5%')).toBeInTheDocument();
  });
});
