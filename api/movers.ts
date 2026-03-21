/**
 * GET /api/movers
 *
 * Returns the top 10 SPX movers (up and down) from Schwab's Market Data API.
 * Shows which index components are driving the move — helps assess whether
 * SPX movement is broad-based or concentrated in a few mega-caps.
 *
 * Owner-gated (uses Schwab credentials).
 *
 * Cache:
 *   Market hours: 120s edge cache + 60s SWR
 *   After hours:  600s edge cache + 120s SWR
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

interface SchwabMover {
  change: number;
  description: string;
  direction: string; // 'up' or 'down'
  last: number;
  symbol: string;
  totalVolume: number;
}

interface SchwabMoversResponse {
  screeners: SchwabMover[];
}

interface MoverSlice {
  symbol: string;
  name: string;
  change: number; // percent change
  price: number;
  volume: number;
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/movers');
    const done = metrics.request('/api/movers');
    try {
      if (rejectIfNotOwner(req, res)) {
        done({ status: 401 });
        return;
      }

      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        done({ status: 403 });
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // Fetch both up and down movers in parallel
      const [upResult, downResult] = await Promise.all([
        schwabFetch<SchwabMoversResponse>(
          '/movers/$SPX?sort=percent_change_up&frequency=0',
        ),
        schwabFetch<SchwabMoversResponse>(
          '/movers/$SPX?sort=percent_change_down&frequency=0',
        ),
      ]);

      const marketOpen = isMarketOpen();
      setCacheHeaders(res, marketOpen ? 120 : 600, marketOpen ? 60 : 120);

      function mapMovers(data: SchwabMoversResponse): MoverSlice[] {
        return (data.screeners || []).slice(0, 10).map((m) => ({
          symbol: m.symbol,
          name: m.description,
          change: m.change,
          price: m.last,
          volume: m.totalVolume,
        }));
      }

      const up = 'data' in upResult ? mapMovers(upResult.data) : [];
      const down = 'data' in downResult ? mapMovers(downResult.data) : [];

      // Concentration analysis: what % of the top 10 movers are mega-caps?
      const megaCaps = new Set([
        'AAPL',
        'MSFT',
        'NVDA',
        'AMZN',
        'GOOG',
        'GOOGL',
        'META',
        'TSLA',
        'BRK.B',
        'AVGO',
      ]);
      const allMovers = [...up, ...down];
      const megaCapMovers = allMovers.filter((m) => megaCaps.has(m.symbol));
      const concentrated = megaCapMovers.length >= 3;

      // Directional bias: are the biggest movers skewed one way?
      const topUpChange = up[0]?.change ?? 0;
      const topDownChange = Math.abs(down[0]?.change ?? 0);
      const bias =
        topUpChange > topDownChange * 1.5
          ? 'bullish'
          : topDownChange > topUpChange * 1.5
            ? 'bearish'
            : 'mixed';

      done({ status: 200 });
      res.status(200).json({
        up,
        down,
        analysis: {
          concentrated,
          megaCapCount: megaCapMovers.length,
          megaCapSymbols: megaCapMovers.map((m) => m.symbol),
          bias,
          topUp: up[0] ?? null,
          topDown: down[0] ?? null,
        },
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
