import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { DeltaRow, DeltaRowError } from '../../types';
import {
  calcBSDelta,
  calcScaledSkew,
  calcScaledCallSkew,
} from '../../utils/calculator';
import { DELTA_Z_SCORES, DELTA_OPTIONS, DEFAULTS } from '../../constants';
import { parseDow } from '../../utils/time';
import {
  findBucket,
  estimateRange,
  getDowMultiplier,
} from '../../data/vixRangeStats';
import RecommendationBanner from './RecommendationBanner';
import RangeThresholdsTable from './RangeThresholdsTable';
import DeltaThresholdsTable from './DeltaThresholdsTable';
import type { ThresholdDelta } from './types';

interface Props {
  readonly vix: number;
  readonly spot: number;
  readonly T: number;
  readonly skew: number; // decimal, e.g. 0.03
  readonly allDeltas: ReadonlyArray<DeltaRow | DeltaRowError>;
  readonly selectedDate?: string; // 'YYYY-MM-DD' from date picker, falls back to today
  readonly clusterMult?: number; // Volatility clustering multiplier (1.0 = no effect)
}

/** A range threshold from the VIX regime data */
interface RangeThreshold {
  readonly label: string;
  readonly pct: number;
  readonly purpose: string;
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

  // Compute sigma internally from VIX — always uses VIX × DEFAULTS.IV_PREMIUM_FACTOR / 100
  // so the Delta Guide stays self-consistent with VIX-based range thresholds,
  // regardless of whether the user switched to Direct IV (VIX1D) for strike pricing.
  const sigma = (vix * DEFAULTS.IV_PREMIUM_FACTOR) / 100;

  // Clustering multiplier (default 1.0 = no effect)
  const cMult = clusterMult != null && clusterMult > 0 ? clusterMult : 1;

  // Derive day of week from selected date, falling back to today
  const dow = parseDow(selectedDate);
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
    const cappedZ = Math.min(approxZ, 3);
    const putSigma = sigma * (1 + calcScaledSkew(skew, cappedZ));
    const callSigma = sigma * (1 - calcScaledCallSkew(skew, cappedZ));

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
  const sqrtT = Math.sqrt(T);
  const guideDistances = new Map<number, { putPct: string; callPct: string }>();
  for (const d of DELTA_OPTIONS) {
    const z = DELTA_Z_SCORES[d];
    if (z == null) continue;
    const pSigma = sigma * (1 + calcScaledSkew(skew, z));
    const cSigma = sigma * (1 - calcScaledCallSkew(skew, z));
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
      ? theme.green
      : bucket.zone === 'caution'
        ? theme.caution
        : theme.red;

  return (
    <div className="mt-4">
      <div className="text-accent mb-2.5 flex flex-wrap items-center gap-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        <span>Delta Guide for VIX {vix.toFixed(1)}</span>
        {dowMult &&
          (() => {
            const dowHL = dowMult.multHL;
            return (
              <span
                className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
                style={{
                  backgroundColor:
                    dowHL < 0.97
                      ? tint(theme.green, '18')
                      : dowHL > 1.03
                        ? tint(theme.caution, '18')
                        : theme.surfaceAlt,
                  color:
                    dowHL < 0.97
                      ? theme.green
                      : dowHL > 1.03
                        ? theme.caution
                        : theme.textMuted,
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
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={{
              backgroundColor:
                cMult > 1.15
                  ? tint(theme.red, '18')
                  : tint(theme.caution, '18'),
              color: cMult > 1.15 ? theme.red : theme.caution,
            }}
          >
            {'\u26A1'} {cMult.toFixed(2)}x cluster
          </span>
        )}
        {cMult < 0.97 && (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={{
              backgroundColor: tint(theme.green, '18'),
              color: theme.green,
            }}
          >
            {'\u2193'} {cMult.toFixed(2)}x calm
          </span>
        )}
      </div>

      {/* Recommendation Banner */}
      {settlementTarget && (
        <RecommendationBanner
          bucket={bucket}
          zoneColor={zoneColor}
          recommendedDelta={recommendedDelta}
          putSpreadCeiling={putSpreadCeiling}
          callSpreadCeiling={callSpreadCeiling}
          settlementTarget={settlementTarget}
          computed={computed}
        />
      )}

      {/* Table 1: Range Thresholds → Delta */}
      <RangeThresholdsTable computed={computed} />

      <p className="text-muted mt-1.5 mb-4 text-[11px] italic">
        {'"'}Max Delta{'"'} = the highest delta whose strike clears that range.
        Sell at or below this delta. Uses VIX-derived {'\u03C3'}=
        {sigma.toFixed(4)} (VIX {vix.toFixed(1)} {'\u00D7'}{' '}
        {DEFAULTS.IV_PREMIUM_FACTOR}) and T={T.toFixed(6)}.
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
      <DeltaThresholdsTable
        deltaRows={deltaRows}
        computed={computed}
        guideDistances={guideDistances}
      />
    </div>
  );
}
