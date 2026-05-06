/**
 * ContractTapeChart — per-minute bid/ask/mid stacked bars (bottom
 * zone) with the volume-weighted average price as an overlay line
 * (upper zone), plus an optional vertical fire-time marker and a
 * three-point CT time axis at the bottom.
 *
 * Mirrors UW's contract-page left panel layout: green = ask-side
 * (calls bought aggressively), red = bid-side (calls sold), blue =
 * mid (no directional bias). Splitting the chart into a price zone
 * (top ~65%) and a volume zone (bottom ~35%) keeps the price line
 * legible even on minutes with extreme volume — under the previous
 * single-zone scaling, a single huge bar would compress the price
 * line into the top sliver.
 *
 * Hand-rolled SVG — same approach as FlowChart, no Recharts dep.
 */

import { memo, useMemo } from 'react';
import type { ContractTapeBar } from './types.js';

interface ContractTapeChartProps {
  /** Per-minute bars from /api/lottery-contract-tape. */
  series: ContractTapeBar[];
  /** Optional fire-time marker (UTC ISO). */
  markerTs?: string;
  /** Fixed height override (SVG units). Default 130. */
  height?: number;
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

const formatHM = (ms: number): string =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });

function ContractTapeChartInner({
  series,
  markerTs,
  height = 130,
  ariaLabel,
}: ContractTapeChartProps) {
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
    const maxVol = Math.max(
      1,
      ...series.map((r) => r.askVol + r.bidVol + r.midVol + r.noSideVol),
    );
    const volH = (v: number) => (v / maxVol) * volAreaH;

    const barW = Math.max(0.6, (innerW / series.length) * 0.85);
    const xAt = (ms: number) => PAD_X + ((ms - tsMin) / tsRange) * innerW;

    type StackedBar = {
      x: number;
      bid: { y: number; h: number };
      ask: { y: number; h: number };
      mid: { y: number; h: number };
    };

    const bars: StackedBar[] = series.map((r, i) => {
      const x = xAt(tsMs[i]!) - barW / 2;
      // Stack from the volume baseline up: bid → ask → mid.
      const bidH = volH(r.bidVol);
      const askH = volH(r.askVol);
      const midH = volH(r.midVol);
      return {
        x,
        bid: { y: volBaseY - bidH, h: bidH },
        ask: { y: volBaseY - bidH - askH, h: askH },
        mid: { y: volBaseY - bidH - askH - midH, h: midH },
      };
    });

    // Price y-scale: confined to priceArea with edge padding.
    const finitePrices = series
      .map((r) => r.avgPrice)
      .filter((p): p is number => p != null && Number.isFinite(p));
    let pricePath: string | null = null;
    let priceMin: number | null = null;
    let priceMax: number | null = null;
    if (finitePrices.length >= 2) {
      const rawMin = Math.min(...finitePrices);
      const rawMax = Math.max(...finitePrices);
      const rawRange = rawMax - rawMin || 1;
      const pad = rawRange * PRICE_PAD_RATIO;
      const minPrice = rawMin - pad;
      const maxPrice = rawMax + pad;
      const priceRange = maxPrice - minPrice || 1;
      const yAtPrice = (p: number) =>
        PAD_Y + (1 - (p - minPrice) / priceRange) * priceAreaH;

      const segs: string[] = [];
      let inSegment = false;
      series.forEach((r, i) => {
        const p = r.avgPrice;
        if (p == null || !Number.isFinite(p)) {
          inSegment = false;
          return;
        }
        const cmd = inSegment ? 'L' : 'M';
        segs.push(
          `${cmd} ${xAt(tsMs[i]!).toFixed(2)} ${yAtPrice(p).toFixed(2)}`,
        );
        inSegment = true;
      });
      pricePath = segs.length > 0 ? segs.join(' ') : null;
      priceMin = rawMin;
      priceMax = rawMax;
    }

    const markerX =
      markerTs != null
        ? (() => {
            const m = Date.parse(markerTs);
            const clamped = Math.max(tsMin, Math.min(tsMax, m));
            return xAt(clamped);
          })()
        : null;

    // Three-point CT time axis: start, midpoint, end.
    const axisLabels = [
      { x: PAD_X, anchor: 'start' as const, text: formatHM(tsMin) },
      {
        x: VIEW_W / 2,
        anchor: 'middle' as const,
        text: formatHM((tsMin + tsMax) / 2),
      },
      { x: VIEW_W - PAD_X, anchor: 'end' as const, text: formatHM(tsMax) },
    ];
    const axisLabelY = PAD_Y + innerH + AXIS_H * 0.75;

    return {
      bars,
      barW,
      pricePath,
      priceMin,
      priceMax,
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
    pricePath,
    priceMin,
    priceMax,
    markerX,
    sepY,
    volBaseY,
    axisLabels,
    axisLabelY,
  } = layout;

  return (
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
              opacity={0.9}
            />
          )}
          {b.ask.h > 0 && (
            <rect
              x={b.x}
              y={b.ask.y}
              width={barW}
              height={b.ask.h}
              fill="rgb(52, 211, 153)"
              opacity={0.9}
            />
          )}
          {b.mid.h > 0 && (
            <rect
              x={b.x}
              y={b.mid.y}
              width={barW}
              height={b.mid.h}
              fill="rgb(96, 165, 250)"
              opacity={0.7}
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
      {axisLabels.map((l) => (
        <text
          key={l.text}
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
  );
}

export const ContractTapeChart = memo(ContractTapeChartInner);
