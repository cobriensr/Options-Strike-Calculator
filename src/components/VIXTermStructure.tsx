import { useState } from 'react';
import type { Theme } from '../themes';
import { tinyLbl } from './ui';

interface Props {
  readonly th: Theme;
  readonly vix: number | null;         // Current VIX from parent (already entered)
  readonly onUseVix1dAsSigma?: (sigma: number) => void; // Optional: let parent switch to VIX1D-derived σ
}

/** Ratio thresholds for signal classification */
const VIX1D_THRESHOLDS = {
  calm: 0.85,
  normal: 1.15,
  elevated: 1.50,
} as const;

const VIX9D_THRESHOLDS = {
  calm: 0.90,
  normal: 1.10,
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
    return { ratio, signal: 'calm', label: 'CALM', color: th.green, advice: 'Today expected quieter than average. Full position size, standard deltas.' };
  }
  if (ratio < VIX1D_THRESHOLDS.normal) {
    return { ratio, signal: 'normal', label: 'NORMAL', color: th.accent, advice: 'Typical day. Follow regime guide delta ceiling.' };
  }
  if (ratio < VIX1D_THRESHOLDS.elevated) {
    return { ratio, signal: 'elevated', label: 'ELEVATED', color: '#E8A317', advice: 'Market pricing above-average move today. Widen deltas or reduce size.' };
  }
  return { ratio, signal: 'extreme', label: 'EVENT RISK', color: th.red, advice: 'Major event expected (CPI, FOMC, NFP?). Consider sitting out or minimal size.' };
}

function classifyVix9dRatio(ratio: number, th: Theme): RatioResult {
  if (ratio < VIX9D_THRESHOLDS.calm) {
    return { ratio, signal: 'calm', label: 'CONTANGO', color: th.green, advice: 'Near-term vol below 30-day. Favorable term structure.' };
  }
  if (ratio < VIX9D_THRESHOLDS.normal) {
    return { ratio, signal: 'normal', label: 'FLAT', color: th.accent, advice: 'Neutral term structure. No additional signal.' };
  }
  if (ratio < VIX9D_THRESHOLDS.elevated) {
    return { ratio, signal: 'elevated', label: 'INVERTED', color: '#E8A317', advice: 'Near-term stress building. Caution over next 1\u20132 weeks.' };
  }
  return { ratio, signal: 'extreme', label: 'STEEP INVERSION', color: th.red, advice: 'Significant near-term fear. Defensive posture warranted.' };
}

const inputCls = "bg-input border-[1.5px] border-edge-strong rounded-lg text-primary py-[11px] px-[14px] text-base font-mono outline-none w-full transition-[border-color] duration-150";

/**
 * VIX Term Structure panel.
 * Accepts VIX1D and VIX9D inputs, computes ratios against the existing VIX,
 * and provides actionable trading signals for 0DTE iron condor positioning.
 */
export default function VIXTermStructure({ th, vix, onUseVix1dAsSigma }: Props) {
  const [vix1dInput, setVix1dInput] = useState('');
  const [vix9dInput, setVix9dInput] = useState('');

  const vix1d = Number.parseFloat(vix1dInput);
  const vix9d = Number.parseFloat(vix9dInput);
  const hasVix = vix != null && vix > 0;
  const hasVix1d = !Number.isNaN(vix1d) && vix1d > 0;
  const hasVix9d = !Number.isNaN(vix9d) && vix9d > 0;

  const vix1dRatio = hasVix && hasVix1d ? vix1d / vix : null;
  const vix9dRatio = hasVix && hasVix9d ? vix9d / vix : null;
  const vix1dResult = vix1dRatio == null ? null : classifyVix1dRatio(vix1dRatio, th);
  const vix9dResult = vix9dRatio == null ? null : classifyVix9dRatio(vix9dRatio, th);

  // Combined signal: worst of the two
  const combinedSignal: Signal | null = (() => {
    if (!vix1dResult && !vix9dResult) return null;
    const signals: Signal[] = [];
    if (vix1dResult) signals.push(vix1dResult.signal);
    if (vix9dResult) signals.push(vix9dResult.signal);
    const order: Signal[] = ['calm', 'normal', 'elevated', 'extreme'];
    return signals.reduce((worst, s) => order.indexOf(s) > order.indexOf(worst) ? s : worst, 'calm');
  })();

  const combinedColor = combinedSignal === 'calm' ? th.green
    : combinedSignal === 'normal' ? th.accent
    : combinedSignal === 'elevated' ? '#E8A317'
    : combinedSignal === 'extreme' ? th.red
    : th.textMuted;

  const combinedLabel = combinedSignal === 'calm' ? 'GREEN LIGHT'
    : combinedSignal === 'normal' ? 'PROCEED'
    : combinedSignal === 'elevated' ? 'CAUTION'
    : combinedSignal === 'extreme' ? 'HIGH ALERT'
    : '';

  // Suggested VIX1D sigma
  const vix1dSigma = hasVix1d ? vix1d / 100 : null;

  return (
    <div>
      {/* Input row */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 mb-3.5">
        <div>
          <label htmlFor="vix1d-input" className={tinyLbl}>
            VIX1D <span className="font-normal normal-case tracking-normal opacity-70">(1-day)</span>
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
            VIX9D <span className="font-normal normal-case tracking-normal opacity-70">(9-day)</span>
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
      {hasVix && (hasVix1d || hasVix9d) && (
        <div className="mb-3.5">
          {/* Combined signal banner */}
          {combinedSignal && (
            <div
              className="flex items-start sm:items-center gap-3 rounded-[10px] p-3 sm:p-4 mb-3"
              style={{ backgroundColor: combinedColor + '10', border: '1.5px solid ' + combinedColor + '30' }}
            >
              <div
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: combinedColor, boxShadow: '0 0 8px ' + combinedColor + '66' }}
              />
              <div>
                <span
                  className="text-[10px] font-bold uppercase tracking-widest font-sans"
                  style={{ color: combinedColor }}
                >
                  {combinedLabel}
                </span>
                <span className="text-[11px] text-secondary ml-2.5 font-sans">
                  {combinedSignal === 'calm' && 'Term structure favors selling premium today'}
                  {combinedSignal === 'normal' && 'Standard conditions \u2014 follow delta guide'}
                  {combinedSignal === 'elevated' && 'Elevated short-term risk \u2014 reduce exposure'}
                  {combinedSignal === 'extreme' && 'Significant event risk \u2014 consider sitting out'}
                </span>
              </div>
            </div>
          )}

          {/* Individual ratio cards */}
          <div className={hasVix1d && hasVix9d ? 'grid grid-cols-1 gap-2.5 sm:grid-cols-2' : 'grid grid-cols-1 gap-2.5'}>
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
        </div>
      )}

      {/* VIX1D as direct σ suggestion */}
      {hasVix1d && vix1dSigma && (
        <div className="py-2.5 px-3.5 rounded-lg bg-surface-alt border border-edge text-[11px] text-secondary font-sans leading-relaxed">
          <strong className="text-primary">Tip:</strong> VIX1D ({vix1d.toFixed(2)}) is derived directly from today{'\u2019'}s 0DTE options.
          You can use it as Direct IV ({'\u03C3'} = {vix1dSigma.toFixed(4)}) with no 0DTE adjustment needed (set multiplier to 1.00).
          {onUseVix1dAsSigma && (
            <button
              onClick={() => onUseVix1dAsSigma(vix1dSigma)}
              className="ml-2 py-[3px] px-2.5 rounded-md text-[11px] font-semibold cursor-pointer border-[1.5px] border-[var(--th-accent)] bg-accent-bg text-accent font-sans"
            >
              Use VIX1D as {'\u03C3'}
            </button>
          )}
        </div>
      )}

      {/* Empty state */}
      {!hasVix && (hasVix1d || hasVix9d) && (
        <p className="text-xs text-muted mt-2 italic">
          Enter a VIX value above to compute term structure ratios.
        </p>
      )}
      {hasVix && !hasVix1d && !hasVix9d && (
        <p className="text-xs text-muted mt-1 italic">
          Enter VIX1D and/or VIX9D from TradingView to see term structure signals.
          Tickers: CBOE:VIX1D and CBOE:VIX9D.
        </p>
      )}
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function RatioCard({ th, title, subtitle, ratio, label, color, advice }: {
  th: Theme; title: string; subtitle: string;
  ratio: number; label: string; color: string; advice: string;
}) {
  return (
    <div className="p-3 sm:p-3.5 rounded-[10px] bg-surface border border-edge">
      <div className="flex justify-between items-start mb-2">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-tertiary font-sans">
            {title}
          </div>
          <div className="text-[9px] text-muted font-sans">
            {subtitle}
          </div>
        </div>
        <span
          className="text-[9px] font-bold py-0.5 px-2 rounded-full font-sans uppercase tracking-[0.06em]"
          style={{ backgroundColor: color + '18', color }}
        >
          {label}
        </span>
      </div>

      <div
        className="text-[22px] font-extrabold font-mono mb-1.5"
        style={{ color }}
      >
        {ratio.toFixed(2)}x
      </div>

      {/* Ratio bar visualization */}
      <div className="mb-2">
        <div className="h-1.5 rounded-[3px] bg-surface-alt relative overflow-hidden">
          <div
            className="absolute top-0 left-0 h-full rounded-[3px] transition-[width] duration-300"
            style={{
              width: Math.min(ratio / 2, 1) * 100 + '%',
              backgroundColor: color,
            }}
          />
          {/* 1.0x marker */}
          <div
            className="absolute -top-px left-1/2 w-0.5 h-2"
            style={{ backgroundColor: th.textMuted + '60' }}
          />
        </div>
        <div className="flex justify-between text-[8px] text-muted font-mono mt-0.5">
          <span>0.5x</span>
          <span>1.0x</span>
          <span>1.5x</span>
          <span>2.0x</span>
        </div>
      </div>

      <div className="text-[11px] text-secondary font-sans leading-normal">
        {advice}
      </div>
    </div>
  );
}
