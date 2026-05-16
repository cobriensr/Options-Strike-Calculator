/**
 * TickerNetFlowChart unit tests.
 *
 * lightweight-charts is mocked so the imperative chart API can be exercised
 * in JSDOM. The mock mirrors the established pattern in PriceChart.test.tsx
 * — a hoisted spy bag injected via vi.hoisted() so the vi.mock factory can
 * close over the spies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TickerNetFlowChart } from '../components/LotteryFinder/TickerNetFlowChart';
import type {
  NetFlowTick,
  TickerCandle,
} from '../components/LotteryFinder/types';

// ── lightweight-charts mock ───────────────────────────────────────────

const {
  mockRemove,
  mockApplyOptions,
  mockSetData,
  mockCreatePriceLine,
  mockTimeToCoordinate,
  mockSetCrosshairPosition,
  mockClearCrosshairPosition,
  mockSubscribeCrosshairMove,
  mockChart,
} = vi.hoisted(() => {
  const setData = vi.fn();
  const createPriceLine = vi.fn().mockReturnValue({});
  const removePriceLine = vi.fn();
  const timeToCoordinate = vi.fn().mockReturnValue(50);

  const series = {
    setData,
    createPriceLine,
    removePriceLine,
  };

  const timeScale = {
    fitContent: vi.fn(),
    timeToCoordinate,
    subscribeVisibleTimeRangeChange: vi.fn(),
    unsubscribeVisibleTimeRangeChange: vi.fn(),
    subscribeSizeChange: vi.fn(),
    unsubscribeSizeChange: vi.fn(),
  };

  const subscribeCrosshairMove = vi.fn();
  const setCrosshairPosition = vi.fn();
  const clearCrosshairPosition = vi.fn();
  const chart = {
    addSeries: vi.fn().mockImplementation(() => series),
    applyOptions: vi.fn(),
    remove: vi.fn(),
    timeScale: vi.fn().mockReturnValue(timeScale),
    subscribeCrosshairMove,
    unsubscribeCrosshairMove: vi.fn(),
    setCrosshairPosition,
    clearCrosshairPosition,
  };

  return {
    mockRemove: chart.remove,
    mockApplyOptions: chart.applyOptions,
    mockSetData: setData,
    mockCreatePriceLine: createPriceLine,
    mockTimeToCoordinate: timeToCoordinate,
    mockSetCrosshairPosition: setCrosshairPosition,
    mockClearCrosshairPosition: clearCrosshairPosition,
    mockSubscribeCrosshairMove: subscribeCrosshairMove,
    mockChart: chart,
  };
});

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn().mockReturnValue(mockChart),
  CrosshairMode: { Magnet: 1, Normal: 0 },
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
  LineSeries: class LineSeries {},
  BaselineSeries: class BaselineSeries {},
}));

// ── Fixtures ──────────────────────────────────────────────────────────

function makeTick(overrides: Partial<NetFlowTick> = {}): NetFlowTick {
  return {
    ts: '2026-05-08T14:30:00Z',
    ncp: 100,
    ncv: 50,
    npp: 60,
    npv: 30,
    cumNcp: 100,
    cumNcv: 50,
    cumNpp: 60,
    cumNpv: 30,
    ...overrides,
  };
}

function makeCandle(overrides: Partial<TickerCandle> = {}): TickerCandle {
  return {
    ts: '2026-05-08T14:30:00Z',
    open: 200,
    high: 200.5,
    low: 199.8,
    close: 200.2,
    volume: 1_000_000,
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// EMPTY STATE
// ============================================================

describe('TickerNetFlowChart: empty / waiting state', () => {
  it('renders the waiting placeholder when series has fewer than 2 ticks', () => {
    render(
      <TickerNetFlowChart
        series={[]}
        candles={[]}
        ariaLabel="AAPL net flow (waiting)"
      />,
    );
    expect(
      screen.getByText(/waiting for ≥2 net-flow ticks…/i),
    ).toBeInTheDocument();
  });

  it('exposes the aria-label on the chart container', () => {
    render(
      <TickerNetFlowChart series={[]} candles={[]} ariaLabel="AAPL waiting" />,
    );
    expect(screen.getByLabelText('AAPL waiting')).toBeInTheDocument();
  });

  it('does not render the marker overlay when in waiting state', () => {
    const { container } = render(
      <TickerNetFlowChart
        series={[]}
        candles={[]}
        markerTs="2026-05-08T14:31:00Z"
        ariaLabel="t"
      />,
    );
    // Marker overlay is a 1px-wide div with repeating-linear-gradient.
    const overlays = container.querySelectorAll(
      'div[style*="repeating-linear-gradient"]',
    );
    expect(overlays.length).toBe(0);
  });
});

// ============================================================
// POPULATED — SMOKE
// ============================================================

describe('TickerNetFlowChart: populated rendering', () => {
  const ticks = [
    makeTick({ ts: '2026-05-08T14:30:00Z', cumNcp: 100, cumNpp: 50 }),
    makeTick({ ts: '2026-05-08T14:31:00Z', cumNcp: 200, cumNpp: 80 }),
  ];

  it('hides the waiting placeholder once ≥2 ticks are present', () => {
    render(<TickerNetFlowChart series={ticks} candles={[]} ariaLabel="t" />);
    expect(
      screen.queryByText(/waiting for ≥2 net-flow ticks/i),
    ).not.toBeInTheDocument();
  });

  it('calls setData on the flow series after data effect runs', () => {
    render(<TickerNetFlowChart series={ticks} candles={[]} ariaLabel="t" />);
    // 4 series total are created (price, NCP, NPP, netVol) — only the 3
    // flow ones are populated when there are no candles.
    expect(mockSetData).toHaveBeenCalled();
  });

  it('creates a previousClose price line when previousClose is finite', () => {
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[makeCandle()]}
        previousClose={199.5}
        ariaLabel="t"
      />,
    );
    expect(mockCreatePriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 199.5, title: 'prev close' }),
    );
  });

  it('skips the previousClose price line when previousClose is null', () => {
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[makeCandle()]}
        previousClose={null}
        ariaLabel="t"
      />,
    );
    // The only createPriceLine call would be the zero-line on netVol.
    const prevCloseCalls = mockCreatePriceLine.mock.calls.filter(
      (call) =>
        (call[0] as { title?: string } | undefined)?.title === 'prev close',
    );
    expect(prevCloseCalls.length).toBe(0);
  });
});

// ============================================================
// MARKER + CLEANUP
// ============================================================

describe('TickerNetFlowChart: fire-time marker', () => {
  it('renders the marker overlay div when markerTs resolves to a coordinate', () => {
    const ticks = [
      makeTick({ ts: '2026-05-08T14:30:00Z' }),
      makeTick({ ts: '2026-05-08T14:31:00Z' }),
    ];
    mockTimeToCoordinate.mockReturnValue(75);
    const { container } = render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        markerTs="2026-05-08T14:31:00Z"
        ariaLabel="t"
      />,
    );
    const overlay = container.querySelector(
      'div[style*="repeating-linear-gradient"]',
    );
    expect(overlay).not.toBeNull();
  });

  it('omits the marker overlay when timeToCoordinate returns null (off-chart)', () => {
    const ticks = [
      makeTick({ ts: '2026-05-08T14:30:00Z' }),
      makeTick({ ts: '2026-05-08T14:31:00Z' }),
    ];
    mockTimeToCoordinate.mockReturnValue(null);
    const { container } = render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        markerTs="2026-05-08T14:31:00Z"
        ariaLabel="t"
      />,
    );
    const overlay = container.querySelector(
      'div[style*="repeating-linear-gradient"]',
    );
    expect(overlay).toBeNull();
  });
});

describe('TickerNetFlowChart: cleanup', () => {
  it('calls chart.remove() on unmount', () => {
    const { unmount } = render(
      <TickerNetFlowChart series={[]} candles={[]} ariaLabel="t" />,
    );
    act(() => {
      unmount();
    });
    expect(mockRemove).toHaveBeenCalled();
  });

  it('applies new height options when the height prop changes', () => {
    const { rerender } = render(
      <TickerNetFlowChart
        series={[]}
        candles={[]}
        height={220}
        ariaLabel="t"
      />,
    );
    rerender(
      <TickerNetFlowChart
        series={[]}
        candles={[]}
        height={300}
        ariaLabel="t"
      />,
    );
    expect(mockApplyOptions).toHaveBeenCalledWith(
      expect.objectContaining({ height: 300 }),
    );
  });
});

// ============================================================
// CROSS-PANEL HOVER SYNC (Phase 5)
// ============================================================

describe('TickerNetFlowChart: cross-panel hover sync', () => {
  it('calls setCrosshairPosition when syncHoverTime is provided', () => {
    const t = Math.floor(Date.parse('2026-05-08T14:32:00Z') / 1000);
    render(
      <TickerNetFlowChart
        series={[]}
        candles={[]}
        syncHoverTime={t}
        ariaLabel="t"
      />,
    );
    expect(mockSetCrosshairPosition).toHaveBeenCalled();
    const lastCall = mockSetCrosshairPosition.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(t);
  });

  it('calls clearCrosshairPosition when syncHoverTime is null', () => {
    render(
      <TickerNetFlowChart
        series={[]}
        candles={[]}
        syncHoverTime={null}
        ariaLabel="t"
      />,
    );
    expect(mockClearCrosshairPosition).toHaveBeenCalled();
  });

  it('emits onHoverTime via the subscribed crosshair callback', () => {
    const onHoverTime = vi.fn();
    // Capture the callback that the component passes to subscribeCrosshairMove.
    let capturedCallback:
      | ((p: { time?: number; seriesData: Map<unknown, unknown> }) => void)
      | null = null;
    mockSubscribeCrosshairMove.mockImplementationOnce(
      (
        cb: (p: { time?: number; seriesData: Map<unknown, unknown> }) => void,
      ) => {
        capturedCallback = cb;
      },
    );
    render(
      <TickerNetFlowChart
        series={[]}
        candles={[]}
        onHoverTime={onHoverTime}
        ariaLabel="t"
      />,
    );
    expect(capturedCallback).not.toBeNull();
    // Simulate a real cursor move. The sync-guard now clears
    // synchronously after the imperative call so a genuine move
    // arriving on the next frame is emitted normally.
    capturedCallback!({
      time: 1715179920,
      seriesData: new Map(),
    });
    expect(onHoverTime).toHaveBeenCalledWith(1715179920);

    // Simulate a leave — `time` undefined — should emit null.
    capturedCallback!({
      seriesData: new Map(),
    });
    expect(onHoverTime).toHaveBeenLastCalledWith(null);
  });

  it('suppresses onHoverTime when a crosshairMove fires inside setCrosshairPosition', () => {
    const onHoverTime = vi.fn();
    let capturedCallback:
      | ((p: { time?: number; seriesData: Map<unknown, unknown> }) => void)
      | null = null;
    mockSubscribeCrosshairMove.mockImplementationOnce(
      (
        cb: (p: { time?: number; seriesData: Map<unknown, unknown> }) => void,
      ) => {
        capturedCallback = cb;
      },
    );
    // Simulate lightweight-charts' real behavior: setCrosshairPosition
    // dispatches a crosshairMove synchronously. If our sync-guard works,
    // that nested move must NOT re-emit onHoverTime, otherwise we'd
    // ping-pong with the parent's lifted state.
    mockSetCrosshairPosition.mockImplementationOnce(
      (_price: number, time: number) => {
        capturedCallback?.({ time, seriesData: new Map() });
      },
    );
    render(
      <TickerNetFlowChart
        series={[]}
        candles={[]}
        syncHoverTime={1715179920}
        onHoverTime={onHoverTime}
        ariaLabel="t"
      />,
    );
    expect(mockSetCrosshairPosition).toHaveBeenCalled();
    expect(onHoverTime).not.toHaveBeenCalled();
  });
});
