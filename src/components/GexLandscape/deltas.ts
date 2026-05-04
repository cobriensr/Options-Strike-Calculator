/**
 * Snapshot-buffer helpers used by the bias verdict: 5-minute strike
 * smoothing and price-trend detection.
 *
 * Per-strike Δ% used to live here (`computeDeltaMap`,
 * `findClosestSnapshot`) but moved to a server-side SQL `LAG()` query
 * in Phase 4 of the GEX Landscape WebSocket-driven accuracy upgrade.
 *
 * Pure functions, no React — all state ownership lives in the component.
 */

import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import { computePriceTrend as computePriceTrendPrimitive } from '../../utils/price-trend';
import type { PriceTrend, Snapshot } from './types';

/**
 * Average netGamma and netCharm for each strike across the current snapshot
 * and all buffer entries within `windowMs` (default 5 minutes).
 *
 * Smoothing makes the structural bias verdict stable: small minute-to-minute
 * GEX fluctuations won't flip the signal. The Δ% columns in the table still
 * show raw real-time changes — only the verdict inputs are smoothed.
 */
export function computeSmoothedStrikes(
  current: GexStrikeLevel[],
  buf: Snapshot[],
  nowTs: number,
  windowMs = 5 * 60 * 1000,
): GexStrikeLevel[] {
  const recent = buf.filter((snap) => snap.ts >= nowTs - windowMs);
  if (recent.length === 0) return current;
  return current.map((s) => {
    const history = recent
      .map((snap) => snap.strikes.find((r) => r.strike === s.strike))
      .filter((r): r is GexStrikeLevel => r !== undefined);
    if (history.length === 0) return s;
    const all = [s, ...history];
    const avgGamma = all.reduce((sum, r) => sum + r.netGamma, 0) / all.length;
    const avgCharm = all.reduce((sum, r) => sum + r.netCharm, 0) / all.length;
    return { ...s, netGamma: avgGamma, netCharm: avgCharm };
  });
}

/**
 * Compute a price trend from the snapshot buffer.
 *
 * Thin adapter over `src/utils/price-trend.ts`'s primitive. Extracts
 * `strikes[0].price` from each buffered snapshot and appends the
 * caller's `currentPrice` as a synthesized "now" point. Keeping the
 * existing signature here means `GexLandscape/index.tsx` doesn't need
 * any changes.
 *
 * Preserves the prior semantics: require at least 3 *buffered* points
 * (not 3 total) before emitting a directional trend. This is a
 * deliberately stricter gate than the primitive's own MIN_SNAPSHOTS
 * check — the extra buffered point ensures we have three
 * step-intervals when `currentPrice` is appended, giving the
 * consistency math real signal.
 *
 * The primitive lives in `src/utils/` so the server-side regime cron
 * can import it without pulling in React / GexLandscape — see
 * `docs/superpowers/specs/futures-playbook-server-drift-override-2026-04-21.md`.
 */
const MIN_BUFFERED_SNAPSHOTS = 3;

export function computePriceTrend(
  currentPrice: number,
  buf: Snapshot[],
  nowTs: number,
  windowMs = 5 * 60 * 1000,
): PriceTrend {
  const inWindow = buf.filter(
    (snap) => snap.ts >= nowTs - windowMs && snap.strikes.length > 0,
  );
  if (inWindow.length < MIN_BUFFERED_SNAPSHOTS) {
    return { direction: 'flat', changePct: 0, changePts: 0, consistency: 0 };
  }
  const points = inWindow.map((snap) => ({
    price: snap.strikes[0]!.price,
    ts: snap.ts,
  }));
  points.push({ price: currentPrice, ts: nowTs });
  return computePriceTrendPrimitive(points, nowTs, windowMs);
}
