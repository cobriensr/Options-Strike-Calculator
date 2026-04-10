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

const chartOptions: DeepPartial<ChartOptions> = {
  layout: {
    background: { color: 'transparent' },
    textColor: 'var(--color-secondary)',
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
      height: containerRef.current.clientHeight || 300,
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

  // ── Responsive resize ────────────────────────────────────────────────

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    if (!containerRef.current || !chartRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      chartRef.current?.applyOptions({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
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
  }, [candles]);

  // ── Overlay lines (GEX levels + previous close) ──────────────────────

  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // Remove previous lines
    for (const line of priceLineRefs.current) {
      candleSeriesRef.current.removePriceLine(line);
    }
    priceLineRefs.current = [];

    if (!score && previousClose === null) return;

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

    // Previous close line
    if (previousClose !== null) {
      const line = candleSeriesRef.current!.createPriceLine({
        price: previousClose,
        color: 'rgba(255,255,255,0.35)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Prev Close',
      });
      lines.push(line);
    }

    priceLineRefs.current = lines;
  }, [score, previousClose]);

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <SectionBox label="PRICE ACTION">
      <div
        ref={containerRef}
        className="h-full min-h-[300px] w-full"
        aria-label="SPX price chart"
        role="img"
      />
    </SectionBox>
  );
});

export default PriceChart;
