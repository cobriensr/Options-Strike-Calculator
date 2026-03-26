import { useState, useEffect, useRef } from 'react';
import { theme } from '../../themes';
import { inputCls, tinyLbl, tint } from '../../utils/ui-utils';
import {
  getClusterMultiplier,
  CLUSTER_THRESHOLDS,
} from '../../data/vixRangeStats';
import PercentileBar from './PercentileBar';

interface Props {
  readonly vix: number | null;
  readonly spot: number | null;
  readonly onMultiplierChange?: (mult: number) => void;
  readonly initialYesterday?: {
    readonly open: number;
    readonly high: number;
    readonly low: number;
  };
  readonly clusterPutMult?: number | null;
  readonly clusterCallMult?: number | null;
}

/**
 * Volatility Clustering signal.
 * Takes yesterday's SPX high/low/open, computes the H-L range,
 * classifies it against VIX-regime percentile thresholds, and shows
 * the clustering multiplier for today's expected range.
 */
export default function VolatilityCluster({
  vix,
  spot,
  onMultiplierChange,
  initialYesterday,
  clusterPutMult,
  clusterCallMult,
}: Props) {
  const [yestHigh, setYestHigh] = useState('5750');
  const [yestLow, setYestLow] = useState('5690');
  const [yestOpen, setYestOpen] = useState('5720');
  const userEdited = useRef(false);

  // Auto-fill from live data (overwrites defaults but respects user edits)
  useEffect(() => {
    if (initialYesterday && !userEdited.current) {
      setYestOpen(initialYesterday.open.toFixed(2));
      setYestHigh(initialYesterday.high.toFixed(2));
      setYestLow(initialYesterday.low.toFixed(2));
    }
  }, [initialYesterday]);

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
  }, [cluster?.mult, onMultiplierChange]);

  // Determine signal color
  const signalColor = cluster
    ? cluster.mult < 0.96
      ? theme.green
      : cluster.mult < 1.05
        ? theme.accent
        : cluster.mult < 1.2
          ? theme.caution
          : theme.red
    : theme.textMuted;

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
            Yesterday Open
          </label>
          <input
            id="yest-open"
            type="text"
            inputMode="decimal"
            placeholder={spot ? spot.toFixed(0) : 'e.g. 6800'}
            value={yestOpen}
            onChange={(e) => {
              setYestOpen(e.target.value);
              userEdited.current = true;
            }}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="yest-high" className={tinyLbl}>
            Yesterday High
          </label>
          <input
            id="yest-high"
            type="text"
            inputMode="decimal"
            placeholder={spot ? (spot + 30).toFixed(0) : 'e.g. 6830'}
            value={yestHigh}
            onChange={(e) => {
              setYestHigh(e.target.value);
              userEdited.current = true;
            }}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="yest-low" className={tinyLbl}>
            Yesterday Low
          </label>
          <input
            id="yest-low"
            type="text"
            inputMode="decimal"
            placeholder={spot ? (spot - 30).toFixed(0) : 'e.g. 6770'}
            value={yestLow}
            onChange={(e) => {
              setYestLow(e.target.value);
              userEdited.current = true;
            }}
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
              backgroundColor: tint(signalColor, '10'),
              border: '1.5px solid ' + tint(signalColor, '30'),
            }}
          >
            <div
              className="h-3 w-3 shrink-0 rounded-full"
              style={{
                backgroundColor: signalColor,
                boxShadow: '0 0 8px ' + tint(signalColor, '66'),
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
              <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
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
              <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
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
              <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
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

          {/* Directional asymmetry indicator */}
          {clusterPutMult != null &&
            clusterCallMult != null &&
            Math.abs(clusterPutMult - clusterCallMult) > 0.01 && (
              <div className="bg-surface border-edge mb-3 rounded-[10px] border p-3">
                <div className="text-tertiary mb-1.5 font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                  Directional Tilt
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-danger font-sans text-[10px] font-bold">
                        Put side
                      </span>
                      <span
                        className="font-mono text-[13px] font-bold"
                        style={{
                          color:
                            clusterPutMult > clusterCallMult
                              ? theme.red
                              : theme.textMuted,
                        }}
                      >
                        {clusterPutMult.toFixed(3)}x
                      </span>
                    </div>
                    <div className="bg-surface-alt relative h-1.5 overflow-hidden rounded-[3px]">
                      <div
                        className="absolute top-0 left-0 h-full rounded-[3px]"
                        style={{
                          width: Math.min(clusterPutMult / 1.5, 1) * 100 + '%',
                          backgroundColor: theme.red,
                          opacity: 0.6,
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-success font-sans text-[10px] font-bold">
                        Call side
                      </span>
                      <span
                        className="font-mono text-[13px] font-bold"
                        style={{
                          color:
                            clusterCallMult > clusterPutMult
                              ? theme.green
                              : theme.textMuted,
                        }}
                      >
                        {clusterCallMult.toFixed(3)}x
                      </span>
                    </div>
                    <div className="bg-surface-alt relative h-1.5 overflow-hidden rounded-[3px]">
                      <div
                        className="absolute top-0 left-0 h-full rounded-[3px]"
                        style={{
                          width: Math.min(clusterCallMult / 1.5, 1) * 100 + '%',
                          backgroundColor: theme.green,
                          opacity: 0.6,
                        }}
                      />
                    </div>
                  </div>
                </div>
                <div className="text-muted mt-1.5 font-sans text-[10px]">
                  {clusterPutMult > clusterCallMult
                    ? 'Yesterday closed lower — downside range expanded more. Consider wider put strikes or tighter call strikes.'
                    : 'Yesterday closed higher — upside range expanded slightly more. Mild asymmetry; both sides affected.'}
                </div>
              </div>
            )}

          {/* Percentile reference bar */}
          {thresholds && (
            <PercentileBar
             
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
