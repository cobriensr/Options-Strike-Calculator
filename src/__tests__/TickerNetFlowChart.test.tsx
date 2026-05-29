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
import { TickerNetFlowChart } from '../components/charts/TickerNetFlowChart';
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
    setVisibleRange: vi.fn(),
    timeToCoordinate,
    subscribeVisibleTimeRangeChange: vi.fn(),
    unsubscribeVisibleTimeRangeChange: vi.fn(),
    subscribeSizeChange: vi.fn(),
    unsubscribeSizeChange: vi.fn(),
  };

  const subscribeCrosshairMove = vi.fn();
  const setCrosshairPosition = vi.fn();
  const clearCrosshairPosition = vi.fn();
  // Two-pane geometry: price pane (index 0) reports 150px tall so the
  // "Net Volume" label can be positioned at its bottom edge.
  const pane0 = {
    setStretchFactor: vi.fn(),
    getStretchFactor: vi.fn().mockReturnValue(3),
    getHeight: vi.fn().mockReturnValue(150),
    paneIndex: vi.fn().mockReturnValue(0),
  };
  const pane1 = {
    setStretchFactor: vi.fn(),
    getStretchFactor: vi.fn().mockReturnValue(1),
    getHeight: vi.fn().mockReturnValue(50),
    paneIndex: vi.fn().mockReturnValue(1),
  };
  const chart = {
    addSeries: vi.fn().mockImplementation(() => series),
    applyOptions: vi.fn(),
    remove: vi.fn(),
    timeScale: vi.fn().mockReturnValue(timeScale),
    panes: vi.fn().mockReturnValue([pane0, pane1]),
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
// SESSION-SPAN WHITESPACE SCAFFOLD
// ============================================================
// When `date` is provided, the flow series must be bracketed with
// minute-cadence whitespace points spanning 08:30–15:00 CT so
// lightweight-charts' (index-based) time scale spans the full session.
// Without this, setVisibleRange() clamps to the data extent — it cannot
// extrapolate time — so a ticker the daemon only indexed for the last
// few minutes collapses the axis to a sliding window and the fixed-time
// fire marker appears to drift between polls.

describe('TickerNetFlowChart: session-span whitespace scaffold', () => {
  const ticks = [
    makeTick({ ts: '2026-05-08T14:30:00Z', cumNcp: 100 }),
    makeTick({ ts: '2026-05-08T14:31:00Z', cumNcp: 200 }),
  ];
  // 2026-05-08 is CDT (UTC-5): 08:30 CT = 13:30Z, 15:00 CT = 20:00Z.
  const openSec = Math.floor(Date.parse('2026-05-08T13:30:00Z') / 1000);
  const closeSec = Math.floor(Date.parse('2026-05-08T20:00:00Z') / 1000);
  const firstTickSec = Math.floor(Date.parse('2026-05-08T14:30:00Z') / 1000);

  type Item = { time: number; value?: number };
  const flowArrays = (): Item[][] =>
    mockSetData.mock.calls
      .map((c) => c[0] as Item[])
      .filter((arr) => Array.isArray(arr) && arr.length >= 2);

  it('brackets flow data with session-bound whitespace when date is provided', () => {
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        date="2026-05-08"
        ariaLabel="t"
      />,
    );
    const arrays = flowArrays();
    const scaffolded = arrays.find(
      (arr) => arr[0]!.time === openSec && arr.at(-1)!.time === closeSec,
    );
    expect(scaffolded).toBeDefined();
    // Endpoints are whitespace (no value); the real ticks survive inside.
    expect(scaffolded![0]!.value).toBeUndefined();
    expect(scaffolded!.at(-1)!.value).toBeUndefined();
    expect(
      scaffolded!.some((p) => p.value === 100 && p.time === firstTickSec),
    ).toBe(true);
    // Minute-cadence fill — no gap between consecutive points exceeds 60s,
    // so the axis is time-proportional rather than collapsing the empty
    // region into a single bar-width.
    const maxGap = scaffolded!.reduce(
      (m, p, i) =>
        i === 0 ? m : Math.max(m, p.time - scaffolded![i - 1]!.time),
      0,
    );
    expect(maxGap).toBeLessThanOrEqual(60);
    // The scaffold exists so this pin actually holds (vs. clamping to the
    // data extent) — assert it fires with the full-session bounds.
    expect(mockChart.timeScale().setVisibleRange).toHaveBeenCalledWith({
      from: openSec,
      to: closeSec,
    });
  });

  it('does not scaffold flow data when date is absent (back-compat)', () => {
    render(<TickerNetFlowChart series={ticks} candles={[]} ariaLabel="t" />);
    const arrays = flowArrays();
    // No array starts at the session-open whitespace point; flow arrays
    // start at the first real tick, unchanged from pre-fix behavior.
    expect(arrays.every((arr) => arr[0]!.time !== openSec)).toBe(true);
    expect(arrays.some((arr) => arr[0]!.time === firstTickSec)).toBe(true);
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

// ============================================================
// UW-STYLE HEADER + PANE TITLES
// ============================================================

describe('TickerNetFlowChart: UW-style inline header', () => {
  const ticks = [
    makeTick({
      ts: '2026-05-29T14:30:00Z',
      cumNcp: -76_100_000,
      cumNpp: 656_000,
      cumNcv: -10_000,
      cumNpv: 45_440,
    }),
    makeTick({
      ts: '2026-05-29T16:37:00Z',
      cumNcp: -76_100_000,
      cumNpp: 656_000,
      cumNcv: -10_000,
      cumNpv: 45_440,
    }),
  ];

  it('renders the symbol and latest spot when symbol + candles are provided', () => {
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[makeCandle({ ts: '2026-05-29T16:37:00Z', close: 757.44 })]}
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    expect(screen.getByText('SPY')).toBeInTheDocument();
    expect(screen.getByText('757.44')).toBeInTheDocument();
  });

  it('renders premium ($) and contract-volume metrics in the header', () => {
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[makeCandle({ ts: '2026-05-29T16:37:00Z', close: 757.44 })]}
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    // Premium $ (compact): NCP = −76.1M, NPP = 656K,
    // Δ$ = −76.1M − 656K = −76,756,000 → −76.8M. Negatives use the
    // U+2212 minus glyph (matching the crosshair tooltip), not ASCII '-'.
    expect(screen.getByText('−76.1M')).toBeInTheDocument();
    expect(screen.getByText('656K')).toBeInTheDocument();
    expect(screen.getByText('−76.8M')).toBeInTheDocument();
    // Contract volume (comma int): NCV = −10,000, NPV = 45,440,
    // Δv = NCV − NPV = −55,440.
    expect(screen.getByText('−10,000')).toBeInTheDocument();
    expect(screen.getByText('45,440')).toBeInTheDocument();
    expect(screen.getByText('−55,440')).toBeInTheDocument();
  });

  it('shows the NCV / NPV / Δv volume labels alongside premiums', () => {
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[makeCandle({ ts: '2026-05-29T16:37:00Z', close: 757.44 })]}
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    expect(screen.getByText('NCV')).toBeInTheDocument();
    expect(screen.getByText('NPV')).toBeInTheDocument();
    expect(screen.getByText('Δv')).toBeInTheDocument();
    expect(screen.getByText('Δ$')).toBeInTheDocument();
  });

  it('renders the Net Premiums and Net Volume pane titles when populated', () => {
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    expect(screen.getByText('Net Premiums')).toBeInTheDocument();
    expect(screen.getByText('Net Volume')).toBeInTheDocument();
  });

  it('sets pane stretch factors 3:1 (premiums:volume) on the two panes', () => {
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    const [pane0, pane1] = mockChart.panes();
    expect(pane0.setStretchFactor).toHaveBeenCalledWith(3);
    expect(pane1.setStretchFactor).toHaveBeenCalledWith(1);
  });

  it('omits the inline metric header when no symbol is provided (back-compat)', () => {
    render(<TickerNetFlowChart series={ticks} candles={[]} ariaLabel="t" />);
    // The freshness label / metric chips key off `symbol`; without it the
    // header row is absent. `−76.1M` (cumNcp) only appears in that header,
    // so its absence proves the header didn't render.
    expect(screen.queryByText('−76.1M')).not.toBeInTheDocument();
  });

  it('omits the header when symbol is an empty string', () => {
    // `'' != null` is true, so a naive guard would render an orphan dot.
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        symbol=""
        ariaLabel="t"
      />,
    );
    expect(screen.queryByText('−76.1M')).not.toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('still renders the ticker symbol when candles are absent (spot lagging)', () => {
    // Candles and net-flow come from separate fetches. When flow has data
    // but candles have not arrived, the symbol must still identify the
    // chart even though the spot price is not yet available.
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    expect(screen.getByText('SPY')).toBeInTheDocument();
    // Premium/volume metrics still render…
    expect(screen.getByText('−76.1M')).toBeInTheDocument();
    // …but no spot price (no candle close to show).
    expect(screen.queryByText('757.44')).not.toBeInTheDocument();
  });

  it('exposes the header as a labelled group for assistive tech', () => {
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    expect(
      screen.getByRole('group', { name: /net-flow summary for SPY/i }),
    ).toBeInTheDocument();
  });

  it('does not render the header in the waiting state', () => {
    render(
      <TickerNetFlowChart
        series={[]}
        candles={[]}
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    expect(screen.queryByText('SPY')).not.toBeInTheDocument();
    expect(screen.queryByText('Net Premiums')).not.toBeInTheDocument();
  });
});
