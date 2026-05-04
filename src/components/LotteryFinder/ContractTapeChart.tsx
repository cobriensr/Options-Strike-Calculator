/**
 * ContractTapeChart — per-minute bid/ask/mid stacked bars with the
 * volume-weighted average price as an overlay line on a second y-axis,
 * plus an optional vertical fire-time marker.
 *
 * Mirrors UW's contract-page left panel: green = ask-side (calls
 * bought aggressively), red = bid-side (calls sold), blue = mid (no
 * directional bias). The price line shows where the contract printed
 * over time so the user can see "ask vol surge → price climb" or
 * "bid vol surge → price crater" at a glance.
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
  /** Fixed height override (SVG units). Default 110. */
  height?: number;
  ariaLabel: string;
}

const VIEW_W = 200;
const PAD_X = 4;
const PAD_Y = 4;
// Inset price line so it doesn't kiss the chart edges.
const PRICE_PAD_RATIO = 0.1;

function ContractTapeChartInner({
  series,
  markerTs,
  height = 110,
  ariaLabel,
}: ContractTapeChartProps) {
  const layout = useMemo(() => {
    if (series.length === 0) return null;

    const tsMs = series.map((r) => Date.parse(r.ts));
    const tsMin = tsMs[0]!;
    const tsMax = tsMs[tsMs.length - 1]!;
    const tsRange = Math.max(tsMax - tsMin, 60_000); // ≥1 min so a single bar still renders

    // Volume y-scale: max stack height across all minutes.
    const maxVol = Math.max(
      1,
      ...series.map((r) => r.askVol + r.bidVol + r.midVol + r.noSideVol),
    );

    // Bar width: divide chart width by minute count, leave ~10% gap.
    const innerH = height - PAD_Y * 2;
    const innerW = VIEW_W - PAD_X * 2;
    const barW = Math.max(0.6, (innerW / series.length) * 0.85);

    const xAt = (ms: number) => PAD_X + ((ms - tsMin) / tsRange) * innerW;
    const volH = (v: number) => (v / maxVol) * innerH;

    type StackedBar = {
      x: number;
      bid: { y: number; h: number };
      ask: { y: number; h: number };
      mid: { y: number; h: number };
    };

    const bars: StackedBar[] = series.map((r, i) => {
      const x = xAt(tsMs[i]!) - barW / 2;
      // Stack from baseline up: bid, then ask, then mid.
      const bidH = volH(r.bidVol);
      const askH = volH(r.askVol);
      const midH = volH(r.midVol);
      const baseY = PAD_Y + innerH;
      return {
        x,
        bid: { y: baseY - bidH, h: bidH },
        ask: { y: baseY - bidH - askH, h: askH },
        mid: { y: baseY - bidH - askH - midH, h: midH },
      };
    });

    // Price y-scale: independent of volume scale, with edge padding.
    const finitePrices = series
      .map((r) => r.avgPrice)
      .filter((p): p is number => p != null && Number.isFinite(p));
    let pricePath: string | null = null;
    if (finitePrices.length >= 2) {
      const rawMin = Math.min(...finitePrices);
      const rawMax = Math.max(...finitePrices);
      const rawRange = rawMax - rawMin || 1;
      const pad = rawRange * PRICE_PAD_RATIO;
      const minPrice = rawMin - pad;
      const maxPrice = rawMax + pad;
      const priceRange = maxPrice - minPrice || 1;
      const yAtPrice = (p: number) =>
        PAD_Y + (1 - (p - minPrice) / priceRange) * innerH;

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
    }

    const markerX =
      markerTs != null
        ? (() => {
            const m = Date.parse(markerTs);
            const clamped = Math.max(tsMin, Math.min(tsMax, m));
            return xAt(clamped);
          })()
        : null;

    return { bars, barW, pricePath, markerX };
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

  const { bars, barW, pricePath, markerX } = layout;

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${height}`}
      className="block w-full"
      role="img"
      aria-label={ariaLabel}
    >
      {bars.map((b, i) => (
        <g key={i}>
          {b.bid.h > 0 && (
            <rect
              x={b.x}
              y={b.bid.y}
              width={barW}
              height={b.bid.h}
              fill="rgb(248, 113, 113)"
              opacity={0.85}
            />
          )}
          {b.ask.h > 0 && (
            <rect
              x={b.x}
              y={b.ask.y}
              width={barW}
              height={b.ask.h}
              fill="rgb(52, 211, 153)"
              opacity={0.85}
            />
          )}
          {b.mid.h > 0 && (
            <rect
              x={b.x}
              y={b.mid.y}
              width={barW}
              height={b.mid.h}
              fill="rgb(96, 165, 250)"
              opacity={0.6}
            />
          )}
        </g>
      ))}

      {/* Volume-weighted avg price overlay — yellow, second y-axis */}
      {pricePath && (
        <path
          d={pricePath}
          fill="none"
          stroke="rgb(250, 204, 21)"
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      )}

      {/* Fire-time vertical marker — purple */}
      {markerX != null && (
        <line
          x1={markerX}
          x2={markerX}
          y1={PAD_Y}
          y2={height - PAD_Y}
          stroke="rgb(196, 181, 253)"
          strokeWidth={0.8}
          strokeDasharray="3 2"
        />
      )}
    </svg>
  );
}

export const ContractTapeChart = memo(ContractTapeChartInner);
