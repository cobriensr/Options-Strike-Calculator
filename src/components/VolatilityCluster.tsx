import { useState, useEffect } from 'react';
import type { Theme } from '../themes';
import { tinyLbl } from './ui';
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

const inputCls = "bg-input border-[1.5px] border-edge-strong rounded-lg text-primary py-[11px] px-[14px] text-base font-mono outline-none w-full transition-[border-color] duration-150";

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

  return (
    <div>
      <div className="font-sans text-[11px] font-bold uppercase tracking-[0.14em] text-accent mb-2.5">
        Volatility Clustering
      </div>

      <p className="text-xs text-secondary m-0 mb-3 font-sans leading-normal">
        Enter yesterday{'\u2019'}s SPX high, low, and open to check if volatility is clustering. Big range days tend to follow big range days.
      </p>

      {/* Input row */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 mb-3.5">
        <div>
          <label htmlFor="yest-open" className={tinyLbl}>Yest. Open</label>
          <input
            id="yest-open"
            type="text"
            inputMode="decimal"
            placeholder={spot ? spot.toFixed(0) : 'e.g. 6800'}
            value={yestOpen}
            onChange={(e) => setYestOpen(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="yest-high" className={tinyLbl}>Yest. High</label>
          <input
            id="yest-high"
            type="text"
            inputMode="decimal"
            placeholder={spot ? (spot + 30).toFixed(0) : 'e.g. 6830'}
            value={yestHigh}
            onChange={(e) => setYestHigh(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="yest-low" className={tinyLbl}>Yest. Low</label>
          <input
            id="yest-low"
            type="text"
            inputMode="decimal"
            placeholder={spot ? (spot - 30).toFixed(0) : 'e.g. 6770'}
            value={yestLow}
            onChange={(e) => setYestLow(e.target.value)}
            className={inputCls}
          />
        </div>
      </div>

      {/* Results */}
      {cluster && yestRangePct != null && (
        <div>
          {/* Signal banner */}
          <div
            className="flex items-start sm:items-center gap-3 rounded-[10px] p-3 sm:p-4 mb-3"
            style={{ backgroundColor: signalColor + '10', border: '1.5px solid ' + signalColor + '30' }}
          >
            <div
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: signalColor, boxShadow: '0 0 8px ' + signalColor + '66' }}
            />
            <div>
              <span
                className="text-[10px] font-bold uppercase tracking-widest font-sans"
                style={{ color: signalColor }}
              >
                {signalLabel}
              </span>
              <span className="text-[11px] text-secondary ml-2.5 font-sans">
                {signalAdvice}
              </span>
            </div>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 py-3.5 px-4 rounded-[10px] bg-surface-alt border border-edge mb-3">
            <div className="text-center">
              <div className="text-[9px] font-bold uppercase tracking-[0.06em] text-tertiary font-sans">Yesterday{'\u2019'}s Range</div>
              <div
                className="text-xl font-bold font-mono mt-0.5"
                style={{ color: signalColor }}
              >
                {yestRangePct.toFixed(2)}%
              </div>
              <div className="text-[10px] text-muted font-mono">
                {(highVal - lowVal).toFixed(0)} pts
              </div>
            </div>
            <div className="text-center">
              <div className="text-[9px] font-bold uppercase tracking-[0.06em] text-tertiary font-sans">Classification</div>
              <div
                className="text-[13px] font-bold font-mono mt-1.5"
                style={{ color: signalColor }}
              >
                {cluster.yesterdayPctile}
              </div>
              <div className="text-[10px] text-muted font-mono">
                {cluster.regime}
              </div>
            </div>
            <div className="text-center">
              <div className="text-[9px] font-bold uppercase tracking-[0.06em] text-tertiary font-sans">Today{'\u2019'}s Multiplier</div>
              <div
                className="text-xl font-extrabold font-mono mt-0.5"
                style={{ color: signalColor }}
              >
                {cluster.mult.toFixed(3)}x
              </div>
              <div className="text-[10px] text-muted font-mono">
                {cluster.mult > 1 ? 'wider' : cluster.mult < 1 ? 'narrower' : 'average'}
              </div>
            </div>
          </div>

          {/* Percentile reference bar */}
          {thresholds && (
            <div className="p-3 sm:px-4 sm:py-3 rounded-[10px] bg-surface border border-edge">
              <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-tertiary font-sans mb-2">
                Yesterday{'\u2019'}s range vs. regime percentiles
              </div>

              <div className="h-3 rounded-md bg-surface-alt relative overflow-visible mb-5">
                {/* Colored segments */}
                <div className="absolute top-0 left-0 w-1/2 h-full rounded-l-md" style={{ backgroundColor: th.green + '30' }} />
                <div className="absolute top-0 left-1/2 w-1/4 h-full" style={{ backgroundColor: th.accent + '20' }} />
                <div className="absolute top-0 left-3/4 w-[15%] h-full" style={{ backgroundColor: '#E8A31730' }} />
                <div className="absolute top-0 left-[90%] w-[10%] h-full rounded-r-md" style={{ backgroundColor: th.red + '30' }} />

                {/* Yesterday's position marker */}
                {(() => {
                  const maxRange = thresholds.p90 * 1.5;
                  const pos = Math.min(yestRangePct / maxRange, 1) * 100;
                  return (
                    <div
                      className="absolute -top-1 w-1 h-5 rounded-sm -translate-x-1/2"
                      style={{
                        left: pos + '%',
                        backgroundColor: signalColor,
                        boxShadow: '0 0 6px ' + signalColor + '88',
                      }}
                    />
                  );
                })()}

                {/* Threshold labels */}
                <div
                  className="absolute top-4 text-[8px] text-muted font-mono -translate-x-1/2"
                  style={{ left: (thresholds.p50 / (thresholds.p90 * 1.5) * 100) + '%' }}
                >p50 ({thresholds.p50.toFixed(2)}%)</div>
                <div
                  className="absolute top-4 text-[8px] text-muted font-mono -translate-x-1/2"
                  style={{ left: (thresholds.p75 / (thresholds.p90 * 1.5) * 100) + '%' }}
                >p75 ({thresholds.p75.toFixed(2)}%)</div>
                <div
                  className="absolute top-4 text-[8px] text-muted font-mono -translate-x-1/2"
                  style={{ left: (thresholds.p90 / (thresholds.p90 * 1.5) * 100) + '%' }}
                >p90 ({thresholds.p90.toFixed(2)}%)</div>
              </div>
            </div>
          )}

          <p className="text-[11px] text-muted mt-2 italic">
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
        <p className="text-xs text-muted mt-1 italic">
          Enter a VIX value above to enable clustering analysis.
        </p>
      )}
      {hasVix && !hasRange && (
        <p className="text-xs text-muted mt-1 italic">
          Enter yesterday{'\u2019'}s SPX high and low to check for volatility clustering.
        </p>
      )}
      {hasBothHL && highVal <= lowVal && (
        <p className="text-xs text-danger mt-1">
          High must be greater than low.
        </p>
      )}
    </div>
  );
}
