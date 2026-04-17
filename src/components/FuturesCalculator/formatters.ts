/**
 * Display helpers for FuturesCalculator P&L readouts.
 *
 * fmtPrice → 2-decimal locale-formatted number (no currency symbol).
 * fmtDollar → signed or unsigned dollar amount with locale separators.
 * pnlColor → theme color for positive/negative/neutral P&L.
 */

import { theme } from '../../themes';

export function fmtPrice(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtDollar(n: number, alwaysSign = false): string {
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = n >= 0 ? (alwaysSign ? '+' : '') : '-';
  return `${sign}$${abs}`;
}

export function pnlColor(n: number): string {
  if (n > 0) return theme.green;
  if (n < 0) return theme.red;
  return theme.textMuted;
}
