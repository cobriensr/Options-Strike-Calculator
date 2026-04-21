/**
 * ActionDirective — the "what do I do right now?" single-line banner.
 *
 * Rendered between the regime header and the playbook panel, this strip
 * compresses the rules + verdict into one imperative sentence so the
 * trader never has to scan IDLE rows to figure out the nearest setup or
 * how many ES points away it is.
 *
 * State computation (first match wins):
 *   1. STAND_ASIDE verdict       → red banner: "sit out, regime ambiguous"
 *   2. Any rule.status === ACTIVE → sky banner: "ENTER NOW {direction} ..."
 *   3. Any rule.status === ARMED  → amber banner: "ARMED: move X pts to ..."
 *   4. Otherwise pick the nearest non-INVALIDATED rule → muted "WAIT"
 *
 * Pure derivation — memoized so React only renders when inputs change.
 * Uses `role="status"` + `aria-live="polite"` so assistive tech announces
 * state transitions.
 */

import { memo, useMemo } from 'react';
import type { PlaybookRule, RegimeVerdict } from './types';

export interface ActionDirectiveProps {
  verdict: RegimeVerdict;
  rules: PlaybookRule[];
  esPrice: number | null;
}

// ── Presentation metadata ────────────────────────────────────────────

type DirectiveState = 'STAND_ASIDE' | 'ACTIVE' | 'ARMED' | 'WAIT';

const STATE_CLASS: Record<DirectiveState, string> = {
  STAND_ASIDE: 'bg-red-500/10 text-red-300 border-red-500/30',
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

function deriveDirective(
  verdict: RegimeVerdict,
  rules: PlaybookRule[],
  esPrice: number | null,
): Directive {
  if (verdict === 'STAND_ASIDE') {
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
}: ActionDirectiveProps) {
  const directive = useMemo(
    () => deriveDirective(verdict, rules, esPrice),
    [verdict, rules, esPrice],
  );

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Action directive"
      className={`mb-3 flex items-center gap-2 rounded-lg border px-3 py-2 font-mono text-[12px] font-semibold ${STATE_CLASS[directive.state]}`}
    >
      <span aria-hidden="true" className="text-[14px]">
        {directive.icon}
      </span>
      <span>{directive.text}</span>
    </div>
  );
});

export default ActionDirective;
