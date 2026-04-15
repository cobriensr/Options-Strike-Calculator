/**
 * PriceChart — Panel 4 of the GexTarget widget.
 *
 * Renders an imperative lightweight-charts candlestick chart with:
 *  - 5-minute SPX candles for the active session (resampled from 1-minute data)
 *  - VWAP line (amber, dashed)
 *  - Top-3 GEX strike levels from the active TargetScore
 *  - Previous-close reference line
 *
 * The chart is created once on mount and updated imperatively; it is never
 * re-created on re-renders. Overlay lines are removed and re-added whenever
 * `score` or `previousClose` change.
 */

import { memo, useRef, useEffect } from 'react';
import {
  createChart,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  LineSeries,
} from 'lightweight-charts';
import type {
  IChartApi,
  ISeriesApi,
  IPriceLine,
  UTCTimestamp,
  DeepPartial,
  ChartOptions,
  SeriesType,
} from 'lightweight-charts';
import { SectionBox } from '../ui';
import { theme } from '../../themes';
import type { SPXCandle } from '../../hooks/useGexTarget';
import type { NopePoint } from '../../hooks/useNopeIntraday';
import type { TargetScore } from '../../utils/gex-target';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PriceChartProps {
  candles: SPXCandle[];
  previousClose: number | null;
  /** The currently-active mode's TargetScore — overlay lines update when this changes. */
  score: TargetScore | null;
  /**
   * Strike with the highest call-volume dominance in the opening snapshot.
   * Drawn as a fixed cyan line for the full session.
   */
  openingCallStrike: number | null;
  /**
   * Strike with the highest put-volume dominance in the opening snapshot.
   * Drawn as a fixed orange line for the full session.
   */
  openingPutStrike: number | null;
  /**
   * Per-minute SPY NOPE points. When non-empty, render in a sub-pane below
   * the candles (own y-axis, ~±0.001 range) with a zero reference line so
   * sign and trajectory are immediately readable. Empty array hides the pane.
   */
  nopePoints?: NopePoint[];
}

// ── 5-minute resampler ────────────────────────────────────────────────────

function resampleTo5Min(candles: SPXCandle[]): SPXCandle[] {
  if (candles.length === 0) return [];
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const buckets = new Map<number, SPXCandle[]>();
  for (const c of candles) {
    const key = c.datetime - (c.datetime % FIVE_MIN_MS);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(c);
    } else {
      buckets.set(key, [c]);
    }
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([key, group]) => ({
      datetime: key,
      open: group.at(0)!.open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group.at(-1)!.close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    }));
}

// ── VWAP helper ───────────────────────────────────────────────────────────

function computeVWAP(
  candles: SPXCandle[],
): { time: UTCTimestamp; value: number }[] {
  let cumPV = 0;
  let cumVol = 0;
  return candles
    .filter((c) => c.volume > 0)
    .map((c) => {
      const tp = (c.high + c.low + c.close) / 3;
      cumPV += tp * c.volume;
      cumVol += c.volume;
      return {
        time: Math.floor(c.datetime / 1000) as UTCTimestamp,
        value: cumPV / cumVol,
      };
    });
}

// ── Chart options ─────────────────────────────────────────────────────────

const ctTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const chartOptions: DeepPartial<ChartOptions> = {
  layout: {
    background: { color: 'transparent' },
    textColor: 'rgba(255,255,255,0.65)',
  },
  grid: {
    vertLines: { color: 'rgba(255,255,255,0.05)' },
    horzLines: { color: 'rgba(255,255,255,0.05)' },
  },
  rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
  timeScale: {
    borderColor: 'rgba(255,255,255,0.1)',
    timeVisible: true,
    secondsVisible: false,
    // tickMarkFormatter controls axis labels (localization.timeFormatter is crosshair only)
    tickMarkFormatter: (utcSeconds: number) =>
      ctTimeFormatter.format(new Date(utcSeconds * 1000)),
  },
  localization: {
    timeFormatter: (utcSeconds: number) =>
      ctTimeFormatter.format(new Date(utcSeconds * 1000)),
  },
  crosshair: { mode: CrosshairMode.Normal },
  handleScroll: { mouseWheel: true, pressedMouseMove: true },
  handleScale: { mouseWheel: true, pinch: true },
};

const GEX_COLORS = [
  '#00e676',
  '#69f0ae',
  '#b9f6ca',
  '#ccffdf',
  '#e8fff0',
] as const;
const GEX_WIDTHS = [2, 1, 1, 1, 1] as const;

// ── Component ─────────────────────────────────────────────────────────────

export const PriceChart = memo(function PriceChart({
  candles,
  previousClose,
  score,
  openingCallStrike,
  openingPutStrike,
  nopePoints = [],
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const nopeSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const nopeZeroLineRef = useRef<IPriceLine | null>(null);
  const priceLineRefs = useRef<IPriceLine[]>([]);
  // Track whether the chart has received its first data load so fitContent()
  // is only called once. Subsequent candle updates (e.g. scrubbing) must not
  // reset a zoom the user has set manually.
  const initialFitDoneRef = useRef(false);

  // ── Create chart once on mount, destroy on unmount ───────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      ...chartOptions,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 320,
    });
    chartRef.current = chart;

    // Candlestick series (v5 API: addSeries with constructor)
    const cs = chart.addSeries(CandlestickSeries, {
      upColor: '#00e676',
      downColor: '#ff5252',
      borderUpColor: '#00e676',
      borderDownColor: '#ff5252',
      wickUpColor: '#00e676',
      wickDownColor: '#ff5252',
    });
    candleSeriesRef.current = cs;

    // VWAP line series
    const vs = chart.addSeries(LineSeries, {
      color: theme.chartAmber,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
    });
    vwapSeriesRef.current = vs;

    // NOPE series in a separate pane (index 1) below the candles. The
    // pane gets its own y-axis so the ~±0.001 NOPE magnitude doesn't
    // conflict with SPX prices in the ~5000 range. Pane is created
    // implicitly by passing { pane: 1 } to addSeries — lightweight-charts
    // v5 reuses any existing pane with that index.
    const ns = chart.addSeries(
      LineSeries,
      {
        color: '#00bcd4',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 6, minMove: 0.000001 },
      },
      1, // pane index — second pane below the main candle pane
    );
    nopeSeriesRef.current = ns;
    // Zero reference line on the NOPE pane — sign flips happen at zero,
    // so making the divider visible is the entire point of the overlay.
    nopeZeroLineRef.current = ns.createPriceLine({
      price: 0,
      color: 'rgba(255,255,255,0.4)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: '',
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      vwapSeriesRef.current = null;
      nopeSeriesRef.current = null;
      nopeZeroLineRef.current = null;
      priceLineRefs.current = [];
    };
  }, []); // create once

  // ── Responsive resize (width only — height is fixed by CSS) ─────────

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    if (!containerRef.current || !chartRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Width only — updating height here causes a feedback loop where the
      // chart canvas grows the container, which fires the observer again.
      // Height is CSS-controlled via h-full; overflow-hidden clips the canvas.
      chartRef.current?.applyOptions({ width: entry.contentRect.width });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // ── Update candle + VWAP data ────────────────────────────────────────

  useEffect(() => {
    if (!candleSeriesRef.current || candles.length === 0) return;

    const resampled = resampleTo5Min(candles);
    const data = resampled.map((c) => ({
      time: Math.floor(c.datetime / 1000) as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    candleSeriesRef.current.setData(data);

    if (vwapSeriesRef.current) {
      vwapSeriesRef.current.setData(computeVWAP(resampled));
    }

    if (!initialFitDoneRef.current) {
      chartRef.current?.timeScale().fitContent();
      initialFitDoneRef.current = true;
    }
  }, [candles]);

  // ── Update NOPE series ───────────────────────────────────────────────
  // When nopePoints is empty we clear the series rather than leaving stale
  // data showing — important because the parent may pass [] to indicate
  // "no NOPE data for this date" without unmounting the chart.

  useEffect(() => {
    if (!nopeSeriesRef.current) return;
    const data = nopePoints.map((p) => ({
      time: Math.floor(new Date(p.timestamp).getTime() / 1000) as UTCTimestamp,
      value: p.nope,
    }));
    nopeSeriesRef.current.setData(data);
  }, [nopePoints]);

  // ── Overlay lines (GEX levels + opening walls + previous close) ────────

  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // Remove previous lines
    for (const line of priceLineRefs.current) {
      candleSeriesRef.current.removePriceLine(line);
    }
    priceLineRefs.current = [];

    if (
      !score &&
      previousClose === null &&
      openingCallStrike === null &&
      openingPutStrike === null
    )
      return;

    const lines: IPriceLine[] = [];

    // GEX levels: top 5 in leaderboard order (same set as urgency/sparklines panels)
    if (score) {
      score.leaderboard.slice(0, 5).forEach((s, i) => {
        const line = candleSeriesRef.current!.createPriceLine({
          price: s.strike,
          color: GEX_COLORS[i] ?? GEX_COLORS[4],
          lineWidth: GEX_WIDTHS[i] ?? 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `#${i + 1} GEX ${s.strike}`,
        });
        lines.push(line);
      });
    }

    // Call wall (highest dealer call-gamma-OI strike at open) — cyan dashed
    if (openingCallStrike !== null) {
      lines.push(
        candleSeriesRef.current!.createPriceLine({
          price: openingCallStrike,
          color: '#00bcd4',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `Call Wall ${openingCallStrike}`,
        }),
      );
    }

    // Put wall (highest dealer put-gamma-OI strike at open) — orange dashed
    if (openingPutStrike !== null) {
      lines.push(
        candleSeriesRef.current!.createPriceLine({
          price: openingPutStrike,
          color: '#ff9800',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `Put Wall ${openingPutStrike}`,
        }),
      );
    }

    // Previous close line
    if (previousClose !== null) {
      lines.push(
        candleSeriesRef.current!.createPriceLine({
          price: previousClose,
          color: 'rgba(255,255,255,0.35)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'Prev Close',
        }),
      );
    }

    priceLineRefs.current = lines;
  }, [score, previousClose, openingCallStrike, openingPutStrike]);

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <SectionBox label="PRICE ACTION">
      <div
        ref={containerRef}
        className="h-full min-h-[280px] w-full overflow-hidden"
        aria-label="SPX price chart"
        role="img"
      />
    </SectionBox>
  );
});

export default PriceChart;
