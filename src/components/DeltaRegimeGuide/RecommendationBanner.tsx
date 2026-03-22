import type { Theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { VIXBucket } from '../../data/vixRangeStats';
import GuidanceCell from './GuidanceCell';
import type { ThresholdDelta } from './types';

interface Props {
  readonly th: Theme;
  readonly bucket: VIXBucket;
  readonly zoneColor: string;
  readonly recommendedDelta: number | null;
  readonly putSpreadCeiling: number | null;
  readonly callSpreadCeiling: number | null;
  readonly settlementTarget: ThresholdDelta;
  readonly computed: ThresholdDelta[];
}

export default function RecommendationBanner({
  th,
  bucket,
  zoneColor,
  recommendedDelta,
  putSpreadCeiling,
  callSpreadCeiling,
  settlementTarget,
  computed,
}: Props) {
  if (recommendedDelta == null) return null;

  const maxD = Math.floor(recommendedDelta);
  const intradayTarget = computed[3]; // 90th H-L
  const intradayDelta = intradayTarget
    ? Math.floor(Math.min(intradayTarget.putDelta, intradayTarget.callDelta))
    : null;

  // When ceiling is 0 or below, no safe delta exists — sit out
  if (maxD <= 0) {
    return (
      <div
        className="mb-3.5 overflow-hidden rounded-[10px]"
        style={{ border: '1.5px solid ' + tint(th.red, '30') }}
      >
        <div
          className="flex flex-col gap-2.5 p-3.5 px-4.5 md:flex-row md:items-center md:justify-between"
          style={{ backgroundColor: tint(th.red, '10') }}
        >
          <div>
            <div
              className="mb-1 font-sans text-[10px] font-bold tracking-[0.08em] uppercase"
              style={{ color: th.red }}
            >
              No safe delta {'\u2014'} consider sitting out
            </div>
            <div className="text-secondary font-sans text-[12px] leading-normal">
              The 90th percentile O{'\u2192'}C move (
              {settlementTarget.pct.toFixed(2)}% / {settlementTarget.pts} pts)
              is too wide for any delta to clear at this VIX level and time
              remaining. Selling premium here means accepting {'\u003C'}90%
              settlement survival.
            </div>
          </div>
          <div className="text-center">
            <div className="text-muted mb-0.5 font-sans text-[10px] font-semibold">
              CEILING
            </div>
            <div
              className="font-mono text-[28px] leading-none font-extrabold"
              style={{ color: th.red }}
            >
              SIT OUT
            </div>
          </div>
        </div>
        <div
          className="text-secondary px-4.5 py-2 font-sans text-[11px] leading-normal"
          style={{
            backgroundColor: tint(th.red, '08'),
            borderTop: '1px solid ' + tint(th.red, '15'),
          }}
        >
          {'\u26A0\uFE0F'}{' '}
          <strong style={{ color: th.red }}>Extreme conditions</strong>{' '}
          {'\u2014'} if you must trade, use the absolute minimum size and the
          widest wings available. But the data says today is one of the days
          that breaks iron condors.
        </div>
      </div>
    );
  }

  // Conservative: 60% of ceiling, but never equal to or above ceiling
  const conservD = Math.max(1, Math.floor(maxD * 0.6));
  // Only show conservative if it's meaningfully below ceiling
  const showConserv = conservD < maxD;

  return (
    <div
      className="mb-3.5 overflow-hidden rounded-[10px]"
      style={{ border: '1.5px solid ' + tint(zoneColor, '30') }}
    >
      {/* Main recommendation */}
      <div
        className="flex flex-col gap-2.5 p-3.5 px-4.5 md:flex-row md:items-center md:justify-between"
        style={{ backgroundColor: tint(zoneColor, '10') }}
      >
        <div>
          <div
            className="mb-1 font-sans text-[10px] font-bold tracking-[0.08em] uppercase"
            style={{ color: zoneColor }}
          >
            Maximum delta {'\u2014'} do not exceed (~90% settlement)
          </div>
          <div className="text-secondary font-sans text-[12px] leading-normal">
            Clears the 90th percentile O{'\u2192'}C move (
            {settlementTarget.pct.toFixed(2)}% / {settlementTarget.pts} pts).
            These are{' '}
            <strong style={{ color: zoneColor }}>ceilings, not targets</strong>{' '}
            {'\u2014'} tighter is safer.
          </div>
        </div>

        {/* Ceiling badges — IC + Put Spread + Call Spread */}
        <div className="flex items-center gap-3">
          {/* IC ceiling */}
          <div className="text-center">
            <div className="text-muted mb-0.5 font-sans text-[10px] font-semibold tracking-wider">
              IRON CONDOR
            </div>
            <div
              className="font-mono text-[28px] leading-none font-extrabold"
              style={{ color: zoneColor }}
            >
              {maxD}
              {'\u0394'}
            </div>
          </div>

          {/* Separator */}
          {putSpreadCeiling != null && callSpreadCeiling != null && (
            <div className="text-muted mx-1 text-[20px] font-light opacity-30">
              |
            </div>
          )}

          {/* Put spread ceiling */}
          {putSpreadCeiling != null && (
            <div className="text-center">
              <div
                className="mb-0.5 font-sans text-[10px] font-semibold tracking-wider"
                style={{ color: tint(th.red, 'CC') }}
              >
                PUT SPREAD
              </div>
              <div
                className="font-mono text-[28px] leading-none font-extrabold"
                style={{ color: th.red }}
              >
                {putSpreadCeiling}
                {'\u0394'}
              </div>
            </div>
          )}

          {/* Call spread ceiling */}
          {callSpreadCeiling != null && (
            <div className="text-center">
              <div
                className="mb-0.5 font-sans text-[10px] font-semibold tracking-wider"
                style={{ color: tint(th.green, 'CC') }}
              >
                CALL SPREAD
              </div>
              <div
                className="font-mono text-[28px] leading-none font-extrabold"
                style={{ color: th.green }}
              >
                {callSpreadCeiling}
                {'\u0394'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Guidance row */}
      {(() => {
        const showModerate =
          intradayDelta != null && intradayDelta > 0 && intradayDelta < maxD;
        const cols = 1 + (showModerate ? 1 : 0) + (showConserv ? 1 : 0);
        const gridCls =
          cols === 3
            ? 'grid grid-cols-1 gap-3 sm:grid-cols-3'
            : cols === 2
              ? 'grid grid-cols-1 gap-3 sm:grid-cols-2'
              : 'grid grid-cols-1 gap-3';
        return (
          <div
            className={'bg-surface-alt px-4.5 py-2.5 ' + gridCls}
            style={{ borderTop: '1px solid ' + tint(zoneColor, '20') }}
          >
            <GuidanceCell
              label="Aggressive"
              delta={maxD}
              desc={'IC ceiling \u2014 90% settle'}
              color={zoneColor}
            />
            {showModerate && (
              <GuidanceCell
                label="Moderate"
                delta={intradayDelta!}
                desc="90% intraday safe"
                color={th.accent}
              />
            )}
            {showConserv && (
              <GuidanceCell
                label="Conservative"
                delta={conservD}
                desc="Extra cushion"
                color={th.green}
              />
            )}
          </div>
        );
      })()}

      {/* Position sizing note for elevated regimes */}
      {(bucket.zone === 'caution' ||
        bucket.zone === 'stop' ||
        bucket.zone === 'danger') && (
        <div
          className="text-secondary px-4.5 py-2 font-sans text-[11px] leading-normal"
          style={{
            backgroundColor: tint(zoneColor, '08'),
            borderTop: '1px solid ' + tint(zoneColor, '15'),
          }}
        >
          {'\u26A0\uFE0F'}{' '}
          <strong style={{ color: zoneColor }}>Elevated VIX</strong> {'\u2014'}{' '}
          consider reducing contracts even at tighter deltas. The 10% of days
          that breach are often {bucket.zone === 'danger' ? '5%+' : '3\u20135%'}{' '}
          moves where max loss hits hard.
        </div>
      )}
    </div>
  );
}
