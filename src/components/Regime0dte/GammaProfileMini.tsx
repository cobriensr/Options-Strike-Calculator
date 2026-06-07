/**
 * GammaProfileMini — compact net-GEX-by-strike profile for the 0DTE Gamma
 * Regime panel. One horizontal bar per strike: negative GEX extends left
 * (red, procyclical dealer hedging), positive extends right (emerald,
 * suppressive). A dashed flip line marks the sign-change strike, a spot
 * marker shows current SPX, and the ±band around spot is highlighted.
 *
 * Pure / presentational SVG: props in, markup out. No data fetching.
 * Strikes are sorted descending (high strike at top) so the y-axis reads
 * like an options chain. Empty / null inputs render a graceful placeholder.
 */

import { memo, useMemo } from 'react';

export interface GammaStrike {
  strike: number;
  netGex: number;
}

interface GammaProfileMiniProps {
  strikes: GammaStrike[];
  flipStrike: number | null;
  spot: number | null;
  /** Half-width of the highlighted band as a fraction of spot (e.g. 0.01 = ±1%). */
  bandPct: number;
}

const VB_W = 240;
const VB_H = 160;
const PAD_X = 8;
const MID_X = VB_W / 2;

function GammaProfileMiniImpl({
  strikes,
  flipStrike,
  spot,
  bandPct,
}: GammaProfileMiniProps) {
  const sorted = useMemo(
    () => [...strikes].sort((a, b) => b.strike - a.strike),
    [strikes],
  );

  const maxAbs = useMemo(
    () => sorted.reduce((m, s) => Math.max(m, Math.abs(s.netGex)), 0),
    [sorted],
  );

  if (sorted.length === 0 || maxAbs === 0) {
    return (
      <div
        className="flex h-24 items-center justify-center rounded border border-slate-700/60 bg-slate-900/40 text-xs text-slate-500"
        role="img"
        aria-label="Net gamma profile unavailable — insufficient strike data"
      >
        no gamma profile
      </div>
    );
  }

  const rowH = (VB_H - 2 * PAD_X) / sorted.length;
  const halfBarW = (VB_W / 2 - PAD_X) / maxAbs;

  // Map a strike value to its row center-y. Higher strike = lower y (top).
  const strikeY = (i: number) => PAD_X + i * rowH + rowH / 2;

  // Linear strike→y interpolation for the flip line / spot marker / band, so
  // they don't have to land exactly on a bar row.
  const hi = sorted[0]?.strike ?? 0;
  const lo = sorted[sorted.length - 1]?.strike ?? 0;
  const span = hi - lo;
  const valueToY = (v: number): number | null => {
    if (span <= 0) return strikeY(0);
    if (v > hi || v < lo) return null;
    const frac = (hi - v) / span;
    return PAD_X + frac * (VB_H - 2 * PAD_X);
  };

  const flipY = flipStrike != null ? valueToY(flipStrike) : null;
  const spotY = spot != null ? valueToY(spot) : null;
  const bandHalf = spot != null ? spot * bandPct : null;
  const bandTopY =
    spot != null && bandHalf != null ? valueToY(spot + bandHalf) : null;
  const bandBotY =
    spot != null && bandHalf != null ? valueToY(spot - bandHalf) : null;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      width="100%"
      className="h-auto w-full"
      role="img"
      aria-label="Net gamma exposure by strike. Red bars left are negative gamma, emerald bars right are positive."
    >
      {/* ±band highlight behind the bars */}
      {bandTopY != null && bandBotY != null && (
        <rect
          x={0}
          y={Math.min(bandTopY, bandBotY)}
          width={VB_W}
          height={Math.abs(bandBotY - bandTopY)}
          className="fill-sky-400/10"
        />
      )}

      {/* zero axis */}
      <line
        x1={MID_X}
        y1={PAD_X}
        x2={MID_X}
        y2={VB_H - PAD_X}
        className="stroke-slate-600"
        strokeWidth={0.5}
      />

      {/* bars */}
      {sorted.map((s, i) => {
        const w = Math.abs(s.netGex) * halfBarW;
        const neg = s.netGex < 0;
        const x = neg ? MID_X - w : MID_X;
        const y = strikeY(i) - rowH * 0.35;
        return (
          <rect
            key={s.strike}
            x={x}
            y={y}
            width={Math.max(w, 0.5)}
            height={rowH * 0.7}
            className={neg ? 'fill-red-500/80' : 'fill-emerald-500/80'}
          />
        );
      })}

      {/* flip line */}
      {flipY != null && (
        <line
          x1={0}
          y1={flipY}
          x2={VB_W}
          y2={flipY}
          className="stroke-amber-400"
          strokeWidth={1}
          strokeDasharray="3 2"
        />
      )}

      {/* spot marker */}
      {spotY != null && (
        <>
          <line
            x1={0}
            y1={spotY}
            x2={VB_W}
            y2={spotY}
            className="stroke-sky-300"
            strokeWidth={1}
          />
          <circle cx={MID_X} cy={spotY} r={2.5} className="fill-sky-300" />
        </>
      )}
    </svg>
  );
}

export const GammaProfileMini = memo(GammaProfileMiniImpl);
