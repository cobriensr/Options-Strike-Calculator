/**
 * Shared types for the Strike IV Anomaly Detector frontend.
 *
 * Mirrors `api/iv-anomalies.ts` response shapes without importing them —
 * src/ cannot reach into api/ (Vite doesn't bundle server-only files) and
 * duplicating the shape here keeps the boundary clean. Keep in sync when
 * the server contract changes.
 */

export type IVAnomalyTicker = 'SPX' | 'SPY' | 'QQQ';
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

export const IV_ANOMALY_TICKERS: readonly IVAnomalyTicker[] = [
  'SPX',
  'SPY',
  'QQQ',
] as const;

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
