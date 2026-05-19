/**
 * Build a canonical OCC option symbol from its parts.
 *
 *   <TICKER><YYMMDD><C|P><STRIKE × 1000, zero-padded to 8 digits>
 *
 * Example: SPY, 2026-05-19, put, 500 → "SPY260519P00500000".
 *
 * `date` is the ISO expiry (YYYY-MM-DD); we strip the first two year
 * digits to fit the OCC 2-digit-year convention. Strikes are scaled
 * by 1000 (so $500 → 500000) and zero-padded to 8 chars.
 *
 * Lives in its own module (not inline in SignalCard.tsx) so that the
 * SignalCard file only exports components — required by the
 * react-refresh/only-export-components lint rule.
 */
export function buildOcc(
  ticker: string,
  date: string,
  side: 'call' | 'put',
  strike: number,
): string {
  const compactDate = date.replace(/-/g, '').slice(2); // YYYYMMDD → YYMMDD
  const sideChar = side === 'call' ? 'C' : 'P';
  const strikeInt = Math.round(strike * 1000);
  const strikeStr = String(strikeInt).padStart(8, '0');
  return `${ticker.toUpperCase()}${compactDate}${sideChar}${strikeStr}`;
}
