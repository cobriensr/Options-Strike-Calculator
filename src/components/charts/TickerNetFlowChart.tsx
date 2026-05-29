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
import type {
  IChartApi,
  ISeriesApi,
  MouseEventParams,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { NetFlowTick, TickerCandle } from '../LotteryFinder/types.js';
import { ctSessionBounds } from '../LotteryFinder/ct-window.js';

/** Live crosshair readout state — populated on hover, cleared on leave. */
interface CrosshairReadout {
  time: UTCTimestamp;
  price: number | null;
  ncp: number | null;
  npp: number | null;
  netVol: number | null;
}

/** Compact signed $-formatter for the crosshair tooltip. */
const fmtSignedDollar = (n: number): string => {
  const sign = n >= 0 ? '+' : '−';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

/** Compact signed vol-formatter for the crosshair tooltip. */
const fmtSignedVol = (n: number): string => {
  const sign = n >= 0 ? '+' : '−';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
};

/**
 * Compact premium formatter for the inline header — matches the UW chart's
 * top strip ("656K", "-76.1M"): negatives carry a "-", positives are bare,
 * no "$" prefix (the colored dot already labels the series).
 */
const fmtHeaderPremium = (n: number): string => {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
};

/** Net-volume formatter for the header — raw integer with thousands commas
 *  ("-55,440"), matching UW's "Vol:" readout. */
const fmtHeaderVol = (n: number): string =>
  Math.round(n).toLocaleString('en-US');

/** Freshness label for the header — "M/D h:mm AM" in CT, from the last tick. */
const fmtHeaderTime = (iso: string): string => {
  const d = new Date(iso);
  const md = d.toLocaleDateString('en-US', {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
  const tm = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Chicago',
  });
  return `${md} ${tm}`;
};

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
  /**
   * YYYY-MM-DD trading day. Used to pin the visible window to the full
   * regular session (08:30–15:00 CT) regardless of how much data has
   * arrived. Without this, lightweight-charts auto-fits to the data,
   * which collapses the axis to a tiny window when the daemon has only
   * indexed the last few minutes. Optional only to keep existing tests
   * green — production callers (LotteryRow) always pass it.
   */
  date?: string;
  /**
   * UTC-second cursor time pushed down from the sibling CONTRACT chart
   * via the parent LotteryRow. When set, this chart paints a synced
   * crosshair (via lightweight-charts' setCrosshairPosition) at the
   * matching time on the price series. `null` clears the synced
   * cursor.
   */
  syncHoverTime?: number | null;
  /**
   * Fired when the chart's crosshair moves over real data. Bubbles up
   * the UTC-second timestamp so the CONTRACT chart can mirror the
   * cursor. Receives `null` when the cursor leaves the chart.
   */
  onHoverTime?: (t: number | null) => void;
  /** Total chart height in pixels. Default 220. */
  height?: number;
  /**
   * Underlying ticker symbol. When provided (and ≥1 tick is present), the
   * chart renders the UW-style inline metric header (symbol/spot · Vol ·
   * NPP · NCP) above the canvas. Omitted callers get the bare chart — the
   * header is opt-in for back-compat with tests and older consumers.
   */
  symbol?: string;
  ariaLabel: string;
}

const isoToUtcSec = (iso: string): UTCTimestamp =>
  Math.floor(Date.parse(iso) / 1000) as UTCTimestamp;

/** Format a UTCTimestamp (seconds) as a CT HH:MM string. */
const formatCt = (t: UTCTimestamp): string =>
  new Date((t as number) * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });

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
  date,
  syncHoverTime,
  onHoverTime,
  height = 220,
  symbol,
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

  /** Pixel x-coordinate of the fire-time marker, recomputed on every
   *  data update + resize. `null` when off-chart or unmeasurable. */
  const [markerX, setMarkerX] = useState<number | null>(null);
  /** Pixel y-coordinate of the volume pane's top edge, used to pin the
   *  "Net Volume" pane-title overlay. Recomputed on data/resize. `null`
   *  until the chart reports pane geometry. */
  const [volPaneTop, setVolPaneTop] = useState<number | null>(null);
  /**
   * Crosshair-driven readout for the floating tooltip strip. lightweight-
   * charts already paints a per-series legend, but it's spread across the
   * left/right gutters; users want a single compact strip that reads
   * "@ 11:32 CT  price 124.50  NCP +1.4M  NPP +14.3M  Δ −12.9M". */
  const [readout, setReadout] = useState<CrosshairReadout | null>(null);

  /**
   * Latest `onHoverTime` callback, accessed via ref so the
   * create-chart effect (which runs once) can call the current
   * callback without re-binding on every prop change. */
  const onHoverTimeRef = useRef<typeof onHoverTime>(onHoverTime);
  onHoverTimeRef.current = onHoverTime;

  /**
   * Flag set while we're imperatively driving the crosshair via
   * `setCrosshairPosition` (sync from sibling). Without this, the
   * sibling-driven move would re-trigger our own `crosshairMove`
   * callback, which would call `onHoverTime` and create a feedback
   * loop with the parent's lifted state. */
  const isSyncingRef = useRef(false);

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

  // ── Latest values for the UW-style inline header ────────────────
  // Derived from the same series/candles the chart already renders, so
  // the header can't drift from the lines. `spot` is null until the
  // first candle arrives; the premium/volume values come from the last
  // cumulative tick.
  const headerStats = useMemo(() => {
    const last = series.at(-1);
    if (!last) return null;
    return {
      time: last.ts,
      spot: candles.at(-1)?.close ?? null,
      ncp: last.cumNcp,
      npp: last.cumNpp,
      netVol: last.cumNcv - last.cumNpv,
    };
  }, [series, candles]);

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
        // `localization.timeFormatter` only formats the crosshair tooltip;
        // axis tick labels need their own formatter or they default to UTC.
        // Without this the axis renders 13:30–20:00 (UTC) instead of
        // 08:30–15:00 (CT) for the regular session. Verified bug pre-fix.
        tickMarkFormatter: (t: UTCTimestamp) => formatCt(t),
      },
      localization: {
        // Crosshair-tooltip time formatter (separate from axis labels).
        timeFormatter: (t: UTCTimestamp) => formatCt(t),
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

    // Premium-dominant pane split (3:1), matching the UW reference where
    // Net Premiums gets the bulk of the height and Net Volume is a thin
    // strip below. Feature-checked rather than try/caught so a library
    // shape change surfaces instead of silently swallowing.
    if (typeof chart.panes === 'function') {
      const panes = chart.panes();
      panes[0]?.setStretchFactor(3);
      panes[1]?.setStretchFactor(1);
    }

    // ── Crosshair subscription drives the floating readout strip ──
    // Called on every mouse move within the chart canvas. When the
    // cursor leaves the chart, `param.time` is undefined — we use that
    // to clear the readout. lightweight-charts internally rAF-batches
    // these callbacks so no extra debouncing is needed.
    const onCrosshair = (param: MouseEventParams<Time>) => {
      if (param.time == null) {
        setReadout(null);
        // Don't emit when the move came from our own setCrosshairPosition.
        if (!isSyncingRef.current) onHoverTimeRef.current?.(null);
        return;
      }
      const t = param.time as UTCTimestamp;
      const readSeries = (
        s: ISeriesApi<'Line'> | ISeriesApi<'Baseline'> | null,
      ): number | null => {
        if (s == null) return null;
        const v = param.seriesData.get(s);
        if (v == null) return null;
        // Both Line and Baseline series carry a `value` field.
        if (
          typeof v === 'object' &&
          'value' in v &&
          typeof v.value === 'number'
        ) {
          return v.value;
        }
        return null;
      };
      setReadout({
        time: t,
        price: readSeries(priceSeriesRef.current),
        ncp: readSeries(ncpSeriesRef.current),
        npp: readSeries(nppSeriesRef.current),
        netVol: readSeries(netVolSeriesRef.current),
      });
      // Emit the cursor's UTC second upward — but only when this move
      // came from a real user gesture, not our own sync-from-sibling.
      if (!isSyncingRef.current) onHoverTimeRef.current?.(t as number);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
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
  }, [flowData]);

  // ── Pin visible window to the full regular session ─────────────
  // Previously a one-shot `fitContent()` ran on first non-empty data
  // load. That collapsed the axis to a 14-minute window whenever the
  // first poll only had the tail of the session indexed. Pin to the
  // explicit 08:30–15:00 CT range on every data/date change so the
  // axis always reads as a full trading day. Falls back to fitContent
  // when `date` isn't supplied (tests).
  useEffect(() => {
    if (!chartRef.current) return;
    if (!flowData && !priceData) return;
    if (date == null) {
      chartRef.current.timeScale().fitContent();
      return;
    }
    const bounds = ctSessionBounds(date);
    const from = Math.floor(Date.parse(bounds.min) / 1000) as UTCTimestamp;
    const to = Math.floor(Date.parse(bounds.max) / 1000) as UTCTimestamp;
    if (!Number.isFinite(from as number) || !Number.isFinite(to as number)) {
      return;
    }
    chartRef.current.timeScale().setVisibleRange({ from, to });
  }, [flowData, priceData, date]);

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

  // ── Sibling-driven crosshair sync ───────────────────────────────
  // When the CONTRACT panel reports its cursor time, push it onto our
  // own crosshair via setCrosshairPosition. The `isSyncingRef` flag
  // suppresses the resulting crosshairMove from re-emitting upward.
  // lightweight-charts dispatches crosshairMove SYNCHRONOUSLY inside
  // setCrosshairPosition / clearCrosshairPosition, so we can flip the
  // flag, run the imperative call, and clear it again in the same tick
  // — no microtask gymnastics, no risk of swallowing a legitimate
  // user move that lands in the same animation frame.
  useEffect(() => {
    const chart = chartRef.current;
    const priceSeries = priceSeriesRef.current;
    if (!chart || !priceSeries) return;
    isSyncingRef.current = true;
    try {
      if (syncHoverTime == null) {
        chart.clearCrosshairPosition();
      } else {
        chart.setCrosshairPosition(
          // Price arg is meaningless when we only want the time crosshair
          // — lightweight-charts requires it but uses it only for vertical
          // pinning on the price scale. NaN tells the chart "no price
          // pin" and just draws the vertical line at the requested time.
          Number.NaN,
          syncHoverTime as UTCTimestamp,
          priceSeries,
        );
      }
    } finally {
      isSyncingRef.current = false;
    }
  }, [syncHoverTime]);

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

  // ── Volume-pane top edge, for the "Net Volume" title overlay ─────
  // The price pane (index 0) height equals the y-offset of the volume
  // pane's top. Recompute on data + height + size changes so the label
  // tracks the pane boundary as it reflows.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || typeof chart.panes !== 'function') {
      setVolPaneTop(null);
      return;
    }
    const recompute = () => {
      const pricePane = chart.panes()[0];
      const h = pricePane?.getHeight();
      setVolPaneTop(typeof h === 'number' && h > 0 ? h : null);
    };
    recompute();
    chart.timeScale().subscribeSizeChange(recompute);
    return () => {
      chart.timeScale().unsubscribeSizeChange(recompute);
    };
  }, [flowData, priceData, height]);

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

  /** Δ between live NCP and NPP values at the cursor, when both are read. */
  const readoutDiff =
    readout != null && readout.ncp != null && readout.npp != null
      ? readout.ncp - readout.npp
      : null;

  /** UW-style inline metric header — opt-in via `symbol`, hidden while the
   *  chart is still waiting for its first two ticks. */
  const showHeader = symbol != null && !showPlaceholder && headerStats != null;

  return (
    <div className="w-full">
      {showHeader && (
        <div className="mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[11px] leading-tight">
          <span className="text-neutral-500">
            {fmtHeaderTime(headerStats.time)}
          </span>
          {headerStats.spot != null && (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
              />
              <span className="text-neutral-400">{symbol}</span>
              <span className="text-neutral-100">
                {headerStats.spot.toFixed(2)}
              </span>
            </span>
          )}
          <span
            className="inline-flex items-center gap-1.5"
            title="Net volume (contracts): cumulative net call − net put volume"
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400"
            />
            <span className="text-neutral-400">Vol</span>
            <span className="text-neutral-100">
              {fmtHeaderVol(headerStats.netVol)}
            </span>
          </span>
          <span
            className="inline-flex items-center gap-1.5"
            title="Cumulative Net Put Premium $"
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-red-400"
            />
            <span className="text-neutral-400">NPP</span>
            <span className="text-neutral-100">
              {fmtHeaderPremium(headerStats.npp)}
            </span>
          </span>
          <span
            className="inline-flex items-center gap-1.5"
            title="Cumulative Net Call Premium $"
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-green-400"
            />
            <span className="text-neutral-400">NCP</span>
            <span className="text-neutral-100">
              {fmtHeaderPremium(headerStats.ncp)}
            </span>
          </span>
        </div>
      )}
      <div
        className="relative w-full"
        style={{ height }}
        role="img"
        aria-label={ariaLabel}
      >
        <div ref={containerRef} className="absolute inset-0" />
        {/* Pane-title overlays — "Net Premiums" pinned to the top pane,
            "Net Volume" pinned to the volume pane's top edge. Mirrors the
            UW reference's in-pane labels. */}
        {!showPlaceholder && (
          <>
            <div className="pointer-events-none absolute top-1 left-1 z-[5] text-[10px] font-medium text-neutral-400">
              Net Premiums
            </div>
            {volPaneTop != null && (
              <div
                className="pointer-events-none absolute left-1 z-[5] text-[10px] font-medium text-neutral-400"
                style={{ top: volPaneTop + 4 }}
              >
                Net Volume
              </div>
            )}
          </>
        )}
        {showPlaceholder && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[10px] text-neutral-500">
            waiting for ≥2 net-flow ticks…
          </div>
        )}
        {/* Crosshair readout strip — pinned top-right so it doesn't
          collide with the fire-time marker label on the left. Only
          shown while the cursor is over the chart. The unified value
          row is denser than lightweight-charts' built-in per-series
          gutter labels. */}
        {!showPlaceholder && readout != null && (
          <div
            className="pointer-events-none absolute top-1 right-1 z-10 flex flex-wrap items-center gap-x-2 rounded border border-neutral-700/80 bg-neutral-950/85 px-1.5 py-0.5 font-mono text-[9px] whitespace-nowrap text-neutral-300 shadow-md backdrop-blur-sm"
            role="status"
            aria-live="polite"
          >
            <span className="text-neutral-500">@</span>
            <span className="text-neutral-100">{formatCt(readout.time)}</span>
            {readout.price != null && (
              <span>
                <span className="text-amber-300">$</span>
                <span className="text-neutral-100">
                  {readout.price.toFixed(2)}
                </span>
              </span>
            )}
            {readout.ncp != null && (
              <span>
                <span className="text-emerald-300">N</span>
                <span className="text-neutral-100">
                  {fmtSignedDollar(readout.ncp)}
                </span>
              </span>
            )}
            {readout.npp != null && (
              <span>
                <span className="text-rose-300">P</span>
                <span className="text-neutral-100">
                  {fmtSignedDollar(readout.npp)}
                </span>
              </span>
            )}
            {readoutDiff != null && (
              <span>
                <span className="text-neutral-500">Δ</span>
                <span
                  className={
                    readoutDiff >= 0 ? 'text-emerald-300' : 'text-rose-300'
                  }
                >
                  {fmtSignedDollar(readoutDiff)}
                </span>
              </span>
            )}
            {readout.netVol != null && (
              <span>
                <span className="text-neutral-500">v</span>
                <span
                  className={
                    readout.netVol >= 0 ? 'text-emerald-300' : 'text-rose-300'
                  }
                >
                  {fmtSignedVol(readout.netVol)}
                </span>
              </span>
            )}
          </div>
        )}
        {/* Fire-time vertical marker — purple, dashed. Painted as an
          overlay so it can sit above the chart without fighting the
          imperative chart canvas. Now carries a small CT-time label
          near the top so the reader knows what the line represents. */}
        {!showPlaceholder && markerX != null && markerTs != null && (
          <>
            <div
              className="pointer-events-none absolute top-0 bottom-6 w-px"
              style={{
                left: markerX,
                background:
                  'repeating-linear-gradient(to bottom, rgb(196,181,253) 0 3px, transparent 3px 6px)',
              }}
              aria-hidden
            />
            <div
              className="pointer-events-none absolute top-0.5 rounded border border-violet-500/40 bg-violet-950/80 px-1 py-px font-mono text-[9px] leading-none text-violet-200"
              style={{
                left: markerX,
                transform: 'translateX(-50%)',
                whiteSpace: 'nowrap',
              }}
              aria-hidden
            >
              ⚡{' '}
              {new Date(markerTs).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZone: 'America/Chicago',
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const TickerNetFlowChart = memo(TickerNetFlowChartInner);
