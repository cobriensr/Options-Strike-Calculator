/**
 * Shared types and constants for the GEXBot level ladder: the nine GEXBot
 * levels, the ±1σ band and the short strikes on one SPX strike scale.
 *
 * Spec: docs/superpowers/specs/gexbot-level-ladder-2026-11-22.md
 */

import type {
  ExpectedMoveRow,
  SnapshotsLatestRow,
} from '../../../hooks/useGexbotData';
import type { DeltaTarget } from '../../../types';

// ────────────────────────────────────────────────────────────
// Constants ("Thresholds and constants" in the spec)
// ────────────────────────────────────────────────────────────

/** The calculator delta whose strikes are the ladder's candidates. */
export const LADDER_SHORT_DELTA: DeltaTarget = 10;

/**
 * A short strike at least this many σ from spot is `clear`; from
 * `LADDER_TESTED_SIGMA` up to here it is `watch`.
 *
 * Unmeasured: a first guess with nothing measured behind it, kept by the
 * owner on 2026-11-26 (spec, open question 1). The ladder's σ is the normal
 * tail matching the strike's priced chance (from GEXBot's IVs), not the
 * calculator's own skewed σ, so a fresh 10Δ candidate can start at `watch`
 * by this measure.
 */
export const LADDER_CLEAR_SIGMA = 1.2;

/**
 * A short strike closer to spot than this many σ (but not past it) is
 * `tested`: it is priced inside ±1σ.
 *
 * Unmeasured: a first guess with nothing measured behind it, kept by the
 * owner on 2026-11-26 (spec, open question 1).
 */
export const LADDER_TESTED_SIGMA = 1.0;

/** The window reaches at least this far from spot on each side, in points. */
export const LADDER_MIN_HALF_SPAN_PTS = 20;

/**
 * The window reaches at most this far from spot on each side, in points;
 * anything farther is listed on the `above` or `below` line.
 */
export const LADDER_MAX_HALF_SPAN_PTS = 60;

/**
 * While the market is open, a snapshot (by `capturedAt`) or an expected-move
 * row (by `asOf`) older than this is not used. The client sees a row about
 * 130 s after the database does with every cron run on time (one write a
 * minute, a 15 s cache with 60 s stale-while-revalidate, a 30 s poll), and
 * about 190 s after one missed run: 240 s keeps the levels through one
 * missed run and drops them after two. Deliberately not
 * `FIRE_TIME_MAX_AGE_SECONDS` (180 s), which bounds a direct database read.
 */
export const LADDER_MAX_LEVEL_AGE_SECONDS = 240;

// ────────────────────────────────────────────────────────────
// Levels
// ────────────────────────────────────────────────────────────

/** The ladder's own level ids, chosen to match the planned study's tags. */
export type LadderLevelId =
  | 'classic_pos_vol'
  | 'classic_neg_vol'
  | 'classic_pos_oi'
  | 'classic_neg_oi'
  | 'state_long_gamma'
  | 'state_short_gamma'
  | 'state_major_call'
  | 'state_major_put'
  | 'classic_zero_gamma';

/** The snapshot fields that hold a level price. */
export type LadderLevelField = keyof Pick<
  SnapshotsLatestRow,
  | 'majorPosVol'
  | 'majorNegVol'
  | 'majorPosOi'
  | 'majorNegOi'
  | 'zMlgamma'
  | 'zMsgamma'
  | 'zeroMcall'
  | 'zeroMput'
  | 'zeroGamma'
>;

export interface LadderLevelDef {
  id: LadderLevelId;
  field: LadderLevelField;
  /** The vendor's field name, as printed on the chip or marker. */
  label: string;
  /**
   * `strike`: a price that can sit on a listed strike (a chip there, else a
   * marker line). `crossing`: zero gamma, always a marker line, and never
   * counted as a level between spot and a strike.
   */
  kind: 'strike' | 'crossing';
}

/** The spec's "Levels" table, in its order (chips on one strike follow it). */
export const LADDER_LEVELS: readonly LadderLevelDef[] = [
  {
    id: 'classic_pos_vol',
    field: 'majorPosVol',
    label: 'Classic major positive · volume',
    kind: 'strike',
  },
  {
    id: 'classic_neg_vol',
    field: 'majorNegVol',
    label: 'Classic major negative · volume',
    kind: 'strike',
  },
  {
    id: 'classic_pos_oi',
    field: 'majorPosOi',
    label: 'Classic major positive · OI',
    kind: 'strike',
  },
  {
    id: 'classic_neg_oi',
    field: 'majorNegOi',
    label: 'Classic major negative · OI',
    kind: 'strike',
  },
  {
    id: 'state_long_gamma',
    field: 'zMlgamma',
    label: 'State long gamma · taker-long',
    kind: 'strike',
  },
  {
    id: 'state_short_gamma',
    field: 'zMsgamma',
    label: 'State short gamma · taker-short',
    kind: 'strike',
  },
  {
    id: 'state_major_call',
    field: 'zeroMcall',
    label: 'State major call',
    kind: 'strike',
  },
  {
    id: 'state_major_put',
    field: 'zeroMput',
    label: 'State major put',
    kind: 'strike',
  },
  {
    id: 'classic_zero_gamma',
    field: 'zeroGamma',
    label: 'Classic zero gamma',
    kind: 'crossing',
  },
];

/**
 * What the ladder does with the snapshot's levels. `shown`: chips and level
 * markers render. The others drop them, and all but `missing` with the
 * market closed print one line saying why (`LadderLevels.line`).
 */
export type LadderLevelsState =
  | 'shown'
  | 'stale'
  | 'not_same_day'
  | 'missing'
  | 'unavailable';

// ────────────────────────────────────────────────────────────
// Short strikes and odds
// ────────────────────────────────────────────────────────────

export type ShortSide = 'call' | 'put';

/** A short strike handed to the ladder: a candidate or an open leg. */
export interface LadderStrikeInput {
  side: ShortSide;
  strike: number;
}

/** Where a short strike came from; open legs hide the candidates. */
export type ShortSource = 'candidate' | 'open';

/**
 * How exposed a short strike is: by its priced σ while spot has not reached
 * it, `breached` once spot is at or past it.
 */
export type StrikeStatus = 'clear' | 'watch' | 'tested' | 'breached';

/**
 * One strike's call and put IV from the expected-move capture (fractions,
 * 0.11 = 11%); null where GEXBot sent none on that side.
 */
export interface LadderStrikeIv {
  strike: number;
  callIv: number | null;
  putIv: number | null;
}

/**
 * Everything a short strike's odds are priced from: `E` and the time left,
 * both carried forward to now, and the strike IVs (null when there are none).
 */
export interface LadderVolatility {
  /** One ATM standard deviation to expiry, in points (> 0). */
  expectedMove: number;
  /** Time left to expiry, in days (> 0). */
  daysLeft: number;
  strikeIvs: readonly LadderStrikeIv[] | null;
}

/**
 * Which price the odds came from: `priced`, the market's priced chance (a
 * vertical spread at the strike, narrowed to nothing) from the strike's own
 * IV and the smile's slope; `atm`, the ATM σ fallback.
 */
export type OddsSource = 'priced' | 'atm';

/** The word every status pill carries, so colour is never the only signal. */
export const STATUS_PILL_LABEL: Record<StrikeStatus, string> = {
  clear: 'CLEAR',
  watch: 'WATCH',
  tested: 'TESTED',
  breached: 'BREACHED',
};

/**
 * A short strike's priced odds against the ladder's spot. `sigmaAway` is the
 * σ whose normal tail equals the priced chance of finishing beyond, so the
 * printed σ and odds always agree. A breached strike has been touched: it
 * carries how far past it spot is instead of a touch and a finish beyond.
 */
export type StrikeOdds =
  | {
      /**
       * Distance from spot toward the money, in σ. Can be ≤ 0 for a strike
       * spot has not reached when it is priced at 50% or more (a skew a
       * point or two from spot); it prints as "0.00σ".
       */
      sigmaAway: number;
      status: Exclude<StrikeStatus, 'breached'>;
      /** Priced chance of finishing beyond the strike. */
      finishBeyond: number;
      /** Priced chance of a touch before expiry. */
      touch: number;
      pointsPast: null;
      oddsSource: OddsSource;
    }
  | {
      sigmaAway: number;
      status: 'breached';
      finishBeyond: null;
      touch: null;
      /** How far spot is past the strike, in points (≥ 0). */
      pointsPast: number;
      oddsSource: OddsSource;
    };

// ────────────────────────────────────────────────────────────
// Model input
// ────────────────────────────────────────────────────────────

export type LadderSpotSource = 'schwab' | 'gexbot';

export interface LadderSpot {
  spot: number;
  source: LadderSpotSource;
  /** How the header names the spot: "spot" (Schwab) or "GEXBot spot". */
  label: string;
}

export interface LevelLadderInput {
  /** The ladder's spot, from `pickLadderSpot`; null when there is none. */
  spot: number | null;
  /** The SPX row of `snapshots-latest`, or null when the view has none. */
  snapshot: SnapshotsLatestRow | null;
  /** The SPX row of `expected-move`, or null when the view has none. */
  expectedMove: ExpectedMoveRow | null;
  /**
   * The same capture's per-strike IVs, which price each short strike; null
   * when there are none, and the odds fall back to the ATM σ.
   */
  strikeIvs: readonly LadderStrikeIv[] | null;
  /** The levels view failed: an error with no rows held (`isViewFailed`). */
  levelsFailed: boolean;
  /** The expected-move view failed: an error with no rows held. */
  expectedMoveFailed: boolean;
  /** The calculator's candidates (`candidatesFromDeltas`). */
  candidates: readonly LadderStrikeInput[];
  /** Open short legs; any at all hide the candidates. */
  openShortStrikes: readonly LadderStrikeInput[];
  nowMs: number;
  marketOpen: boolean;
}

// ────────────────────────────────────────────────────────────
// Model output
// ────────────────────────────────────────────────────────────

export type LadderChip =
  | { kind: 'level'; id: LadderLevelId; label: string }
  | {
      kind: 'short';
      side: ShortSide;
      source: ShortSource;
      /** "CANDIDATE · 10Δ CALL", "OPEN · SHORT PUT". */
      label: string;
    };

/** One listed strike, top to bottom. */
export interface LadderStrikeRow {
  kind: 'strike';
  strike: number;
  /** "7,620". */
  strikeText: string;
  /** Short-strike chips first, then level chips in table order. */
  chips: LadderChip[];
  /** The pill on a short-strike row; null with no odds or no short strike. */
  status: StrikeStatus | null;
  /** The odds behind the pill (the worst short strike on the row). */
  odds: StrikeOdds | null;
  /**
   * The second column: the odds line on a short-strike row ("1.37σ · touch
   * 17% · finish beyond 8%"), distance and band position on a level row
   * ("+16.6 pts · inside +1σ"), null on an untagged row.
   */
  detail: string | null;
}

export type LadderMarkerKind = 'spot' | 'upper' | 'lower' | 'level';

/** A full-width line between two strike rows. */
export interface LadderMarkerRow {
  kind: 'marker';
  marker: LadderMarkerKind;
  /** The level on a `level` marker (zero gamma or an off-grid level). */
  levelId: LadderLevelId | null;
  value: number;
  /** "SPX 7,588.4", "+1σ · 7,611.4", "Classic zero gamma · 7,586.2". */
  text: string;
  /**
   * Distance and band position for an off-grid strike level
   * ("+8.9 pts · inside +1σ"); null for spot, the bounds and zero gamma.
   */
  detail: string | null;
}

export type LadderRow = LadderStrikeRow | LadderMarkerRow;

/** Something that fell outside the window, listed on one line per side. */
export interface LadderEdgeItem {
  kind: 'level' | 'bound' | 'short';
  value: number;
  /** "Classic major positive · OI 7,700", "Call 7,700 (CLEAR 1.39σ · …)". */
  text: string;
  /** A short strike keeps its odds; null for levels and bounds. */
  status: StrikeStatus | null;
  odds: StrikeOdds | null;
}

export interface LadderEdge {
  /** Nearest first. */
  items: LadderEdgeItem[];
  /** "Above: Classic major positive · OI 7,700"; null when nothing fell out. */
  text: string | null;
}

export interface LadderLevels {
  state: LadderLevelsState;
  /** The one line that says why the levels are hidden; null otherwise. */
  line: string | null;
  /** The held snapshot's `capturedAt` in CT ("09:45 CT"); null with none. */
  asOfText: string | null;
}

/** Which result-line case applied (spec "Result line", first match wins). */
export type LadderResultKind =
  | 'no_spot'
  | 'closed'
  | 'no_short_strikes'
  | 'no_expected_move'
  | 'status';

export interface LadderResult {
  kind: LadderResultKind;
  /** The worst status among the short strikes shown; null with no status. */
  pill: StrikeStatus | null;
  /** One to three sentences; empty for `no_spot`. */
  text: string;
}

/** The ±1σ band, centred on the ladder's own spot. */
export interface LadderBand {
  /** `E`, one standard deviation to expiry in points, carried to now. */
  expectedMove: number;
  upper: number;
  lower: number;
}

export interface LevelLadder {
  result: LadderResult;
  /** Strike and marker rows, top to bottom; empty with no spot. */
  rows: LadderRow[];
  above: LadderEdge;
  below: LadderEdge;
  levels: LadderLevels;
  band: LadderBand | null;
  /** "7,588.4"; null with no spot. */
  spotText: string | null;
  /** One line per side for the strike the result line names there. */
  summary: { call: string | null; put: string | null };
}
