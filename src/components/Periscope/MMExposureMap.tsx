/**
 * MMExposureMap — single-frame "trader's map" for the Periscope panel.
 *
 * Replaces the multi-section layout (GammaSection / CharmSection /
 * VannaSection / FlipsSection) with one box that answers four questions:
 *
 *   1. Where are the structural levels around spot?
 *   2. When should I go long, where's the stop, where are the targets?
 *   3. When should I go short, same questions?
 *   4. What's the WAIT band — and what's the right structure inside it?
 *
 * Reads:
 *   - PeriscopeView (from /api/periscope-map, GEXBot-fed, 1-min cadence)
 *   - computeTradePlan(view) for verdicts / triggers / stops / targets
 *   - pickStructures(view, plan) for spread leg selection
 *
 * Spec: docs/superpowers/specs/periscope-analyzer-build-2026-05-21.md
 * (this is the MVP — full T1/T2 ordering by regime per the
 * TARGET_ORDER_RULE constant lives in api/_lib/periscope-analyzer-rules.ts
 * and is reproduced here client-side).
 */

import { theme } from '../../themes';
import type { PeriscopeView } from '../../types/periscope.js';
import {
  computeTradePlan,
  pickStructures,
  type DirectionalPlan,
  type RecommendedStructure,
  type Regime,
} from '../../utils/periscope-trade-plan';
import {
  fmtLevel,
  regimeColor,
  verdictColor,
} from '../../utils/periscope-formatting';

// ── Magnitudes — pulled from view in M (millions) for compactness ────

function fmtMagnitudeM(value: number): string {
  const sign = value >= 0 ? '+' : '−';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

// ── Target ordering — mirrors api/_lib/periscope-analyzer-rules.ts ───
// gamma_wall is T1 in every regime (validated rule); magnet is T2 by
// default; charm_zero takes T2 in pin regime.

interface OrderedTargets {
  t1: { strike: number; label: string };
  t2: { strike: number; label: string } | null;
}

function orderedLongTargets(
  view: PeriscopeView,
  regime: Regime,
): OrderedTargets | null {
  const ceiling = view.gamma.ceiling;
  if (ceiling == null) return null;
  const t1 = { strike: ceiling.strike, label: 'γ wall' };
  // Magnet for non-pin; charm_zero for pin.
  const magnet = view.gamma.topByAbsNear[0];
  const charmZero = view.charm.charmZeroStrike;
  let t2: OrderedTargets['t2'] = null;
  if (regime === 'pin' && charmZero != null) {
    t2 = { strike: charmZero, label: 'charm zero' };
  } else if (magnet != null && magnet.strike !== ceiling.strike) {
    t2 = { strike: magnet.strike, label: 'magnet' };
  }
  return { t1, t2 };
}

function orderedShortTargets(
  view: PeriscopeView,
  regime: Regime,
): OrderedTargets | null {
  const floor = view.gamma.floor;
  if (floor == null) return null;
  const t1 = { strike: floor.strike, label: 'γ wall' };
  const magnet = view.gamma.topByAbsNear[0];
  const charmZero = view.charm.charmZeroStrike;
  let t2: OrderedTargets['t2'] = null;
  if (regime === 'pin' && charmZero != null) {
    t2 = { strike: charmZero, label: 'charm zero' };
  } else if (magnet != null && magnet.strike !== floor.strike) {
    t2 = { strike: magnet.strike, label: 'magnet' };
  }
  return { t1, t2 };
}

// ── Sub-components ───────────────────────────────────────────────────

function LevelRow({
  arrow,
  label,
  strike,
  detail,
  isSpot = false,
}: {
  arrow: '↑' | '↓' | '─';
  label: string;
  strike: number;
  detail?: string;
  isSpot?: boolean;
}) {
  return (
    <div
      className="flex items-baseline gap-3 font-mono text-[12px]"
      style={{
        color: isSpot ? theme.text : theme.textSecondary,
        fontWeight: isSpot ? 700 : 400,
      }}
    >
      <span style={{ width: '1ch' }}>{arrow}</span>
      <span style={{ minWidth: '8ch' }}>{label}</span>
      <span style={{ minWidth: '7ch', textAlign: 'right' }}>
        {strike.toFixed(2)}
      </span>
      {detail && (
        <span className="text-[11px]" style={{ color: theme.textMuted }}>
          {detail}
        </span>
      )}
    </div>
  );
}

function DirectionalRow({
  label,
  plan,
  targets,
  structure,
  comparator,
}: {
  label: 'LONG' | 'SHORT';
  plan: DirectionalPlan;
  targets: OrderedTargets | null;
  structure: RecommendedStructure | null;
  comparator: '>' | '<';
}) {
  const color = verdictColor(plan.verdict);
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[12px]">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-bold" style={{ color: theme.text }}>
          {label}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px] tracking-wider uppercase"
          style={{
            color,
            backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
          }}
        >
          {plan.verdict}
        </span>
        {plan.verdict !== 'avoid' && plan.trigger != null && (
          <span style={{ color: theme.textSecondary }}>
            arms {comparator} {fmtLevel(plan.trigger)}
            {plan.stop != null && <> · stop {fmtLevel(plan.stop)}</>}
            {targets?.t1 && <> · T1 {fmtLevel(targets.t1.strike)}</>}
            {targets?.t2 && <> · T2 {fmtLevel(targets.t2.strike)}</>}
          </span>
        )}
      </div>
      {plan.verdict !== 'avoid' && plan.reason && (
        <span
          className="pl-[5ch] text-[11px] leading-snug"
          style={{ color: theme.textMuted }}
        >
          {plan.reason}
        </span>
      )}
      {structure && (
        <span
          className="pl-[5ch] text-[11px]"
          style={{ color: theme.textSecondary }}
        >
          {structure.label}
        </span>
      )}
    </div>
  );
}

function WaitRow({
  longTrigger,
  shortTrigger,
  structure,
  regime,
}: {
  longTrigger: number | null;
  shortTrigger: number | null;
  structure: RecommendedStructure | null;
  regime: Regime;
}) {
  if (longTrigger == null && shortTrigger == null) return null;
  const bandLabel =
    longTrigger != null && shortTrigger != null
      ? `${fmtLevel(shortTrigger)} – ${fmtLevel(longTrigger)}`
      : longTrigger != null
        ? `below ${fmtLevel(longTrigger)}`
        : `above ${fmtLevel(shortTrigger!)}`;
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[12px]">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-bold" style={{ color: theme.text }}>
          WAIT
        </span>
        <span style={{ color: theme.textSecondary }}>{bandLabel}</span>
      </div>
      {structure ? (
        <span
          className="pl-[5ch] text-[11px]"
          style={{ color: theme.textSecondary }}
        >
          {structure.label}
        </span>
      ) : (
        <span
          className="pl-[5ch] text-[11px]"
          style={{ color: theme.textMuted }}
        >
          {regime === 'no-data' ? 'no structure read' : 'no defined-risk fit'}
        </span>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────

export function MMExposureMap({ view }: { view: PeriscopeView }) {
  const plan = computeTradePlan(view);
  const structures = pickStructures(view, plan);
  const longTargets = orderedLongTargets(view, plan.regime);
  const shortTargets = orderedShortTargets(view, plan.regime);
  const regimeFg = regimeColor(plan.regime);

  return (
    <div
      className="flex flex-col gap-3 rounded-md border p-3"
      style={{
        borderColor: theme.border,
        backgroundColor: theme.surfaceAlt,
      }}
    >
      {/* Header */}
      <div className="flex items-baseline justify-between font-mono text-[11px]">
        <span
          className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
          style={{ color: theme.textTertiary }}
        >
          MM Exposure Map
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px] tracking-wider uppercase"
          style={{
            color: regimeFg,
            backgroundColor: `color-mix(in srgb, ${regimeFg} 15%, transparent)`,
          }}
        >
          {plan.regime}
        </span>
      </div>

      {/* Level ladder */}
      <div className="flex flex-col gap-0.5">
        {view.gamma.ceiling && (
          <LevelRow
            arrow="↑"
            label="CEILING"
            strike={view.gamma.ceiling.strike}
            detail={`γ ${fmtMagnitudeM(view.gamma.ceiling.value)}`}
          />
        )}
        {longTargets?.t1 &&
          view.gamma.ceiling &&
          longTargets.t1.strike !== view.gamma.ceiling.strike && (
            <LevelRow
              arrow="↑"
              label="T1 ↑"
              strike={longTargets.t1.strike}
              detail={longTargets.t1.label}
            />
          )}
        <LevelRow arrow="─" label="SPOT" strike={view.spot} isSpot />
        {shortTargets?.t1 &&
          view.gamma.floor &&
          shortTargets.t1.strike !== view.gamma.floor.strike && (
            <LevelRow
              arrow="↓"
              label="T1 ↓"
              strike={shortTargets.t1.strike}
              detail={shortTargets.t1.label}
            />
          )}
        {view.gamma.floor && (
          <LevelRow
            arrow="↓"
            label="FLOOR"
            strike={view.gamma.floor.strike}
            detail={`γ ${fmtMagnitudeM(view.gamma.floor.value)}`}
          />
        )}
      </div>

      {/* Setups */}
      <div
        className="flex flex-col gap-2 border-t pt-2"
        style={{ borderColor: theme.border }}
      >
        <DirectionalRow
          label="LONG"
          plan={plan.long}
          targets={longTargets}
          structure={structures.long}
          comparator=">"
        />
        <DirectionalRow
          label="SHORT"
          plan={plan.short}
          targets={shortTargets}
          structure={structures.short}
          comparator="<"
        />
        <WaitRow
          longTrigger={plan.long.trigger}
          shortTrigger={plan.short.trigger}
          structure={structures.wait}
          regime={plan.regime}
        />
      </div>

      {/* Footer */}
      <div
        className="flex flex-wrap items-baseline gap-3 border-t pt-2 font-mono text-[10px]"
        style={{ borderColor: theme.border, color: theme.textMuted }}
      >
        {view.cone && (
          <span>
            cone {fmtLevel(view.cone.coneLower)}–{fmtLevel(view.cone.coneUpper)}
          </span>
        )}
        {view.charm.charmZeroStrike != null && (
          <span>charm zero {fmtLevel(view.charm.charmZeroStrike)}</span>
        )}
        {view.signFlips.length > 0 && (
          <span style={{ color: '#fb923c' /* orange */ }}>
            {view.signFlips.length} γ flip{view.signFlips.length > 1 ? 's' : ''}{' '}
            this slice
          </span>
        )}
      </div>

      {plan.summary && (
        <p
          className="font-mono text-[11px] leading-snug"
          style={{ color: theme.textMuted }}
        >
          {plan.summary}
        </p>
      )}
    </div>
  );
}
