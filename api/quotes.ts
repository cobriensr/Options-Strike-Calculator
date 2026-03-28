/**
 * GET /api/quotes
 *
 * Returns real-time quotes for SPY, $SPX, $VIX, $VIX1D, $VIX9D, $VVIX.
 *
 * Cache:
 *   Market hours: 60s edge cache + 30s SWR
 *   After hours:  300s edge cache + 60s SWR
 *
 * Response:
 * {
 *   spy:    { price, open, high, low, prevClose, change, changePct },
 *   spx:    { price, open, high, low, prevClose, change, changePct },
 *   vix:    { price, open, high, low, prevClose, change, changePct },
 *   vix1d:  { price, open, high, low, prevClose, change, changePct },
 *   vix9d:  { price, open, high, low, prevClose, change, changePct },
 *   marketOpen: boolean,
 *   asOf:   ISO string
 * }
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  schwabFetch,
  setCacheHeaders,
  isMarketOpen,
  rejectIfNotOwner,
  checkBot,
} from './_lib/api-helpers.js';

// ============================================================
// TYPES
// ============================================================

interface SchwabQuote {
  quote: {
    lastPrice: number;
    openPrice: number;
    highPrice: number;
    lowPrice: number;
    closePrice: number;
    netChange: number;
    netPercentChange: number;
    tradeTime: number;
  };
}

type SchwabQuotesResponse = Record<string, SchwabQuote>;

interface QuoteSlice {
  price: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
  changePct: number;
}

// ============================================================
// HELPERS
// ============================================================

const SYMBOLS = 'SPY,$SPX,$VIX,$VIX1D,$VIX9D,$VVIX';

function toSlice(q: SchwabQuote): QuoteSlice {
  return {
    price: q.quote.lastPrice,
    open: q.quote.openPrice,
    high: q.quote.highPrice,
    low: q.quote.lowPrice,
    prevClose: q.quote.closePrice,
    change: q.quote.netChange,
    changePct: q.quote.netPercentChange,
  };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/quotes');
    const done = metrics.request('/api/quotes');
    try {
      // Owner-only: public visitors get 401, frontend falls back to manual input
      if (rejectIfNotOwner(req, res)) return done({ status: 401 });

      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        done({ status: 403 });
        return res.status(403).json({ error: 'Access denied' });
      }
      const result = await schwabFetch<SchwabQuotesResponse>(
        `/quotes?symbols=${encodeURIComponent(SYMBOLS)}&fields=quote`,
      );

      if (!result.ok) {
        done({ status: result.status, error: 'schwab' });
        return res.status(result.status).json({ error: result.error });
      }

      const data = result.data;
      const marketOpen = isMarketOpen();

      // Set cache: 60s during market hours, 5 min after close
      setCacheHeaders(res, marketOpen ? 60 : 300, marketOpen ? 30 : 60);

      const response: Record<string, unknown> = {
        marketOpen,
        asOf: new Date().toISOString(),
      };

      // Map each symbol, handling possible missing data gracefully
      const mapping: [string, string][] = [
        ['spy', 'SPY'],
        ['spx', '$SPX'],
        ['vix', '$VIX'],
        ['vix1d', '$VIX1D'],
        ['vix9d', '$VIX9D'],
        ['vvix', '$VVIX'],
      ];

      for (const [key, symbol] of mapping) {
        const q = data[symbol];
        if (q?.quote) {
          response[key] = toSlice(q);
        } else {
          response[key] = null;
        }
      }

      done({ status: 200 });
      res.status(200).json(response);
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
