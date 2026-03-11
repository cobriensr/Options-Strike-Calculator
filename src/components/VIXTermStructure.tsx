import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../themes';
import { tinyLblStyle } from './ui';

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
  const vix1dResult = vix1dRatio != null ? classifyVix1dRatio(vix1dRatio, th) : null;
  const vix9dResult = vix9dRatio != null ? classifyVix9dRatio(vix9dRatio, th) : null;

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

  const tinyLbl = tinyLblStyle(th);
  const inputStyle: CSSProperties = {
    backgroundColor: th.inputBg, border: '1.5px solid ' + th.borderStrong, borderRadius: 8,
    color: th.text, padding: '11px 14px', fontSize: 16, fontFamily: "'DM Mono', monospace",
    outline: 'none', width: '100%', boxSizing: 'border-box' as const, transition: 'border-color 0.15s',
  };

  return (
    <div>
      {/* Input row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <div>
          <label htmlFor="vix1d-input" style={tinyLbl}>
            VIX1D <span style={{ fontWeight: 400, textTransform: 'none' as const, letterSpacing: 0, opacity: 0.7 }}>(1-day)</span>
          </label>
          <input
            id="vix1d-input"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 18.5"
            value={vix1dInput}
            onChange={(e) => setVix1dInput(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="vix9d-input" style={tinyLbl}>
            VIX9D <span style={{ fontWeight: 400, textTransform: 'none' as const, letterSpacing: 0, opacity: 0.7 }}>(9-day)</span>
          </label>
          <input
            id="vix9d-input"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 20.1"
            value={vix9dInput}
            onChange={(e) => setVix9dInput(e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Ratio readouts */}
      {hasVix && (hasVix1d || hasVix9d) && (
        <div style={{ marginBottom: 14 }}>
          {/* Combined signal banner */}
          {combinedSignal && (
            <div style={{
              padding: '10px 16px', borderRadius: 10, marginBottom: 12,
              backgroundColor: combinedColor + '10',
              border: '1.5px solid ' + combinedColor + '30',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{
                width: 12, height: 12, borderRadius: '50%',
                backgroundColor: combinedColor,
                boxShadow: '0 0 8px ' + combinedColor + '66',
                flexShrink: 0,
              }} />
              <div>
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
                  letterSpacing: '0.1em', color: combinedColor,
                  fontFamily: "'Outfit', sans-serif",
                }}>
                  {combinedLabel}
                </span>
                <span style={{
                  fontSize: 11, color: th.textSecondary, marginLeft: 10,
                  fontFamily: "'Outfit', sans-serif",
                }}>
                  {combinedSignal === 'calm' && 'Term structure favors selling premium today'}
                  {combinedSignal === 'normal' && 'Standard conditions \u2014 follow delta guide'}
                  {combinedSignal === 'elevated' && 'Elevated short-term risk \u2014 reduce exposure'}
                  {combinedSignal === 'extreme' && 'Significant event risk \u2014 consider sitting out'}
                </span>
              </div>
            </div>
          )}

          {/* Individual ratio cards */}
          <div style={{ display: 'grid', gridTemplateColumns: hasVix1d && hasVix9d ? '1fr 1fr' : '1fr', gap: 10 }}>
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
        <div style={{
          padding: '10px 14px', borderRadius: 8,
          backgroundColor: th.surfaceAlt,
          border: '1px solid ' + th.border,
          fontSize: 11, color: th.textSecondary,
          fontFamily: "'Outfit', sans-serif", lineHeight: 1.6,
        }}>
          <strong style={{ color: th.text }}>Tip:</strong> VIX1D ({vix1d.toFixed(2)}) is derived directly from today{'\u2019'}s 0DTE options.
          You can use it as Direct IV ({'\u03C3'} = {vix1dSigma.toFixed(4)}) with no 0DTE adjustment needed (set multiplier to 1.00).
          {onUseVix1dAsSigma && (
            <button
              onClick={() => onUseVix1dAsSigma(vix1dSigma)}
              style={{
                marginLeft: 8, padding: '3px 10px', borderRadius: 6,
                fontSize: 11, fontWeight: 600, cursor: 'pointer',
                border: '1.5px solid ' + th.accent,
                backgroundColor: th.accentBg, color: th.accent,
                fontFamily: "'Outfit', sans-serif",
              }}
            >
              Use VIX1D as {'\u03C3'}
            </button>
          )}
        </div>
      )}

      {/* Empty state */}
      {!hasVix && (hasVix1d || hasVix9d) && (
        <p style={{ fontSize: 12, color: th.textMuted, margin: '8px 0 0', fontStyle: 'italic' }}>
          Enter a VIX value above to compute term structure ratios.
        </p>
      )}
      {hasVix && !hasVix1d && !hasVix9d && (
        <p style={{ fontSize: 12, color: th.textMuted, margin: '4px 0 0', fontStyle: 'italic' }}>
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
    <div style={{
      padding: '12px 14px', borderRadius: 10,
      backgroundColor: th.surface,
      border: '1px solid ' + th.border,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
            letterSpacing: '0.08em', color: th.textTertiary,
            fontFamily: "'Outfit', sans-serif",
          }}>
            {title}
          </div>
          <div style={{
            fontSize: 9, color: th.textMuted,
            fontFamily: "'Outfit', sans-serif",
          }}>
            {subtitle}
          </div>
        </div>
        <span style={{
          fontSize: 9, fontWeight: 700,
          padding: '2px 8px', borderRadius: 99,
          backgroundColor: color + '18', color,
          fontFamily: "'Outfit', sans-serif",
          textTransform: 'uppercase' as const,
          letterSpacing: '0.06em',
        }}>
          {label}
        </span>
      </div>

      <div style={{
        fontSize: 22, fontWeight: 800, color,
        fontFamily: "'DM Mono', monospace",
        marginBottom: 6,
      }}>
        {ratio.toFixed(2)}x
      </div>

      {/* Ratio bar visualization */}
      <div style={{ marginBottom: 8 }}>
        <div style={{
          height: 6, borderRadius: 3, backgroundColor: th.surfaceAlt,
          position: 'relative', overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', top: 0, left: 0,
            height: '100%',
            width: Math.min(ratio / 2, 1) * 100 + '%', // 2.0x = full bar
            backgroundColor: color,
            borderRadius: 3,
            transition: 'width 0.3s',
          }} />
          {/* 1.0x marker */}
          <div style={{
            position: 'absolute', top: -1, left: '50%',
            width: 2, height: 8,
            backgroundColor: th.textMuted + '60',
          }} />
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: 8, color: th.textMuted,
          fontFamily: "'DM Mono', monospace",
          marginTop: 2,
        }}>
          <span>0.5x</span>
          <span>1.0x</span>
          <span>1.5x</span>
          <span>2.0x</span>
        </div>
      </div>

      <div style={{
        fontSize: 11, color: th.textSecondary,
        fontFamily: "'Outfit', sans-serif",
        lineHeight: 1.5,
      }}>
        {advice}
      </div>
    </div>
  );
}
