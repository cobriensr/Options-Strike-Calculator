/**
 * Trade-bias synthesis — collapses regime + rules + conviction + drift +
 * wall-flow into a single `LONG / SHORT / NEUTRAL` directional call.
 *
 * Pure: no hooks, no fetches, no React. The aggregator hook
 * (`useFuturesGammaPlaybook`) calls this once per snapshot and the
 * `TradeBiasStrip` component renders the result at the top of the
 * playbook panel.
 *
 * Decision flow (first match wins):
 *   1. TRANSITIONING regime → NEUTRAL · regime ambiguous
 *   2. Count ACTIVE rules; if exactly one, derive direction from it.
 *      - Conviction upgrades to `strong` when wall-flow aligns with
 *        the direction AND rule conviction is high.
 *      - Conviction downgrades the bias to NEUTRAL when rule
 *        conviction is low AND wall-flow contradicts.
 *   3. No ACTIVE but ARMED present → direction from nearest ARMED
 *      rule, conviction = mild, reason notes "wait pullback".
 *   4. NEGATIVE regime special case — if the anchor wall is already
 *      BROKEN and the break rule is DISTANT (price overshot),
 *      inherit the trend direction with a "wait pullback" reason.
 *   5. Otherwise NEUTRAL.
 *
 * The logic avoids forcing a direction that the rule set wouldn't
 * support. Charm-drift (EITHER) rules never produce a direction —
 * they're passed through as NEUTRAL with an explicit reason so the
 * trader isn't surprised by the lack of a call.
 */

import { RULE_ACTIVE_BAND_ES } from './playbook.js';
import { evaluateDriftOverride } from './flow-signals.js';
import type {
  EsLevel,
  GexRegime,
  PlaybookFlowSignals,
  PlaybookRule,
  TradeBias,
} from './types';

// ── Inputs ────────────────────────────────────────────────────────────

export interface TradeBiasInput {
  regime: GexRegime;
  rules: PlaybookRule[];
  levels: EsLevel[];
  flowSignals: PlaybookFlowSignals;
}

// ── Output factories ──────────────────────────────────────────────────

function neutral(reason: string): TradeBias {
  return { direction: 'NEUTRAL', conviction: 'neutral', entryEs: null, reason };
}

function directional(
  direction: 'LONG' | 'SHORT',
  conviction: 'strong' | 'mild',
  entryEs: number | null,
  reason: string,
): TradeBias {
  return { direction, conviction, entryEs, reason };
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Look up the status of a specific level kind, or null when absent. */
function levelStatusOf(
  levels: EsLevel[],
  kind: EsLevel['kind'],
): EsLevel['status'] | null {
  return levels.find((l) => l.kind === kind)?.status ?? null;
}

/**
 * Pick the "best" rule from a filtered list: prefer higher conviction,
 * then shorter distance. Returns null when the list is empty.
 */
function pickBestRule(rules: PlaybookRule[]): PlaybookRule | null {
  if (rules.length === 0) return null;
  const convictionRank: Record<PlaybookRule['conviction'], number> = {
    high: 2,
    standard: 1,
    low: 0,
  };
  return [...rules].sort((a, b) => {
    const cr = convictionRank[b.conviction] - convictionRank[a.conviction];
    if (cr !== 0) return cr;
    // Tiebreak on |distance| — closer rules win.
    const da =
      a.distanceEsPoints === null ? Infinity : Math.abs(a.distanceEsPoints);
    const db =
      b.distanceEsPoints === null ? Infinity : Math.abs(b.distanceEsPoints);
    return da - db;
  })[0]!;
}

/**
 * Check whether wall-flow corroborates a directional rule. Returns
 * true when the "right" side is strengthening (or the opposing side
 * eroding) enough to call it aligned; false when contradicted; null
 * when the flow signals are too weak to matter either way.
 */
const WALL_FLOW_ALIGNMENT_THRESHOLD = 2; // percent, matches WallFlowStrip dead-band

function wallFlowAligned(
  direction: 'LONG' | 'SHORT',
  flow: PlaybookFlowSignals,
): boolean | null {
  const ceiling = flow.ceilingTrend5m;
  const floor = flow.floorTrend5m;
  if (ceiling === null && floor === null) return null;

  // LONG bias likes: floor strengthening, ceiling eroding.
  // SHORT bias likes: ceiling strengthening, floor eroding.
  if (direction === 'LONG') {
    if (floor !== null && floor >= WALL_FLOW_ALIGNMENT_THRESHOLD) return true;
    if (ceiling !== null && ceiling <= -WALL_FLOW_ALIGNMENT_THRESHOLD)
      return true;
    if (floor !== null && floor <= -WALL_FLOW_ALIGNMENT_THRESHOLD) return false;
    if (ceiling !== null && ceiling >= WALL_FLOW_ALIGNMENT_THRESHOLD)
      return false;
    return null;
  }
  // SHORT: mirror
  if (ceiling !== null && ceiling >= WALL_FLOW_ALIGNMENT_THRESHOLD) return true;
  if (floor !== null && floor <= -WALL_FLOW_ALIGNMENT_THRESHOLD) return true;
  if (ceiling !== null && ceiling <= -WALL_FLOW_ALIGNMENT_THRESHOLD)
    return false;
  if (floor !== null && floor >= WALL_FLOW_ALIGNMENT_THRESHOLD) return false;
  return null;
}

function driftIsActive(flow: PlaybookFlowSignals): 'up' | 'down' | null {
  // Shared with `triggers.ts` and `playbook.ts` via `evaluateDriftOverride`
  // so the three modules agree on what "drift override is firing" means.
  const drift = evaluateDriftOverride(flow);
  if (drift.up) return 'up';
  if (drift.down) return 'down';
  return null;
}

/**
 * Compose a directional bias for one −GEX break setup. Centralizes the
 * `wallFlowAligned + 'strong' / 'mild' + reason` shape that previously
 * repeated four times in `deriveTradeBias`'s NEGATIVE-regime branch.
 *
 * - `direction` — 'LONG' for the call-wall break, 'SHORT' for the put-wall.
 * - `entryEs`   — the rule's entry level, propagated to the bias output.
 * - `reasonOnAligned` / `reasonOnUnaligned` — human-readable strings
 *   forwarded into the bias's `.reason` field. Pulled out as parameters
 *   because the four sites used four different copy variants.
 */
function buildBreakBias(
  direction: 'LONG' | 'SHORT',
  entryEs: number | null,
  flow: PlaybookFlowSignals,
  reasonOnAligned: string,
  reasonOnUnaligned: string,
): TradeBias {
  const aligned = wallFlowAligned(direction, flow);
  return directional(
    direction,
    aligned === true ? 'strong' : 'mild',
    entryEs,
    aligned === true ? reasonOnAligned : reasonOnUnaligned,
  );
}

/**
 * Rule → direction. `EITHER` rules (charm-drift) intentionally collapse
 * to null so the bias becomes NEUTRAL rather than forcing a fake side.
 */
function ruleDirection(rule: PlaybookRule): 'LONG' | 'SHORT' | null {
  if (rule.direction === 'LONG') return 'LONG';
  if (rule.direction === 'SHORT') return 'SHORT';
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────

export function deriveTradeBias(input: TradeBiasInput): TradeBias {
  const { regime, rules, levels, flowSignals } = input;

  if (regime === 'TRANSITIONING') {
    return neutral('regime ambiguous · spot inside ZG band');
  }

  const activeRules = rules.filter((r) => r.status === 'ACTIVE');
  const armedRules = rules.filter((r) => r.status === 'ARMED');

  // ── POSITIVE regime (mean-revert) ──────────────────────────────────
  if (regime === 'POSITIVE') {
    // Prefer an ACTIVE directional rule.
    const activeDirectional = activeRules.filter(
      (r) => ruleDirection(r) !== null,
    );
    const picked = pickBestRule(activeDirectional);
    if (picked && ruleDirection(picked) !== null) {
      const direction = ruleDirection(picked)!;
      if (picked.conviction === 'low') {
        // Low-conviction fade/lift = stand aside unless wall-flow is
        // explicitly confirming. We'd rather under-call than push a
        // weak trade the trader wouldn't want.
        const aligned = wallFlowAligned(direction, flowSignals);
        if (aligned === true) {
          return directional(
            direction,
            'mild',
            picked.entryEs,
            'low conviction but flow aligned',
          );
        }
        return neutral('low conviction · weakening pin');
      }
      const aligned = wallFlowAligned(direction, flowSignals);
      const strong = picked.conviction === 'high' && aligned === true;
      const reason = strong
        ? 'sticky-pin wall · flow aligned'
        : picked.conviction === 'high'
          ? 'sticky-pin wall'
          : 'fade/lift setup active';
      return directional(
        direction,
        strong ? 'strong' : 'mild',
        picked.entryEs,
        reason,
      );
    }

    // No ACTIVE rule — fall back to ARMED.
    const armedDirectional = armedRules.filter(
      (r) => ruleDirection(r) !== null,
    );
    const armed = pickBestRule(armedDirectional);
    if (armed && ruleDirection(armed) !== null) {
      return directional(
        ruleDirection(armed)!,
        'mild',
        armed.entryEs,
        'setup armed · wait for entry',
      );
    }

    // No ACTIVE and no ARMED. Drift direction can still hint.
    const drift = driftIsActive(flowSignals);
    if (drift !== null) {
      return neutral(`drifting ${drift} · no structural edge`);
    }
    return neutral('all setups distant');
  }

  // ── NEGATIVE regime (trend-follow) ─────────────────────────────────
  // Prefer ACTIVE breakout rules whose anchor wall is NOT broken.
  const callWallStatus = levelStatusOf(levels, 'CALL_WALL');
  const putWallStatus = levelStatusOf(levels, 'PUT_WALL');

  const activeBreakCall = activeRules.find(
    (r) => r.id === 'neg-break-call-wall',
  );
  const activeBreakPut = activeRules.find((r) => r.id === 'neg-break-put-wall');

  if (activeBreakCall && callWallStatus !== 'BROKEN') {
    return buildBreakBias(
      'LONG',
      activeBreakCall.entryEs,
      flowSignals,
      'break-call · flow aligned',
      'break-call continuation',
    );
  }
  if (activeBreakPut && putWallStatus !== 'BROKEN') {
    return buildBreakBias(
      'SHORT',
      activeBreakPut.entryEs,
      flowSignals,
      'break-put · flow aligned',
      'break-put continuation',
    );
  }

  // Call wall already broken — the upside trend is live, trader missed
  // the clean entry. Inherit the LONG bias with a "wait pullback" reason
  // so they know there's no instant action. Mirror block below for the
  // put-wall side.
  if (callWallStatus === 'BROKEN' && putWallStatus !== 'BROKEN') {
    // Use the break-call-wall rule for entry (even if DISTANT) so the
    // trader can see the retest level.
    const breakCall = rules.find((r) => r.id === 'neg-break-call-wall');
    if (breakCall) {
      return buildBreakBias(
        'LONG',
        breakCall.entryEs,
        flowSignals,
        'break fired early · wait pullback',
        'break fired early · wait pullback',
      );
    }
  }
  if (putWallStatus === 'BROKEN' && callWallStatus !== 'BROKEN') {
    const breakPut = rules.find((r) => r.id === 'neg-break-put-wall');
    if (breakPut) {
      return buildBreakBias(
        'SHORT',
        breakPut.entryEs,
        flowSignals,
        'break fired early · wait pullback',
        'break fired early · wait pullback',
      );
    }
  }

  if (callWallStatus === 'BROKEN' && putWallStatus === 'BROKEN') {
    return neutral('both walls broken · whipsaw risk');
  }

  // Fall back to ARMED breakouts.
  const armedBreak = pickBestRule(
    armedRules.filter((r) => ruleDirection(r) !== null),
  );
  if (armedBreak && ruleDirection(armedBreak) !== null) {
    return directional(
      ruleDirection(armedBreak)!,
      'mild',
      armedBreak.entryEs,
      'breakout armed · wait trigger',
    );
  }

  // Distance to the nearest wall, purely informational when no
  // rule is in range.
  const nearest = [...rules]
    .filter((r) => ruleDirection(r) !== null && r.distanceEsPoints !== null)
    .sort(
      (a, b) => Math.abs(a.distanceEsPoints!) - Math.abs(b.distanceEsPoints!),
    )[0];
  if (
    nearest &&
    Math.abs(nearest.distanceEsPoints!) <= RULE_ACTIVE_BAND_ES * 4
  ) {
    return neutral(
      `nearest setup ${Math.round(nearest.distanceEsPoints!)} pts off`,
    );
  }

  return neutral('all setups distant');
}
