/**
 * GET /api/intraday
 *
 * Returns today's running SPX OHLC and 30-minute opening range,
 * computed from 5-minute intraday candles.
 *
 * Uses Schwab priceHistory: $SPX, period=1 day, 5-min candles.
 *
 * Cache:
 *   Market hours: 120s edge cache + 60s SWR
 *   A trading day until today's opening range is complete: the same
 *   After hours (and weekends, holidays): 600s edge cache + 120s SWR
 *
 * Response:
 * {
 *   today: { open, high, low, last },
 *   openingRange: { high, low, rangePts, minutes, complete },
 *   sessionDate: 'YYYY-MM-DD' | null,  // the session the range is from
 *   previousClose: number,
 *   candleCount: number,
 *   marketOpen: boolean,
 *   asOf: ISO string
 * }
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  schwabFetch,
  setCacheHeaders,
  isMarketOpen,
  guardOwnerOrGuestEndpoint,
} from './_lib/api-helpers.js';
import { getETTotalMinutes, getETDateStr } from '../src/utils/timezone.js';
import { CASH_OPEN_MIN_ET, isTradingDay } from '../src/data/marketHours.js';

// ============================================================
// TYPES
// ============================================================

interface SchwabCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number;
}

interface SchwabPriceHistory {
  symbol: string;
  empty: boolean;
  previousClose: number;
  previousCloseDate: number;
  candles: SchwabCandle[];
}

// ============================================================
// HELPERS
// ============================================================

/** 10:00 AM ET, in ET minutes after midnight: the 30-minute opening range ends here. */
const OPENING_RANGE_END_MIN_ET = 600;

/** 6 bars of 5 minutes make the 30-minute opening range. */
const OPENING_RANGE_BARS = 6;

/**
 * Compute the 30-minute opening range from one session's 5-min candles: the
 * bars that start before 10:00 AM ET (at most 6, 9:30–9:55).
 *
 * `complete` means the range can no longer change: all 6 bars exist and the
 * data shows the 9:55 bar has closed, because the session is a past one or a
 * bar starting at or after 10:00 is present. A clock check alone would trust a
 * 9:55 bar that Schwab may still be revising, and six bars alone can include
 * the 9:55 bar while it runs.
 */
function computeOpeningRange(
  candles: SchwabCandle[],
  sessionIsPast: boolean,
): {
  high: number;
  low: number;
  rangePts: number;
  minutes: number;
  complete: boolean;
} | null {
  if (candles.length === 0) return null;

  const orCandles = candles
    .filter(
      (c) => getETTotalMinutes(new Date(c.datetime)) < OPENING_RANGE_END_MIN_ET,
    )
    .slice(0, OPENING_RANGE_BARS);
  if (orCandles.length === 0) return null;

  const laterBarPresent = candles.some(
    (c) => getETTotalMinutes(new Date(c.datetime)) >= OPENING_RANGE_END_MIN_ET,
  );
  const complete =
    orCandles.length === OPENING_RANGE_BARS &&
    (sessionIsPast || laterBarPresent);

  let high = -Infinity;
  let low = Infinity;
  for (const c of orCandles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }

  return {
    high,
    low,
    rangePts: Math.round((high - low) * 100) / 100,
    minutes: orCandles.length * 5,
    complete,
  };
}

/**
 * Compute today's running OHLC from all candles.
 */
function computeTodayOHLC(candles: SchwabCandle[]): {
  open: number;
  high: number;
  low: number;
  last: number;
} | null {
  if (candles.length === 0) return null;

  const open = candles[0]!.open;
  const last = candles.at(-1)!.close;
  let high = -Infinity;
  let low = Infinity;

  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }

  return { open, high, low, last };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/intraday');
    const done = metrics.request('/api/intraday');
    try {
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      // Fetch recent candles and filter to the most recent trading session.
      // A 24h lookback fails on holidays/weekends because Schwab snaps
      // epoch timestamps to session boundaries and the snapped end can
      // precede the snapped start. 5 days covers any holiday combo.
      const now = new Date();

      const startMs = now.getTime() - 5 * 24 * 60 * 60 * 1000;
      const endMs = now.getTime();

      const params = new URLSearchParams({
        symbol: '$SPX',
        periodType: 'day',
        frequencyType: 'minute',
        frequency: '5',
        startDate: String(startMs),
        endDate: String(endMs),
        needExtendedHoursData: 'false',
        needPreviousClose: 'true',
      });

      const result = await schwabFetch<SchwabPriceHistory>(
        `/pricehistory?${params.toString()}`,
      );

      if (!result.ok) {
        done({ status: result.status, error: 'schwab' });
        return res.status(result.status).json({ error: result.error });
      }

      const { previousClose } = result.data;
      const marketOpen = isMarketOpen();

      // Find the most recent trading date in the results. On holidays
      // and weekends this will be the last trading day, not today.
      let latestETDate = '';
      for (const c of result.data.candles) {
        const etDate = getETDateStr(new Date(c.datetime));
        if (etDate > latestETDate) latestETDate = etDate;
      }

      // Filter to that session's regular-hours candles only.
      // $SPX candles can start before 9:30 AM (pre-market indicative values)
      // even with needExtendedHoursData=false. We need the 9:30 AM open to
      // match the actual regular session open shown on TradingView/brokers.
      const todayCandles = result.data.candles.filter((c) => {
        const d = new Date(c.datetime);
        const etDate = getETDateStr(d);
        if (etDate !== latestETDate) return false;

        // Only keep candles from 9:30 AM onward
        return getETTotalMinutes(d) >= CASH_OPEN_MIN_ET;
      });

      // The session the range is from: today's date, or on a weekend or
      // holiday (or before today's first bar) the last session's. No candles
      // at all gives null. Before the open, Schwab's indicative bars make the
      // latest date today with no regular bar, so the range is null then.
      const sessionDate = latestETDate === '' ? null : latestETDate;
      const todayET = getETDateStr(now);

      const today = computeTodayOHLC(todayCandles);
      const openingRange = computeOpeningRange(
        todayCandles,
        sessionDate != null && sessionDate < todayET,
      );

      // Cache: 2 min during hours (the day's OHLC moves; the opening range
      // doesn't change after 10 AM), 10 min after close (data is final). A
      // trading day also takes the short cache until today's own opening
      // range is complete, so a body from before the open or from the
      // previous session is not served past the first bars. A weekend or
      // holiday has nothing newer to wait for.
      const todayIsFinal = sessionDate === todayET && openingRange?.complete;
      const shortCache = marketOpen || (isTradingDay(todayET) && !todayIsFinal);
      setCacheHeaders(res, shortCache ? 120 : 600, shortCache ? 60 : 120);

      done({ status: 200 });
      res.status(200).json({
        today,
        openingRange,
        sessionDate,
        previousClose,
        candleCount: todayCandles.length,
        marketOpen,
        asOf: new Date().toISOString(),
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
