/**
 * TickerNetFlowChart — UW-style two-pane chart for one ticker's
 * intraday net flow. Top pane overlays the underlying stock price
 * (yellow, left axis) on cumulative NCP / NPP (green / red, right
 * axis). Bottom pane renders a single signed area for cumulative
 * net volume (cumNcv − cumNpv) — green above zero, red below.
 *
 * Built on lightweight-charts v5 to match the existing GexTarget
 * PriceChart pattern in this codebase. Imperative chart, created
 * once, updated by data effects. Time axis is shared across panes
 * so the crosshair stays in lockstep between the price/flow pane
 * and the volume pane.
 *
 * Why three series in the top pane: the user trades 0DTE options
 * but the entry signal is the underlying's drift relative to the
 * net call vs put flow regime. Reading "price climbing while NCP
 * climbs" is a different setup than "price climbing while NPP
 * also climbs" — the cumulative flow lines disambiguate.
 *
 * Fire-time marker: lightweight-charts has no native vertical
 * line, so we paint a thin overlay div positioned via the
 * timeScale's `timeToCoordinate` helper. Re-pinned on every chart
 * resize and data update.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CrosshairMode,
  LineSeries,
  BaselineSeries,
  LineStyle,
} from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { NetFlowTick, TickerCandle } from './types.js';

/** Local time-pinned alias — narrower than the library's Time union. */
type Point = { time: UTCTimestamp; value: number };

interface TickerNetFlowChartProps {
  /** Per-tick rows with cumNcp / cumNpp / cumNcv / cumNpv populated. */
  series: NetFlowTick[];
  /** Per-minute underlying candles. May be empty while loading. */
  candles: TickerCandle[];
  /** Previous trading session's close — drawn as a dashed reference line on the price axis. */
  previousClose?: number | null;
  /** Optional fire-time marker (UTC ISO). Renders a vertical purple line. */
  markerTs?: string;
  /** Total chart height in pixels. Default 220. */
  height?: number;
  ariaLabel: string;
}

const isoToUtcSec = (iso: string): UTCTimestamp =>
  Math.floor(Date.parse(iso) / 1000) as UTCTimestamp;

/**
 * lightweight-charts shows duplicate-time points as outright errors
 * and silently drops monotonically-out-of-order points. Our net-flow
 * series can occasionally have two ticks at the same second (rare,
 * but possible when the daemon timestamps coincide); collapse them
 * by keeping the last value for each second.
 */
function dedupAscending<T extends { time: UTCTimestamp; value: number }>(
  rows: T[],
): T[] {
  if (rows.length === 0) return rows;
  const out: T[] = [];
  let lastSec: UTCTimestamp | null = null;
  for (const r of rows) {
    if (lastSec != null && r.time === lastSec) {
      out[out.length - 1] = r;
      continue;
    }
    if (lastSec != null && r.time < lastSec) continue; // out-of-order; skip
    out.push(r);
    lastSec = r.time;
  }
  return out;
}

function TickerNetFlowChartInner({
  series,
  candles,
  previousClose,
  markerTs,
  height = 220,
  ariaLabel,
}: TickerNetFlowChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ncpSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const nppSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const netVolSeriesRef = useRef<ISeriesApi<'Baseline'> | null>(null);
  const prevCloseLineRef = useRef<ReturnType<
    NonNullable<typeof priceSeriesRef.current>['createPriceLine']
  > | null>(null);
  const initialFitDoneRef = useRef(false);

  /** Pixel x-coordinate of the fire-time marker, recomputed on every
   *  data update + resize. `null` when off-chart or unmeasurable. */
  const [markerX, setMarkerX] = useState<number | null>(null);

  // ── Build series data (memoized per props) ──────────────────────
  const flowData = useMemo(() => {
    if (series.length < 2) return null;
    const ncpRaw: Point[] = series.map((r) => ({
      time: isoToUtcSec(r.ts),
      value: r.cumNcp,
    }));
    const nppRaw: Point[] = series.map((r) => ({
      time: isoToUtcSec(r.ts),
      value: r.cumNpp,
    }));
    const netVolRaw: Point[] = series.map((r) => ({
      time: isoToUtcSec(r.ts),
      value: r.cumNcv - r.cumNpv,
    }));
    return {
      ncp: dedupAscending(ncpRaw),
      npp: dedupAscending(nppRaw),
      netVol: dedupAscending(netVolRaw),
    };
  }, [series]);

  const priceData = useMemo<Point[] | null>(() => {
    if (candles.length === 0) return null;
    const raw: Point[] = candles.map((c) => ({
      time: isoToUtcSec(c.ts),
      value: c.close,
    }));
    return dedupAscending(raw);
  }, [candles]);

  // ── Create chart once ──────────────────────────────────────────
  // Deps are intentionally empty — the container is always mounted
  // (see render-time JSX) so this fires on initial mount and stays
  // alive for the life of the row. Height changes apply via a
  // separate effect below.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { color: 'transparent' },
        textColor: '#a3a3a3',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(64,64,64,0.25)' },
        horzLines: { color: 'rgba(64,64,64,0.25)' },
      },
      crosshair: { mode: CrosshairMode.Magnet },
      rightPriceScale: { borderColor: '#262626' },
      leftPriceScale: { visible: true, borderColor: '#262626' },
      timeScale: {
        borderColor: '#262626',
        timeVisible: true,
        secondsVisible: false,
      },
      localization: {
        // Render time-axis labels + crosshair tooltip in CT to match
        // the rest of the lottery panel UI.
        timeFormatter: (t: UTCTimestamp) =>
          new Date((t as number) * 1000).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'America/Chicago',
          }),
      },
    });
    chartRef.current = chart;

    // Top pane (index 0): price (left axis) + NCP/NPP (right axis).
    priceSeriesRef.current = chart.addSeries(LineSeries, {
      color: '#fbbf24', // amber-400 — yellow, matches UW
      lineWidth: 2,
      priceScaleId: 'left',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ncpSeriesRef.current = chart.addSeries(LineSeries, {
      color: '#34d399', // emerald-400
      lineWidth: 1,
      priceScaleId: 'right',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    nppSeriesRef.current = chart.addSeries(LineSeries, {
      color: '#f87171', // red-400
      lineWidth: 1,
      priceScaleId: 'right',
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // Bottom pane (index 1): cumulative net volume signed area.
    netVolSeriesRef.current = chart.addSeries(
      BaselineSeries,
      {
        baseValue: { type: 'price', price: 0 },
        topLineColor: '#34d399',
        topFillColor1: 'rgba(52,211,153,0.45)',
        topFillColor2: 'rgba(52,211,153,0.05)',
        bottomLineColor: '#f87171',
        bottomFillColor1: 'rgba(248,113,113,0.05)',
        bottomFillColor2: 'rgba(248,113,113,0.45)',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1, // pane index — second pane below the main pane
    );
    // Zero reference on the volume pane.
    netVolSeriesRef.current.createPriceLine({
      price: 0,
      color: 'rgba(255,255,255,0.25)',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: '',
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      ncpSeriesRef.current = null;
      nppSeriesRef.current = null;
      netVolSeriesRef.current = null;
      prevCloseLineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply height changes without recreating the chart.
  useEffect(() => {
    chartRef.current?.applyOptions({ height });
  }, [height]);

  // ── Update data ────────────────────────────────────────────────
  useEffect(() => {
    if (!flowData || !ncpSeriesRef.current || !nppSeriesRef.current) return;
    ncpSeriesRef.current.setData(flowData.ncp);
    nppSeriesRef.current.setData(flowData.npp);
    if (netVolSeriesRef.current)
      netVolSeriesRef.current.setData(flowData.netVol);
    if (!initialFitDoneRef.current) {
      chartRef.current?.timeScale().fitContent();
      initialFitDoneRef.current = true;
    }
  }, [flowData]);

  useEffect(() => {
    if (!priceData || !priceSeriesRef.current) {
      // No candles yet (or cleared) — clear the series so a stale
      // line doesn't linger after a refetch.
      priceSeriesRef.current?.setData([]);
      return;
    }
    priceSeriesRef.current.setData(priceData);
  }, [priceData]);

  // Previous-close horizontal reference on the price axis. Cheap UW
  // parity touch — gives the user "is today's spot above or below
  // yesterday's close?" without arithmetic.
  useEffect(() => {
    const ps = priceSeriesRef.current;
    if (!ps) return;
    if (prevCloseLineRef.current) {
      ps.removePriceLine(prevCloseLineRef.current);
      prevCloseLineRef.current = null;
    }
    if (previousClose != null && Number.isFinite(previousClose)) {
      prevCloseLineRef.current = ps.createPriceLine({
        price: previousClose,
        color: 'rgba(251, 191, 36, 0.45)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'prev close',
      });
    }
  }, [previousClose]);

  // ── Marker x-coordinate, recomputed on data + visible-range +
  //     width changes ─────────────────────────────────────────────
  // Visible-range subscriptions cover scroll/zoom; size subscriptions
  // cover container width changes that don't shift the visible range.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || markerTs == null) {
      setMarkerX(null);
      return;
    }
    const ts = isoToUtcSec(markerTs);
    const recompute = () => {
      const x = chart.timeScale().timeToCoordinate(ts);
      setMarkerX(typeof x === 'number' ? x : null);
    };
    recompute();
    chart.timeScale().subscribeVisibleTimeRangeChange(recompute);
    chart.timeScale().subscribeSizeChange(recompute);
    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(recompute);
      chart.timeScale().unsubscribeSizeChange(recompute);
    };
  }, [markerTs, flowData, priceData]);

  // ── Width-only responsive resize ───────────────────────────────
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    if (!containerRef.current || !chartRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      chartRef.current?.applyOptions({ width: entry.contentRect.width });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // The container is always mounted so the create-effect can attach
  // on first render. Until both series have ≥2 ticks, we paint a
  // small "waiting" label as an overlay.
  const showPlaceholder = series.length < 2;

  return (
    <div
      className="relative w-full"
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    >
      <div ref={containerRef} className="absolute inset-0" />
      {showPlaceholder && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[10px] text-neutral-500">
          waiting for ≥2 net-flow ticks…
        </div>
      )}
      {/* Fire-time vertical marker — purple, dashed. Painted as an
          overlay so it can sit above the chart without fighting the
          imperative chart canvas. */}
      {!showPlaceholder && markerX != null && (
        <div
          className="pointer-events-none absolute top-0 bottom-6 w-px"
          style={{
            left: markerX,
            background:
              'repeating-linear-gradient(to bottom, rgb(196,181,253) 0 3px, transparent 3px 6px)',
          }}
          aria-hidden
        />
      )}
    </div>
  );
}

export const TickerNetFlowChart = memo(TickerNetFlowChartInner);
