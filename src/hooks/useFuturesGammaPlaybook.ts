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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GexStrikeLevel, UseGexPerStrikeReturn } from './useGexPerStrike';
import { useGexPerStrike } from './useGexPerStrike';
import { useFuturesData } from './useFuturesData';
import type { FuturesDataState } from './useFuturesData';
import { useSpotGexHistory } from './useSpotGexHistory';
import { useIsOwner } from './useIsOwner';
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
import { evaluateTriggers } from '../components/FuturesGammaPlaybook/triggers';
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
   * ES price of the highest-|netGamma| strike. The charm-drift magnet.
   * Mirrors GexLandscape's "gravity" concept so the two components agree.
   * Not rendered as an EsLevel row — it's always either the call wall or
   * the put wall by definition, so a dedicated row would duplicate one.
   */
  esGammaPin: number | null;
  /**
   * Intraday regime timeseries for the active session, sourced from
   * `/api/spot-gex-history`. Each point carries `ts`, `netGex`, `spot`,
   * and the regime classified against the current zero-gamma estimate.
   * Empty array while history is loading or the day has no snapshots yet.
   */
  regimeTimeline: RegimeTimelinePoint[];
  /**
   * CT wall-clock boundaries (ISO-8601 instants) for the five session
   * phases plotted on the RegimeTimeline x-axis. Derived from the active
   * trading date.
   */
  sessionPhaseBoundaries: SessionPhaseBoundariesCt;
  loading: boolean;
  /**
   * True while the max-pain fetch is in flight. The fetch fires once per
   * `selectedDate` change in both live and scrub modes (the endpoint picks
   * live vs. historical server-side based on the date param).
   */
  maxPainLoading: boolean;
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
}

/**
 * Extract structural levels from the per-strike data:
 *   - callWall  — strike with the largest positive netGamma
 *   - putWall   — strike with the largest-magnitude negative netGamma
 *   - zeroGamma — interpolated zero crossing of cumulative netGamma
 *   - gammaPin  — strike with the largest |netGamma| (GexLandscape gravity)
 *   - spot      — price field carried on every strike row (same value)
 *   - netGex    — sum of netGamma across all strikes
 */
function deriveSpxLevels(strikes: GexStrikeLevel[]): SpxLevels {
  if (strikes.length === 0) {
    return {
      callWall: null,
      putWall: null,
      zeroGamma: null,
      gammaPin: null,
      spot: null,
      netGex: 0,
    };
  }

  let callWallRow: GexStrikeLevel | null = null;
  let putWallRow: GexStrikeLevel | null = null;
  let gammaPinRow: GexStrikeLevel | null = null;
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
    if (
      gammaPinRow === null ||
      Math.abs(s.netGamma) > Math.abs(gammaPinRow.netGamma)
    ) {
      gammaPinRow = s;
    }
  }

  const spot = strikes[0]?.price ?? null;
  const zeroGamma =
    spot !== null ? computeZeroGammaStrike(strikes, spot) : null;

  return {
    callWall: callWallRow?.strike ?? null,
    putWall: putWallRow?.strike ?? null,
    zeroGamma,
    gammaPin: gammaPinRow?.strike ?? null,
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
  /**
   * ES price of the highest |netGamma| strike — the actual charm-drift
   * target. Computed alongside the walls but not rendered as its own row
   * in EsLevelsPanel (it's always either call wall or put wall by
   * definition, so a dedicated row would duplicate one of those). Used
   * only by the charm-drift rule.
   */
  esGammaPin: number | null;
}

function buildEsLevels(
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

  // Note: MAX_PAIN is intentionally omitted from the rendered level rows.
  // UW's max-pain endpoint only returns monthly expirations, so today's
  // value is typically the nearest-upcoming monthly (e.g. the May chain
  // on an April Tuesday) — that has structural institutional put OI
  // anchoring max-pain deep OTM, which does not drag intraday SPX price.
  // The value is still fetched and passed to Claude's analyze context
  // via `formatMaxPainForClaude`, which labels the expiry correctly, but
  // the realtime UI shouldn't display a misleading magnet. Charm-drift
  // now uses `esGammaPin` (today's highest-|GEX| strike) as its target.
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
  const futuresAt = gex.isScrubbed && gex.timestamp ? gex.timestamp : undefined;
  const futures: FuturesDataState = useFuturesData(futuresAt);
  // Intraday SPX spot-GEX timeseries for the RegimeTimeline. Fetches the
  // selected trading date so scrubbing backwards shows that day's series,
  // not today's.
  const history = useSpotGexHistory(gex.selectedDate, marketOpen);

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

  // ── Max-pain (SPX) ─────────────────────────────────────────────────
  //
  // Phase 1D.4 unified path: a single `/api/max-pain-current?date=<selected>`
  // fetch covers both live and historical. The endpoint routes today ET to
  // the UW live path and past dates to a DB-backed compute from the
  // `oi_per_strike` table (populated daily by `fetch-oi-per-strike.ts`),
  // so the hook no longer has to distinguish live vs. scrub. This replaces
  // the prior live-only fetch that forced scrub mode to resolve to null.
  const [spxMaxPain, setSpxMaxPain] = useState<number | null>(null);
  const [maxPainLoading, setMaxPainLoading] = useState(false);
  const isOwner = useIsOwner();
  // One fetch per (selectedDate, isOwner) combination. The key guards the
  // effect from infinite re-fetching when the setter below triggers a
  // re-render but the identity of the fetch scope hasn't actually changed.
  const maxPainFetchKey = useRef<string | null>(null);

  useEffect(() => {
    if (!isOwner) {
      setSpxMaxPain(null);
      setMaxPainLoading(false);
      maxPainFetchKey.current = null;
      return;
    }

    const key = gex.selectedDate;
    if (maxPainFetchKey.current === key) return;
    maxPainFetchKey.current = key;

    const controller = new AbortController();
    setMaxPainLoading(true);

    (async () => {
      try {
        const url = `/api/max-pain-current?date=${encodeURIComponent(
          gex.selectedDate,
        )}`;
        const res = await fetch(url, {
          credentials: 'same-origin',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(5_000),
          ]),
        });
        if (!res.ok) {
          setSpxMaxPain(null);
          return;
        }
        const data = (await res.json()) as { maxPain: number | null };
        setSpxMaxPain(data.maxPain ?? null);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Max-pain is advisory — swallow to null, don't surface as a
        // top-level hook error.
        setSpxMaxPain(null);
      } finally {
        setMaxPainLoading(false);
      }
    })();

    return () => controller.abort();
  }, [gex.selectedDate, isOwner]);

  const { levels, derived } = useMemo(
    () =>
      buildEsLevels(spx, futures.esSpxBasis, esPrice, levelHistory, spxMaxPain),
    [spx, futures.esSpxBasis, esPrice, levelHistory, spxMaxPain],
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
      levels.map((l) => `${l.kind}:${l.distanceEsPoints.toFixed(4)}`).join('|'),
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
    () => rulesForRegime(regime, phase, derived, esPrice),
    [regime, phase, derived, esPrice],
  );

  // Named-setup trigger evaluation. Phase 1D.3 uses the same pure
  // evaluator the TriggersPanel renders, so the bias payload Claude sees
  // matches exactly what the trader sees on screen. Only ACTIVE rows
  // contribute to `firedTriggers` — IDLE/RECENTLY_FIRED are filtered out.
  const firedTriggers: string[] = useMemo(
    () =>
      evaluateTriggers({
        regime,
        phase,
        esPrice,
        levels,
        esGammaPin: derived.esGammaPin,
      })
        .filter((t) => t.status === 'ACTIVE')
        .map((t) => t.id),
    [regime, phase, esPrice, levels, derived.esGammaPin],
  );

  const bias: PlaybookBias = useMemo(
    () => ({
      regime,
      verdict,
      esZeroGamma: derived.esZeroGamma,
      esCallWall: derived.esCallWall,
      esPutWall: derived.esPutWall,
      sessionPhase: phase,
      firedTriggers,
    }),
    [regime, verdict, derived, phase, firedTriggers],
  );

  // Regime timeline — one point per spot_exposures snapshot. Each point is
  // classified against the CURRENT session's zero-gamma estimate, not a
  // per-point one. That's deliberate: zero-gamma is estimated from today's
  // strike ladder; fabricating a historical estimate from only netGex+spot
  // would be hand-wavy. The classifier handles null zero-gamma by returning
  // TRANSITIONING, so the worst case is a timeline of TRANSITIONING bars
  // when the strike ladder hasn't loaded yet.
  const regimeTimeline: RegimeTimelinePoint[] = useMemo(
    () =>
      history.series.map((point) => ({
        ts: point.ts,
        netGex: point.netGex,
        spot: point.spot,
        regime: classifyRegime(point.netGex, spx.zeroGamma, point.spot),
      })),
    [history.series, spx.zeroGamma],
  );

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
    esGammaPin: derived.esGammaPin,
    regimeTimeline,
    sessionPhaseBoundaries,
    loading,
    maxPainLoading,
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
