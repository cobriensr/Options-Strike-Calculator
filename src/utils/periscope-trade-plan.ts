/**
 * Pure analyzer that turns a PeriscopeView into an actionable trade
 * plan. Encodes the periscope skill's reading framework so the panel
 * can show "what does this data mean for entry / exit / management"
 * without round-tripping to Claude.
 *
 * The skill's core hedge primitive (gamma sign × price direction):
 *   −γ + price up   → MM buys → fuels rally (procyclical)
 *   −γ + price down → MM sells → fuels selloff (procyclical)
 *   +γ + price up   → MM sells → caps rally (suppressive)
 *   +γ + price down → MM buys → catches dip (suppressive)
 *
 * Permission/prohibition framework for directional execution:
 *   LONG safe when:    no near-spot +γ wall above (no mechanical cap),
 *                      OR cone has been breached upward (vol extension)
 *   LONG avoid when:   +γ ceiling sits within ~15 pts above spot
 *   SHORT safe when:   −γ acceleration zone below spot (fuels selling)
 *   SHORT avoid when:  +γ floor sits within ~15 pts below spot
 *
 * Cone-breach overrides:
 *   UPPER breach → chase the breakout, do NOT fade
 *   LOWER breach → mirror
 *
 * All numeric thresholds below are deliberately loose — this is a
 * directional read, not a precise signal. The panel renders the verdict
 * + level tie + short reason, the trader makes the call.
 */

import type { PeriscopeView } from '../types/periscope.js';

/** Distance (pts) under which a +γ wall is "near spot" — close enough to
 *  cap a directional move on its own. */
const NEAR_WALL_PTS = 15;

/** Charm tally magnitude under which we treat the tally as "noise" rather
 *  than a directional tilt. Calibrated for 0DTE charm scales. */
const CHARM_TALLY_NOISE_THRESHOLD = 1_000_000; // 1M

export type Regime =
  | 'cone-breach-up'
  | 'cone-breach-down'
  | 'pin'
  | 'drift-and-cap'
  | 'chop'
  | 'no-data';

export type Bias =
  | 'long-only'
  | 'short-only'
  | 'two-sided'
  | 'fade-only'
  | 'no-trade';

export type Verdict = 'safe' | 'conditional' | 'avoid';

export interface DirectionalPlan {
  verdict: Verdict;
  /** Short tag, e.g. "chase the breakout" or "fights +γ ceiling". */
  reason: string;
  /** Specific price level whose break confirms the trade, when known. */
  trigger: number | null;
  /** Stop level (a few pts past the structural defense). */
  stop: number | null;
  /** Target level (closest mechanical cap on this side). */
  target: number | null;
}

export interface TradePlan {
  regime: Regime;
  bias: Bias;
  /** One-sentence framing of the read. */
  summary: string;
  long: DirectionalPlan;
  short: DirectionalPlan;
  /** Description of the no-trade / chop band, when one exists. */
  waitZone: string | null;
}

function noTradeReason(reason: string): DirectionalPlan {
  return {
    verdict: 'avoid',
    reason,
    trigger: null,
    stop: null,
    target: null,
  };
}

/**
 * Compute the trade plan from a fully-loaded view. Returns a no-data
 * shape when the view has too little structure to read (no cone AND
 * no gamma topology).
 */
export function computeTradePlan(view: PeriscopeView): TradePlan {
  const { spot, gamma, charm, cone, breaches } = view;

  const ceiling = gamma.ceiling;
  const floor = gamma.floor;
  const ceilingDist = ceiling != null ? ceiling.strike - spot : null;
  const floorDist = floor != null ? spot - floor.strike : null;

  // ── Cone breach overrides ─────────────────────────────────────
  const upperBreach = breaches.find((b) => b.direction === 'upper');
  const lowerBreach = breaches.find((b) => b.direction === 'lower');

  if (upperBreach != null) {
    return tradePlanForUpperBreach({
      spot,
      ceiling,
      ceilingDist,
      cone,
    });
  }
  if (lowerBreach != null) {
    return tradePlanForLowerBreach({
      spot,
      floor,
      floorDist,
      cone,
    });
  }

  // ── Charm tally direction (mechanical /ES drift) ──────────────
  const charmNet = charm.tallyNear50;
  const charmWide = charm.tallyWide100;
  const charmDir =
    Math.abs(charmNet) < CHARM_TALLY_NOISE_THRESHOLD
      ? 'flat'
      : charmNet > 0
        ? 'up'
        : 'down';

  // ── Inside-cone gamma topology read ──────────────────────────
  const longCappedNearby =
    ceiling != null && ceilingDist != null && ceilingDist <= NEAR_WALL_PTS;
  const shortCaughtNearby =
    floor != null && floorDist != null && floorDist <= NEAR_WALL_PTS;

  // No structural defense at all on either side — chop / no-trade.
  if (ceiling == null && floor == null) {
    return {
      regime: 'no-data',
      bias: 'no-trade',
      summary:
        'No +γ structure within ±100 of spot. Walls are absent — directional bets have no mechanical defense. Wait for structure.',
      long: noTradeReason('no +γ ceiling identified'),
      short: noTradeReason('no +γ floor identified'),
      waitZone: 'Whole strike grid — no structural anchor.',
    };
  }

  // Pin candidate: both walls present and near spot.
  const pinCandidate =
    ceiling != null &&
    floor != null &&
    ceilingDist != null &&
    floorDist != null &&
    ceilingDist <= NEAR_WALL_PTS &&
    floorDist <= NEAR_WALL_PTS;

  if (pinCandidate) {
    const magnet = pickMagnet(view);
    const magnetClause = magnet != null ? ` near ${magnet}` : '';
    const summary = `Pin setup: +γ ceiling ${ceiling.strike} (${signedPts(ceilingDist!)}) and +γ floor ${floor.strike} (${signedPts(-floorDist!)}) bracket spot tightly. Mean-revert toward the dominant magnet${magnetClause}; avoid chasing breakouts.`;
    return {
      regime: 'pin',
      bias: 'fade-only',
      summary,
      long: {
        verdict: 'avoid',
        reason: `+γ ceiling at ${ceiling.strike} caps rallies (${ceilingDist!.toFixed(0)} pts above)`,
        trigger: null,
        stop: null,
        target: null,
      },
      short: {
        verdict: 'avoid',
        reason: `+γ floor at ${floor.strike} catches selloffs (${floorDist!.toFixed(0)} pts below)`,
        trigger: null,
        stop: null,
        target: null,
      },
      waitZone: `Inside ${floor.strike}–${ceiling.strike} — fade extremes only.`,
    };
  }

  // Drift-and-cap setup: +γ ceiling above spot but not pinning.
  const longPlan: DirectionalPlan = longCappedNearby
    ? {
        verdict: 'avoid',
        reason: `+γ ceiling ${ceiling!.strike} sits ${ceilingDist!.toFixed(0)} pts above spot — mechanical cap, naked longs fight dealer hedging`,
        trigger: null,
        stop: null,
        target: ceiling!.strike,
      }
    : ceiling != null
      ? {
          verdict: charmDir === 'up' ? 'safe' : 'conditional',
          reason:
            charmDir === 'up'
              ? `charm tally positive (${fmtSigned(charmWide)} ±100); mechanical /ES drift up toward ${ceiling.strike}`
              : `+γ ceiling at ${ceiling.strike} is ${ceilingDist!.toFixed(0)} pts away — room to drift, but charm tally ${fmtSigned(charmNet)} near 50 doesn't confirm`,
          trigger: spot + 2,
          stop: floor != null ? floor.strike - 5 : null,
          target: ceiling.strike,
        }
      : noTradeReason('no +γ ceiling identified');

  const shortPlan: DirectionalPlan = shortCaughtNearby
    ? {
        verdict: 'avoid',
        reason: `+γ floor ${floor!.strike} sits ${floorDist!.toFixed(0)} pts below spot — passive bid catches selloffs`,
        trigger: null,
        stop: null,
        target: floor!.strike,
      }
    : floor != null
      ? {
          verdict: charmDir === 'down' ? 'safe' : 'conditional',
          reason:
            charmDir === 'down'
              ? `charm tally negative (${fmtSigned(charmWide)} ±100); mechanical /ES drift down toward ${floor.strike}`
              : `+γ floor at ${floor.strike} is ${floorDist!.toFixed(0)} pts away — room to drop, but charm tally ${fmtSigned(charmNet)} near 50 doesn't confirm`,
          trigger: spot - 2,
          stop: ceiling != null ? ceiling.strike + 5 : null,
          target: floor.strike,
        }
      : noTradeReason('no +γ floor identified');

  // Bias derivation from charm + plan verdicts.
  let bias: Bias;
  if (longPlan.verdict === 'avoid' && shortPlan.verdict === 'avoid') {
    bias = 'no-trade';
  } else if (longPlan.verdict === 'safe' && shortPlan.verdict !== 'safe') {
    bias = 'long-only';
  } else if (shortPlan.verdict === 'safe' && longPlan.verdict !== 'safe') {
    bias = 'short-only';
  } else if (charmDir === 'flat') {
    bias = 'fade-only';
  } else {
    bias = 'two-sided';
  }

  // Regime label. drift-and-cap when at least one +γ wall is near
  // spot AND charm tilts in a clear direction; chop otherwise.
  let regime: Regime;
  if (longCappedNearby || shortCaughtNearby) {
    regime = 'drift-and-cap';
  } else if (charmDir === 'flat') {
    regime = 'chop';
  } else {
    regime = 'drift-and-cap';
  }

  return {
    regime,
    bias,
    summary: buildSummary({
      regime,
      bias,
      ceiling,
      floor,
      ceilingDist,
      floorDist,
      charmNet,
      charmWide,
      cone,
    }),
    long: longPlan,
    short: shortPlan,
    waitZone: buildWaitZone({ longPlan, shortPlan, spot }),
  };
}

function tradePlanForUpperBreach(args: {
  spot: number;
  ceiling: PeriscopeView['gamma']['ceiling'];
  ceilingDist: number | null;
  cone: PeriscopeView['cone'];
}): TradePlan {
  const { spot, ceiling, cone } = args;
  // Bound to retreat back into = the cone's upper bound (or spot if
  // cone unknown). Stops on a chase trade go a few pts inside that.
  const reclaimBound = cone?.coneUpper ?? spot - 2;
  const ceilingClause = ceiling != null ? ` at ${ceiling.strike}` : '';
  const summary = `Cone upper bound breached — vol-extension regime. UW empirical: breakouts beyond the 0DTE straddle cone tend to extend, not fade. Chase the move; the next mechanical cap is the +γ ceiling${ceilingClause}.`;
  return {
    regime: 'cone-breach-up',
    bias: 'long-only',
    summary,
    long: {
      verdict: 'safe',
      reason:
        'cone breached — vol-extension setup, MM hedging fuels continuation',
      trigger: spot,
      stop: reclaimBound - 2,
      target: ceiling?.strike ?? null,
    },
    short: {
      verdict: 'avoid',
      reason:
        'fading a confirmed cone breach is the highest-loss-rate trade per the skill — short-vol sellers will buy back hedges and extend the move further',
      trigger: null,
      stop: null,
      target: null,
    },
    waitZone: null,
  };
}

function tradePlanForLowerBreach(args: {
  spot: number;
  floor: PeriscopeView['gamma']['floor'];
  floorDist: number | null;
  cone: PeriscopeView['cone'];
}): TradePlan {
  const { spot, floor, cone } = args;
  const reclaimBound = cone?.coneLower ?? spot + 2;
  return {
    regime: 'cone-breach-down',
    bias: 'short-only',
    summary: buildLowerBreachSummary(floor),
    long: {
      verdict: 'avoid',
      reason:
        'fading a downside cone breach fights both vol expansion and the procyclical −γ hedge below spot',
      trigger: null,
      stop: null,
      target: null,
    },
    short: {
      verdict: 'safe',
      reason:
        'cone breached — vol-extension setup, MM hedging accelerates the move',
      trigger: spot,
      stop: reclaimBound + 2,
      target: floor?.strike ?? null,
    },
    waitZone: null,
  };
}

function buildLowerBreachSummary(
  floor: PeriscopeView['gamma']['floor'],
): string {
  const floorClause = floor != null ? ` at ${floor.strike}` : '';
  return `Cone lower bound breached — downside vol-extension regime. The next mechanical floor is the +γ floor${floorClause}; expect MM put-side hedging to amplify the move there.`;
}

function pickMagnet(view: PeriscopeView): number | null {
  // Magnet = strike with biggest |γ| OR biggest |charm| close to spot.
  // The skill's "magnet" is per-strike, sometimes positions-driven; we
  // approximate with the most extreme |γ| within ±50.
  const cand = view.gamma.topByAbsNear[0];
  return cand?.strike ?? null;
}

export function fmtSigned(n: number): string {
  if (Math.abs(n) >= 1_000_000)
    return `${n >= 0 ? '+' : ''}${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000)
    return `${n >= 0 ? '+' : ''}${(n / 1_000).toFixed(1)}K`;
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}`;
}

function signedPts(pts: number): string {
  return `${pts >= 0 ? '+' : ''}${pts.toFixed(0)} pts`;
}

// buildSummary handles only the regimes that fall through to the shared
// drift-and-cap/chop path. Pin, cone-breach-up, cone-breach-down, and
// no-data each return their own hand-built summary earlier in
// computeTradePlan. Narrowing the param prevents accidental re-use of
// this builder for those regimes.
type SummaryRegime = 'drift-and-cap' | 'chop';

function buildSummary(args: {
  regime: SummaryRegime;
  bias: Bias;
  ceiling: PeriscopeView['gamma']['ceiling'];
  floor: PeriscopeView['gamma']['floor'];
  ceilingDist: number | null;
  floorDist: number | null;
  charmNet: number;
  charmWide: number;
  cone: PeriscopeView['cone'];
}): string {
  const { regime, bias, ceiling, floor, charmWide } = args;
  const parts: string[] = [];
  if (regime === 'drift-and-cap') {
    parts.push('Drift-and-cap setup');
  } else {
    parts.push('Range / chop');
  }
  if (ceiling != null && floor != null) {
    parts.push(`bracketed by +γ ${floor.strike}/${ceiling.strike}`);
  } else if (ceiling != null) {
    parts.push(`+γ ceiling ${ceiling.strike} caps upside`);
  } else if (floor != null) {
    parts.push(`+γ floor ${floor.strike} catches downside`);
  }
  if (Math.abs(charmWide) >= CHARM_TALLY_NOISE_THRESHOLD) {
    parts.push(
      `charm ±100 ${fmtSigned(charmWide)} (${charmWide >= 0 ? 'mechanical buy into close' : 'mechanical sell into close'})`,
    );
  } else {
    parts.push('charm flow flat');
  }
  parts.push(`bias: ${bias}`);
  return parts.join(' · ') + '.';
}

function buildWaitZone(args: {
  longPlan: DirectionalPlan;
  shortPlan: DirectionalPlan;
  spot: number;
}): string | null {
  // Invariant in computeTradePlan: trigger == null ⟹ verdict === 'avoid'
  // for every DirectionalPlan we hand off here. We branch only on trigger
  // presence; the final fallthrough means "both triggers null → no
  // actionable setup at all".
  const { trigger: lt } = args.longPlan;
  const { trigger: st } = args.shortPlan;
  const { spot } = args;
  if (lt != null && st != null) {
    return `${st.toFixed(0)}–${lt.toFixed(0)} — no edge until either trigger fires.`;
  }
  if (lt != null) {
    return `Below ${lt.toFixed(0)} (current ${spot.toFixed(0)}) — no long edge.`;
  }
  if (st != null) {
    return `Above ${st.toFixed(0)} (current ${spot.toFixed(0)}) — no short edge.`;
  }
  return null;
}

// ============================================================
// Structure picker — maps a TradePlan + topology to a specific options
// structure (spread legs, BWB body, iron condor wings, etc.).
//
// Sourced from docs/superpowers/specs/periscope-analyzer-build-2026-05-21.md
// "Structure mapping" table. The trade-direction and verdict already
// come from computeTradePlan above; this layer chooses HOW to express
// each side as a defined-risk options structure.
// ============================================================

export type TradeStructure =
  | 'debit_call_spread'
  | 'debit_put_spread'
  | 'credit_call_spread'
  | 'credit_put_spread'
  | 'iron_condor'
  | 'broken_wing_butterfly'
  | 'directional_long_call'
  | 'directional_long_put'
  | 'long_strangle'
  | 'no_trade';

export interface StructureLeg {
  strike: number;
  type: 'C' | 'P';
  side: 'long' | 'short';
}

export interface RecommendedStructure {
  kind: TradeStructure;
  legs: StructureLeg[];
  /** Display label, e.g. "debit_call_spread 7395/7405". */
  label: string;
}

export interface StructurePlan {
  long: RecommendedStructure | null;
  short: RecommendedStructure | null;
  wait: RecommendedStructure | null;
}

const SPX_STRIKE_INCREMENT = 5;

function roundToStrike(n: number): number {
  return Math.round(n / SPX_STRIKE_INCREMENT) * SPX_STRIKE_INCREMENT;
}

/**
 * Pick the directional spread for a LONG-side setup.
 *
 * @param trigger entry-arm level from plan.long.trigger
 * @param ceiling +γ ceiling strike (long-side cap)
 * @param regime  trade plan regime — cone-breach-up uses naked long instead
 */
function pickLongStructure(
  trigger: number,
  ceiling: number | null,
  regime: Regime,
): RecommendedStructure {
  const longLeg = roundToStrike(trigger);
  // Cone breach above = vol expansion. Naked long captures the expansion
  // upside; capping it with a short above defeats the point.
  if (regime === 'cone-breach-up') {
    const legs: StructureLeg[] = [{ strike: longLeg, type: 'C', side: 'long' }];
    return {
      kind: 'directional_long_call',
      legs,
      label: `directional_long_call ${longLeg}`,
    };
  }
  // No ceiling identified — naked long is the only structure that doesn't
  // require a known short strike.
  if (ceiling == null) {
    const legs: StructureLeg[] = [{ strike: longLeg, type: 'C', side: 'long' }];
    return {
      kind: 'directional_long_call',
      legs,
      label: `directional_long_call ${longLeg}`,
    };
  }
  // Standard case: long at the trigger, short at the +γ ceiling.
  const shortLeg = roundToStrike(ceiling);
  const legs: StructureLeg[] = [
    { strike: longLeg, type: 'C', side: 'long' },
    { strike: shortLeg, type: 'C', side: 'short' },
  ];
  return {
    kind: 'debit_call_spread',
    legs,
    label: `debit_call_spread ${longLeg}/${shortLeg}`,
  };
}

function pickShortStructure(
  trigger: number,
  floor: number | null,
  regime: Regime,
): RecommendedStructure {
  const longLeg = roundToStrike(trigger);
  if (regime === 'cone-breach-down') {
    const legs: StructureLeg[] = [{ strike: longLeg, type: 'P', side: 'long' }];
    return {
      kind: 'directional_long_put',
      legs,
      label: `directional_long_put ${longLeg}`,
    };
  }
  if (floor == null) {
    const legs: StructureLeg[] = [{ strike: longLeg, type: 'P', side: 'long' }];
    return {
      kind: 'directional_long_put',
      legs,
      label: `directional_long_put ${longLeg}`,
    };
  }
  const shortLeg = roundToStrike(floor);
  const legs: StructureLeg[] = [
    { strike: longLeg, type: 'P', side: 'long' },
    { strike: shortLeg, type: 'P', side: 'short' },
  ];
  return {
    kind: 'debit_put_spread',
    legs,
    label: `debit_put_spread ${longLeg}/${shortLeg}`,
  };
}

/**
 * Pick the wait-zone (no-directional) structure.
 *
 * - pin → broken_wing_butterfly anchored at the dominant gamma magnet
 *   inside the wait band.
 * - chop → iron_condor with short legs at the trigger boundaries and
 *   long legs at the +γ floor / +γ ceiling.
 * - drift-and-cap → null (drift-and-cap has a directional side; the
 *   wait band is a transitional zone, not a structure target).
 * - cone-breach / no-data → null.
 */
function pickWaitStructure(
  view: PeriscopeView,
  plan: TradePlan,
): RecommendedStructure | null {
  const { gamma } = view;
  const floor = gamma.floor?.strike ?? null;
  const ceiling = gamma.ceiling?.strike ?? null;
  const longTrigger = plan.long.trigger;
  const shortTrigger = plan.short.trigger;

  if (plan.regime === 'pin') {
    // BWB body at the largest |γ| strike near spot. Pick from
    // topByAbsNear which is already sorted by |value|.
    const magnet = gamma.topByAbsNear[0];
    if (magnet == null) return null;
    const body = roundToStrike(magnet.strike);
    // Symmetric ±10 wings for v1; per-regime cone-aware wings is a
    // refinement we'll add when we have a vol skew signal feeding in.
    const lowerWing = body - 10;
    const upperWing = body + 10;
    const legs: StructureLeg[] = [
      { strike: lowerWing, type: 'P', side: 'long' },
      { strike: body, type: 'P', side: 'short' },
      { strike: body, type: 'C', side: 'short' },
      { strike: upperWing, type: 'C', side: 'long' },
    ];
    return {
      kind: 'broken_wing_butterfly',
      legs,
      label: `broken_wing_butterfly ${lowerWing}/${body}/${upperWing}`,
    };
  }

  if (
    plan.regime === 'chop' &&
    floor != null &&
    ceiling != null &&
    longTrigger != null &&
    shortTrigger != null
  ) {
    const farPut = roundToStrike(floor);
    const nearPut = roundToStrike(shortTrigger);
    const nearCall = roundToStrike(longTrigger);
    const farCall = roundToStrike(ceiling);
    const legs: StructureLeg[] = [
      { strike: farPut, type: 'P', side: 'long' },
      { strike: nearPut, type: 'P', side: 'short' },
      { strike: nearCall, type: 'C', side: 'short' },
      { strike: farCall, type: 'C', side: 'long' },
    ];
    return {
      kind: 'iron_condor',
      legs,
      label: `iron_condor ${farPut}p/${nearPut}p/${nearCall}c/${farCall}c`,
    };
  }

  return null;
}

/**
 * Derive options structures for each side of the TradePlan. Returns a
 * {long, short, wait} bundle where each entry is null when the
 * directional verdict is 'avoid' or the topology doesn't support a
 * defined structure (e.g. cone-breach with no +γ wall to anchor on).
 *
 * Pure function — view + plan in, structure recommendations out. No
 * I/O. Strike rounding is fixed at SPX (5-pt grid).
 *
 * Note: `legs` are ordered short-first by convention for the existing
 * debit_*_spread enum readers, but the helper functions here build
 * them long-first for readability. Both shapes are equivalent for the
 * downstream renderer which inspects `side` per leg.
 */
export function pickStructures(
  view: PeriscopeView,
  plan: TradePlan,
): StructurePlan {
  const long =
    plan.long.verdict === 'safe' && plan.long.trigger != null
      ? pickLongStructure(
          plan.long.trigger,
          view.gamma.ceiling?.strike ?? null,
          plan.regime,
        )
      : null;
  const short =
    plan.short.verdict === 'safe' && plan.short.trigger != null
      ? pickShortStructure(
          plan.short.trigger,
          view.gamma.floor?.strike ?? null,
          plan.regime,
        )
      : null;
  const wait = pickWaitStructure(view, plan);
  return { long, short, wait };
}
