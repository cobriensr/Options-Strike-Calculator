/**
 * PinSetupTile formatters — small helpers kept colocated with the tile
 * because they're tile-specific (gamma-OI is already scaled to millions
 * by the upstream API, and the evaluated-at formatter swallows parse
 * failures with an em-dash fallback that only makes sense in this UI).
 */

/**
 * Format a gamma-OI value that is already scaled to millions. Values
 * over 1000 M render as B (billions); below that, raw M.
 */
export function formatGammaM(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}B`;
  return `${value.toFixed(0)}M`;
}

export function formatSignedFixed(value: number, dp = 1): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(dp)}`;
}

export function formatEvaluatedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '—';
  }
}
