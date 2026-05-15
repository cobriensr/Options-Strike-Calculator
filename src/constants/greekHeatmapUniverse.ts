/**
 * Ticker universe for the 0DTE Greek Heatmap section.
 *
 * Mirrors `LOTTERY_V3_TICKERS` + `LOTTERY_EXTENDED_TICKERS` from
 * `api/_lib/lottery-finder.ts` (deduped) and `_LOTTERY_TICKERS` from
 * `uw-stream/src/config.py`. All three lists must stay in sync — when
 * either side adds a ticker, update this list too.
 *
 * Why a third copy: the alerts universe is server-side data, but the
 * frontend chip-button selector needs the list at render time without a
 * roundtrip. Hardcoding the same set here matches the precedent set by
 * `uw-stream/src/config.py` (Python copy of the same array).
 *
 * Sorted alphabetically for stable chip-grid ordering. The Set wrapper
 * shields callers from accidental duplicates if a copy-paste introduces
 * one.
 */

const TICKERS = [
  'AAOI',
  'AAPL',
  'AMD',
  'AMZN',
  'APLD',
  'APP',
  'ARM',
  'ASTS',
  'AVGO',
  'BA',
  'BABA',
  'BE',
  'CAR',
  'COIN',
  'CRCL',
  'CRWD',
  'CRWV',
  'CSCO',
  'CVNA',
  'DELL',
  'GME',
  'GOOG',
  'GOOGL',
  'HIMS',
  'HOOD',
  'IBIT',
  'IBM',
  'INTC',
  'IONQ',
  'IREN',
  'IWM',
  'LITE',
  'LLY',
  'META',
  'MRVL',
  'MSFT',
  'MSTR',
  'MU',
  'NBIS',
  'NDXP',
  'NFLX',
  'NOW',
  'NVDA',
  'NVTS',
  'OKLO',
  'ORCL',
  'PLTR',
  'POET',
  'QCOM',
  'QQQ',
  'RBLX',
  'RDDT',
  'RGTI',
  'RIOT',
  'RIVN',
  'RKLB',
  'RUTW',
  'SEDG',
  'SHOP',
  'SLV',
  'SMCI',
  'SMH',
  'SNDK',
  'SNOW',
  'SOFI',
  'SOUN',
  'SOXL',
  'SOXS',
  'SPXW',
  'SPY',
  'SQQQ',
  'STX',
  'TEAM',
  'TLT',
  'TNA',
  'TQQQ',
  'TSLA',
  'TSLL',
  'TSM',
  'UBER',
  'UNH',
  'USAR',
  'USO',
  'WDC',
  'WMT',
  'WULF',
  'XOM',
] as const;

export type GreekHeatmapTicker = (typeof TICKERS)[number];

export const GREEK_HEATMAP_TICKER_UNIVERSE: readonly string[] = TICKERS;

export const DEFAULT_GREEK_HEATMAP_TICKER: GreekHeatmapTicker = 'SPY';
