/**
 * ContractTapeChart — per-minute bid/ask/mid stacked bars (bottom
 * zone) with the volume-weighted average price as an overlay line
 * (upper zone), plus an optional vertical fire-time marker and a
 * five-point CT time axis at the bottom.
 *
 * Mirrors UW's contract-page left panel layout: green = ask-side
 * (calls bought aggressively), red = bid-side (calls sold), blue =
 * mid (no directional bias). Splitting the chart into a price zone
 * (top ~65%) and a volume zone (bottom ~35%) keeps the price line
 * legible even on minutes with extreme volume — under the previous
 * single-zone scaling, a single huge bar would compress the price
 * line into the top sliver.
 *
 * Hover tooltip: mousemove over the SVG snaps to the nearest bar and
 * paints a floating div with the minute's exact bid/mid/ask split,
 * total volume, and avg fill price. Replaces UW's contract-lookup
 * tooltip in functionality — the hand-rolled SVG can't take advantage
 * of lightweight-charts' crosshair, so the React layer drives it.
 *
 * Visual polish:
 *  - VWAP horizontal reference across the price zone so the reader
 *    can tell where the contract is trading vs. its session average.
 *  - Largest single-minute volume bar gets an annotation arrow + value
 *    label above the price zone — surfaces the day's "biggest print"
 *    without forcing the reader to scan every bar.
 *  - Max-vol corner label gives the volume y-axis a magnitude anchor.
 *
 * Hand-rolled SVG — same approach as FlowChart, no Recharts dep.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ContractTapeBar } from './types.js';

interface ContractTapeChartProps {
  /** Per-minute bars from /api/lottery-contract-tape. */
  series: ContractTapeBar[];
  /** Optional fire-time marker (UTC ISO). */
  markerTs?: string;
  /** Fixed height override (SVG units). Default 130. */
  height?: number;
  /**
   * UTC-second cursor time pushed down from a sibling chart (NET FLOW)
   * via the parent LotteryRow. When set, this chart paints a thin
   * synced cursor line at the matching bar — without showing the rich
   * tooltip, which is reserved for the user's own pointer. `null` when
   * no sibling is hovered.
   */
  syncHoverTime?: number | null;
  /**
   * Fired when the local cursor enters/leaves a bar. The parent lifts
   * the time into shared state so the NET FLOW panel can render a
   * synced crosshair at the same minute. Receives `null` on mouseleave.
   */
  onHoverTime?: (t: number | null) => void;
  ariaLabel: string;
}

const VIEW_W = 200;
const PAD_X = 4;
const PAD_Y = 4;
/** Bottom band reserved for CT time labels (SVG units). */
const AXIS_H = 12;
/** Top fraction of the inner plot area dedicated to the price line. */
const PRICE_AREA_RATIO = 0.65;
/** Y-axis padding around the raw price min/max so the line floats. */
const PRICE_PAD_RATIO = 0.1;
/** Bars taller than `MAX_BAR_HIGHLIGHT_MULT * median` get an annotation. */
const MAX_BAR_HIGHLIGHT_MULT = 2;
/** Number of CT-time tick marks along the bottom axis. */
const AXIS_TICK_COUNT = 5;
/**
 * Tolerance for matching a sibling's `syncHoverTime` to a bar. One
 * minute on each side covers minute-bucket misalignment without
 * letting an off-screen sibling clamp a misleading cursor to an edge.
 */
const SYNC_WINDOW_MS = 60_000;

const formatHM = (ms: number): string =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });

const formatVolShort = (n: number): string => {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
};

function ContractTapeChartInner({
  series,
  markerTs,
  height = 130,
  syncHoverTime,
  onHoverTime,
  ariaLabel,
}: ContractTapeChartProps) {
  /** Container ref so we can map clientX → SVG x for hover. */
  const containerRef = useRef<HTMLDivElement | null>(null);
  /**
   * Cached container bounding rect. mousemove fires at ~60 Hz; each
   * `getBoundingClientRect` forces a layout flush, so we read it once
   * on mount and on every ResizeObserver tick. The ref is read inside
   * the mousemove handler without re-rendering. */
  const rectRef = useRef<DOMRect | null>(null);
  /** Index of the bar nearest the cursor; null when not hovering. */
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Measure container size once on mount and again whenever it
  // resizes. Falls back to a one-shot measurement when ResizeObserver
  // is unavailable (older jsdom).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    rectRef.current = el.getBoundingClientRect();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      rectRef.current = el.getBoundingClientRect();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (series.length === 0) return null;

    const tsMs = series.map((r) => Date.parse(r.ts));
    const tsMin = tsMs[0]!;
    const tsMax = tsMs[tsMs.length - 1]!;
    const tsRange = Math.max(tsMax - tsMin, 60_000); // ≥1 min so a single bar still renders

    const innerH = height - PAD_Y * 2 - AXIS_H;
    const innerW = VIEW_W - PAD_X * 2;
    const priceAreaH = innerH * PRICE_AREA_RATIO;
    const volAreaH = innerH - priceAreaH;
    const sepY = PAD_Y + priceAreaH;
    const volBaseY = PAD_Y + innerH;

    // Volume y-scale: max stack height across all minutes — confined
    // to the bottom volume zone so the price line above stays
    // legible regardless of bar magnitude.
    const totalsByBar = series.map(
      (r) => r.askVol + r.bidVol + r.midVol + r.noSideVol,
    );
    const maxVol = Math.max(1, ...totalsByBar);
    const volH = (v: number) => (v / maxVol) * volAreaH;

    const barW = Math.max(0.6, (innerW / series.length) * 0.85);
    const xAt = (ms: number) => PAD_X + ((ms - tsMin) / tsRange) * innerW;

    type StackedBar = {
      x: number;
      cx: number; // bar center, for tooltip pinning
      bid: { y: number; h: number };
      ask: { y: number; h: number };
      mid: { y: number; h: number };
      total: number;
    };

    const bars: StackedBar[] = series.map((r, i) => {
      const cx = xAt(tsMs[i]!);
      const x = cx - barW / 2;
      const bidH = volH(r.bidVol);
      const askH = volH(r.askVol);
      const midH = volH(r.midVol);
      return {
        x,
        cx,
        bid: { y: volBaseY - bidH, h: bidH },
        ask: { y: volBaseY - bidH - askH, h: askH },
        mid: { y: volBaseY - bidH - askH - midH, h: midH },
        total: totalsByBar[i]!,
      };
    });

    // ── Price line + VWAP across the session ─────────────────────
    const finitePrices = series
      .map((r) => r.avgPrice)
      .filter((p): p is number => p != null && Number.isFinite(p));
    let pricePath: string | null = null;
    let priceMin: number | null = null;
    let priceMax: number | null = null;
    let yAtPrice: ((p: number) => number) | null = null;
    let vwap: number | null = null;
    let vwapY: number | null = null;
    if (finitePrices.length >= 2) {
      const rawMin = Math.min(...finitePrices);
      const rawMax = Math.max(...finitePrices);
      const rawRange = rawMax - rawMin || 1;
      const pad = rawRange * PRICE_PAD_RATIO;
      const minPrice = rawMin - pad;
      const maxPrice = rawMax + pad;
      const priceRange = maxPrice - minPrice || 1;
      const yAt = (p: number) =>
        PAD_Y + (1 - (p - minPrice) / priceRange) * priceAreaH;
      yAtPrice = yAt;

      const segs: string[] = [];
      let inSegment = false;
      series.forEach((r, i) => {
        const p = r.avgPrice;
        if (p == null || !Number.isFinite(p)) {
          inSegment = false;
          return;
        }
        const cmd = inSegment ? 'L' : 'M';
        segs.push(`${cmd} ${xAt(tsMs[i]!).toFixed(2)} ${yAt(p).toFixed(2)}`);
        inSegment = true;
      });
      pricePath = segs.length > 0 ? segs.join(' ') : null;
      priceMin = rawMin;
      priceMax = rawMax;

      // Volume-weighted session VWAP. Bars with no price are skipped.
      let pvSum = 0;
      let vSum = 0;
      series.forEach((r) => {
        if (
          r.avgPrice != null &&
          Number.isFinite(r.avgPrice) &&
          r.totalVol > 0
        ) {
          pvSum += r.avgPrice * r.totalVol;
          vSum += r.totalVol;
        }
      });
      if (vSum > 0) {
        vwap = pvSum / vSum;
        vwapY = yAt(vwap);
      }
    }

    // Highest-volume bar — annotated only if it stands out from the
    // crowd. The 2× median test keeps the chart quiet on normal
    // sessions; spikes get a callout.
    const maxIdx = totalsByBar.indexOf(Math.max(...totalsByBar));
    const med = median(totalsByBar);
    const isSpike =
      totalsByBar[maxIdx]! >= MAX_BAR_HIGHLIGHT_MULT * Math.max(med, 1);

    const markerX =
      markerTs != null
        ? (() => {
            const m = Date.parse(markerTs);
            const clamped = Math.max(tsMin, Math.min(tsMax, m));
            return xAt(clamped);
          })()
        : null;

    // Five-point CT time axis: evenly spaced across the session. Three
    // ticks read sparse on a 6.5-hour session; five gives ~80-minute
    // resolution which matches the reader's mental clock cadence.
    const axisLabels = Array.from({ length: AXIS_TICK_COUNT }, (_, i) => {
      const t = i / (AXIS_TICK_COUNT - 1);
      let anchor: 'start' | 'middle' | 'end' = 'middle';
      if (i === 0) anchor = 'start';
      else if (i === AXIS_TICK_COUNT - 1) anchor = 'end';
      return {
        x: PAD_X + t * innerW,
        anchor,
        text: formatHM(tsMin + t * (tsMax - tsMin)),
      };
    });
    const axisLabelY = PAD_Y + innerH + AXIS_H * 0.75;

    return {
      bars,
      barW,
      tsMs,
      pricePath,
      priceMin,
      priceMax,
      yAtPrice,
      vwap,
      vwapY,
      maxVol,
      maxIdx,
      isSpike,
      markerX,
      sepY,
      volBaseY,
      axisLabels,
      axisLabelY,
    };
  }, [series, markerTs, height]);

  if (layout == null) {
    return (
      <div
        className="font-mono text-[9px] text-neutral-500"
        aria-label={ariaLabel}
      >
        no tape data — daemon may not have indexed this contract
      </div>
    );
  }

  const {
    bars,
    barW,
    tsMs,
    pricePath,
    priceMin,
    priceMax,
    yAtPrice,
    vwap,
    vwapY,
    maxVol,
    maxIdx,
    isSpike,
    markerX,
    sepY,
    volBaseY,
    axisLabels,
    axisLabelY,
  } = layout;

  /**
   * Map a clientX to the nearest bar index. The SVG is rendered with a
   * viewBox so we must scale the mouse position by the actual rendered
   * width / VIEW_W ratio. Bars are ordered by time so a simple linear
   * search is fine at <500 entries (one per session minute).
   */
  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    // Prefer the cached rect (refreshed by ResizeObserver). When tests
    // mock `getBoundingClientRect` after render, the cached value may
    // be stale; fall through to a live read when the cache is null or
    // reports zero width.
    let rect = rectRef.current;
    if (rect == null || rect.width === 0) {
      const el = containerRef.current;
      if (!el) return;
      rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      rectRef.current = rect;
    }
    const svgX = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    let nearestIdx = 0;
    let nearestDist = Infinity;
    bars.forEach((b, i) => {
      const d = Math.abs(b.cx - svgX);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    });
    // Only show the tooltip when the cursor is within reasonable
    // proximity — half a bar width. Past that, the reader is in dead
    // space between bars and a snapped tooltip would feel laggy.
    const next = nearestDist <= Math.max(barW, 2) * 1.5 ? nearestIdx : null;
    setHoverIdx(next);
    if (onHoverTime) {
      onHoverTime(next != null ? Math.floor(tsMs[next]! / 1000) : null);
    }
  };

  const onMouseLeave = (): void => {
    setHoverIdx(null);
    onHoverTime?.(null);
  };

  const hoveredBar = hoverIdx != null ? bars[hoverIdx] : null;
  const hoveredRow = hoverIdx != null ? series[hoverIdx] : null;

  /**
   * Synced sibling cursor — when NET FLOW is being hovered, paint a
   * thin amber line at the nearest bar to its cursor time. Only fires
   * when this chart isn't being directly hovered (local hover takes
   * precedence to avoid visual conflict). */
  let syncCursorX: number | null = null;
  if (hoverIdx == null && syncHoverTime != null && bars.length > 0) {
    const targetMs = syncHoverTime * 1000;
    let nearestIdx = 0;
    let nearestDist = Infinity;
    tsMs.forEach((t, i) => {
      const d = Math.abs(t - targetMs);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    });
    // Only sync when the sibling's time falls inside this chart's
    // window — otherwise the cursor would clamp to an edge and mislead.
    if (
      syncHoverTime * 1000 >= tsMs[0]! - SYNC_WINDOW_MS &&
      syncHoverTime * 1000 <= tsMs[tsMs.length - 1]! + SYNC_WINDOW_MS
    ) {
      syncCursorX = bars[nearestIdx]!.cx;
    }
  }

  // Pixel-coords for the floating tooltip. The cached rect is already
  // fresh thanks to the ResizeObserver — no second layout flush here.
  let tooltipLeft = 0;
  let tooltipTop = 0;
  if (hoveredBar != null && rectRef.current != null) {
    const rect = rectRef.current;
    const scaleX = rect.width / VIEW_W;
    const scaleY = rect.height / height;
    tooltipLeft = hoveredBar.cx * scaleX;
    tooltipTop = sepY * scaleY;
  }

  const maxBar = bars[maxIdx];

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        className="block w-full"
        role="img"
        aria-label={ariaLabel}
      >
        {/* Subtle horizontal separator between price and volume zones. */}
        <line
          x1={PAD_X}
          x2={VIEW_W - PAD_X}
          y1={sepY}
          y2={sepY}
          stroke="rgb(38, 38, 38)"
          strokeWidth={0.5}
        />

        {/* VWAP reference across the price zone — amber dashed. */}
        {vwap != null && vwapY != null && (
          <>
            <line
              x1={PAD_X}
              x2={VIEW_W - PAD_X}
              y1={vwapY}
              y2={vwapY}
              stroke="rgba(251, 191, 36, 0.45)"
              strokeWidth={0.5}
              strokeDasharray="2 2"
            />
            <text
              x={PAD_X + 1}
              y={vwapY - 1}
              fill="rgba(251, 191, 36, 0.7)"
              fontSize={5}
              fontFamily="ui-monospace, monospace"
            >
              VWAP ${vwap.toFixed(2)}
            </text>
          </>
        )}

        {/* Volume bars (bottom zone). */}
        {bars.map((b, i) => (
          <g key={i}>
            {b.bid.h > 0 && (
              <rect
                x={b.x}
                y={b.bid.y}
                width={barW}
                height={b.bid.h}
                fill="rgb(248, 113, 113)"
                opacity={hoverIdx == null || hoverIdx === i ? 0.9 : 0.35}
              />
            )}
            {b.ask.h > 0 && (
              <rect
                x={b.x}
                y={b.ask.y}
                width={barW}
                height={b.ask.h}
                fill="rgb(52, 211, 153)"
                opacity={hoverIdx == null || hoverIdx === i ? 0.9 : 0.35}
              />
            )}
            {b.mid.h > 0 && (
              <rect
                x={b.x}
                y={b.mid.y}
                width={barW}
                height={b.mid.h}
                fill="rgb(96, 165, 250)"
                opacity={hoverIdx == null || hoverIdx === i ? 0.7 : 0.25}
              />
            )}
          </g>
        ))}

        {/* Volume baseline. */}
        <line
          x1={PAD_X}
          x2={VIEW_W - PAD_X}
          y1={volBaseY}
          y2={volBaseY}
          stroke="rgb(38, 38, 38)"
          strokeWidth={0.5}
        />

        {/* Max-vol y-axis tick label — anchors the volume zone so the
            reader can map bar heights to numbers. */}
        <text
          x={PAD_X + 1}
          y={sepY + 5}
          fill="rgb(115, 115, 115)"
          fontSize={5}
          fontFamily="ui-monospace, monospace"
        >
          max {formatVolShort(maxVol)}
        </text>

        {/* Vol-weighted avg price overlay (top zone). */}
        {pricePath != null && (
          <path
            d={pricePath}
            fill="none"
            stroke="rgb(250, 204, 21)"
            strokeWidth={1.3}
            strokeLinejoin="round"
          />
        )}

        {/* Right-edge price min/max corner labels. Suppressed when
            flat (single tick or no movement) — repeating the same
            number twice is just noise. */}
        {priceMin != null && priceMax != null && priceMax > priceMin && (
          <>
            <text
              x={VIEW_W - PAD_X}
              y={PAD_Y + 5}
              textAnchor="end"
              fill="rgb(217, 119, 6)"
              fontSize={6}
              fontFamily="ui-monospace, monospace"
            >
              ${priceMax.toFixed(2)}
            </text>
            <text
              x={VIEW_W - PAD_X}
              y={sepY - 1}
              textAnchor="end"
              fill="rgb(217, 119, 6)"
              fontSize={6}
              fontFamily="ui-monospace, monospace"
            >
              ${priceMin.toFixed(2)}
            </text>
          </>
        )}

        {/* Biggest-print callout — only when the max bar is ≥2× the
            session median. Tiny downward triangle + volume readout
            above the price zone, pointing to the spike bar. */}
        {isSpike && maxBar != null && (
          <g>
            <polygon
              points={`${maxBar.cx - 1.5},${PAD_Y - 0.5} ${maxBar.cx + 1.5},${PAD_Y - 0.5} ${maxBar.cx},${PAD_Y + 1.5}`}
              fill="rgb(244, 114, 182)"
              opacity={0.85}
            />
            <text
              x={maxBar.cx}
              y={PAD_Y - 1}
              textAnchor="middle"
              fill="rgb(244, 114, 182)"
              fontSize={5}
              fontFamily="ui-monospace, monospace"
            >
              biggest {formatVolShort(maxBar.total)}
            </text>
          </g>
        )}

        {/* Hover cursor — thin vertical line snapped to the bar center. */}
        {hoveredBar != null && (
          <line
            x1={hoveredBar.cx}
            x2={hoveredBar.cx}
            y1={PAD_Y}
            y2={volBaseY}
            stroke="rgba(255,255,255,0.4)"
            strokeWidth={0.5}
          />
        )}

        {/* Synced cursor — driven by the sibling NET FLOW chart's
            crosshair. Thin amber to distinguish from this chart's own
            white hover line. No tooltip; reader's eye sits on NET FLOW. */}
        {syncCursorX != null && (
          <line
            x1={syncCursorX}
            x2={syncCursorX}
            y1={PAD_Y}
            y2={volBaseY}
            stroke="rgba(251, 191, 36, 0.6)"
            strokeWidth={0.6}
            strokeDasharray="1.5 1.5"
          />
        )}

        {/* Hover price-line dot, when an avg price exists. */}
        {hoveredBar != null &&
          hoveredRow != null &&
          hoveredRow.avgPrice != null &&
          yAtPrice != null && (
            <circle
              cx={hoveredBar.cx}
              cy={yAtPrice(hoveredRow.avgPrice)}
              r={1.3}
              fill="rgb(250, 204, 21)"
              stroke="rgba(0,0,0,0.6)"
              strokeWidth={0.4}
            />
          )}

        {/* Fire-time vertical marker — purple, dashed. */}
        {markerX != null && (
          <line
            x1={markerX}
            x2={markerX}
            y1={PAD_Y}
            y2={volBaseY}
            stroke="rgb(196, 181, 253)"
            strokeWidth={0.8}
            strokeDasharray="3 2"
          />
        )}

        {/* CT time axis. */}
        {axisLabels.map((l, i) => (
          <text
            key={`${l.text}-${i}`}
            x={l.x}
            y={axisLabelY}
            textAnchor={l.anchor}
            fill="rgb(115, 115, 115)"
            fontSize={6}
            fontFamily="ui-monospace, monospace"
          >
            {l.text}
          </text>
        ))}
      </svg>

      {/* Floating hover tooltip — positioned in container-pixel
          space (computed from clientRect on each render while
          hovering). Pinned just above the price/volume separator so
          it never overlaps the time axis. */}
      {hoveredRow != null && hoveredBar != null && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-neutral-700 bg-neutral-950/95 px-2 py-1.5 font-mono text-[10px] whitespace-nowrap text-neutral-200 shadow-lg"
          style={{ left: tooltipLeft, top: tooltipTop }}
          role="tooltip"
          aria-live="polite"
        >
          <div className="mb-0.5 font-semibold text-neutral-100">
            {formatHM(tsMs[hoverIdx!]!)} CT
          </div>
          <div className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-sm bg-red-400"
            />
            <span className="text-red-300">Bid</span>
            <span>{formatVolShort(hoveredRow.bidVol)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-sm bg-blue-400"
            />
            <span className="text-blue-300">Mid</span>
            <span>{formatVolShort(hoveredRow.midVol)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-sm bg-green-400"
            />
            <span className="text-green-300">Ask</span>
            <span>{formatVolShort(hoveredRow.askVol)}</span>
          </div>
          {hoveredRow.avgPrice != null && (
            <div className="mt-0.5 border-t border-neutral-800 pt-0.5 text-amber-300">
              avg ${hoveredRow.avgPrice.toFixed(2)}
              {hoveredRow.highPrice != null && hoveredRow.lowPrice != null && (
                <span className="ml-1 text-neutral-500">
                  ({hoveredRow.lowPrice.toFixed(2)}–
                  {hoveredRow.highPrice.toFixed(2)})
                </span>
              )}
            </div>
          )}
          <div className="text-neutral-500">
            total {formatVolShort(hoveredRow.totalVol)}
          </div>
        </div>
      )}
    </div>
  );
}

export const ContractTapeChart = memo(ContractTapeChartInner);
