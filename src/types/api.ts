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
  readonly vvix: QuoteSlice | null;
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

export interface EventItem {
  readonly date: string;
  readonly event: string;
  readonly description: string;
  readonly time: string;
  readonly severity: 'high' | 'medium';
  readonly source: 'fred' | 'static' | 'finnhub';
}

export interface EventsResponse {
  readonly events: readonly EventItem[];
  readonly startDate: string;
  readonly endDate: string;
  readonly cached: boolean;
  readonly asOf: string;
}

export interface MoverSlice {
  readonly symbol: string;
  readonly name: string;
  readonly change: number;
  readonly price: number;
  readonly volume: number;
}

export interface MoversAnalysis {
  readonly concentrated: boolean;
  readonly megaCapCount: number;
  readonly megaCapSymbols: readonly string[];
  readonly bias: 'bullish' | 'bearish' | 'mixed';
  readonly topUp: MoverSlice | null;
  readonly topDown: MoverSlice | null;
}

export interface MoversResponse {
  readonly up: readonly MoverSlice[];
  readonly down: readonly MoverSlice[];
  readonly analysis: MoversAnalysis;
  readonly marketOpen: boolean;
  readonly asOf: string;
}

export interface HistoryCandle {
  readonly datetime: number; // Unix ms
  readonly time: string; // "9:30 AM", "10:05 AM"
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface HistoryResponse {
  readonly date: string;
  readonly candles: readonly HistoryCandle[];
  readonly previousClose: number;
  readonly previousDay: DaySummary | null;
  readonly candleCount: number;
  readonly asOf: string;
}
