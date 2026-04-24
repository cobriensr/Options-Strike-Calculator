/**
 * Shared types for the Strike IV Anomaly Detector frontend.
 *
 * Mirrors `api/iv-anomalies.ts` response shapes without importing them —
 * src/ cannot reach into api/ (Vite doesn't bundle server-only files) and
 * duplicating the shape here keeps the boundary clean. Keep in sync when
 * the server contract changes.
 */

export type IVAnomalyTicker = 'SPXW' | 'NDXP' | 'SPY' | 'QQQ' | 'IWM';
export type IVAnomalySide = 'call' | 'put';
export type IVAnomalyFlowPhase = 'early' | 'mid' | 'reactive';

export interface IVAnomalyRow {
  id: number;
  ticker: string;
  strike: number;
  side: IVAnomalySide;
  expiry: string;
  spotAtDetect: number;
  ivAtDetect: number;
  skewDelta: number | null;
  zScore: number | null;
  askMidDiv: number | null;
  /**
   * Intraday volume / start-of-day OI at detection. PRIMARY signal for
   * the user — displayed prominently on each row. Null on legacy rows
   * ingested before the 2026-04-24 rescope (pre-vol/OI gate migration).
   */
  volOiRatio: number | null;
  flagReasons: string[];
  flowPhase: IVAnomalyFlowPhase | null;
  contextSnapshot: unknown;
  resolutionOutcome: unknown;
  ts: string;
}

export interface StrikeIVSample {
  ts: string;
  ivMid: number | null;
  ivBid: number | null;
  ivAsk: number | null;
  midPrice: number | null;
  spot: number;
}

export interface IVAnomaliesListResponse {
  mode: 'list';
  latest: Record<IVAnomalyTicker, IVAnomalyRow | null>;
  history: Record<IVAnomalyTicker, IVAnomalyRow[]>;
}

export interface IVAnomaliesHistoryResponse {
  mode: 'history';
  ticker: IVAnomalyTicker;
  strike: number;
  side: IVAnomalySide;
  expiry: string;
  samples: StrikeIVSample[];
}

export type IVAnomaliesResponse =
  | IVAnomaliesListResponse
  | IVAnomaliesHistoryResponse;

/**
 * Display order matches the server-side `STRIKE_IV_TICKERS` tuple
 * (weekly-index roots first, ETFs after). Kept in sync manually since
 * src/ cannot reach into api/ directly.
 */
export const IV_ANOMALY_TICKERS: readonly IVAnomalyTicker[] = [
  'SPXW',
  'NDXP',
  'SPY',
  'QQQ',
  'IWM',
] as const;

/**
 * Anomaly phase — the state of a compound key on the active board.
 *
 *   - `active`       — entry detected, values updating in place.
 *   - `cooling`      — IV regressing from peak OR ask-mid divergence collapsed
 *                      after sustained accumulation. Holders relaxing / demand
 *                      fading but still-displayed on the board.
 *   - `distributing` — detector firing rate (volume proxy) accelerating while
 *                      IV slope flat-or-negative. Holders actively exiting;
 *                      stronger exit signal than plain cooling.
 *
 * Both cooling and distributing remain on the board — the whole point is to
 * SHOW the user when exit signals fire. They evict through the normal silence
 * path (ANOMALY_SILENCE_MS since `lastFiredTs`).
 */
export type IVAnomalyPhase = 'active' | 'cooling' | 'distributing';

/** Why an exit transition fired — surfaces in the row subtitle + banner. */
export type IVAnomalyExitReason =
  | 'iv_regression'
  | 'ask_mid_compression'
  | 'volume_surge_flat_iv';

export interface IVHistoryPoint {
  ts: string;
  ivMid: number | null;
}

export interface IVFiringPoint {
  ts: string;
  /** Cumulative firing count at this ts — used to derive firing-rate slope. */
  firingCount: number;
}

/**
 * Aggregated anomaly view — one entry per active compound key
 * (`ticker:strike:side:expiry`). `useIVAnomalies` builds these from the
 * raw per-minute `IVAnomalyRow` stream so the display stays stable while
 * the detector keeps firing the same strike.
 *
 * Invariants:
 *   - `latest` always holds the most recent row's full payload (the
 *     displayed row updates its metrics in place).
 *   - `firstSeenTs` is pinned at the first firing of the current
 *     active-span; if the strike goes silent ≥ ANOMALY_SILENCE_MS and then
 *     re-fires, `firstSeenTs` resets to that new firing.
 *   - `firingCount` is the number of raw rows aggregated into this entry
 *     within its current active-span — it resets on re-banner.
 *
 * Exit-signal machinery (see useIVAnomalies reconcile):
 *   - `phase`              — active | cooling | distributing.
 *   - `entryIv`            — iv_mid from the row that opened this span.
 *   - `peakIv` / `peakTs`  — highest iv_mid observed during this active span
 *                            AND when it was seen. Reset on cooling→active
 *                            recovery so the next cooling transition is
 *                            measured against the new high.
 *   - `entryAskMidDiv`     — iv_ask - iv_mid on the first row of the span.
 *   - `askMidPeakTs`       — most recent ts where ask-mid div exceeded the
 *                            accumulation threshold. Null until first crossing.
 *   - `ivHistory`          — rolling (ts, iv_mid) samples, last 10 min.
 *   - `firingHistory`      — rolling (ts, cumulative firingCount), last 10
 *                            min. Used as the volume-rate proxy.
 *   - `exitReason`         — why the current phase transition fired; `null`
 *                            in the `active` phase.
 */
export interface ActiveAnomaly {
  /** `${ticker}:${strike}:${side}:${expiry}` — stable across polls. */
  compoundKey: string;
  ticker: IVAnomalyTicker;
  strike: number;
  side: IVAnomalySide;
  expiry: string;
  /** Most recent raw row — its values drive the displayed metrics. */
  latest: IVAnomalyRow;
  /** First firing in the current active-span (ISO). */
  firstSeenTs: string;
  /** Most recent firing (ISO). */
  lastFiredTs: string;
  /** Count of raw rows seen in the current active-span. */
  firingCount: number;
  /** Current phase on the board. */
  phase: IVAnomalyPhase;
  /** Reason the current non-active phase fired (null while active). */
  exitReason: IVAnomalyExitReason | null;
  /** iv_mid of the first row of this active span. */
  entryIv: number;
  /** Max iv_mid seen during this active span. Resets on cooling→active recovery. */
  peakIv: number;
  /** ISO ts when `peakIv` was recorded. */
  peakTs: string;
  /** iv_ask - iv_mid on the first row of the active span (or null if unknown). */
  entryAskMidDiv: number | null;
  /** Last ts where ask-mid div exceeded the accumulation threshold (null if never). */
  askMidPeakTs: string | null;
  /** Rolling iv_mid samples — last ~10 min. */
  ivHistory: readonly IVHistoryPoint[];
  /** Rolling firing-count samples — last ~10 min. */
  firingHistory: readonly IVFiringPoint[];
}

/**
 * Build the compound key for an anomaly row. Exported so tests (and any
 * future consumers) agree on the grouping contract.
 */
export function anomalyCompoundKey(
  row: Pick<IVAnomalyRow, 'ticker' | 'strike' | 'side' | 'expiry'>,
): string {
  return `${row.ticker}:${row.strike}:${row.side}:${row.expiry}`;
}
