/**
 * Pure regime → rule translation for the FuturesGammaPlaybook module.
 *
 * Every function here is a pure function of its arguments — no hooks, no
 * fetches, no side effects. The aggregator hook (`useFuturesGammaPlaybook`)
 * glues these together with live data.
 *
 * Design notes:
 *   - `classifyRegime` uses a ±0.5% band around zero-gamma to mark the
 *     in-transition zone. When spot sits inside that band (or zero-gamma
 *     is unknown), we surface `TRANSITIONING` so the verdict collapses
 *     to `STAND_ASIDE` — the playbook explicitly refuses to name a
 *     direction when the regime is ambiguous.
 *   - `classifySessionPhase` converts any instant to CT wall-clock via
 *     the existing `getCTTime` util, then bucketizes by total minutes.
 *   - `rulesForRegime` is deliberately narrow — 1-3 concrete rules per
 *     (regime, phase) combo. We interpolate ES levels into the human-
 *     readable `condition` string so the UI renders "fade into 5812.25"
 *     rather than "fade into the call wall".
 */

import { getCTTime } from '../../utils/timezone';
import { esTickRound } from './basis';
import type {
  GexRegime,
  PlaybookRule,
  RegimeVerdict,
  RuleLevels,
  RuleStatus,
  SessionPhase,
} from './types';

// ── Tunable constants (exported — referenced by hook, tests, analyze) ──

/** Spot must sit outside ±0.5% of zero-gamma to pick a side. */
export const REGIME_TRANSITION_BAND_PCT = 0.005;

/** ES levels within this many points of price get an `APPROACHING` badge. */
export const LEVEL_PROXIMITY_ES_POINTS = 5;

/** Charm-drift window kicks in at 13:30 CT. */
export const CHARM_DRIFT_PHASE_START_CT = '13:30';

/** Minimum seconds between repeat fires of the same alert type. */
export const ALERT_COOLDOWN_SECONDS = 90;

/** How long a level must stay crossed before the breach is confirmed. */
export const LEVEL_BREACH_CONFIRM_SECONDS = 60;

/** ES futures minimum tick size (0.25 index points = $12.50/contract). */
export const ES_TICK_SIZE = 0.25;

/**
 * Band (ES points) within which a rule is "ACTIVE" — enter now. Matches the
 * existing `LEVEL_PROXIMITY_ES_POINTS` (5 pts) but named separately so the
 * two can drift independently if we tune rule bands later.
 */
export const RULE_ACTIVE_BAND_ES = 5;

/**
 * Band (ES points) within which a rule is "ARMED" — close enough that the
 * trader should pay attention. Anything beyond this is DISTANT.
 */
export const RULE_ARMED_BAND_ES = 15;

/**
 * CT wall-clock phase windows. Values are [start, end) half-open ranges —
 * a timestamp at the end boundary belongs to the *next* phase. These are
 * deliberately aligned to the user's trading schedule.
 */
export const SESSION_PHASES_CT = {
  open: ['08:30', '09:00'],
  morning: ['09:00', '11:30'],
  lunch: ['11:30', '13:00'],
  afternoon: ['13:00', '14:30'],
  power: ['14:30', '15:30'],
  close: ['15:30', '16:00'],
} as const;

// ── Regime classification ──────────────────────────────────────────────

/**
 * Map (netGex, zeroGamma, spot) to a gamma regime.
 *
 * - `TRANSITIONING` when zeroGamma is null OR spot is within
 *   ±REGIME_TRANSITION_BAND_PCT of zeroGamma (ambiguous zone).
 * - `POSITIVE` when netGex > 0 and spot is outside the band.
 * - `NEGATIVE` when netGex < 0 and spot is outside the band.
 * - `TRANSITIONING` otherwise (e.g. netGex exactly 0 with spot outside
 *   the band — no side to pick).
 */
export function classifyRegime(
  netGex: number,
  zeroGamma: number | null,
  spot: number,
): GexRegime {
  if (zeroGamma === null || zeroGamma <= 0) return 'TRANSITIONING';
  const bandHalfWidth = zeroGamma * REGIME_TRANSITION_BAND_PCT;
  if (Math.abs(spot - zeroGamma) <= bandHalfWidth) return 'TRANSITIONING';
  if (netGex > 0) return 'POSITIVE';
  if (netGex < 0) return 'NEGATIVE';
  return 'TRANSITIONING';
}

/** POSITIVE → MEAN_REVERT, NEGATIVE → TREND_FOLLOW, else STAND_ASIDE. */
export function verdictForRegime(regime: GexRegime): RegimeVerdict {
  if (regime === 'POSITIVE') return 'MEAN_REVERT';
  if (regime === 'NEGATIVE') return 'TREND_FOLLOW';
  return 'STAND_ASIDE';
}

// ── Session phase ──────────────────────────────────────────────────────

/** Parse a 'HH:MM' string into total minutes past midnight. Returns NaN on malformed input. */
function parseHhmmToMinutes(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number.parseInt(hStr ?? '', 10);
  const m = Number.parseInt(mStr ?? '', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.NaN;
  return h * 60 + m;
}

/**
 * Classify a Date into one of the eight session phases using CT wall-clock.
 *
 * The input Date can be in any absolute instant; `getCTTime` handles the
 * TZ conversion internally. The phase windows are half-open — the start
 * minute belongs to the phase, the end minute starts the next phase.
 */
export function classifySessionPhase(nowCt: Date): SessionPhase {
  const { hour, minute } = getCTTime(nowCt);
  const total = hour * 60 + minute;

  const openStart = parseHhmmToMinutes(SESSION_PHASES_CT.open[0]);
  const openEnd = parseHhmmToMinutes(SESSION_PHASES_CT.open[1]);
  const morningEnd = parseHhmmToMinutes(SESSION_PHASES_CT.morning[1]);
  const lunchEnd = parseHhmmToMinutes(SESSION_PHASES_CT.lunch[1]);
  const afternoonEnd = parseHhmmToMinutes(SESSION_PHASES_CT.afternoon[1]);
  const powerEnd = parseHhmmToMinutes(SESSION_PHASES_CT.power[1]);
  const closeEnd = parseHhmmToMinutes(SESSION_PHASES_CT.close[1]);

  if (total < openStart) return 'PRE_OPEN';
  if (total < openEnd) return 'OPEN';
  if (total < morningEnd) return 'MORNING';
  if (total < lunchEnd) return 'LUNCH';
  if (total < afternoonEnd) return 'AFTERNOON';
  if (total < powerEnd) return 'POWER';
  if (total < closeEnd) return 'CLOSE';
  return 'POST_CLOSE';
}

// ── Rule generation ────────────────────────────────────────────────────

/** Format a level for human-readable rule copy, or "—" when unknown. */
function fmt(level: number | null): string {
  return level === null ? '—' : level.toFixed(2);
}

/**
 * Rule archetype — shapes how INVALIDATED is detected.
 *
 * - `fade-lift` — mean-revert setups (+GEX fade-call / lift-put). Price
 *   overshooting the wall by > ACTIVE band means the structural fade has
 *   failed → INVALIDATED.
 * - `breakout`  — trend-follow setups (−GEX break-call / break-put).
 *   Price being on the "pre-trigger" side of the wall is not failure — it
 *   is the normal waiting state. Classified as DISTANT / ARMED / ACTIVE.
 *   These rules never emit INVALIDATED.
 * - `either`    — direction-agnostic (charm-drift). Never INVALIDATED;
 *   fall back to DISTANT by default.
 */
type RuleArchetype = 'fade-lift' | 'breakout' | 'either';

/**
 * Compute status + signed distance for a directional rule.
 *
 * Distance is signed so the UI can tell the trader which way the market
 * must move: positive = price must rally up to entry, negative = price
 * must fall to entry.
 */
function classifyRule(
  direction: PlaybookRule['direction'],
  entryEs: number | null,
  esPrice: number | null,
  archetype: RuleArchetype,
): { distanceEsPoints: number | null; status: RuleStatus } {
  if (esPrice === null || entryEs === null) {
    return { distanceEsPoints: null, status: 'DISTANT' };
  }
  const distance = entryEs - esPrice;
  const abs = Math.abs(distance);

  // INVALIDATED detection: only fade/lift rules have a "wrong side" that
  // kills the setup. Breakout rules and EITHER rules never invalidate.
  if (archetype === 'fade-lift') {
    if (direction === 'SHORT' && -distance > RULE_ACTIVE_BAND_ES) {
      // SHORT fade — entry at call wall, price rallied through wall by
      // more than ACTIVE band → structural fade failed.
      return { distanceEsPoints: distance, status: 'INVALIDATED' };
    }
    if (direction === 'LONG' && distance > RULE_ACTIVE_BAND_ES) {
      // LONG lift — entry at put wall, price broke below wall by more
      // than ACTIVE band → structural lift failed.
      return { distanceEsPoints: distance, status: 'INVALIDATED' };
    }
  }

  if (abs <= RULE_ACTIVE_BAND_ES) {
    return { distanceEsPoints: distance, status: 'ACTIVE' };
  }
  if (abs <= RULE_ARMED_BAND_ES) {
    return { distanceEsPoints: distance, status: 'ARMED' };
  }
  return { distanceEsPoints: distance, status: 'DISTANT' };
}

/**
 * Attach `distanceEsPoints` and `status` to a bare rule shape. Keeps
 * `rulesForRegime` focused on rule ID / direction / entry / target / stop
 * generation and delegates the price-vs-entry classification here.
 */
function finalize(
  rule: Omit<PlaybookRule, 'distanceEsPoints' | 'status'>,
  esPrice: number | null,
  archetype: RuleArchetype,
): PlaybookRule {
  const { distanceEsPoints, status } = classifyRule(
    rule.direction,
    rule.entryEs,
    esPrice,
    archetype,
  );
  return { ...rule, distanceEsPoints, status };
}

/**
 * Generate 1-3 concrete rules for the current (regime, phase) pair.
 *
 * When no rules apply (STAND_ASIDE, outside RTH, or zero-gamma unknown)
 * returns an empty array — the panel shows a neutral "sit out" message.
 *
 * `esPrice` feeds the rule-level status classifier — pass null when the
 * current futures price is unknown (pre-market, data gap) and every rule
 * falls back to DISTANT / null distance.
 */
export function rulesForRegime(
  regime: GexRegime,
  phase: SessionPhase,
  levels: RuleLevels,
  esPrice: number | null,
): PlaybookRule[] {
  // TRANSITIONING → STAND_ASIDE verdict → no rules.
  if (verdictForRegime(regime) === 'STAND_ASIDE') return [];

  // Outside RTH: no directional playbook. The futures tape is too thin to
  // trust SPX-derived levels.
  if (phase === 'PRE_OPEN' || phase === 'POST_CLOSE') return [];

  const rules: PlaybookRule[] = [];

  if (regime === 'POSITIVE') {
    // Fade moves into the overhead wall; target a mean-revert pull-in.
    //
    // Stop = one ES tick ABOVE the wall (i.e. wall + ES_TICK_SIZE). The
    // stop is the INVALIDATION price — beyond it the structural thesis
    // has failed. Zero-gamma is the TARGET of the trade, not the stop.
    if (levels.esCallWall !== null) {
      const stop = esTickRound(levels.esCallWall + ES_TICK_SIZE);
      rules.push(
        finalize(
          {
            id: 'pos-fade-call-wall',
            condition: `Fade rallies into call wall at ${fmt(levels.esCallWall)} · stop ${fmt(stop)} (one tick above the wall)`,
            direction: 'SHORT',
            entryEs: levels.esCallWall,
            targetEs: levels.esZeroGamma,
            stopEs: stop,
            sizingNote:
              'Tight stops — one ES tick above the wall invalidates the fade.',
          },
          esPrice,
          'fade-lift',
        ),
      );
    }

    // Lift support at the put wall — mirror fade from below.
    //
    // Stop = one ES tick BELOW the wall (put wall − ES_TICK_SIZE).
    if (levels.esPutWall !== null) {
      const stop = esTickRound(levels.esPutWall - ES_TICK_SIZE);
      rules.push(
        finalize(
          {
            id: 'pos-lift-put-wall',
            condition: `Buy dips into put wall at ${fmt(levels.esPutWall)} · stop ${fmt(stop)} (one tick below the wall)`,
            direction: 'LONG',
            entryEs: levels.esPutWall,
            targetEs: levels.esZeroGamma,
            stopEs: stop,
            sizingNote:
              'Tight stops — one ES tick below the wall invalidates the lift.',
          },
          esPrice,
          'fade-lift',
        ),
      );
    }

    // Charm-drift window: price grinds toward the highest |GEX| strike
    // (the "gamma pin") — where dealer hedging physically concentrates as
    // OTM 0DTE options decay to zero delta. This is NOT max-pain
    // (which is a theoretical OI-payout minimum). They often converge but
    // when they diverge, gamma-pin is the mechanistic target because
    // dealer hedging flow follows gamma, not payout math.
    if (
      (phase === 'AFTERNOON' || phase === 'POWER') &&
      levels.esGammaPin !== null
    ) {
      rules.push(
        finalize(
          {
            id: 'pos-charm-drift',
            condition: `Charm drift toward gamma pin at ${fmt(levels.esGammaPin)}`,
            direction: 'EITHER',
            entryEs: null,
            targetEs: levels.esGammaPin,
            stopEs: null,
            sizingNote: 'Enter between 13:30–14:30 CT; exit before 15:30 CT.',
          },
          esPrice,
          'either',
        ),
      );
    }
  } else if (regime === 'NEGATIVE') {
    // Breakouts of the walls in negative regimes — trade direction, not fades.
    //
    // Stop = one ES tick on the "inside" of the wall — if price pulls back
    // through the wall the breakout has failed. LONG breakout stops BELOW
    // the wall; SHORT breakdown stops ABOVE. Zero-gamma is NOT a valid
    // stop: the same bug as the +GEX rules.
    if (levels.esCallWall !== null) {
      const stop = esTickRound(levels.esCallWall - ES_TICK_SIZE);
      rules.push(
        finalize(
          {
            id: 'neg-break-call-wall',
            condition: `Trade breakouts above call wall at ${fmt(levels.esCallWall)} · stop ${fmt(stop)} (one tick below the wall)`,
            direction: 'LONG',
            entryEs: levels.esCallWall,
            targetEs: null,
            stopEs: stop,
            sizingNote: 'Wider stops — negative gamma amplifies both directions.',
          },
          esPrice,
          'breakout',
        ),
      );
    }
    if (levels.esPutWall !== null) {
      const stop = esTickRound(levels.esPutWall + ES_TICK_SIZE);
      rules.push(
        finalize(
          {
            id: 'neg-break-put-wall',
            condition: `Trade breakdowns below put wall at ${fmt(levels.esPutWall)} · stop ${fmt(stop)} (one tick above the wall)`,
            direction: 'SHORT',
            entryEs: levels.esPutWall,
            targetEs: null,
            stopEs: stop,
            sizingNote: 'Wider stops — negative gamma amplifies both directions.',
          },
          esPrice,
          'breakout',
        ),
      );
    }
  }

  return rules;
}

// ── Sizing guidance ────────────────────────────────────────────────────

/** $ per ES index point (full-size contract). */
const ES_DOLLARS_PER_POINT = 50;
/** $ per point for a 1-lot spread with delta = 1.0. */
const SPREAD_DOLLARS_PER_POINT = 100;

/**
 * Advisory sizing text for stacking ES onto an existing spread book.
 *
 * Math: 1 ES = $50 / index point. A 1-lot spread at delta D moves $100 × D
 * per index point. So one ES matches `50 / (100 × D) = 0.5 / D` spread lots
 * of delta exposure.
 *
 * Deliberately advisory — we show the ratio, not "click to trade X".
 */
export function sizingGuidance(spreadNetDelta: number | null): string {
  if (spreadNetDelta === null || spreadNetDelta === 0) {
    return '1 ES ≈ $50 / SPX point — sizing depends on your spread delta.';
  }
  const ratio =
    ES_DOLLARS_PER_POINT /
    (SPREAD_DOLLARS_PER_POINT * Math.abs(spreadNetDelta));
  return `1 ES ≈ ${ratio.toFixed(1)} spread lots of delta (delta=${spreadNetDelta.toFixed(2)}).`;
}
