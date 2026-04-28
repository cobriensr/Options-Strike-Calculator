/**
 * Cross-asset zero-gamma ticker config.
 *
 * Single source of truth for the four tickers we run zero-gamma on, plus the
 * per-ticker primary-expiry policy. Both `fetch-strike-exposure` (ingest) and
 * `compute-zero-gamma` (compute) import from here so the ingest cron and the
 * derivative cron can never disagree about which tickers exist or which
 * expiry the zero-gamma level should be computed against.
 *
 * See docs/superpowers/specs/cross-asset-zero-gamma-2026-04-28.md.
 */

export const ZERO_GAMMA_TICKERS = ['SPX', 'NDX', 'SPY', 'QQQ'] as const;
export type ZeroGammaTicker = (typeof ZERO_GAMMA_TICKERS)[number];

/**
 * NDX expirations are Mon/Wed/Fri only (no daily expirations as of 2026-04).
 * Cron only fires Mon-Fri, so input dates are always weekdays.
 *   Mon (1), Wed (3), Fri (5) → today
 *   Tue (2), Thu (4)          → tomorrow (Wed/Fri)
 */
export function getFrontNdxExpiry(today: string): string {
  const d = new Date(`${today}T12:00:00`);
  const dow = d.getDay();
  if (dow === 1 || dow === 3 || dow === 5) return today;
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The "primary" expiry per ticker — the one zero-gamma is computed against.
 * SPX/SPY/QQQ have daily expirations so the primary is always today.
 * NDX uses the front Mon/Wed/Fri expiration.
 */
export function getPrimaryExpiry(
  ticker: ZeroGammaTicker,
  today: string,
): string {
  if (ticker === 'NDX') return getFrontNdxExpiry(today);
  return today;
}
