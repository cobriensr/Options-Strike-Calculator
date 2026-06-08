/**
 * IvSparkline — the morning SPXW 0DTE nearest-ATM put-IV series for the 0DTE
 * Gamma Regime panel. A polyline of IV over the session, the 08:30–10:00 CT
 * reference range shaded (the morning high that an IV-break must exceed by
 * >2%), and a dot at the minute the break fired (if any).
 *
 * Pure / presentational SVG: props in, markup out. No data fetching.
 * Empty / single-point series render a graceful placeholder.
 */

import { memo, useMemo } from 'react';

export interface IvSparkPoint {
  ctMin: number;
  iv: number;
}

interface IvSparklineProps {
  series: IvSparkPoint[];
  /** Morning-range high (08:30–10:00 CT). A break must exceed refHi × 1.02. */
  refHi: number | null;
  /** CT minute the IV-break fired, or null if it has not fired. */
  breakAtCtMin: number | null;
}

const VB_W = 240;
const VB_H = 64;
const PAD = 6;

// 08:30–10:00 CT reference window (minutes from CT midnight). These mirror the
// calibrated backend source `REGIME_0DTE.IVBREAK_REF_START / IVBREAK_REF_END`
// in `api/_lib/regime-0dte.ts` and MUST stay in sync. We keep a local copy
// rather than importing from `api/_lib` to respect the frontend→backend
// boundary (a `src/` component must not depend on `api/`).
const REF_START = 510;
const REF_END = 600;

function IvSparklineImpl({ series, refHi, breakAtCtMin }: IvSparklineProps) {
  const sorted = useMemo(
    () => [...series].sort((a, b) => a.ctMin - b.ctMin),
    [series],
  );

  const bounds = useMemo(() => {
    if (sorted.length === 0) return null;
    const xs = sorted.map((p) => p.ctMin);
    const ys = sorted.map((p) => p.iv);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    let minY = Math.min(...ys);
    let maxY = Math.max(...ys);
    if (refHi != null) maxY = Math.max(maxY, refHi);
    // Avoid a zero-height range when IV is flat.
    if (maxY === minY) {
      maxY += 0.001;
      minY -= 0.001;
    }
    return { minX, maxX, minY, maxY };
  }, [sorted, refHi]);

  // Derive all SVG geometry in one memo so the polyline string, scale
  // closures, ref-band coords, and break-point lookup are not recomputed on
  // every (poll-driven) render — only when the underlying series/bounds change.
  const geometry = useMemo(() => {
    if (sorted.length < 2 || bounds == null || bounds.maxX === bounds.minX) {
      return null;
    }
    const { minX, maxX, minY, maxY } = bounds;
    const xScale = (m: number) =>
      PAD + ((m - minX) / (maxX - minX)) * (VB_W - 2 * PAD);
    const yScale = (iv: number) =>
      VB_H - PAD - ((iv - minY) / (maxY - minY)) * (VB_H - 2 * PAD);

    const points = sorted
      .map((p) => `${xScale(p.ctMin).toFixed(1)},${yScale(p.iv).toFixed(1)}`)
      .join(' ');

    // Reference-range shaded band (08:30–10:00 CT), clipped to the data x-range.
    const refX1 = xScale(Math.max(REF_START, minX));
    const refX2 = xScale(Math.min(REF_END, maxX));
    const showRefBand = refX2 > refX1;

    const breakPoint =
      breakAtCtMin != null
        ? sorted.find((p) => p.ctMin === breakAtCtMin)
        : undefined;

    return { xScale, yScale, points, refX1, refX2, showRefBand, breakPoint };
    // `refHi` is intentionally omitted: it only affects geometry via `bounds`,
    // which is already a dependency. The standalone refHi line is rendered
    // outside this memo.
  }, [sorted, bounds, breakAtCtMin]);

  if (geometry == null) {
    return (
      <div
        className="flex h-16 items-center justify-center rounded border border-slate-700/60 bg-slate-900/40 text-xs text-slate-500"
        role="img"
        aria-label="Put-IV series unavailable — insufficient data"
      >
        no IV series
      </div>
    );
  }

  const { xScale, yScale, points, refX1, refX2, showRefBand, breakPoint } =
    geometry;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      width="100%"
      className="h-auto w-full"
      role="img"
      aria-label="Morning put-implied-volatility series with the 08:30 to 10:00 reference range shaded."
    >
      {showRefBand && (
        <rect
          x={refX1}
          y={PAD}
          width={refX2 - refX1}
          height={VB_H - 2 * PAD}
          className="fill-slate-400/10"
        />
      )}

      {refHi != null && (
        <line
          x1={PAD}
          y1={yScale(refHi)}
          x2={VB_W - PAD}
          y2={yScale(refHi)}
          className="stroke-amber-400/60"
          strokeWidth={0.75}
          strokeDasharray="3 2"
        />
      )}

      <polyline
        points={points}
        fill="none"
        className="stroke-sky-300"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {breakPoint && (
        <circle
          cx={xScale(breakPoint.ctMin)}
          cy={yScale(breakPoint.iv)}
          r={3}
          className="fill-amber-400 stroke-amber-200"
          strokeWidth={0.75}
        />
      )}
    </svg>
  );
}

export const IvSparkline = memo(IvSparklineImpl);
