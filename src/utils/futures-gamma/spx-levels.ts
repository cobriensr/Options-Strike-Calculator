/**
 * Pure SPX/ES level-derivation helpers for the FuturesGammaPlaybook.
 *
 * Extracted from `useFuturesGammaPlaybook.ts` so the math is testable in
 * isolation and shareable with cron / analyze-context callers that don't
 * want to spin up the full hook. Everything here is pure — no hooks, no
 * fetches, no React. Inputs are plain values; outputs are plain values.
 *
 * Three responsibilities live here:
 *
 *   - `deriveSpxLevels`            — pick the structural strikes (call/put
 *                                    walls, gamma pin, top up/down rows,
 *                                    netGex, spot, zero-gamma) from a
 *                                    `GexStrikeLevel[]`.
 *   - `buildEsLevels`              — translate those SPX strikes through
 *                                    the live ES−SPX basis to ES space and
 *                                    classify each level's status.
 *   - `computeSessionPhaseBoundaries` — emit the four CT phase boundaries
 *                                    as ET-offset ISO strings for the
 *                                    RegimeTimeline x-axis.
 */

import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import type { EsLevel, SessionPhaseBoundariesCt } from './types';
import {
  classifyLevelStatus,
  distanceInEsPoints,
  translateSpxToEs,
} from './basis.js';
import { computeZeroGammaStrike } from '../zero-gamma.js';

// ── Types ─────────────────────────────────────────────────────────────

type LevelKind = EsLevel['kind'];

export type LevelHistoryBuffer = Partial<Record<LevelKind, number[]>>;

export interface SpxLevels {
  callWall: number | null;
  putWall: number | null;
  zeroGamma: number | null;
  /**
   * Strike with the largest absolute netGamma anywhere in the window —
   * the gamma-pin / "gravity" strike. Mirrors `GexLandscape/bias.ts:50-57`
   * so the two components always agree on which strike represents the
   * dealer-gamma concentration. Used as the charm-drift target because
   * dealer hedging physically concentrates at this strike as OTM 0DTE
   * options decay to zero delta.
   */
  gammaPin: number | null;
  spot: number | null;
  netGex: number;
  /**
   * Row with the largest |netGamma| ABOVE spot. The top upside drift
   * target — feeds charm classification for the fade-call conviction.
   * Null when no above-spot strikes exist (e.g. empty window or spot at
   * the top of the ladder).
   */
  topUpsideRow: GexStrikeLevel | null;
  /**
   * Row with the largest |netGamma| BELOW spot. Mirror of
   * `topUpsideRow` — drives lift-put conviction.
   */
  topDownsideRow: GexStrikeLevel | null;
}

export interface EsDerivedLevels {
  esCallWall: number | null;
  esPutWall: number | null;
  esZeroGamma: number | null;
  esMaxPain: number | null;
  /**
   * ES price of the highest |netGamma| strike — the actual charm-drift
   * target. Computed alongside the walls but not rendered as its own row
   * in EsLevelsPanel (it's always either call wall or put wall by
   * definition, so a dedicated row would duplicate one of those). Used
   * only by the charm-drift rule.
   */
  esGammaPin: number | null;
}

// ── deriveSpxLevels ───────────────────────────────────────────────────

/**
 * Extract structural levels from the per-strike data:
 *   - callWall  — strike with the largest positive netGamma
 *   - putWall   — strike with the largest-magnitude negative netGamma
 *   - zeroGamma — interpolated zero crossing of cumulative netGamma
 *   - gammaPin  — strike with the largest |netGamma| (GexLandscape gravity)
 *   - spot      — price field carried on every strike row (same value)
 *   - netGex    — sum of netGamma across all strikes
 */
export function deriveSpxLevels(strikes: GexStrikeLevel[]): SpxLevels {
  if (strikes.length === 0) {
    return {
      callWall: null,
      putWall: null,
      zeroGamma: null,
      gammaPin: null,
      spot: null,
      netGex: 0,
      topUpsideRow: null,
      topDownsideRow: null,
    };
  }

  let callWallRow: GexStrikeLevel | null = null;
  let putWallRow: GexStrikeLevel | null = null;
  let gammaPinRow: GexStrikeLevel | null = null;
  let topUpsideRow: GexStrikeLevel | null = null;
  let topDownsideRow: GexStrikeLevel | null = null;
  let netGex = 0;

  const spot = strikes[0]?.price ?? null;

  for (const s of strikes) {
    netGex += s.netGamma;
    if (s.netGamma > 0) {
      if (callWallRow === null || s.netGamma > callWallRow.netGamma) {
        callWallRow = s;
      }
    } else if (s.netGamma < 0) {
      if (putWallRow === null || s.netGamma < putWallRow.netGamma) {
        putWallRow = s;
      }
    }
    if (
      gammaPinRow === null ||
      Math.abs(s.netGamma) > Math.abs(gammaPinRow.netGamma)
    ) {
      gammaPinRow = s;
    }
    // Track top |netGamma| above and below spot separately. These mirror
    // `GexLandscape/bias.ts` `upsideTargets[0]` / `downsideTargets[0]`:
    // the anchoring wall for fade-call / lift-put conviction.
    if (spot !== null) {
      if (s.strike > spot) {
        if (
          topUpsideRow === null ||
          Math.abs(s.netGamma) > Math.abs(topUpsideRow.netGamma)
        ) {
          topUpsideRow = s;
        }
      } else if (s.strike < spot) {
        if (
          topDownsideRow === null ||
          Math.abs(s.netGamma) > Math.abs(topDownsideRow.netGamma)
        ) {
          topDownsideRow = s;
        }
      }
    }
  }

  const zeroGamma =
    spot !== null ? computeZeroGammaStrike(strikes, spot) : null;

  return {
    callWall: callWallRow?.strike ?? null,
    putWall: putWallRow?.strike ?? null,
    zeroGamma,
    gammaPin: gammaPinRow?.strike ?? null,
    spot,
    netGex,
    topUpsideRow,
    topDownsideRow,
  };
}

// ── buildEsLevels ─────────────────────────────────────────────────────

/**
 * Translate SPX levels through a live ES−SPX basis into ES space, classify
 * each one's status against any prior history, and return both the rendered
 * level rows and a derived payload of named numeric levels for
 * analyze-context consumers.
 *
 * Note: MAX_PAIN is intentionally omitted from the rendered level rows.
 * UW's max-pain endpoint only returns monthly expirations, so today's
 * value is typically the nearest-upcoming monthly — that has structural
 * institutional put OI anchoring max-pain deep OTM, which does not drag
 * intraday SPX price. The value is still fetched and surfaced via
 * `derived.esMaxPain` for analyze-context, but the realtime UI shouldn't
 * display a misleading magnet.
 */
export function buildEsLevels(
  spx: SpxLevels,
  basis: number | null,
  esPrice: number | null,
  history: LevelHistoryBuffer,
  spxMaxPain: number | null,
): { levels: EsLevel[]; derived: EsDerivedLevels } {
  const empty: EsDerivedLevels = {
    esCallWall: null,
    esPutWall: null,
    esZeroGamma: null,
    esMaxPain: null,
    esGammaPin: null,
  };

  if (basis === null || esPrice === null) {
    return { levels: [], derived: empty };
  }

  const raw: Array<{ kind: LevelKind; spxStrike: number | null }> = [
    { kind: 'CALL_WALL', spxStrike: spx.callWall },
    { kind: 'PUT_WALL', spxStrike: spx.putWall },
    { kind: 'ZERO_GAMMA', spxStrike: spx.zeroGamma },
  ];

  const levels: EsLevel[] = [];
  const derived: EsDerivedLevels = { ...empty };

  for (const { kind, spxStrike } of raw) {
    if (spxStrike === null) continue;
    const esLevelPrice = translateSpxToEs(spxStrike, basis);
    const distance = distanceInEsPoints(esPrice, esLevelPrice);
    // Feed the ring-buffer's prior values into the status classifier so
    // REJECTED (bounced out of the proximity band) and BROKEN (price flipped
    // sign relative to the level) transitions get detected. Undefined when
    // the buffer has not yet accumulated any history — the classifier falls
    // back to proximity-only.
    const prior = history[kind];
    const status = classifyLevelStatus(
      distance,
      prior && prior.length > 0 ? prior : undefined,
      kind,
    );

    levels.push({
      kind,
      spxStrike,
      esPrice: esLevelPrice,
      distanceEsPoints: distance,
      status,
    });

    if (kind === 'CALL_WALL') derived.esCallWall = esLevelPrice;
    else if (kind === 'PUT_WALL') derived.esPutWall = esLevelPrice;
    else if (kind === 'ZERO_GAMMA') derived.esZeroGamma = esLevelPrice;
    else if (kind === 'MAX_PAIN') derived.esMaxPain = esLevelPrice;
  }

  // Translate gammaPin independently — it is not rendered as an EsLevel
  // row (charm-drift consumes the derived value only).
  if (spx.gammaPin !== null) {
    derived.esGammaPin = translateSpxToEs(spx.gammaPin, basis);
  }

  // Keep esMaxPain on the derived payload (for analyze-context consumers)
  // even though the row is no longer rendered in the UI.
  if (spxMaxPain !== null) {
    derived.esMaxPain = translateSpxToEs(spxMaxPain, basis);
  }

  return { levels, derived };
}

// ── computeSessionPhaseBoundaries ─────────────────────────────────────

/**
 * Compute CT wall-clock session-phase boundaries (ISO-8601 instants) for a
 * given trading date (YYYY-MM-DD in ET). Used by `RegimeTimeline` to place
 * the x-axis phase markers. CT is always ET − 1 hour, so the boundary
 * minutes map directly to UTC via standard ISO construction — we don't
 * need a full tz library here.
 */
const ET_OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  timeZoneName: 'longOffset',
});

/**
 * Return the ET offset (e.g. "-04:00" in EDT, "-05:00" in EST) that applies
 * on the given ET trading date. Sampling at noon avoids ambiguity at the DST
 * fall-back/spring-forward transition instants.
 */
function etOffsetForDate(selectedDate: string): string {
  const probe = new Date(`${selectedDate}T12:00:00Z`);
  for (const part of ET_OFFSET_FORMATTER.formatToParts(probe)) {
    if (part.type === 'timeZoneName') {
      return part.value.replace(/^GMT/, '') || '+00:00';
    }
  }
  return '-04:00';
}

export function computeSessionPhaseBoundaries(
  selectedDate: string,
): SessionPhaseBoundariesCt {
  // RegimeTimeline places x-axis markers against ISO instants. We emit
  // ET-offset ISO strings for the four CT session boundaries so positioning
  // math is correct year-round including across the EDT/EST switch.
  // CT 08:30 = ET 09:30, CT 11:30 = ET 12:30, CT 14:30 = ET 15:30,
  // CT 15:30 = ET 16:30.
  const offset = etOffsetForDate(selectedDate);
  const mkIso = (etTime: string) => `${selectedDate}T${etTime}:00${offset}`;
  return {
    open: mkIso('09:30'),
    lunch: mkIso('12:30'),
    power: mkIso('15:30'),
    close: mkIso('16:30'),
  };
}
