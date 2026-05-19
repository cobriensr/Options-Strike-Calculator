/**
 * Build a canonical OCC option symbol for an SPXW 0DTE contract.
 *
 *   SPXW<YYMMDD><C|P><STRIKE × 1000, zero-padded to 8 digits>
 *
 * Example: 2026-05-18, call, 7430 → "SPXW260518C07430000".
 *
 * Lives in its own module (not inline in the panel component) so the
 * panel file only exports components — required by the
 * react-refresh/only-export-components lint rule.
 */
export function buildSpxwOcc(
  date: string,
  side: 'call' | 'put',
  strike: number,
): string {
  const compactDate = date.replace(/-/g, '').slice(2);
  const sideChar = side === 'call' ? 'C' : 'P';
  const strikeInt = Math.round(strike * 1000);
  const strikeStr = String(strikeInt).padStart(8, '0');
  return `SPXW${compactDate}${sideChar}${strikeStr}`;
}

export function spxwUwChainUrl(occ: string): string {
  return `https://unusualwhales.com/flow/option_chains?chain=${encodeURIComponent(occ)}`;
}
