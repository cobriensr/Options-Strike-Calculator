import type { Theme } from '../themes';
import type { DeltaRow, DeltaRowError } from '../types';
import { calcBSDelta, calcScaledSkew } from '../utils/calculator';
import { DELTA_Z_SCORES, DELTA_OPTIONS } from '../constants';
import {
  findBucket,
  estimateRange,
  getDowMultiplier,
  getTodayDow,
} from '../data/vixRangeStats';
import { mkTh, mkTd } from '../utils/ui-utils';

interface Props {
  readonly th: Theme;
  readonly vix: number;
  readonly spot: number;
  readonly T: number;
  readonly skew: number; // decimal, e.g. 0.03
  readonly allDeltas: ReadonlyArray<DeltaRow | DeltaRowError>;
  readonly selectedDate?: string; // 'YYYY-MM-DD' from date picker, falls back to today
  readonly clusterMult?: number; // Volatility clustering multiplier (1.0 = no effect)
}

/** Default 0DTE IV adjustment — matches the calculator's default multiplier */
const VIX_TO_SIGMA_MULT = 1.15;

/** A range threshold from the VIX regime data */
interface RangeThreshold {
  readonly label: string;
  readonly pct: number;
  readonly purpose: string;
}

/** Computed delta for a given range threshold */
interface ThresholdDelta {
  readonly label: string;
  readonly pct: number;
  readonly pts: number;
  readonly putDelta: number;
  readonly callDelta: number;
  readonly purpose: string;
  readonly importance: 'primary' | 'secondary';
}

/**
 * Maps VIX regime range thresholds to concrete delta values using the
 * current Black-Scholes parameters. Answers: "given today's VIX, what
 * delta should I sell at to clear the expected daily range?"
 *
 * Uses continuous interpolation from per-point VIX data (10–30) so that
 * delta recommendations scale smoothly with VIX, avoiding discrete jumps
 * at bucket boundaries.
 *
 * Shows two views:
 * 1. Range thresholds → max delta to sell (the answer)
 * 2. Your standard deltas → which thresholds they clear (the verification)
 */
export default function DeltaRegimeGuide({
  th,
  vix,
  spot,
  T,
  skew,
  allDeltas,
  selectedDate,
  clusterMult,
}: Props) {
  const bucket = findBucket(vix);
  if (!bucket) return null;

  // Compute sigma internally from VIX — always uses VIX × 1.15 / 100
  // so the Delta Guide stays self-consistent with VIX-based range thresholds,
  // regardless of whether the user switched to Direct IV (VIX1D) for strike pricing.
  const sigma = (vix * VIX_TO_SIGMA_MULT) / 100;

  // Clustering multiplier (default 1.0 = no effect)
  const cMult = clusterMult != null && clusterMult > 0 ? clusterMult : 1;

  // Derive day of week from selected date, falling back to today
  const dow = (() => {
    if (selectedDate) {
      // Parse 'YYYY-MM-DD' — use UTC to avoid timezone shift
      const parts = selectedDate.split('-');
      if (parts.length === 3) {
        const d = new Date(
          Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])),
        );
        const jsDay = d.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
        if (jsDay >= 1 && jsDay <= 5) return jsDay - 1; // 0=Mon..4=Fri
        return null; // weekend
      }
    }
    return getTodayDow();
  })();
  const dowMult = dow == null ? null : getDowMultiplier(vix, dow);

  // Use continuous interpolation instead of discrete bucket thresholds.
  const range = estimateRange(vix);

  // Apply day-of-week and clustering multipliers to range thresholds
  const hlAdj = (dowMult?.multHL ?? 1) * cMult;
  const ocAdj = (dowMult?.multOC ?? 1) * cMult;

  // Build range thresholds from interpolated data, adjusted for DOW + clustering
  const thresholds: RangeThreshold[] = [
    {
      label: 'Median O\u2192C',
      pct: range.medOC * ocAdj,
      purpose: '~50% settlement survival',
    },
    {
      label: 'Median H-L',
      pct: range.medHL * hlAdj,
      purpose: '~50% intraday survival',
    },
    {
      label: '90th O\u2192C',
      pct: range.p90OC * ocAdj,
      purpose: '~90% settlement survival',
    },
    {
      label: '90th H-L',
      pct: range.p90HL * hlAdj,
      purpose: '~90% intraday survival',
    },
  ];

  // Compute the BS delta at each threshold distance
  const computed: ThresholdDelta[] = thresholds.map((t, i) => {
    const putStrike = spot * (1 - t.pct / 100);
    const callStrike = spot * (1 + t.pct / 100);

    // Approximate z for skew scaling: z ≈ distance / (sigma * sqrt(T))
    const sqrtT = Math.sqrt(T);
    const approxZ = t.pct / 100 / (sigma * sqrtT);
    const scaledSkew = calcScaledSkew(skew, Math.min(approxZ, 3)); // cap at z=3
    const putSigma = sigma * (1 + scaledSkew);
    const callSigma = sigma * (1 - scaledSkew);

    const putDelta = calcBSDelta(spot, putStrike, putSigma, T, 'put') * 100;
    const callDelta = calcBSDelta(spot, callStrike, callSigma, T, 'call') * 100;

    return {
      label: t.label,
      pct: t.pct,
      pts: Math.round((t.pct / 100) * spot),
      putDelta,
      callDelta,
      purpose: t.purpose,
      importance: i >= 2 ? ('primary' as const) : ('secondary' as const),
    };
  });

  // The recommended max delta: clearing the 90th O→C threshold
  const settlementTarget = computed[2]; // 90th O→C
  const recommendedDelta = settlementTarget
    ? Math.min(settlementTarget.putDelta, settlementTarget.callDelta)
    : null;

  // Spread-specific ceilings (use individual put/call deltas instead of min)
  const putSpreadCeiling = settlementTarget
    ? Math.floor(settlementTarget.putDelta)
    : null;
  const callSpreadCeiling = settlementTarget
    ? Math.floor(settlementTarget.callDelta)
    : null;

  // Build the "your deltas" matrix
  const deltaRows = allDeltas.filter((r): r is DeltaRow => !('error' in r));

  // Compute guide-consistent strike distances using VIX × 1.15 σ.
  // The user's actual strikes may use VIX1D (tighter), but the regime table
  // must compare against VIX-based thresholds using VIX-based strikes.
  const sqrtT = Math.sqrt(T);
  const guideDistances = new Map<number, { putPct: string; callPct: string }>();
  for (const d of DELTA_OPTIONS) {
    const z = DELTA_Z_SCORES[d];
    if (z == null) continue;
    const sk = calcScaledSkew(skew, z);
    const pSigma = sigma * (1 + sk);
    const cSigma = sigma * (1 - sk);
    const pDrift = -(pSigma * pSigma * T) / 2;
    const cDrift = -(cSigma * cSigma * T) / 2;
    const putStrike = spot * Math.exp(-z * pSigma * sqrtT + pDrift);
    const callStrike = spot * Math.exp(z * cSigma * sqrtT + cDrift);
    guideDistances.set(d, {
      putPct: (((spot - putStrike) / spot) * 100).toFixed(2),
      callPct: (((callStrike - spot) / spot) * 100).toFixed(2),
    });
  }

  // Zone color
  const zoneColor =
    bucket.zone === 'go'
      ? th.green
      : bucket.zone === 'caution'
        ? '#E8A317'
        : th.red;

  return (
    <div className="mt-4">
      <div className="text-accent mb-2.5 flex flex-wrap items-center gap-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        <span>Delta Guide for VIX {vix.toFixed(1)}</span>
        {dowMult &&
          (() => {
            const dowHL = dowMult.multHL;
            return (
              <span
                className="rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold"
                style={{
                  backgroundColor:
                    dowHL < 0.97
                      ? th.green + '18'
                      : dowHL > 1.03
                        ? '#E8A31718'
                        : th.surfaceAlt,
                  color:
                    dowHL < 0.97
                      ? th.green
                      : dowHL > 1.03
                        ? '#E8A317'
                        : th.textMuted,
                }}
              >
                {dowMult.dayShort}{' '}
                {dowHL < 0.97 ? '\u2193' : dowHL > 1.03 ? '\u2191' : '\u2248'}
                {dowHL < 0.97 ? ' quieter' : dowHL > 1.03 ? ' wider' : ' avg'}
              </span>
            );
          })()}
        {cMult > 1.03 && (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold"
            style={{
              backgroundColor: cMult > 1.15 ? th.red + '18' : '#E8A31718',
              color: cMult > 1.15 ? th.red : '#E8A317',
            }}
          >
            {'\u26A1'} {cMult.toFixed(2)}x cluster
          </span>
        )}
        {cMult < 0.97 && (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold"
            style={{
              backgroundColor: th.green + '18',
              color: th.green,
            }}
          >
            {'\u2193'} {cMult.toFixed(2)}x calm
          </span>
        )}
      </div>

      {/* Recommendation Banner */}
      {recommendedDelta != null &&
        (() => {
          const maxD = Math.floor(recommendedDelta);
          const intradayTarget = computed[3]; // 90th H-L
          const intradayDelta = intradayTarget
            ? Math.floor(
                Math.min(intradayTarget.putDelta, intradayTarget.callDelta),
              )
            : null;

          // When ceiling is 0 or below, no safe delta exists — sit out
          if (maxD <= 0) {
            return (
              <div
                className="mb-3.5 overflow-hidden rounded-[10px]"
                style={{ border: '1.5px solid ' + th.red + '30' }}
              >
                <div
                  className="flex flex-col gap-2.5 p-3.5 px-4.5 md:flex-row md:items-center md:justify-between"
                  style={{ backgroundColor: th.red + '10' }}
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
                      {settlementTarget!.pct.toFixed(2)}% /{' '}
                      {settlementTarget!.pts} pts) is too wide for any delta to
                      clear at this VIX level and time remaining. Selling
                      premium here means accepting {'\u003C'}90% settlement
                      survival.
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
                    backgroundColor: th.red + '08',
                    borderTop: '1px solid ' + th.red + '15',
                  }}
                >
                  {'\u26A0\uFE0F'}{' '}
                  <strong style={{ color: th.red }}>Extreme conditions</strong>{' '}
                  {'\u2014'} if you must trade, use the absolute minimum size
                  and the widest wings available. But the data says today is one
                  of the days that breaks iron condors.
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
              style={{ border: '1.5px solid ' + zoneColor + '30' }}
            >
              {/* Main recommendation */}
              <div
                className="flex flex-col gap-2.5 p-3.5 px-4.5 md:flex-row md:items-center md:justify-between"
                style={{ backgroundColor: zoneColor + '10' }}
              >
                <div>
                  <div
                    className="mb-1 font-sans text-[10px] font-bold tracking-[0.08em] uppercase"
                    style={{ color: zoneColor }}
                  >
                    Maximum delta {'\u2014'} do not exceed (~90% settlement)
                  </div>
                  <div className="text-secondary font-sans text-[12px] leading-normal">
                    <strong className="text-primary">
                      {maxD}
                      {'\u0394'}
                    </strong>{' '}
                    is the most aggressive you should sell to clear the 90th
                    percentile O{'\u2192'}C move (
                    {settlementTarget!.pct.toFixed(2)}% /{' '}
                    {settlementTarget!.pts} pts). This is a{' '}
                    <strong style={{ color: zoneColor }}>
                      ceiling, not a target
                    </strong>{' '}
                    {'\u2014'} tighter is safer.
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-muted mb-0.5 font-sans text-[10px] font-semibold">
                    CEILING
                  </div>
                  <div
                    className="font-mono text-[32px] leading-none font-extrabold"
                    style={{ color: zoneColor }}
                  >
                    {maxD}
                    {'\u0394'}
                  </div>
                </div>
              </div>

              {/* Guidance row */}
              {(() => {
                const showModerate =
                  intradayDelta != null &&
                  intradayDelta > 0 &&
                  intradayDelta < maxD;
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
                    style={{ borderTop: '1px solid ' + zoneColor + '20' }}
                  >
                    <GuidanceCell
                      label="Aggressive"
                      delta={maxD}
                      desc={'Ceiling \u2014 90% settle'}
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

              {/* Spread-specific ceilings */}
              {putSpreadCeiling != null &&
                callSpreadCeiling != null &&
                (putSpreadCeiling > maxD || callSpreadCeiling > maxD) && (
                  <div
                    className="flex items-center gap-4 px-4.5 py-2"
                    style={{
                      borderTop: '1px solid ' + zoneColor + '15',
                      backgroundColor: zoneColor + '05',
                    }}
                  >
                    <span className="text-muted font-sans text-[10px] font-bold tracking-wider uppercase">
                      Directional:
                    </span>
                    <span className="font-sans text-[11px]">
                      <span className="text-danger font-bold">
                        {putSpreadCeiling}
                        {'\u0394'}
                      </span>
                      <span className="text-muted ml-1 text-[10px]">
                        put spread
                      </span>
                    </span>
                    <span className="text-muted text-[10px]">{'\u2502'}</span>
                    <span className="font-sans text-[11px]">
                      <span className="text-success font-bold">
                        {callSpreadCeiling}
                        {'\u0394'}
                      </span>
                      <span className="text-muted ml-1 text-[10px]">
                        call spread
                      </span>
                    </span>
                    <span className="text-muted ml-auto font-sans text-[9px] italic">
                      Single-side only {'\u2014'} use with Market Tide
                    </span>
                  </div>
                )}

              {/* Position sizing note for elevated regimes */}
              {(bucket.zone === 'caution' ||
                bucket.zone === 'stop' ||
                bucket.zone === 'danger') && (
                <div
                  className="text-secondary px-4.5 py-2 font-sans text-[11px] leading-normal"
                  style={{
                    backgroundColor: zoneColor + '08',
                    borderTop: '1px solid ' + zoneColor + '15',
                  }}
                >
                  {'\u26A0\uFE0F'}{' '}
                  <strong style={{ color: zoneColor }}>Elevated VIX</strong>{' '}
                  {'\u2014'} consider reducing contracts even at tighter deltas.
                  The 10% of days that breach are often{' '}
                  {bucket.zone === 'danger' ? '5%+' : '3\u20135%'} moves where
                  max loss hits hard.
                </div>
              )}
            </div>
          );
        })()}

      {/* Table 1: Range Thresholds → Delta */}
      <div className="border-edge overflow-x-auto rounded-[10px] border">
        <table
          className="w-full border-collapse font-mono text-[13px]"
          role="table"
          aria-label="VIX regime range thresholds mapped to delta"
        >
          <thead>
            <tr className="bg-table-header">
              <th className={mkTh('left')}>To Clear</th>
              <th className={mkTh('right')}>Range %</th>
              <th className={mkTh('right')}>Points</th>
              <th className={mkTh('right', 'text-danger')}>
                Max Put {'\u0394'}
              </th>
              <th className={mkTh('right', 'text-success')}>
                Max Call {'\u0394'}
              </th>
              <th className={mkTh('left')}>Survival</th>
            </tr>
          </thead>
          <tbody>
            {computed.map((c, i) => (
              <tr
                key={c.label}
                className={
                  c.importance === 'primary'
                    ? 'border-l-accent bg-accent-bg border-l-[3px]'
                    : `border-l-[3px] border-transparent ${i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}`
                }
              >
                <td
                  className={`${mkTd()} ${c.importance === 'primary' ? 'text-accent font-bold' : 'text-primary font-medium'}`}
                >
                  {c.label}
                </td>
                <td className={`${mkTd()} text-right font-semibold`}>
                  {c.pct.toFixed(2)}%
                </td>
                <td className={`${mkTd()} text-secondary text-right`}>
                  {c.pts}
                </td>
                <td
                  className={`${mkTd()} text-danger text-right font-semibold`}
                >
                  {c.putDelta < 1 ? '<1' : c.putDelta.toFixed(1)}
                  {'\u0394'}
                </td>
                <td
                  className={`${mkTd()} text-success text-right font-semibold`}
                >
                  {c.callDelta < 1 ? '<1' : c.callDelta.toFixed(1)}
                  {'\u0394'}
                </td>
                <td className={`${mkTd()} text-muted text-[11px]`}>
                  {c.purpose}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-muted mt-1.5 mb-4 text-[11px] italic">
        {'"'}Max Delta{'"'} = the highest delta whose strike clears that range.
        Sell at or below this delta. Uses VIX-derived {'\u03C3'}=
        {sigma.toFixed(4)} (VIX {vix.toFixed(1)} {'\u00D7'} {VIX_TO_SIGMA_MULT})
        and T={T.toFixed(6)}.
        {skew > 0
          ? ' Skew-adjusted: puts use higher \u03C3, calls use lower.'
          : ''}{' '}
        Range thresholds interpolated for VIX {vix.toFixed(1)} from per-point
        historical data.
        {dowMult
          ? ' ' +
            dowMult.dayLabel +
            ': H-L \u00D7' +
            dowMult.multHL.toFixed(3) +
            '.'
          : ''}
        {cMult === 1 ? '' : ' Clustering: \u00D7' + cMult.toFixed(3) + '.'}
        {dowMult || cMult !== 1
          ? ' Combined adj: H-L \u00D7' +
            hlAdj.toFixed(3) +
            ', O\u2192C \u00D7' +
            ocAdj.toFixed(3) +
            '.'
          : ''}
      </p>

      {/* Table 2: Your Deltas vs. Regime Thresholds */}
      {deltaRows.length > 0 && (
        <>
          <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
            Your Deltas vs. Regime Thresholds
          </div>

          <div className="border-edge overflow-x-auto rounded-[10px] border">
            <table
              className="w-full border-collapse font-mono text-[13px]"
              role="table"
              aria-label="Standard deltas vs VIX regime thresholds"
            >
              <thead>
                <tr className="bg-table-header">
                  <th className={mkTh('center')}>Delta</th>
                  <th className={mkTh('right')}>Put %</th>
                  <th className={mkTh('right')}>Call %</th>
                  <th className={mkTh('center')}>Med O{'\u2192'}C</th>
                  <th className={mkTh('center')}>Med H-L</th>
                  <th className={`${mkTh('center')} border-edge border-l-2`}>
                    90th O{'\u2192'}C
                  </th>
                  <th className={mkTh('center')}>90th H-L</th>
                </tr>
              </thead>
              <tbody>
                {deltaRows.map((r, i) => {
                  // Use guide-consistent distances (VIX × 1.15 σ) for threshold comparison
                  const gd = guideDistances.get(r.delta);
                  const putPct = gd
                    ? Number.parseFloat(gd.putPct)
                    : Number.parseFloat(r.putPct);
                  const callPct = gd
                    ? Number.parseFloat(gd.callPct)
                    : Number.parseFloat(r.callPct);

                  return (
                    <tr
                      key={r.delta}
                      className={i % 2 === 1 ? 'bg-table-alt' : 'bg-surface'}
                    >
                      <td
                        className={`${mkTd()} text-accent text-center font-bold`}
                      >
                        {r.delta}
                        {'\u0394'}
                      </td>
                      <td className={`${mkTd()} text-danger text-right`}>
                        {gd ? gd.putPct : r.putPct}%
                      </td>
                      <td className={`${mkTd()} text-success text-right`}>
                        {gd ? gd.callPct : r.callPct}%
                      </td>
                      {computed.map((c, ci) => {
                        const putClears = putPct >= c.pct;
                        const callClears = callPct >= c.pct;
                        const bothClear = putClears && callClears;
                        return (
                          <td
                            key={c.label}
                            className={`${mkTd()} text-center ${ci === 2 ? 'border-edge border-l-2' : ''}`}
                          >
                            {bothClear ? (
                              <span className="text-success text-[15px] font-bold">
                                {'\u2713'}
                              </span>
                            ) : putClears || callClears ? (
                              <span
                                className="text-[11px] font-semibold"
                                style={{ color: '#E8A317' }}
                              >
                                {putClears ? 'P\u2713' : 'C\u2713'}
                              </span>
                            ) : (
                              <span className="text-danger text-[13px] font-medium">
                                {'\u2717'}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-muted mt-1.5 text-[11px] italic">
            {'\u2713'} = both sides clear threshold (IC safe).{' '}
            <span style={{ color: '#E8A317' }}>P{'\u2713'}</span> = only put
            side clears (put spread OK).{' '}
            <span style={{ color: '#E8A317' }}>C{'\u2713'}</span> = only call
            side clears (call spread OK). {'\u2717'} = neither side clears.
            Put/Call % use VIX {'\u00D7'} 1.15 {'\u03C3'} to match the Guide
            {'\u2019'}s thresholds.
          </p>
        </>
      )}
    </div>
  );
}

function GuidanceCell({
  label,
  delta,
  desc,
  color,
}: {
  label: string;
  delta: number;
  desc: string;
  color: string;
}) {
  return (
    <div className="text-center">
      <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.06em] uppercase">
        {label}
      </div>
      <div
        className="mt-0.5 font-mono text-xl font-extrabold"
        style={{ color }}
      >
        {delta}
        {'\u0394'}
      </div>
      <div className="text-muted font-mono text-[10px]">{desc}</div>
    </div>
  );
}
