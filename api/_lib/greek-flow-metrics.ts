/**
 * Derived metrics for the Greek flow UI panel.
 *
 * All inputs are arrays of cumulative-value points already sorted by
 * timestamp ascending. The functions here are pure — easy to unit-test
 * without DB or API stubs.
 *
 * Conventions:
 *   - "slope" = least-squares slope of the last N cumulative points,
 *     with x in minutes (so units are "cumulative units per minute").
 *     Reported sign tells the trader whether bullish/bearish flow is
 *     accelerating or decelerating.
 *   - "flip" = sign change of cumulative within the lookback window.
 *     Magnitude is the larger of |min| and |max| inside the window —
 *     it answers "how far did it travel after the flip".
 *   - "cliff" = max abs(Δcum) over a trailing 10-min window during the
 *     14:00–15:00 CT power hour. Catches late-day step changes (e.g.
 *     the QQQ OTM Dir Vega cliff between 2:00–3:00 PM that telegraphs
 *     overnight risk).
 *   - "divergence" = sign(SPY) ≠ sign(QQQ) for the same field. A
 *     persistent divergence (>30 min) is a "narrow rally / hedged"
 *     fingerprint.
 */

export type Sign = 1 | -1 | 0;

export interface FlowPoint {
  timestamp: string;
  cumulative: number;
}

export interface SlopeResult {
  /** Slope in cumulative-units-per-minute, or null if too few points. */
  slope: number | null;
  /** Number of points used in the regression. */
  points: number;
}

export interface FlipResult {
  /** True iff the cumulative crossed zero within the lookback window. */
  occurred: boolean;
  /** ISO timestamp of the first row inside the window where sign changed (null if not occurred). */
  atTimestamp: string | null;
  /** Largest abs(cumulative) inside the window — measures travel magnitude. */
  magnitude: number;
  /** Sign of the most recent cumulative value: 1 / -1 / 0. */
  currentSign: Sign;
}

export interface CliffResult {
  /** Max abs(Δcumulative) over a 10-min trailing window inside 14:00–15:00 CT. */
  magnitude: number;
  /** ISO timestamp where that max Δ ended, or null if no qualifying window. */
  atTimestamp: string | null;
}

export interface DivergenceResult {
  spySign: Sign;
  qqqSign: Sign;
  /** True iff signs are non-zero and disagree. */
  diverging: boolean;
}

/**
 * Linear regression slope of `cumulative` vs minute index (0..n-1) over
 * the trailing `windowMinutes` points. Uses minute index rather than
 * absolute epoch so the units are stable and gaps don't distort.
 *
 * Returns `null` when fewer than 2 points are available — a slope
 * undefined for a single sample.
 */
export function slopeLastNMinutes(
  series: FlowPoint[],
  windowMinutes = 15,
): SlopeResult {
  if (series.length < 2) return { slope: null, points: series.length };
  const slice = series.slice(-windowMinutes);
  const n = slice.length;
  if (n < 2) return { slope: null, points: n };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = slice[i]!.cumulative;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, points: n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  return { slope, points: n };
}

/**
 * Detects whether the cumulative crossed zero inside the trailing
 * `lookbackMinutes` window. Reports the timestamp of the first crossing
 * inside the window, plus the largest abs(value) seen inside the window
 * (a proxy for "how decisive was the flip").
 *
 * `currentSign` is always populated (even when no flip occurred) so
 * the UI can color the latest value without a separate query.
 */
export function recentFlip(
  series: FlowPoint[],
  lookbackMinutes = 30,
): FlipResult {
  if (series.length === 0) {
    return {
      occurred: false,
      atTimestamp: null,
      magnitude: 0,
      currentSign: 0,
    };
  }

  const slice = series.slice(-lookbackMinutes);
  const last = slice.at(-1)!.cumulative;
  const currentSign: Sign = last > 0 ? 1 : last < 0 ? -1 : 0;

  let occurred = false;
  let atTimestamp: string | null = null;
  let magnitude = Math.abs(last);
  let prevSign: number | null = null;

  for (const pt of slice) {
    if (Math.abs(pt.cumulative) > magnitude)
      magnitude = Math.abs(pt.cumulative);
    const s = pt.cumulative > 0 ? 1 : pt.cumulative < 0 ? -1 : 0;
    if (prevSign !== null && s !== 0 && prevSign !== 0 && s !== prevSign) {
      if (!occurred) {
        occurred = true;
        atTimestamp = pt.timestamp;
      }
    }
    if (s !== 0) prevSign = s;
  }

  return { occurred, atTimestamp, magnitude, currentSign };
}

/**
 * Returns the largest abs(Δcumulative) over a `windowMinutes` trailing
 * window, but only considers windows whose ending timestamp lies inside
 * the `[startCtHour:00, endCtHour:00)` power-hour band (default 14:00–15:00
 * CT, i.e. 19:00–20:00 UTC during CDT, 20:00–21:00 UTC during CST).
 *
 * `nowUtcOffsetMinutes` is the offset that converts UTC → CT. Pass `-300`
 * during CDT (UTC-5) or `-360` during CST (UTC-6). The endpoint computes
 * this from the row's own timestamp via `Date#getTimezoneOffset`-style
 * adjustment so DST is handled by the JS runtime.
 *
 * If no qualifying window is present (e.g. session hasn't reached 14:00 CT),
 * returns `{ magnitude: 0, atTimestamp: null }`.
 */
export function lateDayCliff(
  series: FlowPoint[],
  windowMinutes = 10,
  startCtHour = 14,
  endCtHour = 15,
): CliffResult {
  if (series.length < windowMinutes + 1) {
    return { magnitude: 0, atTimestamp: null };
  }

  let bestMag = 0;
  let bestTs: string | null = null;

  for (let i = windowMinutes; i < series.length; i++) {
    const end = series[i]!;
    const endDate = new Date(end.timestamp);
    if (Number.isNaN(endDate.getTime())) continue;
    const ctHour = ctHourFromUtc(endDate);
    if (ctHour < startCtHour || ctHour >= endCtHour) continue;

    const start = series[i - windowMinutes]!;
    const delta = Math.abs(end.cumulative - start.cumulative);
    if (delta > bestMag) {
      bestMag = delta;
      bestTs = end.timestamp;
    }
  }

  return { magnitude: bestMag, atTimestamp: bestTs };
}

/**
 * Sign-disagreement check for the same field across SPY and QQQ. Both
 * inputs are the LATEST cumulative value (use `series.at(-1)?.cumulative`
 * before calling). A 0 on either side means "not yet established" — not
 * a divergence.
 */
export function divergence(
  spyCum: number | null | undefined,
  qqqCum: number | null | undefined,
): DivergenceResult {
  const spySign = signOf(spyCum);
  const qqqSign = signOf(qqqCum);
  const diverging = spySign !== 0 && qqqSign !== 0 && spySign !== qqqSign;
  return { spySign, qqqSign, diverging };
}

function signOf(value: number | null | undefined): Sign {
  if (value == null || !Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? 1 : -1;
}

/**
 * Convert a UTC Date to its hour in America/Chicago, accounting for DST.
 * Uses Intl.DateTimeFormat which respects the runtime's tz database —
 * the same approach already in use across `src/utils/timezone.ts`.
 */
function ctHourFromUtc(date: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false,
  });
  const part = fmt.formatToParts(date).find((p) => p.type === 'hour');
  if (!part) return -1;
  const h = Number.parseInt(part.value, 10);
  // Intl returns "24" for midnight in some locales — clamp.
  return h === 24 ? 0 : h;
}
