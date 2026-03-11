import type { Theme } from '../themes';
import type { DeltaRow, DeltaRowError } from '../types';
import { calcBSDelta, calcScaledSkew } from '../utils/calculator';
import { findBucket, estimateRange, getDowMultiplier, getTodayDow } from '../data/vixRangeStats';
import { mkTh, mkTd } from './ui';

interface Props {
  readonly th: Theme;
  readonly vix: number;
  readonly spot: number;
  readonly T: number;
  readonly skew: number; // decimal, e.g. 0.03
  readonly allDeltas: ReadonlyArray<DeltaRow | DeltaRowError>;
  readonly selectedDate?: string; // 'YYYY-MM-DD' from date picker, falls back to today
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
export default function DeltaRegimeGuide({ th, vix, spot, T, skew, allDeltas, selectedDate }: Props) {
  const bucket = findBucket(vix);
  if (!bucket) return null;

  // Compute sigma internally from VIX — always uses VIX × 1.15 / 100
  // so the Delta Guide stays self-consistent with VIX-based range thresholds,
  // regardless of whether the user switched to Direct IV (VIX1D) for strike pricing.
  const sigma = vix * VIX_TO_SIGMA_MULT / 100;

  // Derive day of week from selected date, falling back to today
  const dow = (() => {
    if (selectedDate) {
      // Parse 'YYYY-MM-DD' — use UTC to avoid timezone shift
      const parts = selectedDate.split('-');
      if (parts.length === 3) {
        const d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
        const jsDay = d.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
        if (jsDay >= 1 && jsDay <= 5) return jsDay - 1; // 0=Mon..4=Fri
        return null; // weekend
      }
    }
    return getTodayDow();
  })();
  const dowMult = dow != null ? getDowMultiplier(vix, dow) : null;

  // Use continuous interpolation instead of discrete bucket thresholds.
  const range = estimateRange(vix);

  // Apply day-of-week multiplier to range thresholds
  const hlAdj = dowMult?.multHL ?? 1;
  const ocAdj = dowMult?.multOC ?? 1;

  // Build range thresholds from interpolated data, DOW-adjusted
  const thresholds: RangeThreshold[] = [
    { label: 'Median O\u2192C', pct: range.medOC * ocAdj, purpose: '~50% settlement survival' },
    { label: 'Median H-L', pct: range.medHL * hlAdj, purpose: '~50% intraday survival' },
    { label: '90th O\u2192C', pct: range.p90OC * ocAdj, purpose: '~90% settlement survival' },
    { label: '90th H-L', pct: range.p90HL * hlAdj, purpose: '~90% intraday survival' },
  ];

  // Compute the BS delta at each threshold distance
  const computed: ThresholdDelta[] = thresholds.map((t, i) => {
    const putStrike = spot * (1 - t.pct / 100);
    const callStrike = spot * (1 + t.pct / 100);

    // Approximate z for skew scaling: z ≈ distance / (sigma * sqrt(T))
    const sqrtT = Math.sqrt(T);
    const approxZ = (t.pct / 100) / (sigma * sqrtT);
    const scaledSkew = calcScaledSkew(skew, Math.min(approxZ, 3)); // cap at z=3
    const putSigma = sigma * (1 + scaledSkew);
    const callSigma = sigma * (1 - scaledSkew);

    const putDelta = calcBSDelta(spot, putStrike, putSigma, T, 'put') * 100;
    const callDelta = calcBSDelta(spot, callStrike, callSigma, T, 'call') * 100;

    return {
      label: t.label,
      pct: t.pct,
      pts: Math.round(t.pct / 100 * spot),
      putDelta,
      callDelta,
      purpose: t.purpose,
      importance: i >= 2 ? 'primary' as const : 'secondary' as const,
    };
  });

  // The recommended max delta: clearing the 90th O→C threshold
  const settlementTarget = computed[2]; // 90th O→C
  const recommendedDelta = settlementTarget
    ? Math.min(settlementTarget.putDelta, settlementTarget.callDelta)
    : null;

  // Build the "your deltas" matrix
  const deltaRows = allDeltas.filter((r): r is DeltaRow => !('error' in r));

  // Zone color
  const zoneColor = bucket.zone === 'go' ? th.green
    : bucket.zone === 'caution' ? '#E8A317'
    : th.red;

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{
        fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700,
        textTransform: 'uppercase' as const, letterSpacing: '0.14em',
        color: th.accent, marginBottom: 10,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span>Delta Guide for VIX {vix.toFixed(1)}</span>
        {dowMult && (
          <span style={{
            fontSize: 9, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
            fontFamily: "'DM Mono', monospace",
            backgroundColor: hlAdj < 0.97 ? th.green + '18' : hlAdj > 1.03 ? '#E8A31718' : th.surfaceAlt,
            color: hlAdj < 0.97 ? th.green : hlAdj > 1.03 ? '#E8A317' : th.textMuted,
          }}>
            {dowMult.dayShort} {hlAdj < 0.97 ? '\u2193' : hlAdj > 1.03 ? '\u2191' : '\u2248'}
            {hlAdj < 0.97 ? ' quieter' : hlAdj > 1.03 ? ' wider' : ' avg'}
          </span>
        )}
      </div>

      {/* Recommendation Banner */}
      {recommendedDelta != null && recommendedDelta > 0 && (() => {
        const maxD = Math.floor(recommendedDelta);
        const conservD = Math.max(1, Math.floor(maxD * 0.6));
        const intradayTarget = computed[3]; // 90th H-L
        const intradayDelta = intradayTarget
          ? Math.floor(Math.min(intradayTarget.putDelta, intradayTarget.callDelta))
          : null;

        return (
          <div style={{
            borderRadius: 10, marginBottom: 14, overflow: 'hidden',
            border: '1.5px solid ' + zoneColor + '30',
          }}>
            {/* Main recommendation */}
            <div style={{
              padding: '14px 18px',
              backgroundColor: zoneColor + '10',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexWrap: 'wrap', gap: 10,
            }}>
              <div>
                <div style={{
                  fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
                  letterSpacing: '0.08em', color: zoneColor,
                  fontFamily: "'Outfit', sans-serif", marginBottom: 4,
                }}>
                  Maximum delta {'\u2014'} do not exceed (~90% settlement)
                </div>
                <div style={{ fontSize: 12, color: th.textSecondary, fontFamily: "'Outfit', sans-serif", lineHeight: 1.5 }}>
                  <strong style={{ color: th.text }}>{maxD}{'\u0394'}</strong>
                  {' '}is the most aggressive you should sell to clear the 90th percentile O{'\u2192'}C move ({settlementTarget!.pct.toFixed(2)}% / {settlementTarget!.pts} pts).
                  {' '}This is a <strong style={{ color: zoneColor }}>ceiling, not a target</strong> {'\u2014'} tighter is safer.
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: th.textMuted, fontFamily: "'Outfit', sans-serif", fontWeight: 600, marginBottom: 2 }}>CEILING</div>
                <div style={{
                  fontSize: 32, fontWeight: 800, color: zoneColor,
                  fontFamily: "'DM Mono', monospace", lineHeight: 1,
                }}>
                  {maxD}{'\u0394'}
                </div>
              </div>
            </div>

            {/* Guidance row */}
            <div style={{
              padding: '10px 18px',
              backgroundColor: th.surfaceAlt,
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
              borderTop: '1px solid ' + zoneColor + '20',
            }}>
              <GuidanceCell
                th={th}
                label="Aggressive"
                delta={maxD}
                desc={'Ceiling \u2014 90% settle'}
                color={zoneColor}
              />
              {intradayDelta != null && intradayDelta > 0 && (
                <GuidanceCell
                  th={th}
                  label="Moderate"
                  delta={intradayDelta}
                  desc="90% intraday safe"
                  color={th.accent}
                />
              )}
              <GuidanceCell
                th={th}
                label="Conservative"
                delta={conservD}
                desc="Extra cushion"
                color={th.green}
              />
            </div>

            {/* Position sizing note for elevated regimes */}
            {(bucket.zone === 'caution' || bucket.zone === 'stop' || bucket.zone === 'danger') && (
              <div style={{
                padding: '8px 18px',
                backgroundColor: zoneColor + '08',
                borderTop: '1px solid ' + zoneColor + '15',
                fontSize: 11, color: th.textSecondary,
                fontFamily: "'Outfit', sans-serif", lineHeight: 1.5,
              }}>
                {'\u26A0\uFE0F'} <strong style={{ color: zoneColor }}>Elevated VIX</strong> {'\u2014'} consider reducing contracts even at tighter deltas. The 10% of days that breach are often {bucket.zone === 'danger' ? '5%+' : '3\u20135%'} moves where max loss hits hard.
              </div>
            )}
          </div>
        );
      })()}

      {/* Table 1: Range Thresholds → Delta */}
      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid ' + th.border }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontFamily: "'DM Mono', monospace", fontSize: 13,
        }} role="table" aria-label="VIX regime range thresholds mapped to delta">
          <thead>
            <tr style={{ backgroundColor: th.tableHeader }}>
              <th style={mkTh(th, 'left')}>To Clear</th>
              <th style={mkTh(th, 'right')}>Range %</th>
              <th style={mkTh(th, 'right')}>Points</th>
              <th style={mkTh(th, 'right', th.red)}>Max Put {'\u0394'}</th>
              <th style={mkTh(th, 'right', th.green)}>Max Call {'\u0394'}</th>
              <th style={mkTh(th, 'left')}>Survival</th>
            </tr>
          </thead>
          <tbody>
            {computed.map((c, i) => (
              <tr key={c.label} style={{
                backgroundColor: c.importance === 'primary'
                  ? (th.accentBg)
                  : (i % 2 === 1 ? th.tableRowAlt : th.surface),
                borderLeft: c.importance === 'primary' ? ('3px solid ' + th.accent) : '3px solid transparent',
              }}>
                <td style={{ ...mkTd(th), fontWeight: c.importance === 'primary' ? 700 : 500, color: c.importance === 'primary' ? th.accent : th.text }}>
                  {c.label}
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', fontWeight: 600 }}>
                  {c.pct.toFixed(2)}%
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', color: th.textSecondary }}>
                  {c.pts}
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', color: th.red, fontWeight: 600 }}>
                  {c.putDelta < 1 ? '<1' : c.putDelta.toFixed(1)}{'\u0394'}
                </td>
                <td style={{ ...mkTd(th), textAlign: 'right', color: th.green, fontWeight: 600 }}>
                  {c.callDelta < 1 ? '<1' : c.callDelta.toFixed(1)}{'\u0394'}
                </td>
                <td style={{ ...mkTd(th), fontSize: 11, color: th.textMuted }}>
                  {c.purpose}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: th.textMuted, margin: '6px 0 16px', fontStyle: 'italic' }}>
        {'"'}Max Delta{'"'} = the highest delta whose strike clears that range. Sell at or below this delta. Uses VIX-derived {'\u03C3'}={sigma.toFixed(4)} (VIX {vix.toFixed(1)} {'\u00D7'} {VIX_TO_SIGMA_MULT}) and T={T.toFixed(6)}.
        {skew > 0 ? (' Skew-adjusted: puts use higher \u03C3, calls use lower.') : ''}
        {' '}Range thresholds interpolated for VIX {vix.toFixed(1)} from per-point historical data.
        {dowMult ? (' ' + dowMult.dayLabel + ' adjustment: H-L \u00D7' + hlAdj.toFixed(3) + ', O\u2192C \u00D7' + ocAdj.toFixed(3) + '.') : ''}
      </p>

      {/* Table 2: Your Deltas vs. Regime Thresholds */}
      {deltaRows.length > 0 && (
        <>
          <div style={{
            fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700,
            textTransform: 'uppercase' as const, letterSpacing: '0.14em',
            color: th.accent, marginBottom: 10,
          }}>
            Your Deltas vs. Regime Thresholds
          </div>

          <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid ' + th.border }}>
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              fontFamily: "'DM Mono', monospace", fontSize: 13,
            }} role="table" aria-label="Standard deltas vs VIX regime thresholds">
              <thead>
                <tr style={{ backgroundColor: th.tableHeader }}>
                  <th style={mkTh(th, 'center')}>Delta</th>
                  <th style={mkTh(th, 'right')}>Put %</th>
                  <th style={mkTh(th, 'right')}>Call %</th>
                  <th style={mkTh(th, 'center')}>Med O{'\u2192'}C</th>
                  <th style={mkTh(th, 'center')}>Med H-L</th>
                  <th style={{ ...mkTh(th, 'center'), borderLeft: '2px solid ' + th.border }}>90th O{'\u2192'}C</th>
                  <th style={mkTh(th, 'center')}>90th H-L</th>
                </tr>
              </thead>
              <tbody>
                {deltaRows.map((r, i) => {
                  const putPct = Number.parseFloat(r.putPct);
                  const callPct = Number.parseFloat(r.callPct);
                  // Use the narrower of put/call distance for threshold checks (conservative)
                  const minPct = Math.min(putPct, callPct);
                  return (
                    <tr key={r.delta} style={{ backgroundColor: i % 2 === 1 ? th.tableRowAlt : th.surface }}>
                      <td style={{ ...mkTd(th), textAlign: 'center', fontWeight: 700, color: th.accent }}>
                        {r.delta}{'\u0394'}
                      </td>
                      <td style={{ ...mkTd(th), textAlign: 'right', color: th.red }}>{r.putPct}%</td>
                      <td style={{ ...mkTd(th), textAlign: 'right', color: th.green }}>{r.callPct}%</td>
                      {computed.map((c, ci) => (
                        <td key={c.label} style={{
                          ...mkTd(th), textAlign: 'center',
                          borderLeft: ci === 2 ? ('2px solid ' + th.border) : undefined,
                        }}>
                          {minPct >= c.pct
                            ? <span style={{ color: th.green, fontWeight: 700, fontSize: 15 }}>{'\u2713'}</span>
                            : <span style={{ color: th.red, fontWeight: 500, fontSize: 13 }}>{'\u2717'}</span>
                          }
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 11, color: th.textMuted, margin: '6px 0 0', fontStyle: 'italic' }}>
            {'\u2713'} = your short strike is further from spot than the historical range threshold (safe).{' '}
            {'\u2717'} = strike is within the threshold (at risk).{' '}
            Checks use the narrower side (min of put/call distance) for conservative evaluation.
          </p>
        </>
      )}
    </div>
  );
}

function GuidanceCell({ th, label, delta, desc, color }: {
  th: Theme; label: string; delta: number; desc: string; color: string;
}) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
        letterSpacing: '0.06em', color: th.textTertiary,
        fontFamily: "'Outfit', sans-serif",
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 20, fontWeight: 800, color,
        fontFamily: "'DM Mono', monospace", marginTop: 2,
      }}>
        {delta}{'\u0394'}
      </div>
      <div style={{
        fontSize: 10, color: th.textMuted,
        fontFamily: "'DM Mono', monospace",
      }}>
        {desc}
      </div>
    </div>
  );
}