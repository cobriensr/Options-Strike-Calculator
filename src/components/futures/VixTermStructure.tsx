/**
 * VixTermStructure — Compact status display for VIX futures
 * term structure: front/back month prices, spread, and a
 * prominent CONTANGO / FLAT / BACKWARDATION badge.
 *
 * This is the single most important futures signal for 0DTE
 * trading: backwardation means near-term stress is priced in.
 */

import { memo } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type {
  FuturesSnapshot,
  VxTermStructure as VxTermStructureType,
} from '../../hooks/useFuturesData';

interface VixTermStructureProps {
  readonly snapshots: FuturesSnapshot[];
  readonly vxTermSpread: number | null;
  readonly vxTermStructure: VxTermStructureType | null;
}

function structureColor(
  structure: VxTermStructureType | null,
): string {
  switch (structure) {
    case 'CONTANGO':
      return theme.green;
    case 'BACKWARDATION':
      return theme.red;
    case 'FLAT':
      return theme.textMuted;
    default:
      return theme.textMuted;
  }
}

const VixTermStructure = memo(function VixTermStructure({
  snapshots,
  vxTermSpread,
  vxTermStructure,
}: VixTermStructureProps) {
  const front = snapshots.find((s) => s.symbol === 'VXM1');
  const back = snapshots.find((s) => s.symbol === 'VXM2');

  if (!front && !back && vxTermStructure == null) return null;

  const badgeColor = structureColor(vxTermStructure);

  return (
    <div
      className="border-edge rounded-lg border p-3"
      style={{
        backgroundColor: tint(badgeColor, '06'),
        borderColor: tint(badgeColor, '25'),
      }}
      role="status"
      aria-label="VIX term structure"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="font-sans text-[11px] font-bold tracking-[0.08em] uppercase">
          <span className="text-tertiary">VIX Term Structure</span>
        </div>
        {vxTermStructure && (
          <span
            className="rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold"
            style={{
              backgroundColor: tint(badgeColor, '18'),
              color: badgeColor,
            }}
          >
            {vxTermStructure}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {/* Front month */}
        <div>
          <div className="text-muted mb-0.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
            Front
          </div>
          <div className="text-primary font-mono text-[13px] font-semibold">
            {front ? front.price.toFixed(2) : 'N/A'}
          </div>
          {front && (
            <div
              className="mt-0.5 font-mono text-[10px]"
              style={{
                color:
                  front.changeDayPct >= 0
                    ? theme.green
                    : theme.red,
              }}
            >
              {front.changeDayPct >= 0 ? '+' : ''}
              {front.changeDayPct.toFixed(2)}%
            </div>
          )}
        </div>

        {/* Back month */}
        <div>
          <div className="text-muted mb-0.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
            Back
          </div>
          <div className="text-primary font-mono text-[13px] font-semibold">
            {back ? back.price.toFixed(2) : 'N/A'}
          </div>
          {back && (
            <div
              className="mt-0.5 font-mono text-[10px]"
              style={{
                color:
                  back.changeDayPct >= 0
                    ? theme.green
                    : theme.red,
              }}
            >
              {back.changeDayPct >= 0 ? '+' : ''}
              {back.changeDayPct.toFixed(2)}%
            </div>
          )}
        </div>

        {/* Spread */}
        <div>
          <div className="text-muted mb-0.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
            Spread
          </div>
          <div
            className="font-mono text-[13px] font-semibold"
            style={{ color: badgeColor }}
          >
            {vxTermSpread != null
              ? `${vxTermSpread >= 0 ? '+' : ''}${vxTermSpread.toFixed(2)}`
              : 'N/A'}
          </div>
          <div className="text-muted mt-0.5 font-sans text-[9px]">
            pts (front - back)
          </div>
        </div>
      </div>
    </div>
  );
});

export default VixTermStructure;
