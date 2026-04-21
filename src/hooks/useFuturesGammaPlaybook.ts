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

import { useMemo } from 'react';
import type { GexStrikeLevel, UseGexPerStrikeReturn } from './useGexPerStrike';
import { useGexPerStrike } from './useGexPerStrike';
import { useFuturesData } from './useFuturesData';
import type { FuturesDataState } from './useFuturesData';
import type {
  EsLevel,
  GexRegime,
  PlaybookBias,
  PlaybookRule,
  RegimeVerdict,
  SessionPhase,
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

  const raw: Array<{ kind: EsLevel['kind']; spxStrike: number | null }> = [
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
    const status = classifyLevelStatus(distance, undefined);

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

  const { levels, derived } = useMemo(
    () => buildEsLevels(spx, futures.esSpxBasis, esPrice),
    [spx, futures.esSpxBasis, esPrice],
  );

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
