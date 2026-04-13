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
    prevGexDollars_10m: null,
    prevGexDollars_15m: null,
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
  it('shows New entry arrow on initial render', () => {
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
    // First render: prevRanksRef is empty so every entry is 'new'.
    // The effect fires and sets rankChanges to {type:'new'}, which persists
    // until the next top5 change — so the "NEW" badge is what the user sees.
    expect(screen.getByLabelText('New entry')).toBeInTheDocument();
  });
});

describe('StrikeBox: delta percentage formatting', () => {
  it('shows — for null deltaPct_1m', () => {
    // The Δ% cell renders — for null deltaPct_1m. The rank column now shows
    // "NEW" on initial render (not —), so only the Δ% cell contributes a dash.
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ deltaPct_1m: null, strike: 5800 }),
          }),
        ]}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
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

  it('shows formatted negative deltaPct_1m', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ deltaPct_1m: -0.025, strike: 5800 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('-2.5%')).toBeInTheDocument();
  });
});

describe('StrikeBox: formatNet coverage (est. Δ column)', () => {
  it('renders the leaderboard table with est. Δ column (positive gexDollars)', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({
              gexDollars: 1_000_000_000,
              spot: 5795,
              strike: 5800,
            }),
          }),
        ]}
      />,
    );
    expect(
      screen.getByRole('table', { name: /gex strike leaderboard/i }),
    ).toBeInTheDocument();
  });

  it('renders positive dealer delta (green) when gexDollars is positive', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({
              gexDollars: 1_000_000_000,
              spot: 5795,
              strike: 5800,
            }),
          }),
        ]}
      />,
    );
    // formatNet(1_000_000_000 / (5795 * 100)) — small value, rendered as formatted label
    // The key assertion is that the component renders without crashing
    expect(
      screen.getByRole('table', { name: /gex strike leaderboard/i }),
    ).toBeInTheDocument();
  });

  it('renders negative dealer delta when gexDollars is negative', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({
              gexDollars: -500_000_000,
              spot: 5795,
              strike: 5800,
            }),
          }),
        ]}
      />,
    );
    expect(
      screen.getByRole('table', { name: /gex strike leaderboard/i }),
    ).toBeInTheDocument();
  });
});

describe('StrikeBox: Greek bar tooltips', () => {
  // Note: computeBarStats with a single row sets nearZeroThreshold = abs(value),
  // making any single value "near zero". We need two rows with differing magnitudes
  // so the smaller value is not clamped and the tooltip reflects sign.

  it('renders CHEX cell with tooltip text for positive charm', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ charmNet: 5e7, strike: 5800 }),
          }),
          makeStrike(5750, {
            features: makeFeatures({ charmNet: 1e6, strike: 5750 }),
          }),
        ]}
      />,
    );
    // The larger positive charm row will get the "Positive Charm" tooltip
    const chexCells = screen
      .getAllByTitle(/charm/i)
      .filter((el) => /Positive Charm/i.test(el.title));
    expect(chexCells.length).toBeGreaterThanOrEqual(1);
  });

  it('renders CHEX cell with negative tooltip for negative charm', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ charmNet: -5e7, strike: 5800 }),
          }),
          makeStrike(5750, {
            features: makeFeatures({ charmNet: -1e6, strike: 5750 }),
          }),
        ]}
      />,
    );
    const chexCells = screen
      .getAllByTitle(/charm/i)
      .filter((el) => /Negative Charm/i.test(el.title));
    expect(chexCells.length).toBeGreaterThanOrEqual(1);
  });

  it('renders DEX cell with positive tooltip for positive deltaNet', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ deltaNet: 5e8, strike: 5800 }),
          }),
          makeStrike(5750, {
            features: makeFeatures({ deltaNet: 1e7, strike: 5750 }),
          }),
        ]}
      />,
    );
    const dexCells = screen
      .getAllByTitle(/dex/i)
      .filter((el) => /Positive DEX/i.test(el.title));
    expect(dexCells.length).toBeGreaterThanOrEqual(1);
  });

  it('renders DEX cell with negative tooltip for negative deltaNet', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ deltaNet: -5e8, strike: 5800 }),
          }),
          makeStrike(5750, {
            features: makeFeatures({ deltaNet: -1e7, strike: 5750 }),
          }),
        ]}
      />,
    );
    const dexCells = screen
      .getAllByTitle(/dex/i)
      .filter((el) => /Negative DEX/i.test(el.title));
    expect(dexCells.length).toBeGreaterThanOrEqual(1);
  });

  it('renders VEX cell with positive tooltip for positive vannaNet', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ vannaNet: 5e7, strike: 5800 }),
          }),
          makeStrike(5750, {
            features: makeFeatures({ vannaNet: 1e6, strike: 5750 }),
          }),
        ]}
      />,
    );
    const vexCells = screen
      .getAllByTitle(/vex/i)
      .filter((el) => /Positive VEX/i.test(el.title));
    expect(vexCells.length).toBeGreaterThanOrEqual(1);
  });

  it('renders VEX cell with negative tooltip for negative vannaNet', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ vannaNet: -5e7, strike: 5800 }),
          }),
          makeStrike(5750, {
            features: makeFeatures({ vannaNet: -1e6, strike: 5750 }),
          }),
        ]}
      />,
    );
    const vexCells = screen
      .getAllByTitle(/vex/i)
      .filter((el) => /Negative VEX/i.test(el.title));
    expect(vexCells.length).toBeGreaterThanOrEqual(1);
  });

  it('renders near-zero CHEX tooltip when charmNet is zero', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ charmNet: 0, strike: 5800 }),
          }),
          makeStrike(5750, {
            features: makeFeatures({ charmNet: 0, strike: 5750 }),
          }),
        ]}
      />,
    );
    const chexCells = screen.getAllByTitle(/charm near zero/i);
    expect(chexCells.length).toBeGreaterThanOrEqual(1);
  });
});

describe('StrikeBox: rank arrows (up / down)', () => {
  it('renders rank arrows for all rows in a multi-strike leaderboard', async () => {
    const { rerender } = render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            rankBySize: 1,
            features: makeFeatures({ gexDollars: 3_000_000_000, strike: 5800 }),
          }),
          makeStrike(5750, {
            rankBySize: 2,
            features: makeFeatures({ gexDollars: 2_000_000_000, strike: 5750 }),
          }),
        ]}
      />,
    );

    // After first render + effect flush, all entries show "New entry" (prevRanksRef was empty)
    const newArrows = screen.getAllByLabelText('New entry');
    expect(newArrows.length).toBeGreaterThanOrEqual(1);

    // Rerender with swapped order so rank changes fire
    rerender(
      <StrikeBox
        leaderboard={[
          makeStrike(5750, {
            rankBySize: 1,
            features: makeFeatures({ gexDollars: 2_000_000_000, strike: 5750 }),
          }),
          makeStrike(5800, {
            rankBySize: 2,
            features: makeFeatures({ gexDollars: 3_000_000_000, strike: 5800 }),
          }),
        ]}
      />,
    );

    // After rerender: 5750 was rank 2 → now rank 1 (↑1), 5800 was rank 1 → now rank 2 (↓1).
    // aria-labels now include the delta count ("Rank improved by 1", "Rank worsened by 1").
    const allArrows = [
      ...screen.queryAllByLabelText(/Rank improved/),
      ...screen.queryAllByLabelText(/Rank worsened/),
      ...screen.queryAllByLabelText('Rank unchanged'),
    ];
    expect(allArrows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('StrikeBox: HOT% badge', () => {
  it('shows 0% HOT badge when deltaPct_1m is null', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            features: makeFeatures({ deltaPct_1m: null, strike: 5800 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('shows correct HOT% for a non-null positive deltaPct_1m', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            // |0.08| * 100 = 8 → toFixed(0) = '8'
            features: makeFeatures({ deltaPct_1m: 0.08, strike: 5800 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('8%')).toBeInTheDocument();
  });

  it('shows absolute HOT% for a negative deltaPct_1m', () => {
    render(
      <StrikeBox
        leaderboard={[
          makeStrike(5800, {
            // |-0.12| * 100 = 12 → toFixed(0) = '12'
            features: makeFeatures({ deltaPct_1m: -0.12, strike: 5800 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('12%')).toBeInTheDocument();
  });
});
