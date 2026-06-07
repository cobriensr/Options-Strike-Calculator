/**
 * Regime0dte — the "0DTE Gamma Regime" panel shell. Self-contained section
 * that calls `useRegime0dte()` and composes the four pure sub-viz from the
 * live (last-good-aware) hook payload:
 *
 *   - a graded gate chip (calm / big_move / lean_down, plus a visually
 *     distinct dashed "no read" chip for the `unknown` state) + honest note
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

import { useMemo } from 'react';

import { useRegime0dte } from '../../hooks/useRegime0dte.js';
import { SectionBox } from '../ui';
import { GammaProfileMini, type GammaStrike } from './GammaProfileMini';
import { IvSparkline, type IvSparkPoint } from './IvSparkline';
import { CandleStrip, type StripCandle } from './CandleStrip';
import { TriggerLights } from './TriggerLights';
import { gateMeta } from './gate';

const REGIME_0DTE_HEADING_ID = 'regime-0dte-heading';

// Stable module-level empty fallbacks. The hook returns a fresh `data` object
// every 45s poll; passing `data.gexStrikes ?? []` would allocate a NEW array
// literal each render and defeat the sub-viz React.memo even when the absent
// series is unchanged. Frozen so a referential identity is shared across every
// render that lacks the series.
// Typed as the (read-only-in-practice) mutable element type the pure sub-viz
// expect — they copy-then-sort and never mutate the input, so a frozen array
// is safe to hand through.
const EMPTY_STRIKES = Object.freeze([] as GammaStrike[]) as GammaStrike[];
const EMPTY_IV = Object.freeze([] as IvSparkPoint[]) as IvSparkPoint[];
const EMPTY_CANDLES = Object.freeze([] as StripCandle[]) as StripCandle[];

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

  // Memoize the series props on a CONTENT fingerprint of the payload, not the
  // wall-clock minute: two 45s polls can land in the same CT minute yet carry
  // different data (a freshly-grown series or a just-latched trigger), so
  // keying on `asOfCtMin` alone would hide a fired down-trigger for up to a
  // minute. The fingerprint changes when any series grows, a new IV point
  // lands, or a trigger flips — so TriggerLights + the sub-viz update promptly,
  // while a truly identical poll still short-circuits the memo'd re-render.
  // Absent series fall back to the frozen module-level empties for a stable ref.
  const t = data.triggers;
  const valueKey =
    `${data.date}:${data.asOfCtMin}` +
    `:${data.gexStrikes?.length ?? 0}:${data.putIv?.at(-1)?.ctMin ?? 0}:${data.candles30?.length ?? 0}` +
    `:${Number(t.mostlyRed.fired)}${Number(t.ivBreak.fired)}${Number(t.middayDeepNeg.fired)}`;

  /* eslint-disable react-hooks/exhaustive-deps -- value identity is `valueKey`; the array refs are intentionally read-through */
  const gexStrikes = useMemo<GammaStrike[]>(
    () => data.gexStrikes ?? EMPTY_STRIKES,
    [valueKey],
  );
  const putIv = useMemo<IvSparkPoint[]>(
    () => data.putIv ?? EMPTY_IV,
    [valueKey],
  );
  const candles30 = useMemo<StripCandle[]>(
    () => data.candles30 ?? EMPTY_CANDLES,
    [valueKey],
  );
  // The triggers object is also re-allocated every poll; pin it to value
  // identity so the memo'd TriggerLights skips unchanged ticks too.
  const triggers = useMemo(() => data.triggers, [valueKey]);
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <div className="flex flex-col gap-4">
      {/* Gate chip + honest note. The `unknown` gate renders a distinct
          dashed "no read" chip (glyph + copy), never a calm look-alike. */}
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-sans text-[11px] font-semibold ${meta.chipClass}`}
          aria-label={meta.ariaLabel}
        >
          {!meta.isReal && (
            <span aria-hidden="true" className="opacity-70">
              ⃠
            </span>
          )}
          {meta.label}
        </span>
        <p className="text-secondary m-0 font-sans text-[12px] leading-snug">
          {meta.isReal
            ? data.note
            : 'No regime read right now — insufficient data (pre-open, too few strikes, or a data outage). This is not a calm/neutral verdict.'}
        </p>
      </div>

      <TriggerLights triggers={triggers} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="text-tertiary mb-1.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
            Net gamma by strike
          </div>
          <GammaProfileMini
            strikes={gexStrikes}
            flipStrike={data.flipStrike}
            spot={data.spot ?? null}
            bandPct={data.bandPct ?? 0.01}
          />
          {/* The bars are the live (current-minute) profile; the flip line is the
              OPEN-anchored level the gate is graded on, so on a trending day it
              need not sit at a sign-change of the on-screen bars. */}
          <div className="text-tertiary mt-1 font-sans text-[9px] leading-tight">
            bars: live profile · flip line: open-anchored level
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-tertiary mb-1.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
              Morning put IV
            </div>
            <IvSparkline
              series={putIv}
              refHi={data.triggers.ivBreak.refHi}
              breakAtCtMin={data.triggers.ivBreak.atCtMin}
            />
          </div>
          <div>
            <div className="text-tertiary mb-1.5 font-sans text-[10px] font-bold tracking-[0.12em] uppercase">
              30-min candles
            </div>
            <CandleStrip
              candles={candles30}
              persistEndCtMin={data.persistEndCtMin ?? 660}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
