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
