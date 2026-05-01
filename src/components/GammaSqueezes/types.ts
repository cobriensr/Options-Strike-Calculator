/**
 * Shared types for the Gamma Squeeze frontend.
 *
 * Mirrors `api/gamma-squeezes.ts` response shapes. src/ cannot reach
 * into api/ directly (Vite only bundles browser code), so we duplicate
 * here. Keep in sync when the server contract changes.
 *
 * See spec: docs/superpowers/specs/gamma-squeeze-velocity-detector-2026-04-28.md.
 */

// Tickers eligible for gamma-squeeze detection. Plain string is used
// inline below — gamma-squeeze flags can fire on any ticker the detector
// emits, so we don't enumerate at the type level.
export type GammaSqueezeSide = 'call' | 'put';
export type GammaSqueezePhase = 'forming' | 'active' | 'exhausted';
export type NetGammaSign = 'short' | 'long' | 'unknown';

export interface GammaSqueezeRow {
  id: number;
  ticker: string;
  strike: number;
  side: GammaSqueezeSide;
  expiry: string;
  ts: string;
  spotAtDetect: number;
  pctFromStrike: number;
  spotTrend5m: number;
  volOi15m: number;
  volOi15mPrior: number;
  volOiAcceleration: number;
  volOiTotal: number;
  netGammaSign: NetGammaSign;
  squeezePhase: GammaSqueezePhase;
  contextSnapshot: unknown;
  reachedStrike: boolean | null;
  spotAtClose: number | null;
  maxCallPnlPct: number | null;
  /**
   * Path-shape diagnostic — minutes since detection. Live mode = now − ts;
   * replay mode (?at=) = at − ts. Always ≥ 0.
   */
  freshnessMin: number;
  /**
   * Signed progress from `spotAtDetect` toward `strike`. 0 = no movement,
   * 1 = reached strike, >1 = past strike. Null when current spot is
   * unknown or strike == spotAtDetect.
   */
  progressPct: number | null;
  /**
   * True when freshness > 30 min AND |progressPct| < 0.25. Per the
   * 2026-04-29 outlier study, slow-ITM wins round-trip 56% at close.
   * UI should visually de-emphasize stale alerts.
   */
  isStale: boolean;
  /**
   * Cross-strike Herfindahl of cross-strike notional in the ±0.5% band
   * at fire time. Lower = diffuse winner archetype. Null when band has
   * fewer than 3 strikes with non-zero notional.
   */
  hhiNeighborhood: number | null;
  /**
   * Pearson correlation of per-minute (Δiv, Δvolume), restricted to
   * ≤11:00 CT. Higher = real demand bid IV up. Null when fewer than
   * 5 morning samples or zero variance in either series.
   */
  ivMorningVolCorr: number | null;
  /**
   * True iff (hhiNeighborhood ≤ p30 of the day) AND (ivMorningVolCorr
   * ≥ p80 of the day). Computed per-request from same-day events. The
   * "★" badge surfaces this in the row UI.
   */
  precisionStackPass: boolean;
}

export interface GammaSqueezesResponse {
  mode: 'list';
  latest: Record<string, GammaSqueezeRow | null>;
  history: Record<string, GammaSqueezeRow[]>;
}

/**
 * Build the compound key for a squeeze row. Includes expiry because
 * different expiries on the same strike are distinct setups.
 */
export function squeezeCompoundKey(
  row: Pick<GammaSqueezeRow, 'ticker' | 'strike' | 'side' | 'expiry'>,
): string {
  return `${row.ticker}:${row.strike}:${row.side}:${row.expiry}`;
}

/**
 * Aggregated active squeeze view — one entry per compound key. The hook
 * builds these from the raw row stream so the board stays stable while
 * the cron keeps firing the same compound key.
 */
export interface ActiveSqueeze {
  compoundKey: string;
  ticker: string;
  strike: number;
  side: GammaSqueezeSide;
  expiry: string;
  /** Most recent raw row — drives the displayed metrics. */
  latest: GammaSqueezeRow;
  /** First firing timestamp in the active span (ISO). */
  firstSeenTs: string;
  /** Most recent firing (ISO). */
  lastFiredTs: string;
  /** Count of raw rows seen in the active span. */
  firingCount: number;
}
