/**
 * Long Γ / Short Γ chip with aggregate netGexK magnitude.
 *
 * Renders to the right of the section header to advertise the dealer's
 * net gamma posture for the selected ticker on the 0DTE expiry. Green
 * when Long Γ (positive net gamma across the chain → supportive
 * hedging), red when Short Γ (negative → procyclical hedging).
 */

import { formatNetGexShort } from '../../utils/format-magnitude';

interface RegimeChipProps {
  regime: 'Long Γ' | 'Short Γ' | null;
  netGexK: number | null;
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
  const magnitude = formatNetGexShort(netGexK);
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
