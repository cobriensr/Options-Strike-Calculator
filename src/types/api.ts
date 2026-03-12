/**
 * Shared types for the market data API responses.
 * Used by both the serverless functions and the React frontend.
 */

export interface QuoteSlice {
  readonly price: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly prevClose: number;
  readonly change: number;
  readonly changePct: number;
}

export interface QuotesResponse {
  readonly spy: QuoteSlice | null;
  readonly spx: QuoteSlice | null;
  readonly vix: QuoteSlice | null;
  readonly vix1d: QuoteSlice | null;
  readonly vix9d: QuoteSlice | null;
  readonly marketOpen: boolean;
  readonly asOf: string;
}

export interface IntradayResponse {
  readonly today: {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly last: number;
  } | null;
  readonly openingRange: {
    readonly high: number;
    readonly low: number;
    readonly rangePts: number;
    readonly minutes: number;
    readonly complete: boolean;
  } | null;
  readonly previousClose: number;
  readonly candleCount: number;
  readonly marketOpen: boolean;
  readonly asOf: string;
}

export interface DaySummary {
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly rangePct: number;
  readonly rangePts: number;
}

export interface YesterdayResponse {
  readonly yesterday: DaySummary | null;
  readonly twoDaysAgo: DaySummary | null;
  readonly asOf: string;
}

export interface MarketDataError {
  readonly error: string;
}
