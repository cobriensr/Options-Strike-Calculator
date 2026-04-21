/**
 * Pure alert-edge engine for the FuturesGammaPlaybook.
 *
 * Given a snapshot of playbook-relevant state (`prev`) and a newer snapshot
 * (`next`), emit the list of `AlertEvent`s for every qualifying transition
 * between them. Edge-triggered: the engine never emits for state that simply
 * persisted, only for state that *changed* in a way the trader cares about.
 *
 * ## What this module does NOT do
 *
 * - No cooldown / dedup. The dispatcher (`useAlertDispatcher`) owns that —
 *   keeping this layer free of timers means the function stays
 *   deterministic and trivially unit-testable.
 * - No delivery. No toasts, no Notification API, no audio. Callers consume
 *   the returned events and route them however they want (including into
 *   a "would-have-fired" log during backtest scrub).
 * - No hooks, no React imports, no DOM. Pure TS, pure function.
 *
 * ## Detection rules (edge-triggered)
 *
 * - `REGIME_FLIP` — `prev.regime !== next.regime` AND neither side is
 *   `TRANSITIONING`. Severity is `urgent` when flipping into `NEGATIVE`
 *   (higher actionability), otherwise `info`. Flips through
 *   `TRANSITIONING` are handled by the second arm of the check so that
 *   a `TRANSITIONING → POSITIVE` flip is still surfaced as an `info`
 *   event. The "neither side" guard filters out `POSITIVE → TRANSITIONING`
 *   and `NEGATIVE → TRANSITIONING`, which are considered losses of clarity,
 *   not confirmed flips — the trader shouldn't act on a flip to
 *   "uncertain".
 *
 * - `LEVEL_APPROACH` — per `EsLevel.kind`, prior status was `IDLE` and
 *   the next status is `APPROACHING`. The kind comes directly from the
 *   `EsLevel.kind` field so the cooldown key can be fine-grained per
 *   level kind. Skipped entirely when `prev === null` — we can't tell
 *   whether the approach is new without a point of comparison, and
 *   first-render noise would blast the trader with alerts for every
 *   already-APPROACHING level.
 *
 * - `LEVEL_BREACH` — per `EsLevel.kind`, prior status was NOT `BROKEN`
 *   and the next status IS `BROKEN`. Skipped when `prev === null` for
 *   the same first-render-noise reason as `LEVEL_APPROACH`.
 *
 * - `TRIGGER_FIRE` — per trigger id, `prev.firedTriggers` did NOT
 *   contain the id and `next.firedTriggers` does. De-fires (previously
 *   ACTIVE, now IDLE) are intentionally silent: they are not actionable.
 *   Skipped when `prev === null`.
 *
 * - `PHASE_TRANSITION` — `prev.phase !== next.phase` AND the new phase
 *   is one of `AFTERNOON`, `POWER`, or `CLOSE`. `OPEN` and `MORNING`
 *   transitions are deliberately suppressed — they're too noisy
 *   (chop + opening rotations) to act on cleanly. Always `info`
 *   severity. PHASE_TRANSITION is the ONLY rule that fires on
 *   first-render (prev === null) — when the dispatcher mounts during
 *   AFTERNOON, we still want to announce the phase once.
 */

import type {
  EsLevel,
  GexRegime,
  SessionPhase,
} from './types';

// ── Public types ─────────────────────────────────────────────────────

export type AlertType =
  | 'REGIME_FLIP'
  | 'LEVEL_APPROACH'
  | 'LEVEL_BREACH'
  | 'TRIGGER_FIRE'
  | 'PHASE_TRANSITION';

export type AlertSeverity = 'info' | 'warn' | 'urgent';

export interface AlertEvent {
  /** Unique id: `${type}:${key}:${ts}`. `key` is `''` for REGIME_FLIP / PHASE_TRANSITION. */
  id: string;
  type: AlertType;
  /** Short headline, e.g. 'Regime flip: POSITIVE → NEGATIVE'. */
  title: string;
  /** Longer descriptor suitable for Notification body or toast second line. */
  body: string;
  severity: AlertSeverity;
  /** ISO-8601 UTC timestamp the event is stamped with. Supplied by caller. */
  ts: string;
}

export interface AlertState {
  regime: GexRegime;
  phase: SessionPhase;
  /** Full `EsLevel[]` so detectors can read both `kind` and `status`. */
  levels: EsLevel[];
  /** Trigger ids currently ACTIVE. */
  firedTriggers: string[];
  /** Current ES price, null while unavailable. */
  esPrice: number | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Find the level of a given kind in a state. Returns undefined on miss. */
function findLevel(levels: EsLevel[], kind: EsLevel['kind']): EsLevel | undefined {
  return levels.find((l) => l.kind === kind);
}

/** Human label for an EsLevel kind. */
function levelKindLabel(kind: EsLevel['kind']): string {
  switch (kind) {
    case 'CALL_WALL':
      return 'call wall';
    case 'PUT_WALL':
      return 'put wall';
    case 'ZERO_GAMMA':
      return 'zero-gamma';
    case 'MAX_PAIN':
      return 'max pain';
  }
}

/** Human label for a session phase — used in PHASE_TRANSITION body text. */
function phaseLabel(phase: SessionPhase): string {
  switch (phase) {
    case 'AFTERNOON':
      return 'afternoon';
    case 'POWER':
      return 'power hour';
    case 'CLOSE':
      return 'close';
    default:
      return phase.toLowerCase();
  }
}

/** Format an ES price for alert text — 2 decimal places, blank on null. */
function fmtEs(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(2);
}

// ── Detector ─────────────────────────────────────────────────────────

/**
 * Return every alert edge between `prev` and `next`, stamped at `nowIso`.
 *
 * - `prev === null` means "first evaluation" — in that case we skip the
 *   edge detectors that require a baseline (REGIME_FLIP, LEVEL_APPROACH,
 *   LEVEL_BREACH, TRIGGER_FIRE) because without history there's no real
 *   edge to report. PHASE_TRANSITION still fires so the dispatcher can
 *   surface "we're in AFTERNOON right now" on mount.
 * - Stable output order: REGIME_FLIP → LEVEL_APPROACH (by EsLevel order
 *   in `next.levels`) → LEVEL_BREACH → TRIGGER_FIRE → PHASE_TRANSITION.
 *   This makes testing easier and gives the UI deterministic rendering.
 */
export function detectAlertEdges(
  prev: AlertState | null,
  next: AlertState,
  nowIso: string,
): AlertEvent[] {
  const events: AlertEvent[] = [];

  // ── REGIME_FLIP ───────────────────────────────────────────────
  // Surface every regime change whose endpoints are both definite
  // (neither end is TRANSITIONING). That covers POSITIVE ↔ NEGATIVE
  // directly, and TRANSITIONING → POSITIVE/NEGATIVE as a "just
  // cleared up" flip. Flips INTO TRANSITIONING get suppressed on
  // purpose (loss of clarity, not a confirmed flip).
  if (prev !== null && prev.regime !== next.regime) {
    const fromDefinite = prev.regime !== 'TRANSITIONING';
    const toDefinite = next.regime !== 'TRANSITIONING';
    if (fromDefinite && toDefinite) {
      events.push(
        buildRegimeFlipEvent(prev.regime, next.regime, nowIso),
      );
    } else if (!fromDefinite && toDefinite) {
      // TRANSITIONING → definite: info-severity "clarity restored" flip.
      events.push(buildRegimeFlipEvent(prev.regime, next.regime, nowIso));
    }
  }

  // ── LEVEL_APPROACH + LEVEL_BREACH ─────────────────────────────
  // Both require a `prev` to compare statuses — without it the
  // first render would blast alerts for every already-APPROACHING
  // or BROKEN level, which is noise not signal.
  if (prev !== null) {
    for (const level of next.levels) {
      const priorLevel = findLevel(prev.levels, level.kind);
      if (!priorLevel) continue;

      // APPROACH: IDLE → APPROACHING
      if (priorLevel.status === 'IDLE' && level.status === 'APPROACHING') {
        events.push(buildLevelApproachEvent(level, next.esPrice, nowIso));
      }

      // BREACH: not-BROKEN → BROKEN
      if (priorLevel.status !== 'BROKEN' && level.status === 'BROKEN') {
        events.push(buildLevelBreachEvent(level, next.esPrice, nowIso));
      }
    }
  }

  // ── TRIGGER_FIRE ──────────────────────────────────────────────
  if (prev !== null) {
    const priorFired = new Set(prev.firedTriggers);
    for (const id of next.firedTriggers) {
      if (!priorFired.has(id)) {
        events.push(buildTriggerFireEvent(id, nowIso));
      }
    }
  }

  // ── PHASE_TRANSITION ──────────────────────────────────────────
  // The only detector that fires on first render too: when the
  // dispatcher mounts during an actionable phase we still want to
  // announce it once. Subsequent mounts within the same phase are
  // filtered by the dispatcher's cooldown.
  const actionablePhases: ReadonlySet<SessionPhase> = new Set<SessionPhase>([
    'AFTERNOON',
    'POWER',
    'CLOSE',
  ]);
  if (actionablePhases.has(next.phase)) {
    const phaseChanged = prev === null || prev.phase !== next.phase;
    if (phaseChanged) {
      events.push(buildPhaseTransitionEvent(next.phase, nowIso));
    }
  }

  return events;
}

// ── Event builders ──────────────────────────────────────────────────

function buildRegimeFlipEvent(
  from: GexRegime,
  to: GexRegime,
  nowIso: string,
): AlertEvent {
  const severity: AlertSeverity = to === 'NEGATIVE' ? 'urgent' : 'info';
  return {
    id: `REGIME_FLIP::${nowIso}`,
    type: 'REGIME_FLIP',
    title: `Regime flip: ${from} → ${to}`,
    body:
      to === 'NEGATIVE'
        ? 'Net GEX flipped negative — dealers amplify moves. Switch from fades to trend-follow.'
        : to === 'POSITIVE'
          ? 'Net GEX flipped positive — dealers dampen moves. Fade rallies and dips into walls.'
          : `Regime changed from ${from} to ${to}.`,
    severity,
    ts: nowIso,
  };
}

function buildLevelApproachEvent(
  level: EsLevel,
  esPrice: number | null,
  nowIso: string,
): AlertEvent {
  const kindLabel = levelKindLabel(level.kind);
  return {
    id: `LEVEL_APPROACH:${level.kind}:${nowIso}`,
    type: 'LEVEL_APPROACH',
    title: `Approaching ${kindLabel} at ${fmtEs(level.esPrice)}`,
    body: `ES ${fmtEs(esPrice)} is within the proximity band of the ${kindLabel} (${fmtEs(level.esPrice)}).`,
    severity: 'warn',
    ts: nowIso,
  };
}

function buildLevelBreachEvent(
  level: EsLevel,
  esPrice: number | null,
  nowIso: string,
): AlertEvent {
  const kindLabel = levelKindLabel(level.kind);
  return {
    id: `LEVEL_BREACH:${level.kind}:${nowIso}`,
    type: 'LEVEL_BREACH',
    title: `${kindLabel} broken at ${fmtEs(level.esPrice)}`,
    body: `ES ${fmtEs(esPrice)} has broken through the ${kindLabel} (${fmtEs(level.esPrice)}).`,
    severity: 'urgent',
    ts: nowIso,
  };
}

function buildTriggerFireEvent(triggerId: string, nowIso: string): AlertEvent {
  return {
    id: `TRIGGER_FIRE:${triggerId}:${nowIso}`,
    type: 'TRIGGER_FIRE',
    title: `Trigger fired: ${triggerId}`,
    body: `Named setup "${triggerId}" just became active.`,
    severity: 'warn',
    ts: nowIso,
  };
}

function buildPhaseTransitionEvent(
  phase: SessionPhase,
  nowIso: string,
): AlertEvent {
  const label = phaseLabel(phase);
  return {
    id: `PHASE_TRANSITION:${phase}:${nowIso}`,
    type: 'PHASE_TRANSITION',
    title: `Entering ${label}`,
    body: `Session phase is now ${label}.`,
    severity: 'info',
    ts: nowIso,
  };
}
