/**
 * PriceChart — Panel 4 of the GexTarget widget.
 *
 * Renders an imperative lightweight-charts candlestick chart with:
 *  - 1-minute SPX candles for the active session
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
  },
  localization: {
    timeFormatter: (utcSeconds: number) =>
      ctTimeFormatter.format(new Date(utcSeconds * 1000)),
  },
  crosshair: { mode: CrosshairMode.Normal },
  handleScroll: { mouseWheel: true, pressedMouseMove: true },
  handleScale: { mouseWheel: true, pinch: true },
};

const GEX_COLORS = ['#00e676', '#69f0ae', '#b9f6ca'] as const;
const GEX_WIDTHS = [2, 1, 1] as const;

// ── Component ─────────────────────────────────────────────────────────────

export const PriceChart = memo(function PriceChart({
  candles,
  previousClose,
  score,
  openingCallStrike,
  openingPutStrike,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const priceLineRefs = useRef<IPriceLine[]>([]);

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

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      vwapSeriesRef.current = null;
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

    const data = candles.map((c) => ({
      time: Math.floor(c.datetime / 1000) as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    candleSeriesRef.current.setData(data);

    if (vwapSeriesRef.current) {
      vwapSeriesRef.current.setData(computeVWAP(candles));
    }

    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // ── Overlay lines (GEX levels + opening walls + previous close) ────────

  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // Remove previous lines
    for (const line of priceLineRefs.current) {
      candleSeriesRef.current.removePriceLine(line);
    }
    priceLineRefs.current = [];

    if (!score && previousClose === null && openingCallStrike === null && openingPutStrike === null) return;

    const lines: IPriceLine[] = [];

    // GEX levels: top 3 by abs(gexDollars) from leaderboard
    if (score) {
      const top3 = [...score.leaderboard]
        .sort(
          (a, b) =>
            Math.abs(b.features.gexDollars) - Math.abs(a.features.gexDollars),
        )
        .slice(0, 3);

      top3.forEach((s, i) => {
        const line = candleSeriesRef.current!.createPriceLine({
          price: s.strike,
          color: GEX_COLORS[i] ?? GEX_COLORS[2],
          lineWidth: GEX_WIDTHS[i] ?? 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `#${i + 1} GEX ${s.strike}`,
        });
        lines.push(line);
      });
    }

    // Opening call wall (highest call-volume strike at open) — cyan dashed
    if (openingCallStrike !== null) {
      lines.push(
        candleSeriesRef.current!.createPriceLine({
          price: openingCallStrike,
          color: '#00bcd4',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `HC Vol ${openingCallStrike}`,
        }),
      );
    }

    // Opening put wall (highest put-volume strike at open) — orange dashed
    if (openingPutStrike !== null) {
      lines.push(
        candleSeriesRef.current!.createPriceLine({
          price: openingPutStrike,
          color: '#ff9800',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `HP Vol ${openingPutStrike}`,
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
