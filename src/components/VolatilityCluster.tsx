import { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../themes';
import { tinyLblStyle } from './ui';
import { getClusterMultiplier, CLUSTER_THRESHOLDS } from '../data/vixRangeStats';

interface Props {
  readonly th: Theme;
  readonly vix: number | null;
  readonly spot: number | null;
  readonly onMultiplierChange?: (mult: number) => void; // Callback when clustering mult changes
}

/**
 * Volatility Clustering signal.
 * Takes yesterday's SPX high/low/open, computes the H-L range,
 * classifies it against VIX-regime percentile thresholds, and shows
 * the clustering multiplier for today's expected range.
 *
 * Based on 9,107 trading days of SPX data (1990–2026):
 * - After a p90 range day at VIX 25+, today's median range is 87% wider
 * - After a calm day at VIX <18, today's median range is 9% narrower
 */
export default function VolatilityCluster({ th, vix, spot, onMultiplierChange }: Props) {
  const [yestHigh, setYestHigh] = useState('');
  const [yestLow, setYestLow] = useState('');
  const [yestOpen, setYestOpen] = useState('');

  const hasVix = vix != null && vix > 0;
  const highVal = Number.parseFloat(yestHigh);
  const lowVal = Number.parseFloat(yestLow);
  const openVal = Number.parseFloat(yestOpen);
  const hasBothHL = !Number.isNaN(highVal) && !Number.isNaN(lowVal);
  const hasRange = hasBothHL && highVal > lowVal;

  // Compute yesterday's range %
  const refPrice = !Number.isNaN(openVal) && openVal > 0 ? openVal : (spot ?? ((highVal + lowVal) / 2));
  const yestRangePct = hasRange ? ((highVal - lowVal) / refPrice) * 100 : null;

  // Get cluster result
  const cluster = hasVix && vix && yestRangePct != null
    ? getClusterMultiplier(vix, yestRangePct)
    : null;

  // Notify parent of multiplier changes
  useEffect(() => {
    if (onMultiplierChange) {
      onMultiplierChange(cluster?.mult ?? 1);
    }
  }, [cluster?.mult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Determine signal color
  const signalColor = cluster
    ? cluster.mult < 0.96 ? th.green
      : cluster.mult < 1.05 ? th.accent
      : cluster.mult < 1.20 ? '#E8A317'
      : th.red
    : th.textMuted;

  const signalLabel = cluster
    ? cluster.mult < 0.96 ? 'TAILWIND'
      : cluster.mult < 1.05 ? 'NEUTRAL'
      : cluster.mult < 1.20 ? 'CLUSTERING'
      : 'HIGH CLUSTERING'
    : '';

  const signalAdvice = cluster
    ? cluster.mult < 0.96 ? 'Yesterday was calm. Historically, today tends to be quieter than average. Standard positions.'
      : cluster.mult < 1.05 ? 'Yesterday was typical. No clustering signal. Proceed per delta guide.'
      : cluster.mult < 1.20 ? 'Yesterday was active. Volatility tends to persist \u2014 consider tightening 1\u20132\u0394 or reducing size.'
      : 'Yesterday was extreme. Strong clustering effect \u2014 expect a wider range today. Widen significantly or reduce exposure.'
    : '';

  // Reference thresholds for the current VIX regime
  const thresholds = hasVix && vix
    ? vix < 18 ? CLUSTER_THRESHOLDS.lowVix
      : vix < 25 ? CLUSTER_THRESHOLDS.midVix
      : CLUSTER_THRESHOLDS.highVix
    : null;

  const tinyLbl = tinyLblStyle(th);
  const inputStyle: CSSProperties = {
    backgroundColor: th.inputBg, border: '1.5px solid ' + th.borderStrong, borderRadius: 8,
    color: th.text, padding: '11px 14px', fontSize: 16, fontFamily: "'DM Mono', monospace",
    outline: 'none', width: '100%', boxSizing: 'border-box' as const, transition: 'border-color 0.15s',
  };

  return (
    <div>
      <div style={{
        fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 700,
        textTransform: 'uppercase' as const, letterSpacing: '0.14em',
        color: th.accent, marginBottom: 10,
      }}>
        Volatility Clustering
      </div>

      <p style={{ fontSize: 12, color: th.textSecondary, margin: '0 0 12px', fontFamily: "'Outfit', sans-serif", lineHeight: 1.5 }}>
        Enter yesterday{'\u2019'}s SPX high, low, and open to check if volatility is clustering. Big range days tend to follow big range days.
      </p>

      {/* Input row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
        <div>
          <label htmlFor="yest-open" style={tinyLbl}>Yest. Open</label>
          <input
            id="yest-open"
            type="text"
            inputMode="decimal"
            placeholder={spot ? spot.toFixed(0) : 'e.g. 6800'}
            value={yestOpen}
            onChange={(e) => setYestOpen(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="yest-high" style={tinyLbl}>Yest. High</label>
          <input
            id="yest-high"
            type="text"
            inputMode="decimal"
            placeholder={spot ? (spot + 30).toFixed(0) : 'e.g. 6830'}
            value={yestHigh}
            onChange={(e) => setYestHigh(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="yest-low" style={tinyLbl}>Yest. Low</label>
          <input
            id="yest-low"
            type="text"
            inputMode="decimal"
            placeholder={spot ? (spot - 30).toFixed(0) : 'e.g. 6770'}
            value={yestLow}
            onChange={(e) => setYestLow(e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Results */}
      {cluster && yestRangePct != null && (
        <div>
          {/* Signal banner */}
          <div style={{
            padding: '12px 16px', borderRadius: 10, marginBottom: 12,
            backgroundColor: signalColor + '10',
            border: '1.5px solid ' + signalColor + '30',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{
              width: 12, height: 12, borderRadius: '50%',
              backgroundColor: signalColor,
              boxShadow: '0 0 8px ' + signalColor + '66',
              flexShrink: 0,
            }} />
            <div>
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
                letterSpacing: '0.1em', color: signalColor,
                fontFamily: "'Outfit', sans-serif",
              }}>
                {signalLabel}
              </span>
              <span style={{
                fontSize: 11, color: th.textSecondary, marginLeft: 10,
                fontFamily: "'Outfit', sans-serif",
              }}>
                {signalAdvice}
              </span>
            </div>
          </div>

          {/* Stats grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10,
            padding: '14px 16px', borderRadius: 10,
            backgroundColor: th.surfaceAlt,
            border: '1px solid ' + th.border,
            marginBottom: 12,
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
                letterSpacing: '0.06em', color: th.textTertiary,
                fontFamily: "'Outfit', sans-serif",
              }}>Yesterday{'\u2019'}s Range</div>
              <div style={{
                fontSize: 20, fontWeight: 700, color: signalColor,
                fontFamily: "'DM Mono', monospace", marginTop: 2,
              }}>
                {yestRangePct.toFixed(2)}%
              </div>
              <div style={{ fontSize: 10, color: th.textMuted, fontFamily: "'DM Mono', monospace" }}>
                {(highVal - lowVal).toFixed(0)} pts
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
                letterSpacing: '0.06em', color: th.textTertiary,
                fontFamily: "'Outfit', sans-serif",
              }}>Classification</div>
              <div style={{
                fontSize: 13, fontWeight: 700, color: signalColor,
                fontFamily: "'DM Mono', monospace", marginTop: 6,
              }}>
                {cluster.yesterdayPctile}
              </div>
              <div style={{ fontSize: 10, color: th.textMuted, fontFamily: "'DM Mono', monospace" }}>
                {cluster.regime}
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
                letterSpacing: '0.06em', color: th.textTertiary,
                fontFamily: "'Outfit', sans-serif",
              }}>Today{'\u2019'}s Multiplier</div>
              <div style={{
                fontSize: 20, fontWeight: 800, color: signalColor,
                fontFamily: "'DM Mono', monospace", marginTop: 2,
              }}>
                {cluster.mult.toFixed(3)}x
              </div>
              <div style={{ fontSize: 10, color: th.textMuted, fontFamily: "'DM Mono', monospace" }}>
                {cluster.mult > 1 ? 'wider' : cluster.mult < 1 ? 'narrower' : 'average'}
              </div>
            </div>
          </div>

          {/* Percentile reference bar */}
          {thresholds && (
            <div style={{
              padding: '12px 16px', borderRadius: 10,
              backgroundColor: th.surface,
              border: '1px solid ' + th.border,
            }}>
              <div style={{
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
                letterSpacing: '0.06em', color: th.textTertiary,
                fontFamily: "'Outfit', sans-serif", marginBottom: 8,
              }}>
                Yesterday{'\u2019'}s range vs. regime percentiles
              </div>

              <div style={{
                height: 12, borderRadius: 6, backgroundColor: th.surfaceAlt,
                position: 'relative', overflow: 'visible', marginBottom: 20,
              }}>
                {/* Colored segments */}
                <div style={{ position: 'absolute', top: 0, left: 0, width: '50%', height: '100%', backgroundColor: th.green + '30', borderRadius: '6px 0 0 6px' }} />
                <div style={{ position: 'absolute', top: 0, left: '50%', width: '25%', height: '100%', backgroundColor: th.accent + '20' }} />
                <div style={{ position: 'absolute', top: 0, left: '75%', width: '15%', height: '100%', backgroundColor: '#E8A31730' }} />
                <div style={{ position: 'absolute', top: 0, left: '90%', width: '10%', height: '100%', backgroundColor: th.red + '30', borderRadius: '0 6px 6px 0' }} />

                {/* Yesterday's position marker */}
                {(() => {
                  const maxRange = thresholds.p90 * 1.5;
                  const pos = Math.min(yestRangePct / maxRange, 1) * 100;
                  return (
                    <div style={{
                      position: 'absolute', top: -4,
                      left: pos + '%', transform: 'translateX(-50%)',
                      width: 4, height: 20,
                      backgroundColor: signalColor,
                      borderRadius: 2,
                      boxShadow: '0 0 6px ' + signalColor + '88',
                    }} />
                  );
                })()}

                {/* Threshold labels */}
                <div style={{
                  position: 'absolute', top: 16,
                  left: (thresholds.p50 / (thresholds.p90 * 1.5) * 100) + '%',
                  fontSize: 8, color: th.textMuted, fontFamily: "'DM Mono', monospace",
                  transform: 'translateX(-50%)',
                }}>p50 ({thresholds.p50.toFixed(2)}%)</div>
                <div style={{
                  position: 'absolute', top: 16,
                  left: (thresholds.p75 / (thresholds.p90 * 1.5) * 100) + '%',
                  fontSize: 8, color: th.textMuted, fontFamily: "'DM Mono', monospace",
                  transform: 'translateX(-50%)',
                }}>p75 ({thresholds.p75.toFixed(2)}%)</div>
                <div style={{
                  position: 'absolute', top: 16,
                  left: (thresholds.p90 / (thresholds.p90 * 1.5) * 100) + '%',
                  fontSize: 8, color: th.textMuted, fontFamily: "'DM Mono', monospace",
                  transform: 'translateX(-50%)',
                }}>p90 ({thresholds.p90.toFixed(2)}%)</div>
              </div>
            </div>
          )}

          <p style={{ fontSize: 11, color: th.textMuted, margin: '8px 0 0', fontStyle: 'italic' }}>
            {cluster.mult >= 1.10
              ? 'Volatility clusters: big range days tend to follow big range days. Historical data shows today\u2019s expected range is ' + ((cluster.mult - 1) * 100).toFixed(0) + '% wider than average for this VIX level. Factor this into position sizing and delta selection.'
              : cluster.mult <= 0.96
                ? 'Yesterday was calm for this VIX level. Historically, the following day tends to be ' + ((1 - cluster.mult) * 100).toFixed(0) + '% narrower than average. Slightly favorable for selling premium.'
                : 'Yesterday\u2019s range was typical for this VIX level. No significant clustering signal.'}
          </p>
        </div>
      )}

      {/* Empty states */}
      {!hasVix && (
        <p style={{ fontSize: 12, color: th.textMuted, margin: '4px 0 0', fontStyle: 'italic' }}>
          Enter a VIX value above to enable clustering analysis.
        </p>
      )}
      {hasVix && !hasRange && (
        <p style={{ fontSize: 12, color: th.textMuted, margin: '4px 0 0', fontStyle: 'italic' }}>
          Enter yesterday{'\u2019'}s SPX high and low to check for volatility clustering.
        </p>
      )}
      {hasBothHL && highVal <= lowVal && (
        <p style={{ fontSize: 12, color: th.red, margin: '4px 0 0' }}>
          High must be greater than low.
        </p>
      )}
    </div>
  );
}