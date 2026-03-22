import { useState, useEffect, useRef } from 'react';
import type { Theme } from '../../themes';
import { inputCls, tinyLbl, tint } from '../../utils/ui-utils';
import type { Signal } from './classifiers';
import {
  classifyVix1dRatio,
  classifyVix9dRatio,
  classifyVvix,
} from './classifiers';
import RatioCard from './RatioCard';
import VvixCard from './VvixCard';

interface Props {
  readonly th: Theme;
  readonly vix: number | null; // Current VIX from parent (already entered)
  readonly onUseVix1dAsSigma?: (sigma: number) => void; // Optional: let parent switch to VIX1D-derived σ
  readonly isVix1dActive?: boolean; // True when VIX1D is already being used as σ (Direct IV mode)
  readonly initialVix1d?: number; // Auto-fill from live data
  readonly initialVix9d?: number; // Auto-fill from live data
  readonly initialVvix?: number; // Auto-fill from live data
  readonly termShape?: string | null; // Term structure shape from useComputedSignals
  readonly termShapeAdvice?: string | null;
}

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
  termShape,
  termShapeAdvice,
}: Props) {
  const [vix1dInput, setVix1dInput] = useState('18.50');
  const [vix9dInput, setVix9dInput] = useState('20.10');
  const vix1dEdited = useRef(false);
  const vix9dEdited = useRef(false);

  // Auto-fill from live data (overwrites defaults but respects user edits)
  useEffect(() => {
    if (initialVix1d != null && !vix1dEdited.current)
      setVix1dInput(initialVix1d.toFixed(2));
    if (initialVix9d != null && !vix9dEdited.current)
      setVix9dInput(initialVix9d.toFixed(2));
  }, [initialVix1d, initialVix9d]);

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
          ? th.caution
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
            <span className="text-muted font-normal tracking-normal normal-case">
              (1-day)
            </span>
          </label>
          <input
            id="vix1d-input"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 18.5"
            value={vix1dInput}
            onChange={(e) => {
              setVix1dInput(e.target.value);
              vix1dEdited.current = true;
            }}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="vix9d-input" className={tinyLbl}>
            VIX9D{' '}
            <span className="text-muted font-normal tracking-normal normal-case">
              (9-day)
            </span>
          </label>
          <input
            id="vix9d-input"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 20.1"
            value={vix9dInput}
            onChange={(e) => {
              setVix9dInput(e.target.value);
              vix9dEdited.current = true;
            }}
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
                backgroundColor: tint(combinedColor, '10'),
                border: '1.5px solid ' + tint(combinedColor, '30'),
              }}
            >
              <div
                className="h-3 w-3 shrink-0 rounded-full"
                style={{
                  backgroundColor: combinedColor,
                  boxShadow: '0 0 8px ' + tint(combinedColor, '66'),
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

          {/* Term structure shape */}
          {termShape && termShapeAdvice && (
            <div className="bg-surface border-edge mb-2.5 rounded-[10px] border p-3 sm:p-3.5">
              <div className="mb-1.5 flex items-start justify-between">
                <div>
                  <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase">
                    Curve Shape
                  </div>
                  <div className="text-muted font-sans text-[10px]">
                    VIX1D {'\u2194'} VIX {'\u2194'} VIX9D relationship
                  </div>
                </div>
                <span
                  className="rounded-full px-2 py-0.5 font-sans text-[10px] font-bold tracking-[0.06em] uppercase"
                  style={{
                    backgroundColor: tint(
                      termShape === 'contango'
                        ? th.green
                        : termShape === 'fear-spike'
                          ? th.red
                          : termShape === 'backwardation'
                            ? th.caution
                            : th.accent,
                      '18',
                    ),
                    color:
                      termShape === 'contango'
                        ? th.green
                        : termShape === 'fear-spike'
                          ? th.red
                          : termShape === 'backwardation'
                            ? th.caution
                            : th.accent,
                  }}
                >
                  {termShape === 'contango'
                    ? 'CONTANGO'
                    : termShape === 'fear-spike'
                      ? 'FEAR SPIKE'
                      : termShape === 'backwardation'
                        ? 'BACKWARDATION'
                        : termShape === 'front-calm'
                          ? 'FRONT CALM'
                          : 'FLAT'}
                </span>
              </div>
              <div className="text-secondary font-sans text-[11px] leading-normal">
                {termShapeAdvice}
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
                style={{ backgroundColor: th.backtest }}
              />
              <strong style={{ color: th.backtest }}>Active:</strong> Strike
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
                  className="bg-accent-bg text-accent ml-2 cursor-pointer rounded-md border-[1.5px] border-[var(--color-accent)] px-2.5 py-[3px] font-sans text-[11px] font-semibold"
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
