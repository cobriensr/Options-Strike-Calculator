/**
 * PriceChart unit tests.
 *
 * lightweight-charts is an imperative library that uses browser DOM APIs not
 * available in jsdom. The entire module is mocked so tests verify React
 * behaviour (mounting, prop changes, cleanup) rather than chart internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { PriceChart } from '../../components/GexTarget/PriceChart';
import type { SPXCandle } from '../../hooks/useGexTarget';
import type {
  StrikeScore,
  TargetScore,
  MagnetFeatures,
  ComponentScores,
} from '../../utils/gex-target';

// ── Mock lightweight-charts ────────────────────────────────────────────────

const mockRemovePriceLine = vi.fn();
const mockCreatePriceLine = vi.fn(() => ({}));
const mockSetData = vi.fn();
const mockApplyOptions = vi.fn();
const mockRemove = vi.fn();

const mockCandleSeries = {
  setData: mockSetData,
  createPriceLine: mockCreatePriceLine,
  removePriceLine: mockRemovePriceLine,
};

const mockVwapSeries = {
  setData: mockSetData,
};

const mockAddSeries = vi
  .fn()
  .mockReturnValueOnce(mockCandleSeries) // first call → candlestick series
  .mockReturnValue(mockVwapSeries); // subsequent calls → line series

const mockChart = {
  addSeries: mockAddSeries,
  applyOptions: mockApplyOptions,
  remove: mockRemove,
};

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => mockChart),
  CrosshairMode: { Normal: 1 },
  LineStyle: { Solid: 0, Dashed: 1 },
  CandlestickSeries: {},
  LineSeries: {},
}));

// ── Fixture helpers ────────────────────────────────────────────────────────

function makeCandle(overrides: Partial<SPXCandle> = {}): SPXCandle {
  return {
    open: 5790,
    high: 5800,
    low: 5780,
    close: 5795,
    volume: 1000,
    datetime: 1_700_000_000_000, // epoch ms
    ...overrides,
  };
}

function makeFeatures(overrides: Partial<MagnetFeatures> = {}): MagnetFeatures {
  return {
    strike: 5800,
    spot: 5795,
    distFromSpot: 5,
    gexDollars: 1_000_000_000,
    deltaGex_1m: 10_000_000,
    deltaGex_5m: 50_000_000,
    deltaGex_20m: 150_000_000,
    deltaGex_60m: 300_000_000,
    prevGexDollars_1m: 990_000_000,
    prevGexDollars_5m: 950_000_000,
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

function makeComponents(
  overrides: Partial<ComponentScores> = {},
): ComponentScores {
  return {
    flowConfluence: 0.6,
    priceConfirm: 0.4,
    charmScore: 0.3,
    dominance: 0.7,
    clarity: 0.8,
    proximity: 0.9,
    ...overrides,
  };
}

function makeStrike(
  strike: number,
  gexDollars: number,
  overrides: Partial<StrikeScore> = {},
): StrikeScore {
  return {
    strike,
    features: makeFeatures({ strike, gexDollars }),
    components: makeComponents(),
    finalScore: 0.55,
    tier: 'HIGH',
    wallSide: 'CALL',
    rankByScore: 1,
    rankBySize: 1,
    isTarget: true,
    ...overrides,
  };
}

function makeScore(strikes: StrikeScore[]): TargetScore {
  return {
    target: strikes[0] ?? null,
    leaderboard: strikes,
  };
}

// ── Reset mocks before each test ───────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish addSeries return sequence after clearAllMocks resets call counts
  mockAddSeries
    .mockReset()
    .mockReturnValueOnce(mockCandleSeries)
    .mockReturnValue(mockVwapSeries);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('PriceChart: rendering', () => {
  it('renders chart container with correct aria-label', () => {
    const { getByRole } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
      />,
    );

    const container = getByRole('img', { name: /spx price chart/i });
    expect(container).toBeInTheDocument();
  });

  it('renders empty state when candles array is empty', () => {
    const { getByRole } = render(
      <PriceChart candles={[]} previousClose={null} score={null} />,
    );

    // Container should still render even when there is no data
    expect(getByRole('img', { name: /spx price chart/i })).toBeInTheDocument();
  });
});

describe('PriceChart: score overlay', () => {
  it('calls createPriceLine 3 times for a score with 3 leaderboard items', () => {
    const score = makeScore([
      makeStrike(5800, 3_000_000_000),
      makeStrike(5750, 2_000_000_000, { rankByScore: 2, rankBySize: 2 }),
      makeStrike(5850, 1_000_000_000, { rankByScore: 3, rankBySize: 3 }),
    ]);

    render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={score}
      />,
    );

    expect(mockCreatePriceLine).toHaveBeenCalledTimes(3);
  });

  it('calls createPriceLine with price matching previousClose', () => {
    render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={5200}
        score={null}
      />,
    );

    expect(mockCreatePriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 5200 }),
    );
  });
});

describe('PriceChart: cleanup', () => {
  it('calls chart.remove() on unmount', () => {
    const { unmount } = render(
      <PriceChart candles={[]} previousClose={null} score={null} />,
    );

    unmount();

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});

describe('PriceChart: overlay update on score change', () => {
  it('removes old price lines and adds new ones when score changes', async () => {
    const score1 = makeScore([makeStrike(5800, 1_000_000_000)]);
    const score2 = makeScore([
      makeStrike(5800, 2_000_000_000),
      makeStrike(5750, 1_000_000_000, { rankByScore: 2, rankBySize: 2 }),
    ]);

    const { rerender } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={score1}
      />,
    );

    // Initial render: 1 GEX line
    expect(mockCreatePriceLine).toHaveBeenCalledTimes(1);

    // Update score to 2 items
    await act(async () => {
      rerender(
        <PriceChart
          candles={[makeCandle()]}
          previousClose={null}
          score={score2}
        />,
      );
    });

    // The first price line object should have been removed
    expect(mockRemovePriceLine).toHaveBeenCalledTimes(1);
    // And 2 new lines added
    expect(mockCreatePriceLine).toHaveBeenCalledTimes(3); // 1 original + 2 new
  });
});
