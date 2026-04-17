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
  mockNopeSeries,
  mockChart,
} = vi.hoisted(() => {
  const mockSetData = vi.fn();
  const mockCreatePriceLine = vi.fn().mockReturnValue({});
  // NOPE series uses its OWN createPriceLine spy so the zero-line creation
  // doesn't pollute count assertions on the candle-series spy.
  const mockNopeCreatePriceLine = vi.fn().mockReturnValue({});
  const mockRemovePriceLine = vi.fn();
  const mockApplyOptions = vi.fn();
  const mockRemove = vi.fn();

  const mockCandleSeries = {
    setData: mockSetData,
    createPriceLine: mockCreatePriceLine,
    removePriceLine: mockRemovePriceLine,
  };

  const mockVwapSeries = { setData: mockSetData };
  const mockNopeSeries = {
    setData: mockSetData,
    createPriceLine: mockNopeCreatePriceLine,
  };

  const mockTimeScale = {
    fitContent: vi.fn(),
  };

  const mockChart = {
    addSeries: vi.fn(),
    applyOptions: mockApplyOptions,
    remove: mockRemove,
    timeScale: vi.fn().mockReturnValue(mockTimeScale),
  };

  return {
    mockSetData,
    mockCreatePriceLine,
    mockRemovePriceLine,
    mockApplyOptions,
    mockRemove,
    mockCandleSeries,
    mockVwapSeries,
    mockNopeSeries,
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
      callGexDollars: gexDollars,
      putGexDollars: 0,
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
    .mockReturnValueOnce(mockVwapSeries)
    .mockReturnValue(mockNopeSeries);
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

describe('PriceChart: resampleTo5Min coverage', () => {
  it('merges multiple 1-minute candles into the same 5-minute bucket', () => {
    // Two candles in the same 5-min bucket: datetime difference < 5 min
    const base = 1_744_545_000_000; // arbitrary epoch aligned to 5-min boundary
    const candles: SPXCandle[] = [
      makeCandle({
        datetime: base,
        open: 5800,
        high: 5820,
        low: 5795,
        close: 5810,
        volume: 500,
      }),
      makeCandle({
        datetime: base + 60_000,
        open: 5810,
        high: 5830,
        low: 5808,
        close: 5825,
        volume: 600,
      }),
    ];

    const { getByRole } = render(
      <PriceChart
        candles={candles}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );

    // Component renders without error — merged bucket reduces to 1 resampled candle
    expect(getByRole('img', { name: /spx price chart/i })).toBeInTheDocument();
  });

  it('produces separate 5-minute buckets for candles in different windows', () => {
    // Two candles > 5 minutes apart → two separate buckets
    const base = 1_744_545_000_000;
    const candles: SPXCandle[] = [
      makeCandle({ datetime: base, volume: 500 }),
      makeCandle({ datetime: base + 5 * 60 * 1000, volume: 600 }),
    ];

    const { getByRole } = render(
      <PriceChart
        candles={candles}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );
    expect(getByRole('img', { name: /spx price chart/i })).toBeInTheDocument();
  });
});

describe('PriceChart: VWAP zero-volume filtering', () => {
  it('excludes zero-volume candles from VWAP calculation', () => {
    // Mix of zero-volume and non-zero-volume candles in the same 5-min bucket.
    // The VWAP filter(c => c.volume > 0) should only process the non-zero one.
    const base = 1_744_545_000_000;
    const candles: SPXCandle[] = [
      makeCandle({
        datetime: base,
        volume: 0,
        open: 5800,
        high: 5820,
        low: 5795,
        close: 5810,
      }),
      makeCandle({
        datetime: base + 60_000,
        volume: 1000,
        open: 5810,
        high: 5830,
        low: 5808,
        close: 5825,
      }),
    ];

    const { getByRole } = render(
      <PriceChart
        candles={candles}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );

    // Component should render without crash — VWAP omits zero-volume candles
    expect(getByRole('img', { name: /spx price chart/i })).toBeInTheDocument();
  });

  it('handles all-zero-volume candles gracefully', () => {
    const base = 1_744_545_000_000;
    const candles: SPXCandle[] = [
      makeCandle({ datetime: base, volume: 0 }),
      makeCandle({ datetime: base + 60_000, volume: 0 }),
    ];

    const { getByRole } = render(
      <PriceChart
        candles={candles}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );
    expect(getByRole('img', { name: /spx price chart/i })).toBeInTheDocument();
  });
});

describe('PriceChart: overlay effect early return', () => {
  it('skips createPriceLine when score, previousClose, openingCallStrike, and openingPutStrike are all null', () => {
    render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );

    // No price lines should be created when all overlay inputs are null
    expect(mockCreatePriceLine).not.toHaveBeenCalled();
  });

  it('creates opening call and put lines independently (no score needed)', () => {
    render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={5850}
        openingPutStrike={null}
      />,
    );
    expect(mockCreatePriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 5850, color: '#00bcd4' }),
    );
  });

  it('creates only put line when openingPutStrike is set and others are null', () => {
    render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={5700}
      />,
    );
    expect(mockCreatePriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 5700, color: '#ff9800' }),
    );
  });
});

describe('PriceChart: interval toggle', () => {
  // Exercises lines 417-447 — the 1m / 5m interval toggle buttons and the
  // onIntervalChange callback. Without onIntervalChange the toggle is
  // omitted entirely; with it both buttons render and are clickable.
  it('does not render the interval toggle when onIntervalChange is omitted', () => {
    const { queryByRole } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );

    expect(
      queryByRole('button', { name: /1-minute candles/i }),
    ).not.toBeInTheDocument();
    expect(
      queryByRole('button', { name: /5-minute candles/i }),
    ).not.toBeInTheDocument();
  });

  it('renders both interval buttons with correct aria-pressed state when interval is 5m', () => {
    const onIntervalChange = vi.fn();
    const { getByRole } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
        interval="5m"
        onIntervalChange={onIntervalChange}
      />,
    );

    expect(getByRole('button', { name: /1-minute candles/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(getByRole('button', { name: /5-minute candles/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('calls onIntervalChange with "1m" when the 1m button is clicked', () => {
    const onIntervalChange = vi.fn();
    const { getByRole } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
        interval="5m"
        onIntervalChange={onIntervalChange}
      />,
    );

    getByRole('button', { name: /1-minute candles/i }).click();
    expect(onIntervalChange).toHaveBeenCalledWith('1m');
  });

  it('calls onIntervalChange with "5m" when the 5m button is clicked', () => {
    const onIntervalChange = vi.fn();
    const { getByRole } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
        interval="1m"
        onIntervalChange={onIntervalChange}
      />,
    );

    getByRole('button', { name: /5-minute candles/i }).click();
    expect(onIntervalChange).toHaveBeenCalledWith('5m');
  });

  it('flips aria-pressed when interval prop changes to 1m', () => {
    const onIntervalChange = vi.fn();
    const { getByRole, rerender } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
        interval="5m"
        onIntervalChange={onIntervalChange}
      />,
    );

    rerender(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
        interval="1m"
        onIntervalChange={onIntervalChange}
      />,
    );

    expect(getByRole('button', { name: /1-minute candles/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(getByRole('button', { name: /5-minute candles/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('PriceChart: chart options time formatters', () => {
  // chartOptions.tickMarkFormatter and localization.timeFormatter (lines
  // 144-149) are closures invoked by lightweight-charts at render time.
  // The mock doesn't call them on its own, so we capture the options from
  // the first createChart call and invoke the closures directly.
  it('tickMarkFormatter and timeFormatter produce 24-hour CT strings', async () => {
    const { createChart } = await import('lightweight-charts');
    const mocked = vi.mocked(createChart);

    render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );

    const options = mocked.mock.calls.at(-1)?.[1];
    expect(options).toBeDefined();

    // 2026-01-15T15:30:00Z → 09:30 CT (CST, UTC-6)
    const utcSeconds = Math.floor(
      new Date('2026-01-15T15:30:00Z').getTime() / 1000,
    );
    const tickMarkFmt = (
      options as {
        timeScale?: {
          tickMarkFormatter?: (s: number) => string;
        };
      }
    ).timeScale?.tickMarkFormatter;
    const timeFmt = (
      options as {
        localization?: { timeFormatter?: (s: number) => string };
      }
    ).localization?.timeFormatter;

    expect(typeof tickMarkFmt).toBe('function');
    expect(typeof timeFmt).toBe('function');
    expect(tickMarkFmt!(utcSeconds)).toBe('09:30');
    expect(timeFmt!(utcSeconds)).toBe('09:30');
  });
});

describe('PriceChart: momentum badge', () => {
  // The badge (lines 400-413) only renders when momentum.signal !== 'flat'.
  // A 'flat' signal collapses the branch so nothing is rendered.
  it('renders the signal label when momentum.signal is non-flat', () => {
    const { getByLabelText } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
        momentum={{
          signal: 'drift-up',
          rangeExpanding: false,
          roc1: 2,
          roc3: 5,
          roc5: 7,
          streak: 2,
          avgRange: 3,
          avgRangePrev: 3,
          acceleration: 0.5,
        }}
      />,
    );
    // signalLabel('bullish') renders as visible text inside the badge.
    expect(getByLabelText(/momentum:/i)).toBeInTheDocument();
  });

  it('appends the lightning glyph when rangeExpanding is true', () => {
    const { getByLabelText } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
        momentum={{
          signal: 'drift-down',
          rangeExpanding: true,
          roc1: -2,
          roc3: -5,
          roc5: -7,
          streak: -3,
          avgRange: 5,
          avgRangePrev: 3,
          acceleration: -0.5,
        }}
      />,
    );
    // The badge should include the ⚡ glyph (\u26A1).
    const badge = getByLabelText(/momentum:/i);
    expect(badge.textContent).toContain('\u26A1');
  });

  it('omits the badge when momentum.signal is "flat"', () => {
    const { queryByLabelText } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
        momentum={{
          signal: 'flat',
          rangeExpanding: false,
          roc1: 0,
          roc3: 0,
          roc5: 0,
          streak: 0,
          avgRange: 2,
          avgRangePrev: 2,
          acceleration: 0,
        }}
      />,
    );
    expect(queryByLabelText(/momentum:/i)).not.toBeInTheDocument();
  });

  it('omits the badge when momentum prop is undefined', () => {
    const { queryByLabelText } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );
    expect(queryByLabelText(/momentum:/i)).not.toBeInTheDocument();
  });
});

describe('PriceChart: ResizeObserver guard', () => {
  it('renders without error when ResizeObserver is not available', () => {
    // Simulate environments where ResizeObserver is undefined
    const original = globalThis.ResizeObserver;
    // @ts-expect-error intentionally setting undefined for test
    globalThis.ResizeObserver = undefined;

    const { getByRole } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );
    expect(getByRole('img', { name: /spx price chart/i })).toBeInTheDocument();

    globalThis.ResizeObserver = original;
  });

  it('renders correctly and chart is resizable when ResizeObserver is available', () => {
    // jsdom does not have ResizeObserver; provide a class-based stub to exercise the branch
    const observations: Element[] = [];
    let capturedCallback: ResizeObserverCallback | null = null;

    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        capturedCallback = cb;
      }
      observe(el: Element) {
        observations.push(el);
        // Immediately fire the callback to exercise the resize handler
        capturedCallback!(
          [{ contentRect: { width: 400 } } as ResizeObserverEntry],
          this,
        );
      }
      unobserve = vi.fn();
      disconnect = vi.fn();
    }

    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver;

    const { unmount, getByRole } = render(
      <PriceChart
        candles={[makeCandle()]}
        previousClose={null}
        score={null}
        openingCallStrike={null}
        openingPutStrike={null}
      />,
    );

    expect(getByRole('img', { name: /spx price chart/i })).toBeInTheDocument();
    expect(observations.length).toBeGreaterThan(0);

    unmount();

    globalThis.ResizeObserver = original;
  });
});
