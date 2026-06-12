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

// Spy on Sentry so the malformed-tick diagnostic breadcrumb can be asserted.
const { mockCaptureMessage } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
}));

vi.mock('@sentry/react', () => ({
  captureMessage: mockCaptureMessage,
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

// ── Shared assertion helper ───────────────────────────────────────────
// Flow-series setData payloads (≥2 items) captured by the shared series
// mock — used by the scaffold and malformed-timestamp suites.
type Item = { time: number; value?: number };
const flowArrays = (): Item[][] =>
  mockSetData.mock.calls
    .map((c) => c[0] as Item[])
    .filter((arr) => Array.isArray(arr) && arr.length >= 2);

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

  it('falls back to fitContent (never setVisibleRange) when there is no flow grid — guards the "Value is null" crash', () => {
    // Regression: a ticker with <2 net-flow ticks → flowData is null → no
    // uniform full-session grid spans 08:30→close. With candles present the
    // old code still called setVisibleRange(open→close), which lightweight-
    // charts rejects with "Value is null" (no series reaches the bounds),
    // and the ErrorBoundary blanked the entire Lottery/SilentBoom panel.
    // Now we fitContent to whatever data exists instead.
    render(
      <TickerNetFlowChart
        series={[makeTick({ ts: '2026-05-08T14:30:00Z', cumNcp: 100 })]}
        candles={[makeCandle({ ts: '2026-05-08T14:30:00Z', close: 145 })]}
        date="2026-05-08"
        ariaLabel="sparse"
      />,
    );
    expect(mockChart.timeScale().setVisibleRange).not.toHaveBeenCalled();
    expect(mockChart.timeScale().fitContent).toHaveBeenCalled();
  });

  it('does not scaffold flow data when date is absent (back-compat)', () => {
    render(<TickerNetFlowChart series={ticks} candles={[]} ariaLabel="t" />);
    const arrays = flowArrays();
    // No array starts at the session-open whitespace point; flow arrays
    // start at the first real tick, unchanged from pre-fix behavior.
    expect(arrays.every((arr) => arr[0]!.time !== openSec)).toBe(true);
    expect(arrays.some((arr) => arr[0]!.time === firstTickSec)).toBe(true);
  });

  it('lays a uniform 1-point-per-minute grid (sub-minute ticks collapse, gaps fill)', () => {
    // Sub-minute ticks (the live WS feed is per-tick) plus an interior
    // 2-minute gap. The grid must collapse the two 14:30:xx ticks into one
    // 14:30 slot (last value wins) and fill 14:31/14:32 with whitespace —
    // so EVERY consecutive gap is exactly 60s. That uniform spacing is what
    // makes the time→logical-index map a pure function of wall-clock time,
    // which is what perfectly pins the fire marker.
    const m1430 = Math.floor(Date.parse('2026-05-08T14:30:00Z') / 1000);
    const m1431 = Math.floor(Date.parse('2026-05-08T14:31:00Z') / 1000);
    const subMinuteTicks = [
      makeTick({ ts: '2026-05-08T14:30:05Z', cumNcp: 10 }),
      makeTick({ ts: '2026-05-08T14:30:55Z', cumNcp: 30 }), // same minute, later
      makeTick({ ts: '2026-05-08T14:33:10Z', cumNcp: 40 }), // 14:31/14:32 empty
    ];
    render(
      <TickerNetFlowChart
        series={subMinuteTicks}
        candles={[]}
        date="2026-05-08"
        ariaLabel="t"
      />,
    );
    const grid = flowArrays().find(
      (arr) => arr[0]!.time === openSec && arr.at(-1)!.time === closeSec,
    );
    expect(grid).toBeDefined();
    // Every consecutive gap is exactly one minute — no sub-minute doubling,
    // no compressed interior gap.
    for (let i = 1; i < grid!.length; i++) {
      expect(grid![i]!.time - grid![i - 1]!.time).toBe(60);
    }
    // The 14:30 slot carries the LAST in-minute cumulative value (30, not 10).
    expect(grid!.find((p) => p.time === m1430)?.value).toBe(30);
    // The empty 14:31 minute is whitespace (no value → line breaks there).
    const slot1431 = grid!.find((p) => p.time === m1431);
    expect(slot1431).toBeDefined();
    expect(slot1431!.value).toBeUndefined();
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

  it('survives a setCrosshairPosition throw without crashing the panel', () => {
    // lightweight-charts throws "Value is null" from setCrosshairPosition when
    // the synced time can't be mapped to a logical coordinate (no net-flow
    // ticks AND candles not yet loaded — an empty/degenerate series). The
    // cross-pane crosshair sync is cosmetic, so the throw must be caught, not
    // bubble to the ErrorBoundary. Regression for the 2026-06-05 expand crash.
    mockSetCrosshairPosition.mockImplementationOnce(() => {
      throw new Error('Value is null');
    });
    const t = Math.floor(Date.parse('2026-05-08T14:32:00Z') / 1000);
    expect(() =>
      render(
        <TickerNetFlowChart
          series={[]}
          candles={[]}
          syncHoverTime={t}
          ariaLabel="t"
        />,
      ),
    ).not.toThrow();
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

// ============================================================
// MALFORMED-TIMESTAMP RESILIENCE
// ============================================================
// Regression for the production blank-chart bug: ONE tick whose `ts`
// failed Date.parse poisoned the minute grid (NaN map key → NaN grid
// bounds → empty grid) and the data effect setData([])'d every flow
// series — silently wiping a previously-full chart on every poll. The
// resulting empty time scale then made the session pin throw, leaving
// the axis in the default ~1h tail view.

describe('TickerNetFlowChart: malformed-timestamp resilience', () => {
  // 2026-05-08 is CDT (UTC-5): 08:30 CT = 13:30Z, 15:00 CT = 20:00Z.
  const openSec = Math.floor(Date.parse('2026-05-08T13:30:00Z') / 1000);
  const closeSec = Math.floor(Date.parse('2026-05-08T20:00:00Z') / 1000);
  const m1431 = Math.floor(Date.parse('2026-05-08T14:31:00Z') / 1000);

  it('drops a poisoned tick instead of wiping the chart (setData stays non-empty)', () => {
    const ticks = [
      makeTick({ ts: '2026-05-08T14:30:00Z', cumNcp: 100 }),
      makeTick({ ts: 'not-a-date', cumNcp: 999 }),
      makeTick({ ts: '2026-05-08T14:31:00Z', cumNcp: 200 }),
    ];
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        date="2026-05-08"
        ariaLabel="t"
      />,
    );
    // The full-session grid still reaches setData — NOT an empty wipe.
    const grid = flowArrays().find(
      (arr) => arr[0]!.time === openSec && arr.at(-1)!.time === closeSec,
    );
    expect(grid).toBeDefined();
    // The valid ticks survive; the poisoned tick's value never appears.
    expect(grid!.find((p) => p.time === m1431)?.value).toBe(200);
    expect(grid!.some((p) => p.value === 999)).toBe(false);
    // No NaN time ever reaches the chart in any setData call.
    for (const call of mockSetData.mock.calls) {
      for (const p of call[0] as Item[]) {
        expect(Number.isFinite(p.time)).toBe(true);
      }
    }
    // The session pin still holds (grid spans the bounds).
    expect(mockChart.timeScale().setVisibleRange).toHaveBeenCalledWith({
      from: openSec,
      to: closeSec,
    });
  });

  it('reports dropped ticks to Sentry once per mount (not per poll)', () => {
    const ticks = [
      makeTick({ ts: '2026-05-08T14:30:00Z', cumNcp: 100 }),
      makeTick({ ts: 'not-a-date', cumNcp: 999 }),
      makeTick({ ts: '2026-05-08T14:31:00Z', cumNcp: 200 }),
    ];
    const { rerender } = render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        date="2026-05-08"
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    const droppedCalls = () =>
      mockCaptureMessage.mock.calls.filter(
        (c) => c[0] === 'TickerNetFlowChart.droppedMalformedTicks',
      );
    expect(droppedCalls().length).toBe(1);
    expect(droppedCalls()[0]![1]).toMatchObject({
      level: 'warning',
      extra: { symbol: 'SPY', dropped: 1, sampleTs: 'not-a-date' },
    });
    // A new poll delivers a fresh array (same poisoned tick) — the ref
    // guard must keep this at ONE message for the mount.
    rerender(
      <TickerNetFlowChart
        series={[...ticks]}
        candles={[]}
        date="2026-05-08"
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    expect(droppedCalls().length).toBe(1);
  });

  it('surfaces a clamp-class sample (finite-but-ancient ts) in the Sentry message', () => {
    // V8 parses digit-bearing garbage to a FINITE far-away date (e.g.
    // 'garbage-1' → Jan 2001). Those ticks are range-clamped, not
    // NaN-dropped — the sample must still surface the raw string, since
    // that string IS the diagnosis.
    const ticks = [
      makeTick({ ts: '2026-05-08T14:30:00Z', cumNcp: 100 }),
      makeTick({ ts: '2001-01-01T12:00:00Z', cumNcp: 999 }),
      makeTick({ ts: '2026-05-08T14:31:00Z', cumNcp: 200 }),
    ];
    render(
      <TickerNetFlowChart
        series={ticks}
        candles={[]}
        date="2026-05-08"
        symbol="SPY"
        ariaLabel="t"
      />,
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'TickerNetFlowChart.droppedMalformedTicks',
      expect.objectContaining({
        extra: expect.objectContaining({
          dropped: 1,
          sampleTs: '2001-01-01T12:00:00Z',
        }),
      }),
    );
  });

  it('does not crash when ALL ts are malformed; falls back to fitContent', () => {
    const ticks = [
      makeTick({ ts: 'garbage', cumNcp: 100 }),
      makeTick({ ts: 'not-a-date', cumNcp: 200 }),
    ];
    expect(() =>
      render(
        <TickerNetFlowChart
          series={ticks}
          candles={[]}
          date="2026-05-08"
          ariaLabel="t"
        />,
      ),
    ).not.toThrow();
    // An empty grid can't span the session bounds — the pin must not be
    // attempted (it would throw "Value is null" inside the library).
    expect(mockChart.timeScale().setVisibleRange).not.toHaveBeenCalled();
    expect(mockChart.timeScale().fitContent).toHaveBeenCalled();
  });

  it('falls back to fitContent when the session pin throws (no 1h-tail view)', () => {
    const ticks = [
      makeTick({ ts: '2026-05-08T14:30:00Z', cumNcp: 100 }),
      makeTick({ ts: '2026-05-08T14:31:00Z', cumNcp: 200 }),
    ];
    mockChart.timeScale().setVisibleRange.mockImplementationOnce(() => {
      throw new Error('Value is null');
    });
    expect(() =>
      render(
        <TickerNetFlowChart
          series={ticks}
          candles={[]}
          date="2026-05-08"
          ariaLabel="t"
        />,
      ),
    ).not.toThrow();
    // The failed pin degrades to "all data visible", not the library's
    // default right-aligned tail view.
    expect(mockChart.timeScale().fitContent).toHaveBeenCalled();
    // The existing skip breadcrumb is preserved.
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'TickerNetFlowChart.setVisibleRange skipped',
      expect.objectContaining({ level: 'warning' }),
    );
  });
});
