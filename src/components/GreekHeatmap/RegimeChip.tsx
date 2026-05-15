/**
 * Long Γ / Short Γ chip with aggregate netGexK magnitude.
 *
 * Renders to the right of the section header to advertise the dealer's
 * net gamma posture for the selected ticker on the 0DTE expiry. Green
 * when Long Γ (positive net gamma across the chain → supportive
 * hedging), red when Short Γ (negative → procyclical hedging).
 */

interface RegimeChipProps {
  regime: 'Long Γ' | 'Short Γ' | null;
  netGexK: number | null;
}

/**
 * Format the netGexK magnitude (which is netGamma / 1000) into a
 * compact human-readable label. The raw value can reach the hundreds
 * of millions in dollars (e.g. +142,672.6 = $142.7M net gamma), so
 * "+142672.6k" is technically correct but unreadable. Scale to M/B
 * so the chip reads at a glance.
 */
function formatNetGex(netGexK: number): string {
  const sign = netGexK >= 0 ? '+' : '-';
  // netGexK is gamma in thousands of dollars, so 1k = $1k, 1000k = $1M,
  // 1,000,000k = $1B.
  const absK = Math.abs(netGexK);
  if (absK >= 1_000_000) return `${sign}$${(absK / 1_000_000).toFixed(2)}B`;
  if (absK >= 1_000) return `${sign}$${(absK / 1_000).toFixed(1)}M`;
  if (absK >= 1) return `${sign}$${absK.toFixed(0)}K`;
  return `${sign}$${(absK * 1000).toFixed(0)}`;
}

export function RegimeChip({ regime, netGexK }: RegimeChipProps) {
  if (regime === null || netGexK === null) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1 text-xs font-medium text-neutral-500"
        aria-label="Regime unavailable"
      >
        —
      </span>
    );
  }
  const isLong = regime === 'Long Γ';
  const chipClass = isLong
    ? 'border-emerald-500/70 bg-emerald-950/40 text-emerald-200'
    : 'border-rose-500/70 bg-rose-950/40 text-rose-200';
  const magnitude = formatNetGex(netGexK);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium tabular-nums ${chipClass}`}
      aria-label={`Dealer regime ${regime}, net GEX ${magnitude}`}
    >
      <span>{regime}</span>
      <span className="opacity-80">{magnitude}</span>
    </span>
  );
}
