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
import type { UseGexPerStrikeReturn } from './useGexPerStrike';
import { useGexPerStrike } from './useGexPerStrike';
import { useFuturesData } from './useFuturesData';
import type { FuturesDataState } from './useFuturesData';
import { useSpotGexHistory } from './useSpotGexHistory';
import { useSpxMaxPain } from './useSpxMaxPain';
import { useSnapshotBuffer } from './useSnapshotBuffer';
import { checkIsOwner } from '../utils/auth';
import type {
  EsLevel,
  GexRegime,
  PlaybookBias,
  PlaybookFlowSignals,
  PlaybookRule,
  RegimeTimelinePoint,
  RegimeVerdict,
  SessionPhase,
  SessionPhaseBoundariesCt,
  TradeBias,
} from '../utils/futures-gamma/types';
import { deriveTradeBias } from '../utils/futures-gamma/tradeBias';
import {
  classifyRegime,
  classifySessionPhase,
  rulesForRegime,
  verdictForRegime,
} from '../utils/futures-gamma/playbook';
import { evaluateTriggers } from '../utils/futures-gamma/triggers';
import {
  buildEsLevels,
  computeSessionPhaseBoundaries,
  deriveSpxLevels,
} from '../utils/futures-gamma/spx-levels';
import type { LevelHistoryBuffer } from '../utils/futures-gamma/spx-levels';
import { classify as classifyGex } from '../components/GexLandscape/classify';

/**
 * Number of prior distance samples we retain per level kind so
 * `classifyLevelStatus` can detect REJECTED (moved inside the proximity
 * band then pulled out) and BROKEN (price flipped sign relative to the
 * level) transitions. Matches the 5-point window documented in `basis.ts`.
 */
const LEVEL_HISTORY_WINDOW = 5;

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
   * ES-translated zero-gamma / call wall / put wall. Forwarded off `derived`
   * so panels don't need to `levels.find(...)` to read them. `bias` carries
   * the same three values but is gated by a stable-serialization effect for
   * analyze-context delivery — these fields are the ergonomic accessor.
   */
  esZeroGamma: number | null;
  esCallWall: number | null;
  esPutWall: number | null;
  /**
   * ES price of the highest-|netGamma| strike. The charm-drift magnet.
   * Mirrors GexLandscape's "gravity" concept so the two components agree.
   * Not rendered as an EsLevel row — it's always either the call wall or
   * the put wall by definition, so a dedicated row would duplicate one.
   */
  esGammaPin: number | null;
  /**
   * Flow signals derived from the snapshot buffer — charm classification
   * of the top drift targets, 5m Δ% aggregated above/below spot, and
   * price-trend direction. Fed into `rulesForRegime` so the rule engine
   * can emit charm-aware conviction and drift-override suppression.
   */
  flowSignals: PlaybookFlowSignals;
  /**
   * Directional call (LONG / SHORT / NEUTRAL) synthesized from regime +
   * rules + conviction + drift + wall-flow + level status. The
   * `TradeBiasStrip` renders this at the top of the playbook so the
   * trader sees one decisive direction instead of scanning six panels.
   */
  tradeBias: TradeBias;
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
  // `includeWindow: true` asks the endpoint for a 5-min window of prior
  // per-strike snapshots alongside each fetch. We seed our snapshot ring
  // buffer with those on scrub so backtest mode emits the same flow
  // signals the live path does, without needing to accumulate them by
  // stepping through the scrub controls snapshot-by-snapshot.
  const gex: UseGexPerStrikeReturn = useGexPerStrike(marketOpen, {
    includeWindow: true,
  });
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

  // Owner-gated SPX max-pain. Phase 1D.4 unified live + historical fetch
  // behind `/api/max-pain-current?date=...`; the sub-hook owns the
  // ref-keyed dedupe + stale-clear-before-fetch logic.
  const isOwner = checkIsOwner();
  const { maxPain: spxMaxPain, loading: maxPainLoading } = useSpxMaxPain(
    gex.selectedDate,
    isOwner,
  );

  const { levels, derived } = useMemo(
    () =>
      buildEsLevels(spx, futures.esSpxBasis, esPrice, levelHistory, spxMaxPain),
    [spx, futures.esSpxBasis, esPrice, levelHistory, spxMaxPain],
  );

  // Scrub identity key — when the user jumps to a different snapshot
  // (different date, scrubbed timestamp, or live↔scrub flip) the prior
  // history becomes meaningless because it referenced a different
  // instant. Resetting avoids leaking REJECTED/BROKEN across the seam.
  //
  // `gex.loading` is included so scrub-click → fetch-in-flight → fetch-
  // resolved traverses at least one intermediate key, forcing the
  // levelHistory reset effect to fire before the new snapshot's distances
  // get classified against the previous snapshot's history. Without it,
  // a single scrub showed one frame of false BROKEN/REJECTED states on
  // the EsLevelsPanel as the classifier compared new distances against
  // stale prior history.
  const scrubKey = `${gex.selectedDate}|${gex.timestamp ?? ''}|${
    gex.isScrubbed ? 's' : 'l'
  }|${gex.loading ? '1' : '0'}`;

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

  // ── Snapshot buffer for Δ% and price-trend ────────────────────────────
  //
  // 10-min ring buffer feeding the 5m Δ% map and the price-trend signal.
  // Date changes reset the buffer; forward-scrub semantics keep snapshots
  // in [T₁, T₂) but consume `< now` to avoid future-comparison.
  const { delta5mMap, priceTrend } = useSnapshotBuffer({
    timestamp: gex.timestamp,
    strikes: gex.strikes,
    windowSnapshots: gex.windowSnapshots,
    selectedDate: gex.selectedDate,
  });

  // 5m wall-flow aggregates — avg Δ% across strikes above / below spot.
  // Nullable: a non-empty `delta5mMap` but no above-spot strikes (or all
  // null-valued) collapses to null rather than 0, so the UI can render `—`.
  const { ceilingTrend5m, floorTrend5m } = useMemo(() => {
    const spot = spx.spot;
    if (spot === null || delta5mMap.size === 0) {
      return { ceilingTrend5m: null, floorTrend5m: null };
    }
    const pickAvg = (predicate: (strike: number) => boolean) => {
      let sum = 0;
      let count = 0;
      for (const [strike, pct] of delta5mMap) {
        if (pct === null) continue;
        if (!predicate(strike)) continue;
        sum += pct;
        count++;
      }
      return count > 0 ? sum / count : null;
    };
    return {
      ceilingTrend5m: pickAvg((strike) => strike > spot),
      floorTrend5m: pickAvg((strike) => strike < spot),
    };
  }, [delta5mMap, spx.spot]);

  // Charm classifications for the top drift targets — fed into the rule
  // engine so fade/lift rules can emit conviction overlays.
  const flowSignals: PlaybookFlowSignals = useMemo(
    () => ({
      upsideTargetCls: spx.topUpsideRow
        ? classifyGex(spx.topUpsideRow.netGamma, spx.topUpsideRow.netCharm)
        : null,
      downsideTargetCls: spx.topDownsideRow
        ? classifyGex(spx.topDownsideRow.netGamma, spx.topDownsideRow.netCharm)
        : null,
      ceilingTrend5m,
      floorTrend5m,
      priceTrend,
    }),
    [
      spx.topUpsideRow,
      spx.topDownsideRow,
      ceilingTrend5m,
      floorTrend5m,
      priceTrend,
    ],
  );

  const rules: PlaybookRule[] = useMemo(
    () => rulesForRegime(regime, phase, derived, esPrice, flowSignals),
    [regime, phase, derived, esPrice, flowSignals],
  );

  const tradeBias: TradeBias = useMemo(
    () => deriveTradeBias({ regime, rules, levels, flowSignals }),
    [regime, rules, levels, flowSignals],
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
        flowSignals,
      })
        .filter((t) => t.status === 'ACTIVE')
        .map((t) => t.id),
    [regime, phase, esPrice, levels, derived.esGammaPin, flowSignals],
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
    esZeroGamma: derived.esZeroGamma,
    esCallWall: derived.esCallWall,
    esPutWall: derived.esPutWall,
    esGammaPin: derived.esGammaPin,
    flowSignals,
    tradeBias,
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
