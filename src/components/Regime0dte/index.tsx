/**
 * Regime0dte — the "0DTE Gamma Regime" panel shell. Self-contained section
 * that calls `useRegime0dte()` and composes the four pure sub-viz from the
 * live (last-good-aware) hook payload:
 *
 *   - a graded gate chip (calm / big_move / lean_down / unknown) + honest note
 *   - TriggerLights      — the three down-only confirmation triggers
 *   - GammaProfileMini   — net-GEX-by-strike profile with flip + spot markers
 *   - IvSparkline        — morning put-IV series with the break dot
 *   - CandleStrip        — 30-min SPX candle squares with the persistence divider
 *
 * Outside the 08:30–15:00 CT session (`!isWindowOpen`) or before any data has
 * landed, the panel renders a "waiting for the open" placeholder rather than
 * drawing the visuals on empty data.
 *
 * Mirrors the SectionBox idiom in `MarketRegimeSection` and the last-good
 * `displayData` consumption in `OpeningFlowSignal`.
 *
 * Spec: docs/superpowers/specs/2026-06-07-regime-0dte-panel-design.md
 * Plan: docs/superpowers/plans/2026-06-07-regime-0dte-panel.md (Task 10)
 */

import { useRegime0dte } from '../../hooks/useRegime0dte.js';
import { SectionBox } from '../ui';
import { GammaProfileMini } from './GammaProfileMini';
import { IvSparkline } from './IvSparkline';
import { CandleStrip } from './CandleStrip';
import { TriggerLights } from './TriggerLights';
import { gateMeta } from './gate';

const REGIME_0DTE_HEADING_ID = 'regime-0dte-heading';

export default function Regime0dte(): React.ReactElement {
  const { displayData, isWindowOpen, error } = useRegime0dte();

  const showPanel = isWindowOpen && displayData != null;
  const badge = displayData ? gateMeta(displayData.gate).label : null;

  return (
    <SectionBox label="0DTE Gamma Regime" badge={badge} collapsible>
      <div aria-labelledby={REGIME_0DTE_HEADING_ID}>
        <h3 id={REGIME_0DTE_HEADING_ID} className="sr-only">
          0DTE Gamma Regime
        </h3>

        {error && (
          <div
            role="alert"
            className="mb-3 rounded border border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-200"
          >
            {error}
          </div>
        )}

        {!showPanel ? (
          <p className="text-secondary font-sans text-[12px] leading-relaxed">
            Waiting for the open. The 0DTE gamma regime auto-updates between
            08:30 and 15:00 CT on trading days.
          </p>
        ) : (
          <RegimePanel data={displayData} />
        )}
      </div>
    </SectionBox>
  );
}

function RegimePanel({
  data,
}: {
  data: NonNullable<ReturnType<typeof useRegime0dte>['displayData']>;
}): React.ReactElement {
  const meta = gateMeta(data.gate);

  return (
    <div className="flex flex-col gap-4">
      {/* Gate chip + honest note */}
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full border px-2.5 py-0.5 font-sans text-[11px] font-semibold ${meta.chipClass}`}
          aria-label={meta.ariaLabel}
        >
          {meta.label}
        </span>
        <p className="text-secondary m-0 font-sans text-[12px] leading-snug">
          {data.note}
        </p>
      </div>

      <TriggerLights triggers={data.triggers} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="text-tertiary mb-1.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
            Net gamma by strike
          </div>
          <GammaProfileMini
            strikes={data.gexStrikes ?? []}
            flipStrike={data.flipStrike}
            spot={data.spot ?? null}
            bandPct={data.bandPct ?? 0.01}
          />
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-tertiary mb-1.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
              Morning put IV
            </div>
            <IvSparkline
              series={data.putIv ?? []}
              refHi={data.triggers.ivBreak.refHi}
              breakAtCtMin={data.triggers.ivBreak.atCtMin}
            />
          </div>
          <div>
            <div className="text-tertiary mb-1.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
              30-min candles
            </div>
            <CandleStrip
              candles={data.candles30 ?? []}
              persistEndCtMin={data.persistEndCtMin ?? 660}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
