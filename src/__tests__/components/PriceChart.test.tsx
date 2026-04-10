/**
 * PriceChart unit tests.
 *
 * lightweight-charts is mocked so the imperative chart API calls can be
 * observed without a DOM canvas. The mock exposes spy functions for
 * `createChart`, `addSeries`, `setData`, `createPriceLine`, and
 * `removePriceLine` so each test can assert exactly which calls were made.
 */

import { render, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PriceChart } from '../../components/GexTarget/PriceChart';
import type { SPXCandle } from '../../hooks/useGexTarget';
import type { TargetScore, StrikeScore } from '../../utils/gex-target';

// ── lightweight-charts mock ───────────────────────────────────────────
// vi.mock factories are hoisted above all variable declarations, so mock
// objects must be created with vi.hoisted() to be accessible in the factory.

const {
  mockCreatePriceLine,
  mockRemovePriceLine,
  mockRemove,
  mockCandleSeries,
  mockVwapSeries,
  mockChart,
} = vi.hoisted(() => {
  const mockSetData = vi.fn();
  const mockCreatePriceLine = vi.fn().mockReturnValue({});
  const mockRemovePriceLine = vi.fn();
  const mockApplyOptions = vi.fn();
  const mockRemove = vi.fn();

  const mockCandleSeries = {
    setData: mockSetData,
    createPriceLine: mockCreatePriceLine,
    removePriceLine: mockRemovePriceLine,
  };

  const mockVwapSeries = { setData: mockSetData };

  const mockChart = {
    addSeries: vi.fn(),
    applyOptions: mockApplyOptions,
    remove: mockRemove,
  };

  return {
    mockSetData,
    mockCreatePriceLine,
    mockRemovePriceLine,
    mockApplyOptions,
    mockRemove,
    mockCandleSeries,
    mockVwapSeries,
    mockChart,
  };
});

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn().mockReturnValue(mockChart),
  CrosshairMode: { Normal: 1 },
  LineStyle: { Dashed: 1, Solid: 0 },
  CandlestickSeries: class CandlestickSeries {},
  LineSeries: class LineSeries {},
}));

// ── Fixtures ──────────────────────────────────────────────────────────

function makeCandle(overrides: Partial<SPXCandle> = {}): SPXCandle {
  return {
    open: 5800,
    high: 5810,
    low: 5790,
    close: 5805,
    volume: 1000,
    datetime: Date.now(),
    ...overrides,
  };
}

function makeStrike(
  strike = 5800,
  gexDollars = 1_000_000_000,
  overrides: Partial<StrikeScore> = {},
): StrikeScore {
  return {
    strike,
    features: {
      strike,
      spot: 5795,
      distFromSpot: strike - 5795,
      gexDollars,
      deltaGex_1m: null,
      deltaGex_5m: null,
      deltaGex_20m: null,
      deltaGex_60m: null,
      prevGexDollars_1m: null,
      prevGexDollars_5m: null,
      prevGexDollars_20m: null,
      prevGexDollars_60m: null,
      deltaPct_1m: null,
      deltaPct_5m: null,
      deltaPct_20m: null,
      deltaPct_60m: null,
      callRatio: 0.2,
      charmNet: 0,
      deltaNet: 0,
      vannaNet: 0,
      minutesAfterNoonCT: 60,
    },
    components: {
      flowConfluence: 0,
      priceConfirm: 0,
      charmScore: 0,
      dominance: 0.5,
      clarity: 0.5,
      proximity: 0.5,
    },
    finalScore: 0.5,
    tier: 'MEDIUM',
    wallSide: 'CALL',
    rankByScore: 1,
    rankBySize: 1,
    isTarget: true,
    ...overrides,
  };
}

function makeScore(leaderboard: StrikeScore[]): TargetScore {
  return {
    target: leaderboard[0] ?? null,
    leaderboard,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockChart.addSeries
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
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );

    const container = getByRole('img', { name: /spx price chart/i });
    expect(container).toBeInTheDocument();
  });

  it('renders empty state when candles array is empty', () => {
    const { getByRole } = render(
      <PriceChart
        candles={[]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
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
        openingCallStrike={null}
        openingPutStrike={null}
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
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );

    expect(mockCreatePriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 5200 }),
    );
  });

  it('calls createPriceLine for openingCallStrike and openingPutStrike', () => {
    render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={5900}
        openingPutStrike={5700}
      />,
    );

    expect(mockCreatePriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 5900 }),
    );
    expect(mockCreatePriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 5700 }),
    );
  });
});

describe('PriceChart: cleanup', () => {
  it('calls chart.remove() on unmount', () => {
    const { unmount } = render(
      <PriceChart
        candles={[]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
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
        openingCallStrike={null}
        openingPutStrike={null}
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
          openingCallStrike={null}
          openingPutStrike={null}
        />,
      );
    });

    // The first price line object should have been removed
    expect(mockRemovePriceLine).toHaveBeenCalledTimes(1);
    // And 2 new lines added
    expect(mockCreatePriceLine).toHaveBeenCalledTimes(3); // 1 original + 2 new
  });
});
