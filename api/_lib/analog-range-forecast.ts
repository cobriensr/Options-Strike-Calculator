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
 * Temporal leakage guard: candidate pool strictly `date < targetDate`.
 * Fail-open: null forecast drops the block from the analyze context, so
 * an outage in OpenAI/Neon cannot block an analyze call.
 */

const COHORT_SIZE = 15;
const QUANTILES = [0.5, 0.85, 0.9, 0.95] as const;

type Q = (typeof QUANTILES)[number];

export interface RangeForecast {
  n: number;
  targetDate: string;
  range: Record<Q, number>;
  upExc: Record<Q, number>;
  downExc: Record<Q, number>;
  /** Asymmetric strike hints for the analyze prompt. p85 ≈ 30Δ, p95 ≈ 12Δ. */
  strikes: {
    condor30d: { up: number; down: number };
    condor12d: { up: number; down: number };
  };
}

interface AnalogRow {
  date: string;
  range_pt: number;
  up_exc: number;
  down_exc: number;
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

function quantiles(values: number[]): Record<Q, number> {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const out = {} as Record<Q, number>;
  for (const q of QUANTILES) out[q] = percentile(sorted, q);
  return out;
}

/**
 * Retrieve the 15 text-embedding-nearest historical mornings to
 * `targetSummary`, strictly before `targetDate`, and compute cohort
 * quantiles for range + asymmetric excursion.
 *
 * @param targetDate  ISO date (YYYY-MM-DD) for leakage guard
 * @param targetSummary  Prediction-time summary string (first-hour only)
 *                       to embed and match against historical mornings
 * @returns null if OpenAI fails, if no analogs exist, or if cohort
 *          ranges are entirely missing (backfill incomplete)
 */
export async function getRangeForecast(
  targetDate: string,
  targetSummary: string,
): Promise<RangeForecast | null> {
  const embedding = await generateEmbedding(targetSummary);
  if (!embedding) return null;

  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;
  const rows = (await sql`
    SELECT date, range_pt, up_exc, down_exc
    FROM day_embeddings
    WHERE date < ${targetDate}::date
      AND range_pt IS NOT NULL
      AND up_exc IS NOT NULL
      AND down_exc IS NOT NULL
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${COHORT_SIZE}
  `) as unknown as AnalogRow[];

  if (rows.length === 0) return null;

  const ranges = rows.map((r) => Number(r.range_pt)).filter(Number.isFinite);
  const ups = rows.map((r) => Number(r.up_exc)).filter(Number.isFinite);
  const downs = rows.map((r) => Number(r.down_exc)).filter(Number.isFinite);

  if (ranges.length === 0) return null;

  const range = quantiles(ranges);
  const upExc = quantiles(ups);
  const downExc = quantiles(downs);

  return {
    n: rows.length,
    targetDate,
    range,
    upExc,
    downExc,
    strikes: {
      condor30d: { up: upExc[0.85], down: downExc[0.85] },
      condor12d: { up: upExc[0.95], down: downExc[0.95] },
    },
  };
}

/** Format the forecast for inclusion in the analyze prompt. Emits null
 *  if the forecast is null — caller concatenates conditionally. */
export function formatRangeForecast(f: RangeForecast | null): string | null {
  if (!f) return null;
  const r = f.range;
  const u = f.upExc;
  const d = f.downExc;
  return [
    `Historical analog range forecast (n=${f.n} text-nearest mornings before ${f.targetDate}):`,
    `  Expected daily range — p50: ${r[0.5].toFixed(1)}pt | p85: ${r[0.85].toFixed(1)}pt | p95: ${r[0.95].toFixed(1)}pt`,
    `  Upside excursion (high − open) — p85: ${u[0.85].toFixed(1)}pt | p95: ${u[0.95].toFixed(1)}pt`,
    `  Downside excursion (open − low) — p85: ${d[0.85].toFixed(1)}pt | p95: ${d[0.95].toFixed(1)}pt`,
    `  Implied short-strike hints (distances from open):`,
    `    ~30Δ condor: call ${f.strikes.condor30d.up.toFixed(0)}pt up / put ${f.strikes.condor30d.down.toFixed(0)}pt down`,
    `    ~12Δ condor: call ${f.strikes.condor12d.up.toFixed(0)}pt up / put ${f.strikes.condor12d.down.toFixed(0)}pt down`,
  ].join('\n');
}
