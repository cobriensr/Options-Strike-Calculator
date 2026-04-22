/**
 * ActionDirective — the "what do I do right now?" single-line banner.
 *
 * Rendered between the regime header and the playbook panel, this strip
 * compresses the rules + verdict into one imperative sentence so the
 * trader never has to scan IDLE rows to figure out the nearest setup or
 * how many ES points away it is.
 *
 * State computation (first match wins):
 *   1. STAND_ASIDE  verdict === 'STAND_ASIDE' AND structural levels
 *      (zero-gamma, call wall, put wall) are not all known → red "sit out:
 *      no data" banner.
 *   2. WATCHING     verdict === 'STAND_ASIDE' AND all three ES levels are
 *      present → amber expectant banner that shows the wall prices, ES
 *      distance to each, and the ES move required to commit out of the
 *      transition band. Informational, NOT a trigger.
 *   3. ACTIVE       any rule with status === ACTIVE → sky banner.
 *   4. ARMED        any rule with status === ARMED → amber banner.
 *   5. WAIT         otherwise → muted banner pointing at the nearest
 *      non-INVALIDATED setup.
 *
 * Pure derivation — memoized so React only renders when inputs change.
 * Uses `role="status"` + `aria-live="polite"` so assistive tech announces
 * state transitions.
 */

import { memo, useMemo } from 'react';
import {
  REGIME_TRANSITION_BAND_PCT,
  RULE_ACTIVE_BAND_ES,
} from './playbook.js';
import type { PlaybookRule, RegimeVerdict } from './types.js';

export interface ActionDirectiveProps {
  verdict: RegimeVerdict;
  rules: PlaybookRule[];
  esPrice: number | null;
  /**
   * ES-translated zero-gamma level. When all three level fields are
   * non-null and the verdict is STAND_ASIDE, the banner switches from the
   * red "sit out" copy into the amber WATCHING state.
   */
  esZeroGamma: number | null;
  esCallWall: number | null;
  esPutWall: number | null;
  /**
   * True when the displayed snapshot is live (not scrubbed back to a
   * historical timestamp). When false, the banner prefixes its copy with
   * `[BACKTEST]` and downgrades `aria-live` to `"off"` so screen readers
   * don't announce historical trade calls as if they were actionable now.
   * Defaults to `true` for back-compat; any scrub-aware container should
   * pass `isLive` from `useFuturesGammaPlaybook`.
   */
  isLive?: boolean;
}

// ── Presentation metadata ────────────────────────────────────────────

type DirectiveState = 'STAND_ASIDE' | 'WATCHING' | 'ACTIVE' | 'ARMED' | 'WAIT';

const STATE_CLASS: Record<DirectiveState, string> = {
  STAND_ASIDE: 'bg-red-500/10 text-red-300 border-red-500/30',
  WATCHING: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  ACTIVE: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  ARMED: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  WAIT: 'bg-white/5 text-muted border-edge',
};

const RULE_NAMES: Record<string, string> = {
  'pos-fade-call-wall': 'fade call wall',
  'pos-lift-put-wall': 'lift put wall',
  'pos-charm-drift': 'ride charm drift to pin',
  'neg-break-call-wall': 'break call wall',
  'neg-break-put-wall': 'break put wall',
};

// ── Helpers ───────────────────────────────────────────────────────────

function formatDirection(direction: PlaybookRule['direction']): string {
  if (direction === 'LONG') return 'LONG';
  if (direction === 'SHORT') return 'SHORT';
  return 'EITHER';
}

function nameOf(rule: PlaybookRule): string {
  return RULE_NAMES[rule.id] ?? rule.id;
}

function fmtEntry(entryEs: number | null): string {
  return entryEs === null ? '—' : entryEs.toFixed(2);
}

function fmtSignedPts(distance: number | null): string {
  if (distance === null) return '—';
  const rounded = Math.round(distance);
  if (rounded === 0) return '0 pts';
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded} pts`;
}

/**
 * Format a level price as "{price} ({+/-N} pts)" showing the signed
 * distance from the current ES price. Used by the WATCHING banner.
 */
function fmtLevelWithDist(level: number, esPrice: number): string {
  const dist = Math.round(level - esPrice);
  const sign = dist > 0 ? '+' : '';
  return `${level.toFixed(2)} (${sign}${dist} pts)`;
}

/** Rule is INVALIDATED — do not recommend it as a nearest setup. */
function isInvalidated(rule: PlaybookRule): boolean {
  return rule.status === 'INVALIDATED';
}

/** Distance to entry, for ranking the "closest setup" — Infinity if unknown. */
function sortKey(rule: PlaybookRule): number {
  if (rule.distanceEsPoints === null) return Number.POSITIVE_INFINITY;
  return Math.abs(rule.distanceEsPoints);
}

/**
 * Pick the rule with the smallest absolute distance from `esPrice` among
 * candidates. Stable: ties keep declaration order. Returns null when the
 * candidate list is empty.
 */
function nearestRule(candidates: PlaybookRule[]): PlaybookRule | null {
  if (candidates.length === 0) return null;
  let best = candidates[0] ?? null;
  if (best === null) return null;
  let bestKey = sortKey(best);
  for (let i = 1; i < candidates.length; i += 1) {
    const r = candidates[i];
    if (!r) continue;
    const k = sortKey(r);
    if (k < bestKey) {
      best = r;
      bestKey = k;
    }
  }
  return best;
}

// ── Derivation ────────────────────────────────────────────────────────

interface Directive {
  state: DirectiveState;
  icon: string;
  text: string;
}

/**
 * Build the WATCHING banner copy. Shows current ES, the two walls (with
 * signed distance to each), and the transition band width — the amount of
 * ES movement needed to commit to a regime. Direction-agnostic because
 * whether "commit" means POSITIVE or NEGATIVE isn't known yet.
 */
function buildWatchingDirective(
  esPrice: number,
  esZeroGamma: number,
  esCallWall: number,
  esPutWall: number,
): Directive {
  // Transition-band half-width in ES points. Below `RULE_ACTIVE_BAND_ES`
  // would imply an active setup is already close, so clamp to make sure
  // the number always reads as "some meaningful committing move".
  const bandHalfPts = Math.max(
    1,
    Math.round(esZeroGamma * REGIME_TRANSITION_BAND_PCT),
  );
  const bandPctDisplay = (REGIME_TRANSITION_BAND_PCT * 100).toFixed(1);

  return {
    state: 'WATCHING',
    icon: '🔭',
    text:
      `WATCHING: ES ${esPrice.toFixed(2)} · ZG ${esZeroGamma.toFixed(2)} ` +
      `(band ±${bandPctDisplay}% ≈ ${bandHalfPts} pts) · ` +
      `Call wall ${fmtLevelWithDist(esCallWall, esPrice)} · ` +
      `Put wall ${fmtLevelWithDist(esPutWall, esPrice)} · ` +
      `Arm zone ±${RULE_ACTIVE_BAND_ES} pts from either wall.`,
  };
}

function deriveDirective(
  verdict: RegimeVerdict,
  rules: PlaybookRule[],
  esPrice: number | null,
  esZeroGamma: number | null,
  esCallWall: number | null,
  esPutWall: number | null,
): Directive {
  if (verdict === 'STAND_ASIDE') {
    // Promote to WATCHING when we have enough context to show the trader
    // where a setup would arm. Requires current ES too — without it the
    // distance math is meaningless.
    if (
      esPrice !== null &&
      esZeroGamma !== null &&
      esCallWall !== null &&
      esPutWall !== null
    ) {
      return buildWatchingDirective(
        esPrice,
        esZeroGamma,
        esCallWall,
        esPutWall,
      );
    }
    return {
      state: 'STAND_ASIDE',
      icon: '🛑',
      text: 'STAND ASIDE: Regime ambiguous — no directional edge.',
    };
  }

  const active = rules.filter((r) => r.status === 'ACTIVE');
  if (active.length > 0) {
    const r = nearestRule(active)!;
    const esPart = esPrice === null ? '' : ` (ES ${esPrice.toFixed(2)})`;
    return {
      state: 'ACTIVE',
      icon: '🎯',
      text: `ACTIVE: ${formatDirection(r.direction)} ${nameOf(r)} at ${fmtEntry(
        r.entryEs,
      )} — ES within proximity${esPart}.`,
    };
  }

  const armed = rules.filter((r) => r.status === 'ARMED');
  if (armed.length > 0) {
    const r = nearestRule(armed)!;
    return {
      state: 'ARMED',
      icon: '⏱',
      text: `ARMED: Move ${fmtSignedPts(
        r.distanceEsPoints,
      )} to ${formatDirection(r.direction)} ${nameOf(r)} at ${fmtEntry(
        r.entryEs,
      )}.`,
    };
  }

  // Nearest non-INVALIDATED rule overall.
  const candidates = rules.filter((r) => !isInvalidated(r));
  const r = nearestRule(candidates);
  if (r !== null) {
    return {
      state: 'WAIT',
      icon: '⏸',
      text: `WAIT: Nearest setup ${formatDirection(r.direction)} ${nameOf(
        r,
      )} at ${fmtEntry(r.entryEs)} · ${fmtSignedPts(
        r.distanceEsPoints,
      )} away.`,
    };
  }

  // No rules at all (e.g. missing levels) — show neutral wait copy.
  return {
    state: 'WAIT',
    icon: '⏸',
    text: 'WAIT: No active setups — levels unavailable.',
  };
}

// ── Component ─────────────────────────────────────────────────────────

export const ActionDirective = memo(function ActionDirective({
  verdict,
  rules,
  esPrice,
  esZeroGamma,
  esCallWall,
  esPutWall,
  isLive = true,
}: ActionDirectiveProps) {
  const directive = useMemo(
    () =>
      deriveDirective(
        verdict,
        rules,
        esPrice,
        esZeroGamma,
        esCallWall,
        esPutWall,
      ),
    [verdict, rules, esPrice, esZeroGamma, esCallWall, esPutWall],
  );

  return (
    <div
      role="status"
      // Historical snapshots must not trigger assistive-tech announcements
      // as if they were actionable. Downgrade to `off` when scrubbed.
      aria-live={isLive ? 'polite' : 'off'}
      aria-label={isLive ? 'Action directive' : 'Action directive (backtest)'}
      className={`mb-3 flex items-center gap-2 rounded-lg border px-3 py-2 font-mono text-[12px] font-semibold ${STATE_CLASS[directive.state]}`}
    >
      <span aria-hidden="true" className="text-[14px]">
        {directive.icon}
      </span>
      <span>
        {!isLive && (
          <span
            className="mr-1.5 inline-flex items-center rounded bg-white/10 px-1 py-0.5 font-mono text-[10px] tracking-wider uppercase"
            aria-hidden="true"
          >
            Backtest
          </span>
        )}
        {directive.text}
      </span>
    </div>
  );
});

export default ActionDirective;
