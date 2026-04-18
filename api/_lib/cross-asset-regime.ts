/**
 * Cross-asset risk-regime composite.
 *
 * Reads `futures_bars` for the six futures symbols (ES, NQ, ZN, RTY, CL, GC),
 * computes 5-min returns for each, and classifies the market into one of
 * four regimes:
 *
 *   RISK-ON       — stocks rallying, bonds + gold selling. Composite > 1.5.
 *   RISK-OFF      — stocks selling, bonds or gold bidding. Composite < -1.5.
 *   MIXED         — cross-asset signals disagree or composite near zero.
 *   MACRO-STRESS  — crude oil spike regardless of composite (geopolitical
 *                   or inflation shock overrides the normal read).
 *
 * Composite formula: `(ES_ret + NQ_ret) / (ZN_ret - GC_ret)`. Large positive
 * values classic risk-on (numerator positive, denominator negative → stocks
 * up, bonds/gold down). Large negative values classic risk-off.
 *
 * Auxiliary flags:
 *   - esNqDiverging — |ES_ret - NQ_ret| > 0.3% suggests tech is leading
 *     or lagging the broad market. Claude can use this to discount a
 *     trend read that is driven by mega-cap concentration rather than
 *     broad participation.
 *   - clSpike — |CL_ret over 30 min| > 2% signals macro-stress (oil
 *     shock); overrides the composite classification.
 *
 * All data reads are null-safe: missing bars degrade specific components
 * to `null`, and the helper returns `null` when ES is missing (without
 * ES the signal has no floor).
 */

import { getDb } from './db.js';

// ── Configuration ─────────────────────────────────────────────

/** Symbols used for the composite. */
type RegimeSymbol = 'ES' | 'NQ' | 'ZN' | 'RTY' | 'CL' | 'GC';

/** 5-minute lookback for standard returns. */
const RETURN_LOOKBACK_MS = 5 * 60 * 1000;

/** 30-minute lookback for the CL macro-stress spike detector. */
const CL_SPIKE_LOOKBACK_MS = 30 * 60 * 1000;

/**
 * Max staleness for the "latest" bar — if no bar exists within this
 * window the component is null. Futures trade continuously so a gap
 * longer than this usually means a data outage, not a closed market.
 */
const LATEST_BAR_STALENESS_MS = 10 * 60 * 1000;

/** Classification thresholds. */
const COMPOSITE_RISK_ON_THRESHOLD = 1.5;
const COMPOSITE_RISK_OFF_THRESHOLD = -1.5;
const ES_NQ_DIVERGENCE_THRESHOLD = 0.003; // 0.3% absolute
const CL_SPIKE_THRESHOLD = 0.02; // 2% absolute 30-min move

/**
 * Minimum absolute value for the denominator `ZN_ret - GC_ret` before
 * we compute the composite. Below this the ratio is numerically
 * unstable and we treat the composite as unknown (null) with regime
 * `MIXED`. Expressed in basis-point units (1 bp = 0.0001).
 */
const COMPOSITE_DENOM_MIN = 0.00001; // 0.1 bps

// ── Types ─────────────────────────────────────────────────────

export type CrossAssetRegime =
  | 'RISK-ON'
  | 'RISK-OFF'
  | 'MIXED'
  | 'MACRO-STRESS';

export interface CrossAssetRegimeResult {
  regime: CrossAssetRegime;
  /** Risk composite = (ES_ret + NQ_ret) / (ZN_ret - GC_ret); null when denom ≈ 0. */
  composite: number | null;
  /** |ES_ret - NQ_ret| > 0.3% flag. */
  esNqDiverging: boolean;
  /** |CL_ret over last 30 min| > 2% flag. */
  clSpike: boolean;
  /** 5-min returns per symbol. Null when the required bars aren't available. */
  components: {
    es: number | null;
    nq: number | null;
    zn: number | null;
    rty: number | null;
    cl: number | null;
    gc: number | null;
  };
  computedAt: string; // ISO
}

// ── Internal helpers ──────────────────────────────────────────

/**
 * Fetch close price at or before `at` for a symbol, with a staleness
 * cap. Returns null when no bar is found within the window.
 */
async function closeAt(
  symbol: RegimeSymbol,
  at: Date,
  maxStalenessMs: number,
): Promise<number | null> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = new Date(at.getTime() - maxStalenessMs).toISOString();
  const rows = await sql`
    SELECT close FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts <= ${atIso}
      AND ts >= ${earliestIso}
    ORDER BY ts DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const val = Number.parseFloat(String(rows[0]!.close));
  return Number.isFinite(val) ? val : null;
}

/** Compute a return over `lookbackMs` as of `now`. Null when either bar is missing. */
async function symbolReturn(
  symbol: RegimeSymbol,
  now: Date,
  lookbackMs: number,
): Promise<number | null> {
  const then = new Date(now.getTime() - lookbackMs);
  // Prior bar: search back from `then` with the same staleness cap used
  // for the latest bar. Without a cap a stale historical bar could
  // silently satisfy the query and produce garbage returns.
  const [latest, prior] = await Promise.all([
    closeAt(symbol, now, LATEST_BAR_STALENESS_MS),
    closeAt(symbol, then, LATEST_BAR_STALENESS_MS),
  ]);
  if (latest == null || prior == null || prior === 0) return null;
  return latest / prior - 1;
}

/** Classify the regime from components + flags. */
function classify(args: {
  composite: number | null;
  esRet: number | null;
  znRet: number | null;
  gcRet: number | null;
  clSpike: boolean;
}): CrossAssetRegime {
  if (args.clSpike) return 'MACRO-STRESS';
  if (args.composite == null || args.esRet == null) return 'MIXED';
  if (
    args.composite > COMPOSITE_RISK_ON_THRESHOLD &&
    args.esRet > 0 &&
    args.znRet != null &&
    args.znRet < 0
  ) {
    return 'RISK-ON';
  }
  if (
    args.composite < COMPOSITE_RISK_OFF_THRESHOLD &&
    args.esRet < 0 &&
    ((args.znRet != null && args.znRet > 0) ||
      (args.gcRet != null && args.gcRet > 0))
  ) {
    return 'RISK-OFF';
  }
  return 'MIXED';
}

// ── Public API ────────────────────────────────────────────────

/**
 * Compute the cross-asset regime composite as of `now`.
 * Returns null only when ES has no latest bar (without ES there is
 * no floor for the signal). Partial component coverage is tolerated.
 */
export async function computeCrossAssetRegime(
  now: Date,
): Promise<CrossAssetRegimeResult | null> {
  // Fetch all 5-min returns in parallel; also grab CL 30-min return.
  const [es, nq, zn, rty, cl, gc, cl30m] = await Promise.all([
    symbolReturn('ES', now, RETURN_LOOKBACK_MS),
    symbolReturn('NQ', now, RETURN_LOOKBACK_MS),
    symbolReturn('ZN', now, RETURN_LOOKBACK_MS),
    symbolReturn('RTY', now, RETURN_LOOKBACK_MS),
    symbolReturn('CL', now, RETURN_LOOKBACK_MS),
    symbolReturn('GC', now, RETURN_LOOKBACK_MS),
    symbolReturn('CL', now, CL_SPIKE_LOOKBACK_MS),
  ]);

  // Without ES the signal has no anchor — return null so callers can
  // drop the section cleanly.
  if (es == null) return null;

  const esNqDiverging =
    nq != null && Math.abs(es - nq) > ES_NQ_DIVERGENCE_THRESHOLD;
  const clSpike = cl30m != null && Math.abs(cl30m) > CL_SPIKE_THRESHOLD;

  let composite: number | null = null;
  if (nq != null && zn != null && gc != null) {
    const denom = zn - gc;
    if (Math.abs(denom) >= COMPOSITE_DENOM_MIN) {
      composite = (es + nq) / denom;
      if (!Number.isFinite(composite)) composite = null;
    }
  }

  const regime = classify({
    composite,
    esRet: es,
    znRet: zn,
    gcRet: gc,
    clSpike,
  });

  return {
    regime,
    composite,
    esNqDiverging,
    clSpike,
    components: { es, nq, zn, rty, cl, gc },
    computedAt: now.toISOString(),
  };
}

// ── Formatter ─────────────────────────────────────────────────

function formatPct(v: number | null): string {
  if (v == null) return 'N/A';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(2)}%`;
}

/**
 * Format the regime result for injection into the analyze prompt.
 * Returns null when the result is null so the orchestrator can drop
 * the section.
 */
export function formatCrossAssetRegimeForClaude(
  r: CrossAssetRegimeResult | null,
): string | null {
  if (!r) return null;

  const { components: c } = r;
  const lines: string[] = [];
  lines.push(`Regime: ${r.regime}`);
  lines.push(
    `Risk composite (ES+NQ)/(ZN-GC): ${
      r.composite == null
        ? 'N/A (denominator too small)'
        : r.composite.toFixed(2)
    }`,
  );
  lines.push(
    `5-min returns — ES: ${formatPct(c.es)} | NQ: ${formatPct(c.nq)} | ZN: ${formatPct(c.zn)} | RTY: ${formatPct(c.rty)} | CL: ${formatPct(c.cl)} | GC: ${formatPct(c.gc)}`,
  );

  const flags: string[] = [];
  if (r.esNqDiverging) {
    flags.push('ES/NQ diverging (tech leading or lagging broad market)');
  }
  if (r.clSpike) {
    flags.push('CL 30-min > 2% (macro stress — oil spike)');
  }
  if (flags.length > 0) {
    lines.push(`Flags: ${flags.join('; ')}`);
  }

  return lines.join('\n  ');
}
