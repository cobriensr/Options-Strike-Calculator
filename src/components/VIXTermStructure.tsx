import { useState, useEffect } from 'react';
import type { Theme } from '../themes';
import { tinyLbl } from '../utils/ui-utils';

interface Props {
  readonly th: Theme;
  readonly vix: number | null; // Current VIX from parent (already entered)
  readonly onUseVix1dAsSigma?: (sigma: number) => void; // Optional: let parent switch to VIX1D-derived σ
  readonly isVix1dActive?: boolean; // True when VIX1D is already being used as σ (Direct IV mode)
  readonly initialVix1d?: number; // Auto-fill from live data
  readonly initialVix9d?: number; // Auto-fill from live data
  readonly initialVvix?: number; // Auto-fill from live data
}

/** Ratio thresholds for signal classification */
const VIX1D_THRESHOLDS = {
  calm: 0.85,
  normal: 1.15,
  elevated: 1.5,
} as const;

const VIX9D_THRESHOLDS = {
  calm: 0.9,
  normal: 1.1,
  elevated: 1.25,
} as const;

type Signal = 'calm' | 'normal' | 'elevated' | 'extreme';

interface RatioResult {
  readonly ratio: number;
  readonly signal: Signal;
  readonly label: string;
  readonly color: string;
  readonly advice: string;
}

function classifyVix1dRatio(ratio: number, th: Theme): RatioResult {
  if (ratio < VIX1D_THRESHOLDS.calm) {
    return {
      ratio,
      signal: 'calm',
      label: 'CALM',
      color: th.green,
      advice:
        'Today expected quieter than average. Full position size, standard deltas.',
    };
  }
  if (ratio < VIX1D_THRESHOLDS.normal) {
    return {
      ratio,
      signal: 'normal',
      label: 'NORMAL',
      color: th.accent,
      advice: 'Typical day. Follow regime guide delta ceiling.',
    };
  }
  if (ratio < VIX1D_THRESHOLDS.elevated) {
    return {
      ratio,
      signal: 'elevated',
      label: 'ELEVATED',
      color: '#E8A317',
      advice:
        'Market pricing above-average move today. Widen deltas or reduce size.',
    };
  }
  return {
    ratio,
    signal: 'extreme',
    label: 'EVENT RISK',
    color: th.red,
    advice:
      'Major event expected (CPI, FOMC, NFP?). Consider sitting out or minimal size.',
  };
}

function classifyVix9dRatio(ratio: number, th: Theme): RatioResult {
  if (ratio < VIX9D_THRESHOLDS.calm) {
    return {
      ratio,
      signal: 'calm',
      label: 'CONTANGO',
      color: th.green,
      advice: 'Near-term vol below 30-day. Favorable term structure.',
    };
  }
  if (ratio < VIX9D_THRESHOLDS.normal) {
    return {
      ratio,
      signal: 'normal',
      label: 'FLAT',
      color: th.accent,
      advice: 'Neutral term structure. No additional signal.',
    };
  }
  if (ratio < VIX9D_THRESHOLDS.elevated) {
    return {
      ratio,
      signal: 'elevated',
      label: 'INVERTED',
      color: '#E8A317',
      advice: 'Near-term stress building. Caution over next 1\u20132 weeks.',
    };
  }
  return {
    ratio,
    signal: 'extreme',
    label: 'STEEP INVERSION',
    color: th.red,
    advice: 'Significant near-term fear. Defensive posture warranted.',
  };
}

const VVIX_THRESHOLDS = {
  stable: 80,
  normal: 100,
  unstable: 120,
} as const;

interface VvixResult {
  readonly value: number;
  readonly signal: Signal;
  readonly label: string;
  readonly color: string;
  readonly advice: string;
}

function classifyVvix(vvix: number, th: Theme): VvixResult {
  if (vvix < VVIX_THRESHOLDS.stable) {
    return {
      value: vvix,
      signal: 'calm',
      label: 'STABLE',
      color: th.green,
      advice:
        'VIX is calm and unlikely to spike. Favorable for selling premium.',
    };
  }
  if (vvix < VVIX_THRESHOLDS.normal) {
    return {
      value: vvix,
      signal: 'normal',
      label: 'NORMAL',
      color: th.accent,
      advice: 'Standard VIX volatility. No additional signal.',
    };
  }
  if (vvix < VVIX_THRESHOLDS.unstable) {
    return {
      value: vvix,
      signal: 'elevated',
      label: 'UNSTABLE',
      color: '#E8A317',
      advice: 'VIX could spike mid-session. Tighten deltas or reduce size.',
    };
  }
  return {
    value: vvix,
    signal: 'extreme',
    label: 'DANGER',
    color: th.red,
    advice:
      'VIX is highly volatile \u2014 significant whipsaw risk. Consider sitting out.',
  };
}

const inputCls =
  'bg-input border-[1.5px] border-edge-strong rounded-lg text-primary py-[11px] px-[14px] text-base font-mono outline-none w-full transition-[border-color] duration-150';

/**
 * VIX Term Structure panel.
 * Accepts VIX1D and VIX9D inputs, computes ratios against the existing VIX,
 * and provides actionable trading signals for 0DTE iron condor positioning.
 */
export default function VIXTermStructure({
  th,
  vix,
  onUseVix1dAsSigma,
  isVix1dActive,
  initialVix1d,
  initialVix9d,
  initialVvix,
}: Props) {
  const [vix1dInput, setVix1dInput] = useState('');
  const [vix9dInput, setVix9dInput] = useState('');

  // Auto-fill from live data (only populates empty fields)
  useEffect(() => {
    if (initialVix1d != null && !vix1dInput)
      setVix1dInput(initialVix1d.toFixed(2));
    if (initialVix9d != null && !vix9dInput)
      setVix9dInput(initialVix9d.toFixed(2));
  }, [initialVix1d, initialVix9d]); // eslint-disable-line react-hooks/exhaustive-deps

  const vix1d = Number.parseFloat(vix1dInput);
  const vix9d = Number.parseFloat(vix9dInput);
  const hasVix = vix != null && vix > 0;
  const hasVix1d = !Number.isNaN(vix1d) && vix1d > 0;
  const hasVix9d = !Number.isNaN(vix9d) && vix9d > 0;
  const hasVvix = initialVvix != null && initialVvix > 0;

  const vix1dRatio = hasVix && hasVix1d ? vix1d / vix : null;
  const vix9dRatio = hasVix && hasVix9d ? vix9d / vix : null;
  const vix1dResult =
    vix1dRatio == null ? null : classifyVix1dRatio(vix1dRatio, th);
  const vix9dResult =
    vix9dRatio == null ? null : classifyVix9dRatio(vix9dRatio, th);
  const vvixResult = hasVvix ? classifyVvix(initialVvix, th) : null;

  // Combined signal: worst of all available signals
  const combinedSignal: Signal | null = (() => {
    if (!vix1dResult && !vix9dResult && !vvixResult) return null;
    const signals: Signal[] = [];
    if (vix1dResult) signals.push(vix1dResult.signal);
    if (vix9dResult) signals.push(vix9dResult.signal);
    if (vvixResult) signals.push(vvixResult.signal);
    const order: Signal[] = ['calm', 'normal', 'elevated', 'extreme'];
    return signals.reduce(
      (worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst),
      'calm',
    );
  })();

  const combinedColor =
    combinedSignal === 'calm'
      ? th.green
      : combinedSignal === 'normal'
        ? th.accent
        : combinedSignal === 'elevated'
          ? '#E8A317'
          : combinedSignal === 'extreme'
            ? th.red
            : th.textMuted;

  const combinedLabel =
    combinedSignal === 'calm'
      ? 'GREEN LIGHT'
      : combinedSignal === 'normal'
        ? 'PROCEED'
        : combinedSignal === 'elevated'
          ? 'CAUTION'
          : combinedSignal === 'extreme'
            ? 'HIGH ALERT'
            : '';

  // Suggested VIX1D sigma
  const vix1dSigma = hasVix1d ? vix1d / 100 : null;

  return (
    <div>
      {/* Input row */}
      <div className="mb-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label htmlFor="vix1d-input" className={tinyLbl}>
            VIX1D{' '}
            <span className="font-normal tracking-normal normal-case opacity-70">
              (1-day)
            </span>
          </label>
          <input
            id="vix1d-input"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 18.5"
            value={vix1dInput}
            onChange={(e) => setVix1dInput(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="vix9d-input" className={tinyLbl}>
            VIX9D{' '}
            <span className="font-normal tracking-normal normal-case opacity-70">
              (9-day)
            </span>
          </label>
          <input
            id="vix9d-input"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 20.1"
            value={vix9dInput}
            onChange={(e) => setVix9dInput(e.target.value)}
            className={inputCls}
          />
        </div>
      </div>

      {/* Ratio readouts */}
      {hasVix && (hasVix1d || hasVix9d || hasVvix) && (
        <div className="mb-3.5">
          {/* Combined signal banner */}
          {combinedSignal && (
            <div
              className="mb-3 flex items-start gap-3 rounded-[10px] p-3 sm:items-center sm:p-4"
              style={{
                backgroundColor: combinedColor + '10',
                border: '1.5px solid ' + combinedColor + '30',
              }}
            >
              <div
                className="h-3 w-3 shrink-0 rounded-full"
                style={{
                  backgroundColor: combinedColor,
                  boxShadow: '0 0 8px ' + combinedColor + '66',
                }}
              />
              <div>
                <span
                  className="font-sans text-[10px] font-bold tracking-widest uppercase"
                  style={{ color: combinedColor }}
                >
                  {combinedLabel}
                </span>
                <span className="text-secondary ml-2.5 font-sans text-[11px]">
                  {combinedSignal === 'calm' &&
                    'Term structure favors selling premium today'}
                  {combinedSignal === 'normal' &&
                    'Standard conditions \u2014 follow delta guide'}
                  {combinedSignal === 'elevated' &&
                    'Elevated short-term risk \u2014 reduce exposure'}
                  {combinedSignal === 'extreme' &&
                    'Significant event risk \u2014 consider sitting out'}
                </span>
              </div>
            </div>
          )}

          {/* Individual ratio cards */}
          <div
            className={
              [hasVix1d, hasVix9d, hasVvix].filter(Boolean).length >= 2
                ? 'grid grid-cols-1 gap-2.5 sm:grid-cols-2'
                : 'grid grid-cols-1 gap-2.5'
            }
          >
            {vix1dResult && (
              <RatioCard
                th={th}
                title="VIX1D / VIX"
                subtitle="Today vs. 30-day"
                ratio={vix1dResult.ratio}
                label={vix1dResult.label}
                color={vix1dResult.color}
                advice={vix1dResult.advice}
              />
            )}
            {vix9dResult && (
              <RatioCard
                th={th}
                title="VIX9D / VIX"
                subtitle="9-day vs. 30-day"
                ratio={vix9dResult.ratio}
                label={vix9dResult.label}
                color={vix9dResult.color}
                advice={vix9dResult.advice}
              />
            )}
          </div>

          {/* VVIX card — full width below the ratio cards */}
          {vvixResult && (
            <div className="mt-2.5">
              <VvixCard th={th} result={vvixResult} />
            </div>
          )}
        </div>
      )}

      {/* VIX1D σ status */}
      {hasVix1d && vix1dSigma && (
        <div className="bg-surface-alt border-edge text-secondary rounded-lg border px-3.5 py-2.5 font-sans text-[11px] leading-relaxed">
          {isVix1dActive ? (
            <>
              <span
                className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: '#7C3AED' }}
              />
              <strong style={{ color: '#7C3AED' }}>Active:</strong> Strike
              pricing uses VIX1D ({vix1d.toFixed(2)}) as {'\u03C3'} ={' '}
              {vix1dSigma.toFixed(4)}. No 0DTE adjustment applied.
            </>
          ) : (
            <>
              <strong className="text-primary">Tip:</strong> VIX1D (
              {vix1d.toFixed(2)}) is derived directly from today{'\u2019'}s 0DTE
              options. You can use it as Direct IV ({'\u03C3'} ={' '}
              {vix1dSigma.toFixed(4)}) with no 0DTE adjustment needed.
              {onUseVix1dAsSigma && (
                <button
                  onClick={() => onUseVix1dAsSigma(vix1dSigma)}
                  className="bg-accent-bg text-accent ml-2 cursor-pointer rounded-md border-[1.5px] border-[var(--th-accent)] px-2.5 py-[3px] font-sans text-[11px] font-semibold"
                >
                  Use VIX1D as {'\u03C3'}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Empty state */}
      {!hasVix && (hasVix1d || hasVix9d) && (
        <p className="text-muted mt-2 text-xs italic">
          Enter a VIX value above to compute term structure ratios.
        </p>
      )}
      {hasVix && !hasVix1d && !hasVix9d && !hasVvix && (
        <p className="text-muted mt-1 text-xs italic">
          Enter VIX1D and/or VIX9D from TradingView to see term structure
          signals. Tickers: CBOE:VIX1D and CBOE:VIX9D.
        </p>
      )}
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function RatioCard({
  th,
  title,
  subtitle,
  ratio,
  label,
  color,
  advice,
}: {
  th: Theme;
  title: string;
  subtitle: string;
  ratio: number;
  label: string;
  color: string;
  advice: string;
}) {
  return (
    <div className="bg-surface border-edge rounded-[10px] border p-3 sm:p-3.5">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            {title}
          </div>
          <div className="text-muted font-sans text-[9px]">{subtitle}</div>
        </div>
        <span
          className="rounded-full px-2 py-0.5 font-sans text-[9px] font-bold tracking-[0.06em] uppercase"
          style={{ backgroundColor: color + '18', color }}
        >
          {label}
        </span>
      </div>

      <div
        className="mb-1.5 font-mono text-[22px] font-extrabold"
        style={{ color }}
      >
        {ratio.toFixed(2)}x
      </div>

      {/* Ratio bar visualization */}
      <div className="mb-2">
        <div className="bg-surface-alt relative h-1.5 overflow-hidden rounded-[3px]">
          <div
            className="absolute top-0 left-0 h-full rounded-[3px] transition-[width] duration-300"
            style={{
              width: Math.min(ratio / 2, 1) * 100 + '%',
              backgroundColor: color,
            }}
          />
          {/* 1.0x marker */}
          <div
            className="absolute -top-px left-1/2 h-2 w-0.5"
            style={{ backgroundColor: th.textMuted + '60' }}
          />
        </div>
        <div className="text-muted mt-0.5 flex justify-between font-mono text-[8px]">
          <span>0.5x</span>
          <span>1.0x</span>
          <span>1.5x</span>
          <span>2.0x</span>
        </div>
      </div>

      <div className="text-secondary font-sans text-[11px] leading-normal">
        {advice}
      </div>
    </div>
  );
}

function VvixCard({ th, result }: { th: Theme; result: VvixResult }) {
  const { value, label, color, advice } = result;

  // Bar scale: 60–140 range
  const barPct = Math.min(Math.max((value - 60) / 80, 0), 1) * 100;

  return (
    <div className="bg-surface border-edge rounded-[10px] border p-3 sm:p-3.5">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
            VVIX
          </div>
          <div className="text-muted font-sans text-[9px]">
            Volatility of VIX
          </div>
        </div>
        <span
          className="rounded-full px-2 py-0.5 font-sans text-[9px] font-bold tracking-[0.06em] uppercase"
          style={{ backgroundColor: color + '18', color }}
        >
          {label}
        </span>
      </div>

      <div
        className="mb-1.5 font-mono text-[22px] font-extrabold"
        style={{ color }}
      >
        {value.toFixed(1)}
      </div>

      {/* VVIX bar visualization: 60–140 scale */}
      <div className="mb-2">
        <div className="bg-surface-alt relative h-1.5 overflow-hidden rounded-[3px]">
          <div
            className="absolute top-0 left-0 h-full rounded-[3px] transition-[width] duration-300"
            style={{
              width: barPct + '%',
              backgroundColor: color,
            }}
          />
          {/* 100 marker (midpoint of concern) */}
          <div
            className="absolute -top-px h-2 w-0.5"
            style={{
              left: ((100 - 60) / 80) * 100 + '%',
              backgroundColor: th.textMuted + '60',
            }}
          />
        </div>
        <div className="text-muted mt-0.5 flex justify-between font-mono text-[8px]">
          <span>60</span>
          <span>80</span>
          <span>100</span>
          <span>120</span>
          <span>140</span>
        </div>
      </div>

      <div className="text-secondary font-sans text-[11px] leading-normal">
        {advice}
      </div>
    </div>
  );
}
