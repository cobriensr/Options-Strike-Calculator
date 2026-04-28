/**
 * Sparkline — small SVG dual-line chart comparing spot vs zero-gamma
 * across the most recent N snapshots.
 *
 * Two lines:
 *   - White (text-primary): spot price drift
 *   - Amber: zero-gamma level (gaps where the level was NULL)
 *
 * Y-axis auto-scales to the union of both series so the regime-flip
 * crossing is visible. Width scales to the container via SVG viewBox.
 */

import { memo, useMemo } from 'react';
import type { ZeroGammaRow } from '../../hooks/useZeroGamma';

interface SparklineProps {
  history: ZeroGammaRow[];
  priceDigits: number;
}

const VIEW_W = 200;
const VIEW_H = 40;
const PAD_X = 2;
const PAD_Y = 2;
const INNER_W = VIEW_W - PAD_X * 2;
const INNER_H = VIEW_H - PAD_Y * 2;

function SparklineInner({ history, priceDigits }: SparklineProps) {
  const layout = useMemo(() => {
    if (history.length < 2) return null;

    const spots = history.map((h) => h.spot);
    const zgValues = history
      .map((h) => h.zeroGamma)
      .filter((v): v is number => v != null);

    const allValues = [...spots, ...zgValues];
    if (allValues.length === 0) return null;

    // reduce instead of Math.min/max(...spread) to avoid JS engine
    // call-stack limits on long arrays.
    const seed = allValues[0]!;
    let minVal = seed;
    let maxVal = seed;
    for (const v of allValues) {
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    const range = maxVal - minVal || 1;

    const xAt = (i: number) =>
      PAD_X + (i / Math.max(history.length - 1, 1)) * INNER_W;
    const yAt = (v: number) => PAD_Y + (1 - (v - minVal) / range) * INNER_H;

    const spotPath = history
      .map((h, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(h.spot)}`)
      .join(' ');

    // ZG path: break into segments wherever zeroGamma is null so the line
    // doesn't connect across gaps.
    const zgSegments: string[] = [];
    let currentSegment: string[] = [];
    history.forEach((h, i) => {
      if (h.zeroGamma == null) {
        if (currentSegment.length > 0) {
          zgSegments.push(currentSegment.join(' '));
          currentSegment = [];
        }
      } else {
        const prefix = currentSegment.length === 0 ? 'M' : 'L';
        currentSegment.push(`${prefix} ${xAt(i)} ${yAt(h.zeroGamma)}`);
      }
    });
    if (currentSegment.length > 0) zgSegments.push(currentSegment.join(' '));

    return { spotPath, zgPath: zgSegments.join(' '), minVal, maxVal };
  }, [history]);

  if (layout == null) {
    return (
      <div className="text-secondary font-mono text-[10px]">
        Sparkline: waiting for ≥2 snapshots
      </div>
    );
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="block w-full"
        role="img"
        aria-label="Spot vs zero-gamma sparkline"
      >
        <path
          d={layout.spotPath}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          className="text-primary opacity-80"
        />
        <path
          d={layout.zgPath}
          fill="none"
          stroke="rgb(251, 191, 36)"
          strokeWidth={1.25}
          strokeDasharray="3 2"
        />
      </svg>
      <div className="mt-0.5 flex justify-between font-mono text-[9px]">
        <span className="text-secondary">
          {layout.minVal.toFixed(priceDigits)}
        </span>
        <span className="text-secondary">
          {layout.maxVal.toFixed(priceDigits)}
        </span>
      </div>
    </div>
  );
}

export const Sparkline = memo(SparklineInner);
