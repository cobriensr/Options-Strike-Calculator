/**
 * Pre-computed VIX → SPX daily range statistics.
 * Source: 9,102 matched trading days, Jan 1990 – Mar 2026.
 * VIX open price matched to same-day SPX OHLC.
 */

// ============================================================
// VIX BUCKET STATS (broad buckets for summary display)
// ============================================================

export interface VIXBucket {
  readonly label: string;
  readonly lo: number;
  readonly hi: number;
  readonly count: number;
  readonly medHL: number; // median high-low range %
  readonly avgHL: number; // avg high-low range %
  readonly p90HL: number; // 90th pctile high-low %
  readonly medOC: number; // median open-close absolute %
  readonly avgOC: number; // avg open-close %
  readonly p90OC: number; // 90th pctile open-close %
  readonly over1HL: number; // % of days with H-L range > 1%
  readonly over2HL: number; // % of days with H-L range > 2%
  readonly over1OC: number; // % of days with O-C > 1%
  readonly zone: 'go' | 'caution' | 'stop' | 'danger';
}

export const VIX_BUCKETS: readonly VIXBucket[] = [
  {
    label: 'VIX <12',
    lo: 0,
    hi: 12,
    count: 806,
    medHL: 0.54,
    avgHL: 0.62,
    p90HL: 1.03,
    medOC: 0.24,
    avgOC: 0.34,
    p90OC: 0.76,
    over1HL: 11.2,
    over2HL: 0.1,
    over1OC: 4.7,
    zone: 'go',
  },
  {
    label: 'VIX 12\u201315',
    lo: 12,
    hi: 15,
    count: 2075,
    medHL: 0.68,
    avgHL: 0.76,
    p90HL: 1.22,
    medOC: 0.31,
    avgOC: 0.41,
    p90OC: 0.92,
    over1HL: 19.8,
    over2HL: 0.8,
    over1OC: 7.4,
    zone: 'go',
  },
  {
    label: 'VIX 15\u201318',
    lo: 15,
    hi: 18,
    count: 1862,
    medHL: 0.87,
    avgHL: 0.95,
    p90HL: 1.5,
    medOC: 0.41,
    avgOC: 0.54,
    p90OC: 1.17,
    over1HL: 38.2,
    over2HL: 3.0,
    over1OC: 14.7,
    zone: 'go',
  },
  {
    label: 'VIX 18\u201320',
    lo: 18,
    hi: 20,
    count: 918,
    medHL: 1.08,
    avgHL: 1.17,
    p90HL: 1.81,
    medOC: 0.57,
    avgOC: 0.69,
    p90OC: 1.47,
    over1HL: 57.5,
    over2HL: 6.2,
    over1OC: 24.2,
    zone: 'caution',
  },
  {
    label: 'VIX 20\u201325',
    lo: 20,
    hi: 25,
    count: 1827,
    medHL: 1.31,
    avgHL: 1.44,
    p90HL: 2.28,
    medOC: 0.66,
    avgOC: 0.82,
    p90OC: 1.72,
    over1HL: 73.3,
    over2HL: 16.0,
    over1OC: 32.3,
    zone: 'caution',
  },
  {
    label: 'VIX 25\u201330',
    lo: 25,
    hi: 30,
    count: 864,
    medHL: 1.7,
    avgHL: 1.84,
    p90HL: 2.85,
    medOC: 0.85,
    avgOC: 1.05,
    p90OC: 2.29,
    over1HL: 89.4,
    over2HL: 35.2,
    over1OC: 43.2,
    zone: 'stop',
  },
  {
    label: 'VIX 30\u201340',
    lo: 30,
    hi: 40,
    count: 529,
    medHL: 2.17,
    avgHL: 2.34,
    p90HL: 3.73,
    medOC: 1.08,
    avgOC: 1.39,
    p90OC: 3.0,
    over1HL: 96.4,
    over2HL: 57.7,
    over1OC: 52.9,
    zone: 'danger',
  },
  {
    label: 'VIX 40+',
    lo: 40,
    hi: 999,
    count: 221,
    medHL: 3.62,
    avgHL: 4.08,
    p90HL: 7.16,
    medOC: 2.0,
    avgOC: 2.45,
    p90OC: 5.09,
    over1HL: 98.6,
    over2HL: 87.8,
    over1OC: 73.3,
    zone: 'danger',
  },
] as const;

// ============================================================
// IRON CONDOR SURVIVAL RATES
// ============================================================

export interface SurvivalData {
  readonly wing: number;
  readonly label: string;
  readonly settle: readonly number[];
  readonly intraday: readonly number[];
}

export const SURVIVAL_DATA: readonly SurvivalData[] = [
  {
    wing: 0.5,
    label: '\u00B10.50%',
    settle: [76.6, 69.4, 57.2, 45.6, 39.2, 31.1, 21.6, 11.8],
    intraday: [88.8, 80.2, 61.8, 42.5, 26.7, 10.6, 3.6, 1.4],
  },
  {
    wing: 0.75,
    label: '\u00B10.75%',
    settle: [89.5, 83.6, 74.3, 62.6, 54.8, 46.3, 34.8, 19.5],
    intraday: [98.6, 96.3, 90.1, 79.2, 62.7, 37.5, 17.6, 2.7],
  },
  {
    wing: 1.0,
    label: '\u00B11.00%',
    settle: [95.3, 92.6, 85.3, 75.8, 67.7, 56.8, 47.1, 26.7],
    intraday: [99.9, 99.2, 97.0, 93.8, 84.0, 64.8, 42.3, 12.2],
  },
  {
    wing: 1.25,
    label: '\u00B11.25%',
    settle: [98.4, 96.6, 91.7, 84.6, 78.7, 66.2, 54.8, 33.5],
    intraday: [100, 99.9, 99.2, 98.0, 93.3, 81.8, 66.7, 21.3],
  },
  {
    wing: 1.5,
    label: '\u00B11.50%',
    settle: [99.8, 98.4, 95.2, 91.3, 85.2, 73.8, 62.6, 39.4],
    intraday: [100, 100, 99.7, 99.6, 97.5, 92.4, 80.0, 33.0],
  },
  {
    wing: 2.0,
    label: '\u00B12.00%',
    settle: [99.9, 99.7, 98.9, 97.6, 93.8, 86.1, 77.5, 49.8],
    intraday: [100, 100, 100, 99.9, 99.6, 99.0, 92.6, 62.0],
  },
] as const;

// ============================================================
// FINE-GRAINED VIX STATS (per-point, VIX 10–30)
// ============================================================

export interface FineVIXStat {
  readonly vix: number;
  readonly count: number;
  readonly medHL: number;
  readonly p90HL: number;
  readonly medOC: number;
  readonly p90OC: number;
  readonly over2: number; // % of days with H-L > 2%
}

export const FINE_VIX_STATS: readonly FineVIXStat[] = [
  {
    vix: 10,
    count: 207,
    medHL: 0.51,
    p90HL: 0.94,
    medOC: 0.19,
    p90OC: 0.69,
    over2: 0.5,
  },
  {
    vix: 11,
    count: 529,
    medHL: 0.59,
    p90HL: 1.09,
    medOC: 0.26,
    p90OC: 0.86,
    over2: 0.0,
  },
  {
    vix: 12,
    count: 742,
    medHL: 0.62,
    p90HL: 1.12,
    medOC: 0.27,
    p90OC: 0.85,
    over2: 0.3,
  },
  {
    vix: 13,
    count: 735,
    medHL: 0.69,
    p90HL: 1.21,
    medOC: 0.31,
    p90OC: 0.91,
    over2: 0.8,
  },
  {
    vix: 14,
    count: 598,
    medHL: 0.76,
    p90HL: 1.34,
    medOC: 0.37,
    p90OC: 1.01,
    over2: 1.5,
  },
  {
    vix: 15,
    count: 636,
    medHL: 0.83,
    p90HL: 1.42,
    medOC: 0.41,
    p90OC: 1.12,
    over2: 2.4,
  },
  {
    vix: 16,
    count: 684,
    medHL: 0.86,
    p90HL: 1.49,
    medOC: 0.41,
    p90OC: 1.14,
    over2: 2.9,
  },
  {
    vix: 17,
    count: 542,
    medHL: 0.92,
    p90HL: 1.58,
    medOC: 0.41,
    p90OC: 1.24,
    over2: 3.9,
  },
  {
    vix: 18,
    count: 435,
    medHL: 1.09,
    p90HL: 1.8,
    medOC: 0.54,
    p90OC: 1.47,
    over2: 5.5,
  },
  {
    vix: 19,
    count: 483,
    medHL: 1.08,
    p90HL: 1.85,
    medOC: 0.57,
    p90OC: 1.47,
    over2: 6.8,
  },
  {
    vix: 20,
    count: 426,
    medHL: 1.25,
    p90HL: 2.05,
    medOC: 0.68,
    p90OC: 1.49,
    over2: 11.0,
  },
  {
    vix: 21,
    count: 405,
    medHL: 1.22,
    p90HL: 2.1,
    medOC: 0.59,
    p90OC: 1.67,
    over2: 12.3,
  },
  {
    vix: 22,
    count: 378,
    medHL: 1.29,
    p90HL: 2.22,
    medOC: 0.63,
    p90OC: 1.73,
    over2: 14.8,
  },
  {
    vix: 23,
    count: 317,
    medHL: 1.39,
    p90HL: 2.4,
    medOC: 0.7,
    p90OC: 1.79,
    over2: 20.8,
  },
  {
    vix: 24,
    count: 301,
    medHL: 1.51,
    p90HL: 2.54,
    medOC: 0.74,
    p90OC: 2.02,
    over2: 24.6,
  },
  {
    vix: 25,
    count: 246,
    medHL: 1.62,
    p90HL: 2.69,
    medOC: 0.75,
    p90OC: 2.23,
    over2: 28.5,
  },
  {
    vix: 26,
    count: 177,
    medHL: 1.59,
    p90HL: 2.81,
    medOC: 0.85,
    p90OC: 1.98,
    over2: 28.8,
  },
  {
    vix: 27,
    count: 159,
    medHL: 1.81,
    p90HL: 3.04,
    medOC: 0.9,
    p90OC: 2.48,
    over2: 40.9,
  },
  {
    vix: 28,
    count: 160,
    medHL: 1.77,
    p90HL: 2.96,
    medOC: 0.86,
    p90OC: 2.35,
    over2: 38.1,
  },
  {
    vix: 29,
    count: 122,
    medHL: 1.97,
    p90HL: 2.76,
    medOC: 1.08,
    p90OC: 2.28,
    over2: 46.7,
  },
  {
    vix: 30,
    count: 91,
    medHL: 1.88,
    p90HL: 3.23,
    medOC: 1.2,
    p90OC: 2.62,
    over2: 48.4,
  },
] as const;

// ============================================================
// HELPERS
// ============================================================

/**
 * Find the VIX bucket a given VIX level falls into.
 */
export function findBucket(vix: number): VIXBucket | null {
  return VIX_BUCKETS.find((b) => vix >= b.lo && vix < b.hi) ?? null;
}

/**
 * Find the fine-grained stat for a given VIX level (floored to integer).
 */
export function findFineStat(vix: number): FineVIXStat | null {
  const floored = Math.floor(vix);
  return FINE_VIX_STATS.find((s) => s.vix === floored) ?? null;
}

/**
 * Get survival rates for a given VIX level and wing width.
 * Returns settlement and intraday survival percentages.
 */
export function getSurvival(
  vix: number,
  wingPct: number,
): { settle: number; intraday: number } | null {
  const bucketIdx = VIX_BUCKETS.findIndex((b) => vix >= b.lo && vix < b.hi);
  const survRow = SURVIVAL_DATA.find((s) => s.wing === wingPct);
  if (bucketIdx === -1 || !survRow) return null;
  const settle = survRow.settle[bucketIdx];
  const intraday = survRow.intraday[bucketIdx];
  if (settle === undefined || intraday === undefined) return null;
  return { settle, intraday };
}

/** Result of interpolated range estimation */
export interface RangeEstimate {
  readonly medHL: number;
  readonly medOC: number;
  readonly p90HL: number;
  readonly p90OC: number;
}

/**
 * Interpolate all 4 range thresholds for any VIX value.
 * Uses fine-grained per-point data (VIX 10–30) with linear interpolation.
 * Clamps to VIX 10 below and VIX 30 above.
 * Falls back to bucket stats for VIX > 30.
 */
export function estimateRange(vix: number): RangeEstimate {
  // For VIX > 30, use bucket stats (fine-grained data doesn't cover it)
  if (vix > 30) {
    const bucket = findBucket(vix);
    if (bucket) {
      return {
        medHL: bucket.medHL,
        medOC: bucket.medOC,
        p90HL: bucket.p90HL,
        p90OC: bucket.p90OC,
      };
    }
  }

  const clamped = Math.max(10, Math.min(30, vix));
  const lo = FINE_VIX_STATS.find((s) => s.vix === Math.floor(clamped));
  const hi = FINE_VIX_STATS.find((s) => s.vix === Math.ceil(clamped));
  if (!lo || !hi || lo.vix === hi.vix) {
    const stat = lo ?? hi ?? FINE_VIX_STATS[0]!;
    return {
      medHL: stat.medHL,
      medOC: stat.medOC,
      p90HL: stat.p90HL,
      p90OC: stat.p90OC,
    };
  }
  const frac = clamped - lo.vix;
  return {
    medHL: lo.medHL + (hi.medHL - lo.medHL) * frac,
    medOC: lo.medOC + (hi.medOC - lo.medOC) * frac,
    p90HL: lo.p90HL + (hi.p90HL - lo.p90HL) * frac,
    p90OC: lo.p90OC + (hi.p90OC - lo.p90OC) * frac,
  };
}

/** Total matched days in the dataset */
export const TOTAL_MATCHED_DAYS = 9102;

/** Correlation coefficients */
export const CORRELATIONS = {
  vixToHL: 0.7371,
  vixToOC: 0.5244,
} as const;

// ============================================================
// DAY-OF-WEEK ADJUSTMENT DATA
// ============================================================
// Source: 9,107 SPX trading days (1990–2026), matched with VIX.
// Multipliers = day's median range / weekly average median range.
// 0=Monday through 4=Friday.

export interface DayOfWeekStats {
  readonly day: number; // 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri
  readonly label: string;
  readonly shortLabel: string;
  readonly count: number;
  readonly medHL: number;
  readonly p90HL: number;
  readonly medOC: number;
  readonly p90OC: number;
  readonly over2HL: number; // % of days with H-L > 2%
  readonly multHL: number; // multiplier vs weekly average
  readonly multOC: number;
}

/** Day-of-week stats for all VIX levels */
export const DOW_STATS_ALL: readonly DayOfWeekStats[] = [
  {
    day: 0,
    label: 'Monday',
    shortLabel: 'Mon',
    count: 1716,
    medHL: 0.95,
    p90HL: 2.22,
    medOC: 0.46,
    p90OC: 1.61,
    over2HL: 13.0,
    multHL: 0.942,
    multOC: 0.958,
  },
  {
    day: 1,
    label: 'Tuesday',
    shortLabel: 'Tue',
    count: 1869,
    medHL: 1.01,
    p90HL: 2.18,
    medOC: 0.5,
    p90OC: 1.57,
    over2HL: 12.5,
    multHL: 1.005,
    multOC: 1.047,
  },
  {
    day: 2,
    label: 'Wednesday',
    shortLabel: 'Wed',
    count: 1866,
    medHL: 1.02,
    p90HL: 2.25,
    medOC: 0.46,
    p90OC: 1.5,
    over2HL: 14.1,
    multHL: 1.012,
    multOC: 0.951,
  },
  {
    day: 3,
    label: 'Thursday',
    shortLabel: 'Thu',
    count: 1832,
    medHL: 1.04,
    p90HL: 2.27,
    medOC: 0.5,
    p90OC: 1.61,
    over2HL: 13.5,
    multHL: 1.038,
    multOC: 1.037,
  },
  {
    day: 4,
    label: 'Friday',
    shortLabel: 'Fri',
    count: 1824,
    medHL: 1.01,
    p90HL: 2.27,
    medOC: 0.49,
    p90OC: 1.64,
    over2HL: 14.2,
    multHL: 1.003,
    multOC: 1.007,
  },
] as const;

/** Day-of-week stats for VIX < 18 */
export const DOW_STATS_LOW_VIX: readonly DayOfWeekStats[] = [
  {
    day: 0,
    label: 'Monday',
    shortLabel: 'Mon',
    count: 860,
    medHL: 0.66,
    p90HL: 1.21,
    medOC: 0.29,
    p90OC: 0.9,
    over2HL: 1.0,
    multHL: 0.905,
    multOC: 0.874,
  },
  {
    day: 1,
    label: 'Tuesday',
    shortLabel: 'Tue',
    count: 970,
    medHL: 0.74,
    p90HL: 1.32,
    medOC: 0.34,
    p90OC: 0.99,
    over2HL: 1.0,
    multHL: 1.025,
    multOC: 1.013,
  },
  {
    day: 2,
    label: 'Wednesday',
    shortLabel: 'Wed',
    count: 970,
    medHL: 0.75,
    p90HL: 1.35,
    medOC: 0.32,
    p90OC: 1.03,
    over2HL: 2.4,
    multHL: 1.034,
    multOC: 0.969,
  },
  {
    day: 3,
    label: 'Thursday',
    shortLabel: 'Thu',
    count: 964,
    medHL: 0.75,
    p90HL: 1.37,
    medOC: 0.35,
    p90OC: 1.02,
    over2HL: 1.8,
    multHL: 1.04,
    multOC: 1.063,
  },
  {
    day: 4,
    label: 'Friday',
    shortLabel: 'Fri',
    count: 979,
    medHL: 0.72,
    p90HL: 1.36,
    medOC: 0.36,
    p90OC: 1.0,
    over2HL: 1.5,
    multHL: 0.996,
    multOC: 1.081,
  },
] as const;

/** Day-of-week stats for VIX 18-25 */
export const DOW_STATS_MID_VIX: readonly DayOfWeekStats[] = [
  {
    day: 0,
    label: 'Monday',
    shortLabel: 'Mon',
    count: 539,
    medHL: 1.19,
    p90HL: 2.05,
    medOC: 0.59,
    p90OC: 1.59,
    over2HL: 11.5,
    multHL: 0.966,
    multOC: 0.942,
  },
  {
    day: 1,
    label: 'Tuesday',
    shortLabel: 'Tue',
    count: 562,
    medHL: 1.23,
    p90HL: 2.14,
    medOC: 0.67,
    p90OC: 1.58,
    over2HL: 11.7,
    multHL: 0.994,
    multOC: 1.061,
  },
  {
    day: 2,
    label: 'Wednesday',
    shortLabel: 'Wed',
    count: 572,
    medHL: 1.22,
    p90HL: 2.13,
    medOC: 0.61,
    p90OC: 1.57,
    over2HL: 13.1,
    multHL: 0.987,
    multOC: 0.973,
  },
  {
    day: 3,
    label: 'Thursday',
    shortLabel: 'Thu',
    count: 551,
    medHL: 1.26,
    p90HL: 2.1,
    medOC: 0.62,
    p90OC: 1.58,
    over2HL: 11.8,
    multHL: 1.021,
    multOC: 0.985,
  },
  {
    day: 4,
    label: 'Friday',
    shortLabel: 'Fri',
    count: 521,
    medHL: 1.27,
    p90HL: 2.33,
    medOC: 0.65,
    p90OC: 1.73,
    over2HL: 15.7,
    multHL: 1.032,
    multOC: 1.04,
  },
] as const;

/** Day-of-week stats for VIX 25+ */
export const DOW_STATS_HIGH_VIX: readonly DayOfWeekStats[] = [
  {
    day: 0,
    label: 'Monday',
    shortLabel: 'Mon',
    count: 317,
    medHL: 1.9,
    p90HL: 3.97,
    medOC: 0.98,
    p90OC: 3.17,
    over2HL: 47.9,
    multHL: 0.956,
    multOC: 0.97,
  },
  {
    day: 1,
    label: 'Tuesday',
    shortLabel: 'Tue',
    count: 336,
    medHL: 1.95,
    p90HL: 3.83,
    medOC: 0.98,
    p90OC: 3.01,
    over2HL: 47.0,
    multHL: 0.981,
    multOC: 0.969,
  },
  {
    day: 2,
    label: 'Wednesday',
    shortLabel: 'Wed',
    count: 323,
    medHL: 2.02,
    p90HL: 3.77,
    medOC: 0.97,
    p90OC: 2.8,
    over2HL: 51.1,
    multHL: 1.015,
    multOC: 0.953,
  },
  {
    day: 3,
    label: 'Thursday',
    shortLabel: 'Thu',
    count: 317,
    medHL: 2.06,
    p90HL: 3.9,
    medOC: 1.14,
    p90OC: 3.01,
    over2HL: 52.4,
    multHL: 1.035,
    multOC: 1.12,
  },
  {
    day: 4,
    label: 'Friday',
    shortLabel: 'Fri',
    count: 321,
    medHL: 2.02,
    p90HL: 3.59,
    medOC: 1.0,
    p90OC: 2.44,
    over2HL: 50.5,
    multHL: 1.013,
    multOC: 0.988,
  },
] as const;

/**
 * Get the day-of-week multiplier for range thresholds.
 * Selects the appropriate VIX regime table and returns the multiplier
 * for the given day (0=Mon through 4=Fri).
 * Multipliers are relative to the weekly average: <1 means quieter, >1 means wider.
 */
export function getDowMultiplier(
  vix: number,
  dayOfWeek: number,
): { multHL: number; multOC: number; dayLabel: string; dayShort: string } {
  const clamped = Math.max(0, Math.min(4, dayOfWeek));
  const table =
    vix < 18
      ? DOW_STATS_LOW_VIX
      : vix < 25
        ? DOW_STATS_MID_VIX
        : DOW_STATS_HIGH_VIX;
  const row = table[clamped]!;
  return {
    multHL: row.multHL,
    multOC: row.multOC,
    dayLabel: row.label,
    dayShort: row.shortLabel,
  };
}

/**
 * Get today's day of week (0=Mon through 4=Fri).
 * Returns null on weekends.
 */
export function getTodayDow(): number | null {
  const jsDay = new Date().getDay(); // 0=Sun, 1=Mon ... 6=Sat
  if (jsDay === 0 || jsDay === 6) return null;
  return jsDay - 1; // convert to 0=Mon
}

// ============================================================
// VOLATILITY CLUSTERING DATA
// ============================================================
// Source: 9,107 SPX trading days (1990–2026).
// When yesterday's H-L range falls in a given percentile bucket,
// today's expected range shifts by these multipliers (vs overall median).

export interface ClusterBucket {
  readonly label: string;
  readonly pctileLo: number; // lower percentile bound (0, 50, 75, 90)
  readonly pctileHi: number; // upper percentile bound (50, 75, 90, 100)
  readonly mult: number; // today's range multiplier vs unconditional median
}

/** Clustering multipliers for VIX < 18 */
export const CLUSTER_LOW_VIX: readonly ClusterBucket[] = [
  { label: 'Calm (<p50)', pctileLo: 0, pctileHi: 50, mult: 0.914 },
  { label: 'Normal (p50–p75)', pctileLo: 50, pctileHi: 75, mult: 1.005 },
  { label: 'Active (p75–p90)', pctileLo: 75, pctileHi: 90, mult: 1.103 },
  { label: 'Hot (>p90)', pctileLo: 90, pctileHi: 100, mult: 1.235 },
] as const;

/** Clustering multipliers for VIX 18–25 */
export const CLUSTER_MID_VIX: readonly ClusterBucket[] = [
  { label: 'Calm (<p50)', pctileLo: 0, pctileHi: 50, mult: 0.956 },
  { label: 'Normal (p50–p75)', pctileLo: 50, pctileHi: 75, mult: 0.969 },
  { label: 'Active (p75–p90)', pctileLo: 75, pctileHi: 90, mult: 1.039 },
  { label: 'Hot (>p90)', pctileLo: 90, pctileHi: 100, mult: 1.203 },
] as const;

/** Clustering multipliers for VIX 25+ */
export const CLUSTER_HIGH_VIX: readonly ClusterBucket[] = [
  { label: 'Calm (<p50)', pctileLo: 0, pctileHi: 50, mult: 0.895 },
  { label: 'Normal (p50–p75)', pctileLo: 50, pctileHi: 75, mult: 0.976 },
  { label: 'Active (p75–p90)', pctileLo: 75, pctileHi: 90, mult: 1.192 },
  { label: 'Hot (>p90)', pctileLo: 90, pctileHi: 100, mult: 1.872 },
] as const;

/** Reference percentile thresholds (H-L %) for classifying yesterday's range */
export const CLUSTER_THRESHOLDS = {
  lowVix: { p50: 0.73, p75: 1.01, p90: 1.32 },
  midVix: { p50: 1.24, p75: 1.64, p90: 2.15 },
  highVix: { p50: 1.99, p75: 2.74, p90: 3.78 },
} as const;

export interface ClusterResult {
  readonly bucket: ClusterBucket;
  readonly mult: number;
  readonly yesterdayPctile: string; // which percentile bucket yesterday fell in
  readonly regime: string; // VIX regime label
}

/**
 * Given yesterday's SPX H-L range (%) and today's VIX, compute the
 * volatility clustering multiplier for today's expected range.
 */
export function getClusterMultiplier(
  vix: number,
  yesterdayHLPct: number,
): ClusterResult {
  const regime = vix < 18 ? 'lowVix' : vix < 25 ? 'midVix' : 'highVix';
  const thresholds = CLUSTER_THRESHOLDS[regime];
  const table =
    vix < 18 ? CLUSTER_LOW_VIX : vix < 25 ? CLUSTER_MID_VIX : CLUSTER_HIGH_VIX;
  const regimeLabel =
    vix < 18 ? 'VIX <18' : vix < 25 ? 'VIX 18\u201325' : 'VIX 25+';

  let bucketIdx: number;
  if (yesterdayHLPct < thresholds.p50) {
    bucketIdx = 0;
  } else if (yesterdayHLPct < thresholds.p75) {
    bucketIdx = 1;
  } else if (yesterdayHLPct < thresholds.p90) {
    bucketIdx = 2;
  } else {
    bucketIdx = 3;
  }

  const bucket = table[bucketIdx]!;
  return {
    bucket,
    mult: bucket.mult,
    yesterdayPctile: bucket.label,
    regime: regimeLabel,
  };
}
