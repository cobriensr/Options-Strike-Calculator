import { useState, useEffect } from 'react';
import type { Theme } from '../../themes';
import { tinyLbl } from '../../utils/ui-utils';
import {
  getClusterMultiplier,
  CLUSTER_THRESHOLDS,
} from '../../data/vixRangeStats';
import PercentileBar from './PercentileBar';

interface Props {
  readonly th: Theme;
  readonly vix: number | null;
  readonly spot: number | null;
  readonly onMultiplierChange?: (mult: number) => void;
  readonly initialYesterday?: {
    readonly open: number;
    readonly high: number;
    readonly low: number;
  };
}

const inputCls =
  'bg-input border-[1.5px] border-edge-strong rounded-lg text-primary py-[11px] px-[14px] text-base font-mono outline-none w-full transition-[border-color] duration-150';

/**
 * Volatility Clustering signal.
 * Takes yesterday's SPX high/low/open, computes the H-L range,
 * classifies it against VIX-regime percentile thresholds, and shows
 * the clustering multiplier for today's expected range.
 */
export default function VolatilityCluster({
  th,
  vix,
  spot,
  onMultiplierChange,
  initialYesterday,
}: Props) {
  const [yestHigh, setYestHigh] = useState('');
  const [yestLow, setYestLow] = useState('');
  const [yestOpen, setYestOpen] = useState('');

  // Auto-fill from live data (only populates empty fields)
  useEffect(() => {
    if (initialYesterday && !yestOpen) {
      setYestOpen(initialYesterday.open.toFixed(2));
      setYestHigh(initialYesterday.high.toFixed(2));
      setYestLow(initialYesterday.low.toFixed(2));
    }
  }, [initialYesterday]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasVix = vix != null && vix > 0;
  const highVal = Number.parseFloat(yestHigh);
  const lowVal = Number.parseFloat(yestLow);
  const openVal = Number.parseFloat(yestOpen);
  const hasBothHL = !Number.isNaN(highVal) && !Number.isNaN(lowVal);
  const hasRange = hasBothHL && highVal > lowVal;

  // Compute yesterday's range %
  const refPrice =
    !Number.isNaN(openVal) && openVal > 0
      ? openVal
      : (spot ?? (highVal + lowVal) / 2);
  const yestRangePct = hasRange ? ((highVal - lowVal) / refPrice) * 100 : null;

  // Get cluster result
  const cluster =
    hasVix && vix && yestRangePct != null
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
    ? cluster.mult < 0.96
      ? th.green
      : cluster.mult < 1.05
        ? th.accent
        : cluster.mult < 1.2
          ? '#E8A317'
          : th.red
    : th.textMuted;

  const signalLabel = cluster
    ? cluster.mult < 0.96
      ? 'TAILWIND'
      : cluster.mult < 1.05
        ? 'NEUTRAL'
        : cluster.mult < 1.2
          ? 'CLUSTERING'
          : 'HIGH CLUSTERING'
    : '';

  const signalAdvice = cluster
    ? cluster.mult < 0.96
      ? 'Yesterday was calm. Historically, today tends to be quieter than average. Standard positions.'
      : cluster.mult < 1.05
        ? 'Yesterday was typical. No clustering signal. Proceed per delta guide.'
        : cluster.mult < 1.2
          ? 'Yesterday was active. Volatility tends to persist \u2014 consider tightening 1\u20132\u0394 or reducing size.'
          : 'Yesterday was extreme. Strong clustering effect \u2014 expect a wider range today. Widen significantly or reduce exposure.'
    : '';

  // Reference thresholds for the current VIX regime
  const thresholds =
    hasVix && vix
      ? vix < 18
        ? CLUSTER_THRESHOLDS.lowVix
        : vix < 25
          ? CLUSTER_THRESHOLDS.midVix
          : CLUSTER_THRESHOLDS.highVix
      : null;

  return (
    <div>
      <div className="text-accent mb-2.5 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
        Volatility Clustering
      </div>

      <p className="text-secondary m-0 mb-3 font-sans text-xs leading-normal">
        Enter yesterday{'\u2019'}s SPX high, low, and open to check if
        volatility is clustering. Big range days tend to follow big range days.
      </p>

      {/* Input row */}
      <div className="mb-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <div>
          <label htmlFor="yest-open" className={tinyLbl}>
            Yest. Open
          </label>
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
          <label htmlFor="yest-high" className={tinyLbl}>
            Yest. High
          </label>
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
          <label htmlFor="yest-low" className={tinyLbl}>
            Yest. Low
          </label>
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
            className="mb-3 flex items-start gap-3 rounded-[10px] p-3 sm:items-center sm:p-4"
            style={{
              backgroundColor: signalColor + '10',
              border: '1.5px solid ' + signalColor + '30',
            }}
          >
            <div
              className="h-3 w-3 shrink-0 rounded-full"
              style={{
                backgroundColor: signalColor,
                boxShadow: '0 0 8px ' + signalColor + '66',
              }}
            />
            <div>
              <span
                className="font-sans text-[10px] font-bold tracking-widest uppercase"
                style={{ color: signalColor }}
              >
                {signalLabel}
              </span>
              <span className="text-secondary ml-2.5 font-sans text-[11px]">
                {signalAdvice}
              </span>
            </div>
          </div>

          {/* Stats grid */}
          <div className="bg-surface-alt border-edge mb-3 grid grid-cols-1 gap-2.5 rounded-[10px] border px-4 py-3.5 sm:grid-cols-3">
            <div className="text-center">
              <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.06em] uppercase">
                Yesterday{'\u2019'}s Range
              </div>
              <div
                className="mt-0.5 font-mono text-xl font-bold"
                style={{ color: signalColor }}
              >
                {yestRangePct.toFixed(2)}%
              </div>
              <div className="text-muted font-mono text-[10px]">
                {(highVal - lowVal).toFixed(0)} pts
              </div>
            </div>
            <div className="text-center">
              <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.06em] uppercase">
                Classification
              </div>
              <div
                className="mt-1.5 font-mono text-[13px] font-bold"
                style={{ color: signalColor }}
              >
                {cluster.yesterdayPctile}
              </div>
              <div className="text-muted font-mono text-[10px]">
                {cluster.regime}
              </div>
            </div>
            <div className="text-center">
              <div className="text-tertiary font-sans text-[9px] font-bold tracking-[0.06em] uppercase">
                Today{'\u2019'}s Multiplier
              </div>
              <div
                className="mt-0.5 font-mono text-xl font-extrabold"
                style={{ color: signalColor }}
              >
                {cluster.mult.toFixed(3)}x
              </div>
              <div className="text-muted font-mono text-[10px]">
                {cluster.mult > 1
                  ? 'wider'
                  : cluster.mult < 1
                    ? 'narrower'
                    : 'average'}
              </div>
            </div>
          </div>

          {/* Percentile reference bar */}
          {thresholds && (
            <PercentileBar
              th={th}
              thresholds={thresholds}
              yestRangePct={yestRangePct}
              signalColor={signalColor}
            />
          )}

          <p className="text-muted mt-2 text-[11px] italic">
            {cluster.mult >= 1.1
              ? 'Volatility clusters: big range days tend to follow big range days. Historical data shows today\u2019s expected range is ' +
                ((cluster.mult - 1) * 100).toFixed(0) +
                '% wider than average for this VIX level. Factor this into position sizing and delta selection.'
              : cluster.mult <= 0.96
                ? 'Yesterday was calm for this VIX level. Historically, the following day tends to be ' +
                  ((1 - cluster.mult) * 100).toFixed(0) +
                  '% narrower than average. Slightly favorable for selling premium.'
                : 'Yesterday\u2019s range was typical for this VIX level. No significant clustering signal.'}
          </p>
        </div>
      )}

      {/* Empty states */}
      {!hasVix && (
        <p className="text-muted mt-1 text-xs italic">
          Enter a VIX value above to enable clustering analysis.
        </p>
      )}
      {hasVix && !hasRange && (
        <p className="text-muted mt-1 text-xs italic">
          Enter yesterday{'\u2019'}s SPX high and low to check for volatility
          clustering.
        </p>
      )}
      {hasBothHL && highVal <= lowVal && (
        <p className="text-danger mt-1 text-xs">
          High must be greater than low.
        </p>
      )}
    </div>
  );
}
