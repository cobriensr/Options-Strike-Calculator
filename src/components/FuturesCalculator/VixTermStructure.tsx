/**
 * VixTermStructure — Compact status display for the VIX term structure:
 * spot VIX, VIX3M, their ratio, and a CONTANGO / FLAT / BACKWARDATION
 * badge (ratio ≤ 0.90 / between / ≥ 1.00 — bands are classified
 * server-side in api/_lib/vix-term-structure.ts).
 *
 * The headline reading is the live Schwab ratio when present, otherwise
 * the prior session's close (Schwab, only sent while the cash session is
 * open). The prior close and UW's current VIX-futures label (front two VX
 * contracts) are shown as context when available.
 *
 * Backwardation (spot above 3-month) means near-term stress is priced in.
 */

import { memo } from 'react';
import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import { tint } from '../../utils/ui-utils';
import type {
  VixTermBand,
  VixTermStructureData,
} from '../../hooks/useFuturesData';

interface VixTermStructureProps {
  readonly vixTermStructure: VixTermStructureData | null;
}

function bandColor(band: VixTermBand | null): string {
  switch (band) {
    case 'CONTANGO':
      return theme.green;
    case 'BACKWARDATION':
      return theme.red;
    default:
      return theme.textMuted;
  }
}

function Stat({
  label,
  value,
  sub,
  color,
}: Readonly<{ label: string; value: string; sub?: string; color?: string }>) {
  return (
    <div>
      <div className="text-muted mb-0.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
        {label}
      </div>
      <div
        className="text-primary font-mono text-[13px] font-semibold"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {sub && (
        <div className="text-muted mt-0.5 font-sans text-[9px]">{sub}</div>
      )}
    </div>
  );
}

const VixTermStructure = memo(function VixTermStructure({
  vixTermStructure,
}: VixTermStructureProps) {
  if (vixTermStructure == null) return null;
  const { live, priorClose, futuresRegime } = vixTermStructure;
  const reading = live ?? priorClose;
  if (reading == null && futuresRegime == null) return null;

  const band = reading?.band ?? null;
  const badgeColor = bandColor(band);
  const asOf = live ? formatTimeCT(live.asOf) : '';
  let source: string | null = null;
  if (live) source = asOf ? `Live · ${asOf} CT` : 'Live';
  else if (priorClose) source = 'Prior close (no live quote)';

  return (
    <div
      className="border-edge rounded-lg border p-3"
      style={{
        backgroundColor: tint(badgeColor, '06'),
        borderColor: tint(badgeColor, '25'),
      }}
      role="status"
      aria-label="VIX term structure"
      // The live quote time changes on every 30 s poll; don't re-announce.
      aria-live="off"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="font-sans text-[11px] font-bold tracking-[0.08em] uppercase">
          <span className="text-tertiary">VIX Term Structure</span>
        </div>
        {band && (
          <span
            className="rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold"
            style={{
              backgroundColor: tint(badgeColor, '18'),
              color: badgeColor,
            }}
          >
            {band}
          </span>
        )}
      </div>

      {reading && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="VIX" value={reading.vix.toFixed(2)} />
          <Stat label="VIX3M" value={reading.vix3m.toFixed(2)} />
          <Stat
            label="Ratio"
            value={reading.ratio.toFixed(3)}
            sub="VIX / VIX3M"
            color={badgeColor}
          />
        </div>
      )}

      <div className="text-muted mt-2 flex flex-wrap gap-x-3 gap-y-0.5 font-sans text-[10px]">
        {source && <span>{source}</span>}
        {live && priorClose && (
          <span>
            Prior close {priorClose.ratio.toFixed(3)} ({priorClose.band})
          </span>
        )}
        {futuresRegime && <span>VX futures: {futuresRegime}</span>}
      </div>
    </div>
  );
});

export default VixTermStructure;
