/**
 * Deterministic Periscope playbook grader.
 *
 * Phase 2 of docs/superpowers/specs/periscope-calibration-grading-2026-05-11.md.
 *
 * `gradePlaybook` is a pure function: takes a playbook's `panel_payload`,
 * the slot's `captured_at` timestamp, and 1-min candle arrays for SPX,
 * ES, and NQ over [slot, EOD]. Returns a `Grade` row populated with all
 * 12 dimensions scored.
 *
 * No DB access, no HTTP, no Date.now() — every output is a pure function
 * of the inputs. Makes the function table-testable and lets the same
 * function re-grade historical data without changing behavior.
 */

import {
  type Candle,
  type CharmDriftDirection,
  GRADER_THRESHOLDS,
  GRADER_VERSION,
  type Grade,
  type ObservedRegime,
  type StructureGrades,
  type TradeAsset,
  type TradeExitReason,
  type TradeSide,
  type TradeSim,
} from './periscope-grades-types.js';
import { gradeStructureList } from './periscope-grader-structures.js';

// ─── Playbook input shape ──────────────────────────────────────────

/**
 * Subset of panel_payload that the grader consumes. Matches the shape
 * the auto-playbook runner writes (api/_lib/periscope-chat-runner.ts,
 * `mapStructuredToPanelPayload`). Optional fields → null when absent.
 */
export interface GraderPlaybook {
  /** Spot at read time. Falls back to slotSpot from candles if null. */
  spot: number | null;
  cone: { lower: number; upper: number } | null;
  longTrigger: number | null;
  shortTrigger: number | null;
  regime: string | null;
  bias: string | null;
  recommended: string[];
  avoid: string[];
  gammaFloor: number | null;
  gammaCeiling: number | null;
  magnet: number | null;
  charmZero: number | null;
  confidence: string | null;
  /** Charm-driven drift direction. The runner may write 'up'/'down'/
   * 'flat' explicitly, or null. When null, the grader derives the
   * expected drift from sign(charmZero - spot). */
  charmDriftDirection: CharmDriftDirection | null;
}

export interface GradePlaybookArgs {
  periscopeAnalysisId: number;
  tradingDate: string; // YYYY-MM-DD CT
  slotCapturedAt: Date;
  mode: 'pre_trade' | 'intraday' | 'debrief';
  playbook: GraderPlaybook;
  /** 1-min SPX candles, slot_captured_at → EOD inclusive. */
  spxCandles: Candle[];
  /** 1-min ES candles over the same window. May be empty. */
  esCandles: Candle[];
  /** 1-min NQ candles over the same window. May be empty. */
  nqCandles: Candle[];
  /** 1-min SPX candles for the 30 min before slot (ATR computation). */
  spxPriorCandles: Candle[];
  /** EOD close time used for IC blown + bias return. */
  eodCloseTs: Date;
}

// ─── Helpers ───────────────────────────────────────────────────────

function clampToEod(candles: Candle[], eodCloseTs: Date): Candle[] {
  return candles.filter((c) => c.ts.getTime() <= eodCloseTs.getTime());
}

function withinWindow(c: Candle, start: Date, end: Date): boolean {
  const t = c.ts.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

/**
 * Compute realized 1-min ATR (mean of |high-low| / spot) over the prior
 * 30 min. Used as the volatility scale for directional structure
 * grading. Returns 0 when candles are empty so callers can fall back
 * to a fixed % threshold via the GRADER_THRESHOLDS constants.
 */
function computeAtrPct(priorCandles: Candle[], slotSpot: number): number {
  if (priorCandles.length === 0 || slotSpot === 0) return 0;
  const ranges = priorCandles.map((c) => (c.high - c.low) / slotSpot);
  return ranges.reduce((acc, r) => acc + r, 0) / ranges.length;
}

// ─── Bias ──────────────────────────────────────────────────────────

interface BiasGrade {
  call: string | null;
  observedReturn: number | null;
  correct: boolean | null;
}

function gradeBias(
  playbook: GraderPlaybook,
  slotSpot: number,
  eodClose: number | null,
): BiasGrade {
  if (eodClose == null || slotSpot === 0)
    return { call: playbook.bias, observedReturn: null, correct: null };
  const ret = (eodClose - slotSpot) / slotSpot;
  if (playbook.bias == null)
    return { call: null, observedReturn: ret, correct: null };
  const { TWO_SIDED_RETURN_PCT } = GRADER_THRESHOLDS;
  let correct: boolean;
  switch (playbook.bias) {
    case 'long':
      correct = ret > 0;
      break;
    case 'short':
      correct = ret < 0;
      break;
    case 'two-sided':
      correct = Math.abs(ret) < TWO_SIDED_RETURN_PCT;
      break;
    default:
      correct = false; // unknown bias label
  }
  return { call: playbook.bias, observedReturn: ret, correct };
}

// ─── Regime ────────────────────────────────────────────────────────

interface RegimeGrade {
  call: string | null;
  observed: ObservedRegime | null;
  correct: boolean | null;
}

function classifyObservedRegime(args: {
  playbook: GraderPlaybook;
  candles: Candle[];
  eodClose: number | null;
}): ObservedRegime | null {
  const { playbook, candles, eodClose } = args;
  if (candles.length === 0 || eodClose == null) return null;

  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));

  const coneUp = playbook.cone?.upper ?? null;
  const coneLow = playbook.cone?.lower ?? null;
  const breachedUp = coneUp != null && high > coneUp;
  const breachedDown = coneLow != null && low < coneLow;

  if (breachedUp && !breachedDown) return 'cone-breach-up';
  if (breachedDown && !breachedUp) return 'cone-breach-down';

  const pinAnchor = playbook.magnet ?? playbook.charmZero ?? null;
  const { PIN_TOLERANCE_PTS } = GRADER_THRESHOLDS;
  const coneHeld = !breachedUp && !breachedDown;
  if (
    pinAnchor != null &&
    Math.abs(eodClose - pinAnchor) <= PIN_TOLERANCE_PTS &&
    coneHeld
  ) {
    return 'pin';
  }

  // drift-and-cap = directional move that respected the cap.
  if (coneHeld && playbook.bias != null && playbook.bias !== 'two-sided') {
    const slotSpot = playbook.spot;
    if (slotSpot != null && slotSpot !== 0) {
      const ret = (eodClose - slotSpot) / slotSpot;
      const directionalLong = playbook.bias === 'long' && ret > 0;
      const directionalShort = playbook.bias === 'short' && ret < 0;
      if (directionalLong || directionalShort) return 'drift-and-cap';
    }
  }

  return 'mixed';
}

/**
 * Map playbook regime strings to observed regime categories. The
 * playbook emits richer vocab (chop, trap, gap-and-rip, generic
 * `cone-breach` without direction); we collapse them onto the
 * observed enum so we can compare apples to apples. Returns null
 * for unmapped strings — surfaced as ungraded rather than wrong.
 */
function canonicalizeCalledRegime(raw: string): ObservedRegime | null {
  const s = raw.trim().toLowerCase();
  if (s === 'pin') return 'pin';
  if (s === 'drift-and-cap' || s.startsWith('drift-and-cap'))
    return 'drift-and-cap';
  if (s === 'cone-breach-up') return 'cone-breach-up';
  if (s === 'cone-breach-down') return 'cone-breach-down';
  // Generic cone-breach without direction — match either breach by
  // returning a sentinel that downstream comparison treats as
  // "either direction is correct". We collapse to a non-direction
  // value and let gradeRegime handle it via prefix.
  if (s === 'cone-breach') return 'cone-breach-up'; // placeholder, see prefix logic
  if (s === 'gap-and-rip') return 'cone-breach-up';
  if (s === 'gap-and-rug' || s === 'gap-and-flush') return 'cone-breach-down';
  if (s === 'chop' || s === 'two-sided' || s === 'trap') return 'mixed';
  return null;
}

function gradeRegime(args: {
  playbook: GraderPlaybook;
  observed: ObservedRegime | null;
}): RegimeGrade {
  const { playbook, observed } = args;
  if (observed == null || playbook.regime == null) {
    return { call: playbook.regime, observed, correct: null };
  }
  // Bidirectional acceptance:
  //   - Exact match after canonicalization
  //   - Generic `cone-breach` call matches either direction observed
  const callCanonical = canonicalizeCalledRegime(playbook.regime);
  const playbookRaw = playbook.regime.trim().toLowerCase();
  let correct: boolean | null;
  if (callCanonical == null) {
    correct = null; // unmapped — surface as ungraded
  } else if (
    playbookRaw === 'cone-breach' &&
    (observed === 'cone-breach-up' || observed === 'cone-breach-down')
  ) {
    correct = true;
  } else {
    correct = callCanonical === observed;
  }
  return { call: playbook.regime, observed, correct };
}

// ─── Level held ────────────────────────────────────────────────────

function levelHeldAbove(
  level: number | null,
  candles: Candle[],
): boolean | null {
  if (level == null || candles.length === 0) return null;
  return candles.every((c) => c.low > level);
}

function levelHeldBelow(
  level: number | null,
  candles: Candle[],
): boolean | null {
  if (level == null || candles.length === 0) return null;
  return candles.every((c) => c.high < level);
}

/**
 * Cone held = the daily 0DTE straddle breakeven cone held at EOD.
 * The cone is priced from the morning ATM straddle; "held" is the
 * settlement question — did SPX cash-settle within the breakeven
 * range? Using the strict every-bar-inside definition was too tight
 * (a ~28pt-wide cone is breached by intraday wicks on most days even
 * when the settle is well inside).
 *
 * Returns null when cone or eodClose is unavailable.
 */
function coneHeld(
  cone: GraderPlaybook['cone'],
  eodClose: number | null,
): boolean | null {
  if (cone == null || eodClose == null) return null;
  return eodClose >= cone.lower && eodClose <= cone.upper;
}

// ─── Charm drift ───────────────────────────────────────────────────

interface CharmDriftGrade {
  call: CharmDriftDirection | null;
  observedPct: number | null;
  correct: boolean | null;
}

function gradeCharmDrift(
  playbook: GraderPlaybook,
  slotSpot: number,
  shortWindowCandles: Candle[],
): CharmDriftGrade {
  // Predicted drift: explicit field wins; fallback to sign(charmZero - spot)
  // since mechanical hedging pushes price toward charm zero.
  let predicted: CharmDriftDirection | null = playbook.charmDriftDirection;
  if (predicted == null && playbook.charmZero != null && slotSpot !== 0) {
    const diff = playbook.charmZero - slotSpot;
    if (Math.abs(diff) < 1) predicted = 'flat';
    else predicted = diff > 0 ? 'up' : 'down';
  }
  if (predicted == null) {
    return { call: null, observedPct: null, correct: null };
  }
  if (shortWindowCandles.length === 0 || slotSpot === 0) {
    return { call: predicted, observedPct: null, correct: null };
  }
  const lastCandle = shortWindowCandles[shortWindowCandles.length - 1];
  if (lastCandle == null) {
    return { call: predicted, observedPct: null, correct: null };
  }
  const lastClose = lastCandle.close;
  const observedPct = (lastClose - slotSpot) / slotSpot;
  const { CHARM_NOISE_PCT } = GRADER_THRESHOLDS;
  const observedDir: CharmDriftDirection =
    Math.abs(observedPct) < CHARM_NOISE_PCT
      ? 'flat'
      : observedPct > 0
        ? 'up'
        : 'down';
  return {
    call: predicted,
    observedPct,
    correct: predicted === observedDir,
  };
}

// ─── Trigger fire detection ────────────────────────────────────────

interface TriggerFire {
  fired: boolean;
  firedAt: Date | null;
  firedAtPrice: number | null;
}

/**
 * A trigger fires when:
 *   1. Spot touches the trigger (high ≥ trigger for long, low ≤ trigger
 *      for short) on some 1-min bar at or after slot_captured_at, AND
 *   2. A subsequent 5-min bar closes on the breakout side (close ≥
 *      trigger for long, close ≤ trigger for short).
 *
 * The 5-min bar is approximated by checking 5 consecutive 1-min
 * candles ending at time T and using the final candle's close as the
 * 5-min close. This works because 1-min candles are contiguous.
 */
function detectTriggerFire(
  trigger: number | null,
  side: 'long' | 'short',
  candles: Candle[],
): TriggerFire {
  const NOT_FIRED: TriggerFire = {
    fired: false,
    firedAt: null,
    firedAtPrice: null,
  };
  if (trigger == null || candles.length < GRADER_THRESHOLDS.TRIGGER_BAR_MIN) {
    return NOT_FIRED;
  }
  const isLong = side === 'long';

  // Step 1: find first touch.
  let touchIdx = -1;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i]!;
    const touched = isLong ? c.high >= trigger : c.low <= trigger;
    if (touched) {
      touchIdx = i;
      break;
    }
  }
  if (touchIdx === -1) return NOT_FIRED;

  // Step 2: starting from touch, find the first 5-min bar whose close
  // is on the breakout side. Use a rolling window of 5 consecutive
  // 1-min candles; the "5-min close" is the close of the last candle.
  const barMin = GRADER_THRESHOLDS.TRIGGER_BAR_MIN;
  for (let end = touchIdx + barMin - 1; end < candles.length; end += 1) {
    const last = candles[end]!;
    const onSide = isLong ? last.close >= trigger : last.close <= trigger;
    if (onSide) {
      return {
        fired: true,
        firedAt: last.ts,
        firedAtPrice: last.close,
      };
    }
  }
  return NOT_FIRED;
}

// ─── Trade simulation ──────────────────────────────────────────────

interface TradeSimArgs {
  asset: TradeAsset;
  side: TradeSide;
  entryAt: Date;
  entryPrice: number;
  stop: number;
  target: number;
  candles: Candle[]; // bars at or after entry, ascending
  eodCloseTs: Date;
}

function simulateTrade(args: TradeSimArgs): TradeSim {
  const {
    asset,
    side,
    entryAt,
    entryPrice,
    stop,
    target,
    candles,
    eodCloseTs,
  } = args;
  const isLong = side === 'long';

  // Scan bars STRICTLY AFTER entry until stop/target/eod. Skipping
  // the entry bar matters: the 5-min trigger close means we only know
  // the price level at end-of-bar, so the bar's intra-bar high/low
  // happened BEFORE we could have entered — they aren't real exit
  // opportunities. The first bar that could plausibly exit us is the
  // NEXT one.
  let exitPrice = entryPrice;
  let exitAt = eodCloseTs;
  let exitReason: TradeExitReason = 'eod';
  for (const c of candles) {
    if (c.ts.getTime() <= entryAt.getTime()) continue;
    if (c.ts.getTime() > eodCloseTs.getTime()) break;
    if (isLong) {
      // Pessimistic ordering: assume stop fills before target if both
      // are touched in the same bar (low first, then high).
      if (c.low <= stop) {
        exitPrice = stop;
        exitAt = c.ts;
        exitReason = 'stop';
        break;
      }
      if (c.high >= target) {
        exitPrice = target;
        exitAt = c.ts;
        exitReason = 'target';
        break;
      }
    } else {
      if (c.high >= stop) {
        exitPrice = stop;
        exitAt = c.ts;
        exitReason = 'stop';
        break;
      }
      if (c.low <= target) {
        exitPrice = target;
        exitAt = c.ts;
        exitReason = 'target';
        break;
      }
    }
    // Track last bar so EOD exit uses its close.
    exitPrice = c.close;
    exitAt = c.ts;
  }

  const pnlPct = isLong
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;
  const durationMs = exitAt.getTime() - entryAt.getTime();
  const durationMin = Math.max(0, Math.round(durationMs / 60_000));
  return {
    asset,
    side,
    entryPrice,
    entryAt: entryAt.toISOString(),
    exitPrice,
    exitAt: exitAt.toISOString(),
    exitReason,
    pnlPct,
    durationMin,
  };
}

// ─── Main entry ────────────────────────────────────────────────────

export function gradePlaybook(args: GradePlaybookArgs): Grade {
  const {
    periscopeAnalysisId,
    tradingDate,
    slotCapturedAt,
    mode,
    playbook,
    spxCandles,
    esCandles,
    nqCandles,
    spxPriorCandles,
    eodCloseTs,
  } = args;

  // Clip every candle stream to [slot, eod] inclusive — defensive
  // against callers that pass a wider window.
  const spx = clampToEod(
    spxCandles.filter((c) => c.ts.getTime() >= slotCapturedAt.getTime()),
    eodCloseTs,
  );
  const es = clampToEod(
    esCandles.filter((c) => c.ts.getTime() >= slotCapturedAt.getTime()),
    eodCloseTs,
  );
  const nq = clampToEod(
    nqCandles.filter((c) => c.ts.getTime() >= slotCapturedAt.getTime()),
    eodCloseTs,
  );

  // Resolve slot spot: prefer playbook.spot (the auto-playbook records
  // the exact captured spot at read time); fall back to first SPX bar
  // open if missing.
  const firstSpx = spx[0] ?? null;
  const slotSpot = playbook.spot ?? firstSpx?.open ?? 0;

  // Short window = [slot, slot+60min].
  const shortWindowEnd = new Date(slotCapturedAt.getTime() + 60 * 60_000);
  const spxShort = spx.filter((c) =>
    withinWindow(c, slotCapturedAt, shortWindowEnd),
  );

  // EOD close = SPX bar closest to (but not after) eodCloseTs.
  const eodCandle =
    spx
      .slice()
      .reverse()
      .find((c) => c.ts.getTime() <= eodCloseTs.getTime()) ?? null;
  const eodClose = eodCandle?.close ?? null;

  // ─── Bias ────────────────────────────────────────────────────────
  const bias = gradeBias(playbook, slotSpot, eodClose);

  // ─── Regime ──────────────────────────────────────────────────────
  const observedRegime = classifyObservedRegime({
    playbook,
    candles: spx,
    eodClose,
  });
  const regime = gradeRegime({ playbook, observed: observedRegime });

  // ─── Levels held (over short window) ─────────────────────────────
  const cone_held = coneHeld(playbook.cone, eodClose);
  const gammaFloorHeld = levelHeldAbove(playbook.gammaFloor, spxShort);
  const gammaCeilingHeld = levelHeldBelow(playbook.gammaCeiling, spxShort);

  // ─── Charm drift ─────────────────────────────────────────────────
  const charm = gradeCharmDrift(playbook, slotSpot, spxShort);

  // ─── Trigger fires (over short window) ───────────────────────────
  const longFire = detectTriggerFire(playbook.longTrigger, 'long', spxShort);
  const shortFire = detectTriggerFire(playbook.shortTrigger, 'short', spxShort);

  // ─── Trade simulations: per fired side × {SPX, ES, NQ} ───────────
  const tradeSims: TradeSim[] = [];
  // Resolve stops/targets per side. Spec: stop at opposite trigger
  // (fallback to gamma floor for longs / ceiling for shorts); target
  // at gamma ceiling (longs) / floor (shorts).
  const longStop = playbook.shortTrigger ?? playbook.gammaFloor ?? null;
  const longTarget = playbook.gammaCeiling ?? null;
  const shortStop = playbook.longTrigger ?? playbook.gammaCeiling ?? null;
  const shortTarget = playbook.gammaFloor ?? null;

  function simAssetSet(args: {
    side: TradeSide;
    fire: TriggerFire;
    stop: number | null;
    target: number | null;
  }) {
    if (!args.fire.fired || args.fire.firedAt == null) return;
    if (args.stop == null || args.target == null) return;
    if (args.fire.firedAtPrice == null) return;
    const entryAt = args.fire.firedAt;
    // SPX trade uses SPX candles
    const spxSim = simulateTrade({
      asset: 'SPX',
      side: args.side,
      entryAt,
      entryPrice: args.fire.firedAtPrice,
      stop: args.stop,
      target: args.target,
      candles: spx,
      eodCloseTs,
    });
    tradeSims.push(spxSim);
    // ES + NQ: use the asset's own price for entry/stop/target. We
    // map the SPX-denominated stop/target onto ES/NQ via the entry-
    // time ratio: ratio = assetEntry / spxEntry; assetLevel = spxLevel
    // × ratio. This preserves the relative %-distance to stop/target.
    function simFutures(asset: 'ES' | 'NQ', futCandles: Candle[]) {
      // Find the futures bar closest to entryAt (within 60s window).
      const futBar = futCandles
        .slice()
        .reverse()
        .find((c) => c.ts.getTime() <= entryAt.getTime());
      if (futBar == null) return;
      const ratio = futBar.close / args.fire.firedAtPrice!;
      const futStop = args.stop! * ratio;
      const futTarget = args.target! * ratio;
      tradeSims.push(
        simulateTrade({
          asset,
          side: args.side,
          entryAt,
          entryPrice: futBar.close,
          stop: futStop,
          target: futTarget,
          candles: futCandles,
          eodCloseTs,
        }),
      );
    }
    simFutures('ES', es);
    simFutures('NQ', nq);
  }
  simAssetSet({
    side: 'long',
    fire: longFire,
    stop: longStop,
    target: longTarget,
  });
  simAssetSet({
    side: 'short',
    fire: shortFire,
    stop: shortStop,
    target: shortTarget,
  });

  // ─── IC blown ────────────────────────────────────────────────────
  let icBlownAtEod: boolean | null = null;
  if (
    eodClose != null &&
    playbook.gammaFloor != null &&
    playbook.gammaCeiling != null
  ) {
    icBlownAtEod =
      eodClose < playbook.gammaFloor || eodClose > playbook.gammaCeiling;
  }

  // ─── Structures ──────────────────────────────────────────────────
  const atrPct = computeAtrPct(spxPriorCandles, slotSpot);
  const structureInput = {
    eodReturnPct: bias.observedReturn ?? 0,
    slotSpot,
    eodClose: eodClose ?? slotSpot,
    atrPct,
    gammaFloor: playbook.gammaFloor,
    gammaCeiling: playbook.gammaCeiling,
    magnet: playbook.magnet,
    icBlownAtEod,
  };
  const recommendedStructuresCorrect: StructureGrades =
    eodClose == null
      ? {}
      : gradeStructureList(playbook.recommended, structureInput);
  const avoidStructuresCorrect: StructureGrades =
    eodClose == null
      ? {}
      : invertStructureGrades(
          gradeStructureList(playbook.avoid, structureInput),
        );

  return {
    periscopeAnalysisId,
    tradingDate,
    slotCapturedAt: slotCapturedAt.toISOString(),
    mode,
    confidence: playbook.confidence,
    graderVersion: GRADER_VERSION,

    regimeCall: regime.call,
    regimeObserved: regime.observed,
    regimeCorrect: regime.correct,

    biasCall: bias.call,
    biasObservedReturn: bias.observedReturn,
    biasCorrect: bias.correct,

    coneLower: playbook.cone?.lower ?? null,
    coneUpper: playbook.cone?.upper ?? null,
    coneHeld: cone_held,

    gammaFloor: playbook.gammaFloor,
    gammaFloorHeld,
    gammaCeiling: playbook.gammaCeiling,
    gammaCeilingHeld,

    charmZero: playbook.charmZero,
    charmDriftCall: charm.call,
    charmDriftObservedPct: charm.observedPct,
    charmDriftCorrect: charm.correct,

    longTrigger: playbook.longTrigger,
    longFired: longFire.fired,
    longFiredAt: longFire.firedAt?.toISOString() ?? null,
    shortTrigger: playbook.shortTrigger,
    shortFired: shortFire.fired,
    shortFiredAt: shortFire.firedAt?.toISOString() ?? null,

    tradeSims,

    eodClose,
    icBlownAtEod,

    recommendedStructuresCorrect,
    avoidStructuresCorrect,
  };
}

/**
 * For an `avoid` list, "structure was correctly avoided" means the
 * structure would have LOST money — i.e., the raw structure grade is
 * false. Invert here so the dashboard can compute accuracy uniformly
 * (count `true` = correct across both lists).
 */
function invertStructureGrades(map: StructureGrades): StructureGrades {
  const out: StructureGrades = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = v == null ? null : !v;
  }
  return out;
}
