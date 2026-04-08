import { useId } from 'react';
import { calcThetaCurve } from '../utils/calculator';

interface ThetaDecayChartProps {
  spot: number;
  sigma: number;
  strikeDistance: number;
  hoursRemaining: number;
  /**
   * Total session length in hours (6.5 normal day, 3.5 NYSE half-day).
   * Defaults to 6.5 to preserve callers that don't yet pass it.
   * Drives the x-scale, the interpolation bounds, and the ET clock-time
   * labels at the bottom of the chart. (FE-MATH-006)
   */
  marketHours?: number;
}

const VIEW_W = 300;
const VIEW_H = 60;
// NYSE always opens at 9:30 ET. Used to convert hoursRemaining → ET clock time.
const OPEN_HOUR_ET = 9.5;

/**
 * Map hoursRemaining to SVG x (0 → VIEW_W).
 * Curve goes from `marketHours` (left/open) to 0.5h (right/close).
 */
function xScale(h: number, marketHours: number): number {
  const span = marketHours - 0.5;
  if (span <= 0) return 0;
  return ((marketHours - h) / span) * VIEW_W;
}

/** Map premiumPct (100 → 0) to SVG y (0 → VIEW_H) */
function yScale(pct: number): number {
  return ((100 - pct) / 100) * VIEW_H;
}

/** Interpolate premium % at a given hoursRemaining from the discrete curve */
function interpolatePremium(
  curve: ReadonlyArray<{ hoursRemaining: number; premiumPct: number }>,
  h: number,
  marketHours: number,
): number | null {
  if (h > marketHours || h < 0.5) return null;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i]!;
    const b = curve[i + 1]!;
    if (h <= a.hoursRemaining && h >= b.hoursRemaining) {
      const t = (a.hoursRemaining - h) / (a.hoursRemaining - b.hoursRemaining);
      return (
        Math.round((a.premiumPct + (b.premiumPct - a.premiumPct) * t) * 10) / 10
      );
    }
  }
  return null;
}

/** Find the contiguous range of hours where thetaPerHour >= session average */
function calcEntryWindow(
  curve: ReadonlyArray<{
    hoursRemaining: number;
    thetaPerHour: number;
  }>,
  marketHours: number,
): string {
  if (curve.length === 0) return '\u2014';
  const mean = curve.reduce((sum, p) => sum + p.thetaPerHour, 0) / curve.length;
  if (mean <= 0) return '\u2014';

  let bestStart = -1;
  let bestEnd = -1;
  let bestLen = 0;
  let runStart = -1;

  for (let i = 0; i < curve.length; i++) {
    if (curve[i]!.thetaPerHour >= mean) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
        bestEnd = i - 1;
      }
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    const len = curve.length - runStart;
    if (len > bestLen) {
      bestStart = runStart;
      bestEnd = curve.length - 1;
    }
  }

  if (bestStart === -1) return '\u2014';

  const startH = curve[bestStart]!.hoursRemaining;
  const endH = curve[bestEnd]!.hoursRemaining;

  return formatETRange(startH, endH, marketHours);
}

/**
 * Convert hoursRemaining pair to ET clock time range string.
 * The session always starts at 9:30 ET (OPEN_HOUR_ET) and ends
 * `marketHours` later, so the ET clock at any hoursRemaining `h`
 * is `(OPEN_HOUR_ET + marketHours) − h` = closeHour − h.
 */
function formatETRange(
  startH: number,
  endH: number,
  marketHours: number,
): string {
  const closeHour = OPEN_HOUR_ET + marketHours;
  return (
    formatETHour(closeHour - startH) + '\u2013' + formatETHour(closeHour - endH)
  );
}

/** Format a 24h ET hour as "10a", "12p", "1p", etc. */
function formatETHour(hour24: number): string {
  const h = Math.round(hour24);
  if (h === 0 || h === 24) return '12a';
  if (h === 12) return '12p';
  if (h < 12) return h + 'a';
  return h - 12 + 'p';
}

export default function ThetaDecayChart({
  spot,
  sigma,
  strikeDistance,
  hoursRemaining,
  marketHours = 6.5,
}: Readonly<ThetaDecayChartProps>) {
  const gradientId = useId();
  const curve = calcThetaCurve(spot, sigma, strikeDistance, 'put', marketHours);
  if (curve.length === 0) return null;

  const linePoints = curve
    .map(
      (p) => xScale(p.hoursRemaining, marketHours) + ',' + yScale(p.premiumPct),
    )
    .join(' ');

  const first = curve[0]!;
  const last = curve.at(-1)!;
  const areaD =
    'M' +
    curve
      .map(
        (p) =>
          xScale(p.hoursRemaining, marketHours) + ',' + yScale(p.premiumPct),
      )
      .join(' L') +
    ' L' +
    xScale(last.hoursRemaining, marketHours) +
    ',' +
    VIEW_H +
    ' L' +
    xScale(first.hoursRemaining, marketHours) +
    ',' +
    VIEW_H +
    ' Z';

  const showNow = hoursRemaining >= 0.5 && hoursRemaining <= marketHours;
  const premNow = interpolatePremium(curve, hoursRemaining, marketHours);
  const nowX = showNow ? xScale(hoursRemaining, marketHours) : 0;
  const nowY = showNow && premNow !== null ? yScale(premNow) : 0;

  let peakTheta = 0;
  let peakHours = 0;
  for (const p of curve) {
    if (p.thetaPerHour > peakTheta) {
      peakTheta = p.thetaPerHour;
      peakHours = p.hoursRemaining;
    }
  }

  const entryWindow = calcEntryWindow(curve, marketHours);

  return (
    <div className="border-edge mt-3.5 border-t pt-3.5">
      <div className="text-tertiary mb-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Theta Decay (10{'\u0394'} put)
      </div>

      <div className="bg-surface-alt rounded-lg p-3">
        <svg
          viewBox={'0 0 ' + VIEW_W + ' ' + VIEW_H}
          className="h-[60px] w-full"
          aria-label="Theta decay curve showing premium remaining over time"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-accent)"
                stopOpacity="0.25"
              />
              <stop
                offset="100%"
                stopColor="var(--color-accent)"
                stopOpacity="0.03"
              />
            </linearGradient>
          </defs>

          <path d={areaD} fill={'url(#' + gradientId + ')'} />

          <polyline
            points={linePoints}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
          />

          {showNow && premNow !== null && (
            <>
              <line
                x1={nowX}
                y1={0}
                x2={nowX}
                y2={VIEW_H}
                stroke="#f59e0b"
                strokeWidth="0.75"
                strokeDasharray="2,2"
                opacity="0.4"
              />
              <circle cx={nowX} cy={nowY} r={3.5} fill="#f59e0b" />
              <text
                x={nowX > VIEW_W - 60 ? nowX - 55 : nowX + 6}
                y={nowY - 4}
                fill="#f59e0b"
                fontSize="8"
                fontFamily="monospace"
              >
                {premNow.toFixed(1) + '% left'}
              </text>
            </>
          )}

          <text
            x="2"
            y="8"
            fill="currentColor"
            fontSize="7"
            fontFamily="monospace"
            opacity="0.3"
          >
            100%
          </text>
          <text
            x="2"
            y={VIEW_H - 2}
            fill="currentColor"
            fontSize="7"
            fontFamily="monospace"
            opacity="0.3"
          >
            0%
          </text>
        </svg>
        <div className="text-muted mt-0.5 flex justify-between font-mono text-[9px]">
          <span>open</span>
          <span>close</span>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <div className="bg-surface-alt rounded-lg p-[7px_8px]">
          <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.08em] uppercase">
            Peak {'\u03B8'}/hr
          </div>
          <div className="text-primary mt-0.5 font-mono text-[14px] font-medium">
            {peakTheta > 0 ? peakTheta + '%' : '\u2014'}
          </div>
          {peakTheta > 0 && (
            <div className="text-muted font-mono text-[8px]">
              {'@ ' + peakHours + 'h'}
            </div>
          )}
        </div>
        <div className="bg-surface-alt rounded-lg p-[7px_8px]">
          <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.08em] uppercase">
            Prem Now
          </div>
          <div className="text-primary mt-0.5 font-mono text-[14px] font-medium">
            {premNow !== null ? premNow.toFixed(1) + '%' : '\u2014'}
          </div>
        </div>
        <div className="bg-surface-alt rounded-lg p-[7px_8px]">
          <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.08em] uppercase">
            Entry
          </div>
          <div className="text-primary mt-0.5 font-mono text-[14px] font-medium">
            {entryWindow}
          </div>
        </div>
      </div>

      <p className="text-muted mt-1.5 mb-0 text-[11px] italic">
        Premium remaining for 10-delta OTM put across the session.
      </p>
    </div>
  );
}
