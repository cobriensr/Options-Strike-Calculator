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
 * Third Friday of (year, month) — the standard NDX/SPX monthly expiration day.
 * Returns YYYY-MM-DD. Holiday adjustments (e.g. Good Friday) are not applied;
 * UW data simply won't have rows for those rare cases and the backfill /
 * live cron will record an empty snapshot for that day.
 */
function thirdFridayOf(year: number, month: number): string {
  const first = new Date(Date.UTC(year, month, 1));
  const firstDow = first.getUTCDay(); // 0=Sun, 5=Fri
  const offsetToFirstFri = (5 - firstDow + 7) % 7;
  const dayOfThirdFri = 1 + offsetToFirstFri + 14;
  const d = new Date(Date.UTC(year, month, dayOfThirdFri));
  return d.toISOString().slice(0, 10);
}

/**
 * Front NDX monthly expiry on or after `today`.
 *
 * UW's `/spot-exposures/expiry-strike` for NDX only carries monthly
 * expirations (3rd Friday of each month). Daily/weekly NDX expirations
 * exist on CBOE but are not exposed by UW's spot-exposures endpoint —
 * verified empirically 2026-04-28: querying UW with NDX `expirations[]`
 * set to a Mon/Wed/Fri non-monthly date returns 0 rows.
 *
 *   today >= this month's 3rd Friday → next month's 3rd Friday
 *   today <  this month's 3rd Friday → this month's 3rd Friday
 */
export function getFrontNdxExpiry(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const thisMonthThirdFri = thirdFridayOf(year, month);
  if (today < thisMonthThirdFri) return thisMonthThirdFri;
  const nextMonth = (month + 1) % 12;
  const nextYear = month === 11 ? year + 1 : year;
  return thirdFridayOf(nextYear, nextMonth);
}

/**
 * The "primary" expiry per ticker — the one zero-gamma is computed against.
 * SPX/SPY/QQQ have daily expirations so the primary is always today.
 * NDX uses the front available monthly (3rd Friday).
 */
export function getPrimaryExpiry(
  ticker: ZeroGammaTicker,
  today: string,
): string {
  if (ticker === 'NDX') return getFrontNdxExpiry(today);
  return today;
}
