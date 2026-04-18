/**
 * VIX/SPX intraday divergence detector.
 *
 * Computes 5-minute returns for VIX and SPX and flags the informed-
 * positioning signal: VIX rises > 3% while SPX is essentially flat
 * (|return| < 0.1%). When this fires, institutional flow is bidding
 * protection before price moves — the "canary" pattern.
 *
 * Data sources:
 *   - VIX minute-bar granularity is NOT stored in the DB. The closest
 *     proxy is `market_snapshots.vix`, which is written whenever the
 *     calculator runs. When the user is actively snapshotting through
 *     the session this often produces usable paired reads; otherwise
 *     the helper returns null and the section is dropped.
 *   - SPX minute bars live in `spx_candles_1m` (1-min cadence), which
 *     gives a reliable 5-min return anchor.
 *
 * If either source lacks a pair of bars spanning the 5-min window
 * the helper returns null.
 */

import { getDb } from './db.js';

// ── Configuration ─────────────────────────────────────────────

const RETURN_LOOKBACK_MS = 5 * 60 * 1000;

/**
 * Max staleness for the "now" bar. Wider window for VIX because
 * market_snapshots is event-driven (written when the calculator
 * runs) and may not be minute-fresh.
 */
const SPX_STALENESS_MS = 2 * 60 * 1000; // 2 min — 1-min cadence source
const VIX_STALENESS_MS = 10 * 60 * 1000; // 10 min — event-driven source

/** Divergence trigger thresholds. */
const VIX_MOVE_THRESHOLD = 0.03; // |VIX 5-min ret| > 3%
const SPX_MOVE_THRESHOLD = 0.001; // |SPX 5-min ret| < 0.1%

// ── Types ─────────────────────────────────────────────────────

export interface VixSpxDivergence {
  triggered: boolean;
  /** VIX 5-min return (fraction, not percent). Null when source is missing a pair. */
  vixRet5m: number | null;
  /** SPX 5-min return (fraction, not percent). Null when source is missing a pair. */
  spxRet5m: number | null;
  computedAt: string;
}

// ── Internal helpers ──────────────────────────────────────────

async function getSpxCloseAt(at: Date): Promise<number | null> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = new Date(at.getTime() - SPX_STALENESS_MS).toISOString();
  const rows = await sql`
    SELECT close FROM spx_candles_1m
    WHERE timestamp <= ${atIso}
      AND timestamp >= ${earliestIso}
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const v = Number.parseFloat(String(rows[0]!.close));
  return Number.isFinite(v) ? v : null;
}

async function getVixAt(at: Date): Promise<number | null> {
  const sql = getDb();
  const atIso = at.toISOString();
  const earliestIso = new Date(at.getTime() - VIX_STALENESS_MS).toISOString();
  // market_snapshots has no `ts` column — rely on `created_at` for
  // chronological ordering. entry_time is free-form text and cannot
  // be sorted reliably.
  const rows = await sql`
    SELECT vix FROM market_snapshots
    WHERE created_at <= ${atIso}
      AND created_at >= ${earliestIso}
      AND vix IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const v = Number.parseFloat(String(rows[0]!.vix));
  return Number.isFinite(v) ? v : null;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Compute the VIX/SPX divergence flag as of `now`.
 * Returns null when either underlying source fails to produce both a
 * latest and a 5-min-prior reading.
 */
export async function computeVixSpxDivergence(
  now: Date,
): Promise<VixSpxDivergence | null> {
  const prior = new Date(now.getTime() - RETURN_LOOKBACK_MS);

  const [vixNow, vixPrior, spxNow, spxPrior] = await Promise.all([
    getVixAt(now),
    getVixAt(prior),
    getSpxCloseAt(now),
    getSpxCloseAt(prior),
  ]);

  const vixRet5m =
    vixNow != null && vixPrior != null && vixPrior !== 0
      ? vixNow / vixPrior - 1
      : null;
  const spxRet5m =
    spxNow != null && spxPrior != null && spxPrior !== 0
      ? spxNow / spxPrior - 1
      : null;

  // If BOTH series failed, return null so the orchestrator drops the
  // section entirely — there's nothing to say.
  if (vixRet5m == null && spxRet5m == null) return null;

  const triggered =
    vixRet5m != null &&
    spxRet5m != null &&
    Math.abs(vixRet5m) > VIX_MOVE_THRESHOLD &&
    Math.abs(spxRet5m) < SPX_MOVE_THRESHOLD;

  return {
    triggered,
    vixRet5m,
    spxRet5m,
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
 * Format the divergence result for injection into the analyze prompt.
 * Returns null when the input is null.
 */
export function formatVixDivergenceForClaude(
  d: VixSpxDivergence | null,
): string | null {
  if (!d) return null;
  const line1 = `VIX 5-min return: ${formatPct(d.vixRet5m)}  |  SPX 5-min return: ${formatPct(d.spxRet5m)}`;
  const line2 = d.triggered
    ? 'DIVERGENCE TRIGGERED — VIX > 3% while SPX < 0.1%. Informed positioning ahead of price move.'
    : 'No divergence — VIX and SPX moves are consistent with each other.';
  return `${line1}\n  ${line2}`;
}
