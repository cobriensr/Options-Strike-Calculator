/**
 * useFuturesGammaPlaybook — aggregator hook for the FuturesGammaPlaybook panel.
 *
 * Composes the two upstream data hooks the panel needs (`useGexPerStrike` for
 * per-strike SPX GEX, `useFuturesData` for ES price + live basis) and runs the
 * pure translation modules (`playbook.ts`, `basis.ts`) over their output to
 * produce:
 *   - `regime` / `verdict` — current gamma posture
 *   - `phase` — CT session phase
 *   - `levels` — SPX walls / zero-gamma / max-pain, translated to ES
 *   - `rules` — concrete rule rows for the cheat sheet
 *   - `bias` — compact payload for the analyze endpoint
 *
 * The hook does not refetch — it reads the existing hooks' state. `marketOpen`
 * is threaded through so `useGexPerStrike` can decide whether to poll live; the
 * caller already has it from `useMarketData`, so we take it as a parameter
 * rather than pulling another hook in here.
 *
 * All heavy derivations are memoized. Loading / error handling is defensive —
 * sensible defaults are returned, nothing throws.
 */

import { useEffect, useMemo, useState } from 'react';
import type { GexStrikeLevel, UseGexPerStrikeReturn } from './useGexPerStrike';
import { useGexPerStrike } from './useGexPerStrike';
import { useFuturesData } from './useFuturesData';
import type { FuturesDataState } from './useFuturesData';
import type {
  EsLevel,
  GexRegime,
  PlaybookBias,
  PlaybookRule,
  RegimeTimelinePoint,
  RegimeVerdict,
  SessionPhase,
  SessionPhaseBoundariesCt,
} from '../components/FuturesGammaPlaybook/types';
import {
  classifyLevelStatus,
  distanceInEsPoints,
  translateSpxToEs,
} from '../components/FuturesGammaPlaybook/basis';
import {
  classifyRegime,
  classifySessionPhase,
  rulesForRegime,
  verdictForRegime,
} from '../components/FuturesGammaPlaybook/playbook';
import { computeZeroGammaStrike } from '../utils/zero-gamma';

/**
 * Number of prior distance samples we retain per level kind so
 * `classifyLevelStatus` can detect REJECTED (moved inside the proximity
 * band then pulled out) and BROKEN (price flipped sign relative to the
 * level) transitions. Matches the 5-point window documented in `basis.ts`.
 */
const LEVEL_HISTORY_WINDOW = 5;

type LevelKind = EsLevel['kind'];

type LevelHistoryBuffer = Partial<Record<LevelKind, number[]>>;

export interface UseFuturesGammaPlaybookReturn {
  regime: GexRegime;
  verdict: RegimeVerdict;
  phase: SessionPhase;
  levels: EsLevel[];
  rules: PlaybookRule[];
  bias: PlaybookBias;
  /** Current ES price (full-size contract), from the futures snapshot. */
  esPrice: number | null;
  /** Live ES − SPX basis at the displayed instant. */
  esSpxBasis: number | null;
  /**
   * Intraday regime timeseries for the active session. Phase 1C ships a
   * current-state-only fallback (always `[]`) until a dedicated
   * `/api/spot-gex-history` endpoint lands — the RegimeTimeline component
   * renders an empty-state shell when this array is empty.
   */
  regimeTimeline: RegimeTimelinePoint[];
  /**
   * CT wall-clock boundaries (ISO-8601 instants) for the five session
   * phases plotted on the RegimeTimeline x-axis. Derived from the active
   * trading date.
   */
  sessionPhaseBoundaries: SessionPhaseBoundariesCt;
  loading: boolean;
  error: Error | null;

  // ── Scrub pass-through (from the inner useGexPerStrike) ─────────────
  /** Timestamp currently being displayed (latest if live, scrub ts if scrubbing) */
  timestamp: string | null;
  /** All snapshot timestamps for the active date, ascending */
  timestamps: string[];
  /** The date currently being viewed (YYYY-MM-DD in ET) */
  selectedDate: string;
  /** Change the viewed date. Clears scrub state as a side effect. */
  setSelectedDate: (date: string) => void;
  /** True when the displayed snapshot is genuinely live */
  isLive: boolean;
  /** True when the user has stepped backwards from the latest snapshot */
  isScrubbed: boolean;
  /** True when there is at least one earlier snapshot the user can scrub to */
  canScrubPrev: boolean;
  /** True when the user is currently scrubbed and can step forward */
  canScrubNext: boolean;
  /** Step one snapshot earlier */
  scrubPrev: () => void;
  /** Step one snapshot later (clears scrub when at the latest) */
  scrubNext: () => void;
  /** Jump directly to a specific snapshot timestamp. */
  scrubTo: (ts: string) => void;
  /** Resume live mode. */
  scrubLive: () => void;
  /** Force a one-shot refetch of the current snapshot. */
  refresh: () => void;
}

// ── SPX-side derivations ──────────────────────────────────────────────

interface SpxLevels {
  callWall: number | null;
  putWall: number | null;
  zeroGamma: number | null;
  spot: number | null;
  netGex: number;
}

/**
 * Extract structural levels from the per-strike data:
 *   - callWall  — strike with the largest positive netGamma
 *   - putWall   — strike with the largest-magnitude negative netGamma
 *   - zeroGamma — interpolated zero crossing of cumulative netGamma
 *   - spot      — price field carried on every strike row (same value)
 *   - netGex    — sum of netGamma across all strikes
 */
function deriveSpxLevels(strikes: GexStrikeLevel[]): SpxLevels {
  if (strikes.length === 0) {
    return {
      callWall: null,
      putWall: null,
      zeroGamma: null,
      spot: null,
      netGex: 0,
    };
  }

  let callWallRow: GexStrikeLevel | null = null;
  let putWallRow: GexStrikeLevel | null = null;
  let netGex = 0;

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
  }

  const spot = strikes[0]?.price ?? null;
  const zeroGamma =
    spot !== null ? computeZeroGammaStrike(strikes, spot) : null;

  return {
    callWall: callWallRow?.strike ?? null,
    putWall: putWallRow?.strike ?? null,
    zeroGamma,
    spot,
    netGex,
  };
}

// ── ES-side assembly ──────────────────────────────────────────────────

interface EsDerivedLevels {
  esCallWall: number | null;
  esPutWall: number | null;
  esZeroGamma: number | null;
  esMaxPain: number | null;
}

function buildEsLevels(
  spx: SpxLevels,
  basis: number | null,
  esPrice: number | null,
  history: LevelHistoryBuffer,
): { levels: EsLevel[]; derived: EsDerivedLevels } {
  const empty: EsDerivedLevels = {
    esCallWall: null,
    esPutWall: null,
    esZeroGamma: null,
    // Max-pain is not currently available on the frontend; it is deferred
    // until an SPX max-pain module/endpoint lands. Passing null keeps
    // downstream code (rule text, bias payload) safely neutral.
    esMaxPain: null,
  };

  if (basis === null || esPrice === null) {
    return { levels: [], derived: empty };
  }

  const raw: Array<{ kind: LevelKind; spxStrike: number | null }> = [
    { kind: 'CALL_WALL', spxStrike: spx.callWall },
    { kind: 'PUT_WALL', spxStrike: spx.putWall },
    { kind: 'ZERO_GAMMA', spxStrike: spx.zeroGamma },
    // Max-pain row is intentionally omitted until a data source is wired.
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
  }

  return { levels, derived };
}

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

function computeSessionPhaseBoundaries(
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

// ── Hook ──────────────────────────────────────────────────────────────

/**
 * Aggregator hook returning everything the FuturesGammaPlaybook panel renders.
 *
 * @param marketOpen — threaded to `useGexPerStrike` for polling decisions.
 *                     Pass whatever the caller has from `useMarketData`.
 *
 * The hook derives the historical ES alignment timestamp internally from the
 * inner `useGexPerStrike`'s scrub state, so the caller does not need to pass
 * `futuresAt` — scrubbing the GEX snapshot automatically re-aligns the ES
 * snapshot to the same instant.
 */
export function useFuturesGammaPlaybook(
  marketOpen: boolean,
): UseFuturesGammaPlaybookReturn {
  const gex: UseGexPerStrikeReturn = useGexPerStrike(marketOpen);
  // When scrubbed, align ES data to the pinned GEX timestamp so distances
  // and basis are read from the same instant. Live → undefined → latest ES.
  const futuresAt =
    gex.isScrubbed && gex.timestamp ? gex.timestamp : undefined;
  const futures: FuturesDataState = useFuturesData(futuresAt);

  // Determine "now" for session-phase classification. When the user is
  // scrubbed we honor the pinned snapshot; otherwise live wall-clock.
  const nowForPhase = useMemo(() => {
    if (gex.isScrubbed && gex.timestamp) {
      const pinned = new Date(gex.timestamp);
      if (!Number.isNaN(pinned.getTime())) return pinned;
    }
    return new Date();
  }, [gex.isScrubbed, gex.timestamp]);

  const phase: SessionPhase = useMemo(
    () => classifySessionPhase(nowForPhase),
    [nowForPhase],
  );

  const spx = useMemo(() => deriveSpxLevels(gex.strikes), [gex.strikes]);

  const regime: GexRegime = useMemo(
    () => classifyRegime(spx.netGex, spx.zeroGamma, spx.spot ?? 0),
    [spx.netGex, spx.zeroGamma, spx.spot],
  );

  const verdict: RegimeVerdict = useMemo(
    () => verdictForRegime(regime),
    [regime],
  );

  // ES side — only derivable when we have both a basis and an ES price.
  const esPrice = useMemo(() => {
    const esRow = futures.snapshots.find((s) => s.symbol === 'ES');
    return esRow?.price ?? null;
  }, [futures.snapshots]);

  // Ring buffer of prior signed distances keyed by level kind. Held as
  // React state (not a ref) so the classifier reads a stable value during
  // render without tripping the "accessing refs during render" lint. Each
  // render classifies against the buffer snapshot from the previous
  // render; the effect below then appends the latest distances so the
  // NEXT render has one more point of history.
  const [levelHistory, setLevelHistory] = useState<LevelHistoryBuffer>({});

  const { levels, derived } = useMemo(
    () => buildEsLevels(spx, futures.esSpxBasis, esPrice, levelHistory),
    [spx, futures.esSpxBasis, esPrice, levelHistory],
  );

  // Scrub identity key — when the user jumps to a different snapshot
  // (different date, scrubbed timestamp, or live↔scrub flip) the prior
  // history becomes meaningless because it referenced a different
  // instant. Resetting avoids leaking REJECTED/BROKEN across the seam.
  const scrubKey = `${gex.selectedDate}|${gex.timestamp ?? ''}|${
    gex.isScrubbed ? 's' : 'l'
  }`;

  // Distance-only signature so the append effect only fires when the raw
  // distances change — NOT when `levels`'s identity changes because the
  // status classifier flipped IDLE→APPROACHING based on a history update.
  // Without this guard the effect would feed the new levels back in after
  // every status flip, triggering an infinite render loop as the buffer
  // churned without distance changes.
  const distanceSignature = useMemo(
    () =>
      levels
        .map((l) => `${l.kind}:${l.distanceEsPoints.toFixed(4)}`)
        .join('|'),
    [levels],
  );

  // After each render append the just-computed distances into the ring
  // buffer, capped at LEVEL_HISTORY_WINDOW — longer windows would make
  // status labels stick around past the move they describe.
  useEffect(() => {
    setLevelHistory((prev) => {
      const next: LevelHistoryBuffer = { ...prev };
      for (const level of levels) {
        const existing = next[level.kind] ?? [];
        const appended = [...existing, level.distanceEsPoints];
        if (appended.length > LEVEL_HISTORY_WINDOW) appended.shift();
        next[level.kind] = appended;
      }
      return next;
    });
    // `levels` is intentionally omitted: distanceSignature already gates
    // the effect on the only field that should trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distanceSignature]);

  // Reset the buffer when the user jumps to a different snapshot. Kept
  // as a separate effect so the append effect above stays simple.
  useEffect(() => {
    setLevelHistory({});
  }, [scrubKey]);

  const rules: PlaybookRule[] = useMemo(
    () => rulesForRegime(regime, phase, derived),
    [regime, phase, derived],
  );

  const bias: PlaybookBias = useMemo(
    () => ({
      regime,
      verdict,
      esZeroGamma: derived.esZeroGamma,
      esCallWall: derived.esCallWall,
      esPutWall: derived.esPutWall,
      sessionPhase: phase,
      // Triggers are populated by the (future) TriggersPanel in Phase 1D;
      // until then the bias payload reports an empty list.
      firedTriggers: [],
    }),
    [regime, verdict, derived, phase],
  );

  // Phase 1C fallback: `/api/spot-gex-history` does not exist yet, so we
  // ship the RegimeTimeline component with an empty timeseries. The panel
  // renders a clear "waiting for session history" empty state in this
  // branch, and the hook contract stays future-proof — when a dedicated
  // endpoint or `useGexPerStrike` extension lands, only this derivation
  // needs to change. Current-state-only intentionally yields `[]`, NOT a
  // single point; a 1-point timeline would draw a degenerate bar.
  const regimeTimeline: RegimeTimelinePoint[] = useMemo(() => [], []);

  const sessionPhaseBoundaries: SessionPhaseBoundariesCt = useMemo(
    () => computeSessionPhaseBoundaries(gex.selectedDate),
    [gex.selectedDate],
  );

  const loading = gex.loading || futures.loading;

  // Unify the two error channels. `useGexPerStrike` emits strings;
  // `useFuturesData` emits strings too. We lift to Error to keep the
  // consumer API uniform.
  const error: Error | null = useMemo(() => {
    const message = gex.error ?? futures.error;
    return message ? new Error(message) : null;
  }, [gex.error, futures.error]);

  return {
    regime,
    verdict,
    phase,
    levels,
    rules,
    bias,
    esPrice,
    esSpxBasis: futures.esSpxBasis,
    regimeTimeline,
    sessionPhaseBoundaries,
    loading,
    error,
    // Scrub pass-through so the container component can render
    // `ScrubControls` without having to call `useGexPerStrike` a second time.
    timestamp: gex.timestamp,
    timestamps: gex.timestamps,
    selectedDate: gex.selectedDate,
    setSelectedDate: gex.setSelectedDate,
    isLive: gex.isLive,
    isScrubbed: gex.isScrubbed,
    canScrubPrev: gex.canScrubPrev,
    canScrubNext: gex.canScrubNext,
    scrubPrev: gex.scrubPrev,
    scrubNext: gex.scrubNext,
    scrubTo: gex.scrubTo,
    scrubLive: gex.scrubLive,
    refresh: gex.refresh,
  };
}
