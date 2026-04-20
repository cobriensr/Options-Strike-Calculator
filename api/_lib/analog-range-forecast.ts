import { getDb } from './db.js';
import { generateEmbedding } from './embeddings.js';

/**
 * Analog range forecast — per-morning cohort-conditional distribution of
 * expected daily range, upside excursion, and downside excursion, sourced
 * from the 15 text-embedding-nearest historical mornings.
 *
 * This is the production consumer of the day_embeddings + OHLC backfill.
 * The validation work in `scripts/compare-analog-backends.mjs` showed
 * that text-embedding cohorts produce nearly-calibrated range forecasts
 * (cohort p90 hits 78% of actuals on 2024-2026 n=563, target 80%) — and
 * meaningfully capture SPX's left-tail asymmetry (down p80 > up p80).
 *
 * The output shape is designed to give the analyze-endpoint prompt the
 * two numbers a 0DTE condor trader actually cares about: where ~30-delta
 * and ~12-delta short strikes would sit based on historically-similar
 * sessions, rather than a fixed percentage of spot or global
 * unconditional distribution (which was dramatically miscalibrated in
 * 2024-2026 vs the pre-2024 archive).
 *
 * Phase 4: when the caller passes today's VIX bucket, a SECOND cohort
 * is retrieved filtered to same-regime analogs only. Both are returned
 * so Claude can prefer regime-matched when the subset is healthy
 * (≥ MIN_REGIME_COHORT rows) and fall back to the unstratified cohort
 * otherwise.
 *
 * Temporal leakage guard: candidate pool strictly `date < targetDate`.
 * Fail-open: null forecast drops the block from the analyze context, so
 * an outage in OpenAI/Neon cannot block an analyze call.
 */

const COHORT_SIZE = 15;
const QUANTILES = [0.5, 0.85, 0.9, 0.95] as const;
/** Below this many regime-matched rows, the subset is statistically
 *  too thin to trust — forecast falls back to the unstratified cohort. */
const MIN_REGIME_COHORT = 8;

type Q = (typeof QUANTILES)[number];

export type VixBucket = 'low' | 'normal' | 'elevated' | 'crisis';

export interface CohortQuantiles {
  n: number;
  range: Record<Q, number>;
  upExc: Record<Q, number>;
  downExc: Record<Q, number>;
}

export interface RangeForecast {
  targetDate: string;
  /** Unstratified cohort — 15 text-nearest mornings across all regimes. */
  cohort: CohortQuantiles;
  /** Same-VIX-bucket cohort, null when bucket wasn't supplied OR when
   *  the filtered subset was too thin (<MIN_REGIME_COHORT rows) to be
   *  statistically trustworthy. */
  regimeMatched: (CohortQuantiles & { vixBucket: VixBucket }) | null;
  /** Asymmetric strike hints. Uses regime-matched when available,
   *  unstratified otherwise. p85 ≈ 30Δ, p95 ≈ 12Δ. */
  strikes: {
    condor30d: { up: number; down: number };
    condor12d: { up: number; down: number };
    source: 'regime-matched' | 'unstratified';
  };
}

interface AnalogRow {
  date: string;
  range_pt: number;
  up_exc: number;
  down_exc: number;
}

/** Bucket the current VIX close into one of the four regime tags used
 *  for day_embeddings.vix_bucket. Cut-points match the validation
 *  harness and the system-prompt tier language. */
export function vixBucketOf(
  vixClose: number | null | undefined,
): VixBucket | null {
  if (!Number.isFinite(vixClose)) return null;
  const v = vixClose as number;
  if (v < 15) return 'low';
  if (v < 22) return 'normal';
  if (v < 30) return 'elevated';
  return 'crisis';
}

/** Pick percentile from a sorted-ascending numeric array. Linear interp.
 * `sorted[lo]` / `sorted[hi]` are bounds-safe: `lo` ≤ `hi` ≤ length-1 by
 * construction from `(length-1) * p` with p ∈ [0,1]. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0] as number;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] as number;
  const hiVal = sorted[hi] as number;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

function summarizeRows(rows: AnalogRow[]): CohortQuantiles | null {
  const ranges = rows.map((r) => Number(r.range_pt)).filter(Number.isFinite);
  const ups = rows.map((r) => Number(r.up_exc)).filter(Number.isFinite);
  const downs = rows.map((r) => Number(r.down_exc)).filter(Number.isFinite);
  if (ranges.length === 0) return null;
  const range = {} as Record<Q, number>;
  const upExc = {} as Record<Q, number>;
  const downExc = {} as Record<Q, number>;
  const rSorted = [...ranges].sort((a, b) => a - b);
  const uSorted = [...ups].sort((a, b) => a - b);
  const dSorted = [...downs].sort((a, b) => a - b);
  for (const q of QUANTILES) {
    range[q] = percentile(rSorted, q);
    upExc[q] = percentile(uSorted, q);
    downExc[q] = percentile(dSorted, q);
  }
  return { n: rows.length, range, upExc, downExc };
}

/**
 * Retrieve text-embedding-nearest historical mornings and compute cohort
 * quantiles for range + asymmetric excursion. When `vixBucket` is
 * supplied, a second regime-matched cohort is also retrieved.
 *
 * @param targetDate     ISO date (YYYY-MM-DD) for leakage guard
 * @param targetSummary  Prediction-time summary (first-hour only)
 * @param vixBucket      Optional today's VIX regime. When supplied and
 *                       the filtered subset is healthy, strike hints
 *                       come from the regime-matched cohort.
 * @returns null if OpenAI fails, if no analogs exist, or if cohort
 *          ranges are entirely missing (backfill incomplete)
 */
export async function getRangeForecast(
  targetDate: string,
  targetSummary: string,
  vixBucket?: VixBucket | null,
): Promise<RangeForecast | null> {
  const embedding = await generateEmbedding(targetSummary);
  if (!embedding) return null;

  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;

  const unstratifiedRows = (await sql`
    SELECT date, range_pt, up_exc, down_exc
    FROM day_embeddings
    WHERE date < ${targetDate}::date
      AND range_pt IS NOT NULL
      AND up_exc IS NOT NULL
      AND down_exc IS NOT NULL
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${COHORT_SIZE}
  `) as unknown as AnalogRow[];

  if (unstratifiedRows.length === 0) return null;
  const cohort = summarizeRows(unstratifiedRows);
  if (!cohort) return null;

  let regimeMatched: RangeForecast['regimeMatched'] = null;
  if (vixBucket) {
    const regimeRows = (await sql`
      SELECT date, range_pt, up_exc, down_exc
      FROM day_embeddings
      WHERE date < ${targetDate}::date
        AND range_pt IS NOT NULL
        AND up_exc IS NOT NULL
        AND down_exc IS NOT NULL
        AND vix_bucket = ${vixBucket}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${COHORT_SIZE}
    `) as unknown as AnalogRow[];
    if (regimeRows.length >= MIN_REGIME_COHORT) {
      const r = summarizeRows(regimeRows);
      if (r) regimeMatched = { ...r, vixBucket };
    }
  }

  // Strike hints prefer regime-matched (higher confidence in the current
  // vol regime) but transparently fall back when it's absent/too thin.
  const strikeSource: 'regime-matched' | 'unstratified' = regimeMatched
    ? 'regime-matched'
    : 'unstratified';
  const sourceQuantiles = regimeMatched ?? cohort;

  return {
    targetDate,
    cohort,
    regimeMatched,
    strikes: {
      condor30d: {
        up: sourceQuantiles.upExc[0.85],
        down: sourceQuantiles.downExc[0.85],
      },
      condor12d: {
        up: sourceQuantiles.upExc[0.95],
        down: sourceQuantiles.downExc[0.95],
      },
      source: strikeSource,
    },
  };
}

/** Format the forecast for inclusion in the analyze prompt. Emits null
 *  if the forecast is null — caller concatenates conditionally. */
export function formatRangeForecast(f: RangeForecast | null): string | null {
  if (!f) return null;
  const lines: string[] = [];
  lines.push(
    `Historical analog range forecast (n=${f.cohort.n} text-nearest mornings before ${f.targetDate}):`,
    `  Expected daily range — p50: ${f.cohort.range[0.5].toFixed(1)}pt | p85: ${f.cohort.range[0.85].toFixed(1)}pt | p95: ${f.cohort.range[0.95].toFixed(1)}pt`,
    `  Upside excursion (high − open) — p85: ${f.cohort.upExc[0.85].toFixed(1)}pt | p95: ${f.cohort.upExc[0.95].toFixed(1)}pt`,
    `  Downside excursion (open − low) — p85: ${f.cohort.downExc[0.85].toFixed(1)}pt | p95: ${f.cohort.downExc[0.95].toFixed(1)}pt`,
  );
  if (f.regimeMatched) {
    lines.push(
      `Regime-matched cohort (n=${f.regimeMatched.n} same-VIX-bucket [${f.regimeMatched.vixBucket}] mornings):`,
      `  Range — p50: ${f.regimeMatched.range[0.5].toFixed(1)}pt | p85: ${f.regimeMatched.range[0.85].toFixed(1)}pt | p95: ${f.regimeMatched.range[0.95].toFixed(1)}pt`,
      `  Up p85: ${f.regimeMatched.upExc[0.85].toFixed(1)}pt | p95: ${f.regimeMatched.upExc[0.95].toFixed(1)}pt`,
      `  Down p85: ${f.regimeMatched.downExc[0.85].toFixed(1)}pt | p95: ${f.regimeMatched.downExc[0.95].toFixed(1)}pt`,
    );
  }
  lines.push(
    `  Implied short-strike hints (from ${f.strikes.source} cohort, distances from open):`,
    `    ~30Δ condor: call ${f.strikes.condor30d.up.toFixed(0)}pt up / put ${f.strikes.condor30d.down.toFixed(0)}pt down`,
    `    ~12Δ condor: call ${f.strikes.condor12d.up.toFixed(0)}pt up / put ${f.strikes.condor12d.down.toFixed(0)}pt down`,
  );
  return lines.join('\n');
}
