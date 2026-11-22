import { useState, useEffect, useRef } from 'react';
import { theme } from '../../themes';
import type { IVMode, CalculationResults } from '../../types';
import { IV_MODES } from '../../constants';
import { SectionBox, Chip, ErrorMsg } from '../ui';
import { tinyLbl, tint, inputCls } from '../../utils/ui-utils';
import VIXRegimeCard from '../VIXRegimeCard';
import VIXTermStructure from '../VIXTermStructure';
import type { MarketDataState } from '../../hooks/useMarketData';
import type { HistorySnapshot } from '../../hooks/useHistoryData';
import { isPastETDate } from '../../utils/timezone';
import IVTooltip from './IVTooltip';

interface Props {
  ivMode: IVMode;
  onIvModeChange: (mode: IVMode) => void;
  vixInput: string;
  onVixChange: (v: string) => void;
  multiplier: string;
  onMultiplierChange: (v: string) => void;
  directIVInput: string;
  onDirectIVChange: (v: string) => void;
  dVix: string;
  results: CalculationResults | null;
  errors: Record<string, string>;
  market: MarketDataState;
  /**
   * Whether the term-structure card may poll today's VIX trajectory: App's
   * clock AND owner-or-guest flag (`liveMarketOpen`), not `market.marketOpen`.
   * /api/vix-snapshots-recent is owner-or-guest, and this card renders for
   * public visitors too.
   */
  marketOpen: boolean;
  selectedDate: string;
  /**
   * Today's ET date from the clock `selectedDate` follows (useVixData's), so
   * "past" turns in the render the date moves, not before it.
   */
  etToday: string;
  historySnapshot?: HistorySnapshot | null;
  /**
   * The slot a history snapshot is read at, as the time picker shows it
   * ('8:30 AM CT'). The term-structure card keys on it, so an edit resets at
   * the next slot. Without it the card falls back to the snapshot's candle
   * and index.
   */
  entryTimeLabel?: string;
  onUseVix1dAsSigma: (sigma: number) => void;
  termShape?: string | null;
  termShapeAdvice?: string | null;
  defaultCollapsed?: boolean;
}

export default function IVInputSection({
  ivMode,
  onIvModeChange,
  vixInput,
  onVixChange,
  multiplier,
  onMultiplierChange,
  directIVInput,
  onDirectIVChange,
  dVix,
  results,
  errors,
  market,
  marketOpen,
  selectedDate,
  etToday,
  historySnapshot,
  entryTimeLabel,
  onUseVix1dAsSigma,
  termShape,
  termShapeAdvice,
  defaultCollapsed,
}: Readonly<Props>) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Tooltip close on outside click + Escape
  useEffect(() => {
    if (!tooltipOpen) return;
    const onMouse = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node))
        setTooltipOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTooltipOpen(false);
    };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [tooltipOpen]);

  // Live quotes are today's, and they load on any date. A past date must
  // not fall back to them, or "Use VIX1D as σ" would apply today's VIX1D to
  // that date. The selected date decides, as in useAutoFill and App's
  // backtest mode, so a past date with no intraday history (older than ~60
  // days, a failed fetch, a weekend or holiday) gets no live values either.
  // historySnapshot is always the selected date's (useAutoFill drops another
  // date's history while the selected date's loads). Today keeps the
  // fallback, with or without its own snapshot. Past is judged against
  // etToday, the clock the date follows, not the wall clock: a render in the
  // moment after ET midnight, before that clock ticks, must not flip the
  // key below and remount the card, which would then remount again at the
  // tick.
  const pastDate = isPastETDate(selectedDate, etToday);
  const liveQuotes = pastDate ? null : market.data.quotes;
  // Remount the card when its source changes, so a value it took from an
  // earlier source (today's live VIX1D, say) can't stay on a past date, and an
  // edit resets at the next slot. The slot label tells slots apart exactly.
  // The candle does not: under the as-of rule it is the same first bar at 8:30
  // and 8:35 CT, and the same last ended bar either side of a missing SPX bar.
  // The date separates two dates read at the same label. Without a label, the
  // candle and its index are the best identity there is.
  const historySlotKey = historySnapshot
    ? (entryTimeLabel ??
      `${historySnapshot.candle.datetime}:${historySnapshot.candleIndex}`)
    : null;
  let termStructureKey = 'live';
  if (historySlotKey != null) {
    termStructureKey = `hist-${selectedDate}-${historySlotKey}`;
  } else if (pastDate) {
    termStructureKey = `past-${selectedDate}`;
  }

  return (
    <SectionBox
      label="Implied Volatility"
      collapsible
      defaultCollapsed={defaultCollapsed}
      headerRight={
        <fieldset className="m-0 border-none p-0">
          <legend className="sr-only">IV input mode</legend>
          <div className="flex gap-1">
            {(
              [
                { key: IV_MODES.VIX, label: 'VIX' },
                { key: IV_MODES.DIRECT, label: 'Direct IV' },
              ] as const
            ).map(({ key, label }) => (
              <Chip
                key={key}
                active={ivMode === key}
                onClick={() => onIvModeChange(key)}
                label={label}
              />
            ))}
          </div>
        </fieldset>
      }
    >
      {ivMode === IV_MODES.VIX ? (
        <div className="grid grid-cols-[1fr_140px] items-end gap-2.5">
          <div>
            <label htmlFor="vix-val" className={tinyLbl}>
              VIX Value
            </label>
            <input
              id="vix-val"
              type="text"
              inputMode="decimal"
              placeholder="e.g. 19"
              value={vixInput}
              onChange={(e) => onVixChange(e.target.value)}
              aria-invalid={!!errors['vix']}
              aria-describedby={errors['vix'] ? 'err-vix' : undefined}
              className={inputCls}
            />
          </div>
          <div className="relative" ref={tooltipRef}>
            <div className="mb-1 flex items-center gap-1.5">
              <label htmlFor="mult-val" className={tinyLbl + ' !mb-0'}>
                0DTE Adj.
              </label>
              <button
                type="button"
                onClick={() => setTooltipOpen(!tooltipOpen)}
                aria-expanded={tooltipOpen}
                aria-label="What is the 0DTE adjustment?"
                className="border-edge-strong bg-surface-alt text-tertiary inline-flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full border-[1.5px] p-0 font-sans text-[11px] leading-none font-bold"
              >
                ?
              </button>
            </div>
            <input
              id="mult-val"
              type="text"
              inputMode="decimal"
              placeholder="1.15"
              value={multiplier}
              onChange={(e) => onMultiplierChange(e.target.value)}
              aria-invalid={!!errors['multiplier']}
              aria-describedby={
                errors['multiplier']
                  ? 'adj-tooltip-content err-mult'
                  : 'adj-tooltip-content'
              }
              className={inputCls}
            />
            <IVTooltip open={tooltipOpen} />
          </div>
        </div>
      ) : (
        <div>
          {/* Direct IV mode: σ from VIX1D + VIX field for regime analysis */}
          <div className="grid grid-cols-[1fr_1fr] items-end gap-2.5">
            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <label htmlFor="direct-iv" className={tinyLbl + ' !mb-0'}>
                  {'\u03C3'} (Direct IV)
                </label>
                <span
                  className="rounded-full px-2 py-0.5 font-sans text-[10px] font-bold tracking-wider uppercase"
                  style={{
                    backgroundColor: tint(theme.backtest, '18'),
                    color: theme.backtest,
                  }}
                >
                  VIX1D
                </span>
              </div>
              <input
                id="direct-iv"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 0.22"
                value={directIVInput}
                onChange={(e) => onDirectIVChange(e.target.value)}
                aria-invalid={!!errors['iv']}
                aria-describedby={errors['iv'] ? 'err-iv' : undefined}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="vix-regime" className={tinyLbl}>
                VIX (regime only)
              </label>
              <input
                id="vix-regime"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 19"
                value={vixInput}
                onChange={(e) => onVixChange(e.target.value)}
                aria-invalid={!!errors['vix']}
                className={inputCls}
              />
            </div>
          </div>
          <div className="text-muted mt-1.5 font-sans text-[10px] leading-normal">
            Strike pricing uses VIX1D directly. VIX is used only for regime
            analysis and delta guide thresholds.
          </div>
        </div>
      )}
      {errors['vix'] && <ErrorMsg id="err-vix">{errors['vix']}</ErrorMsg>}
      {errors['multiplier'] && (
        <ErrorMsg id="err-mult">{errors['multiplier']}</ErrorMsg>
      )}
      {errors['iv'] && <ErrorMsg id="err-iv">{errors['iv']}</ErrorMsg>}

      {/* VIX Regime Card — shown in both VIX and Direct IV modes */}
      {dVix && !errors['vix'] && Number.parseFloat(dVix) > 0 && results && (
        <VIXRegimeCard vix={Number.parseFloat(dVix)} spot={results.spot} />
      )}

      {/* Term Structure — shown in both modes */}
      {dVix && !errors['vix'] && Number.parseFloat(dVix) > 0 && (
        <div className="mt-3.5">
          <div className="text-tertiary mb-2 font-sans text-[11px] font-bold tracking-[0.14em] uppercase">
            Term Structure
          </div>
          <VIXTermStructure
            key={termStructureKey}
            vix={Number.parseFloat(dVix)}
            onUseVix1dAsSigma={onUseVix1dAsSigma}
            isVix1dActive={ivMode === IV_MODES.DIRECT}
            initialVix1d={historySnapshot?.vix1d ?? liveQuotes?.vix1d?.price}
            initialVix9d={historySnapshot?.vix9d ?? liveQuotes?.vix9d?.price}
            initialVvix={historySnapshot?.vvix ?? liveQuotes?.vvix?.price}
            termShape={termShape}
            termShapeAdvice={termShapeAdvice}
            marketOpen={marketOpen && !historySnapshot && !pastDate}
          />
        </div>
      )}
    </SectionBox>
  );
}
