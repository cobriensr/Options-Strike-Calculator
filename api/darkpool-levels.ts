/**
 * GET /api/darkpool-levels
 *
 * Returns dark pool aggregated levels sorted by total premium for the
 * requested symbol selector. The frontend polls this every 60 seconds
 * — no Claude involved.
 *
 * Query params:
 *   ?date=YYYY-MM-DD       — return levels for a specific date (default: today in ET)
 *   ?symbol=SPX|NDX|SPY|QQQ — selector (default: SPX for backward compat)
 *   ?time=HH:MM            — optional CT wall-clock cutoff
 *
 * Backed by the shared `dark-pool-query.ts` helper which queries the
 * raw `dark_pool_prints` table (written by the uw-stream daemon's
 * off_lit_trades handler) and synthesizes index-mapped levels at read
 * time via the contemporaneous candle ratio in `index_candles_1m`.
 * SPX falls back to the legacy `dark_pool_levels` cron-fed table for
 * dates the daemon hasn't backfilled yet — the fallback is removed in
 * Phase 7 cutover.
 *
 * Backward-compat field aliases (will be removed once frontend
 * migrates to the new shape): each level row exposes `spxLevel` AND
 * `level`. The two are identical for SPX (the legacy frontend reads
 * `spxLevel`); for NDX/SPY/QQQ selectors `spxLevel` is the
 * symbol-native value too, so consumers reading `spxLevel` get the
 * right number regardless of selector.
 *
 * Owner-or-guest — dark pool data derives from UW API (OPRA compliance).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from './_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from './_lib/api-helpers.js';
import {
  getDarkPoolLevels,
  type DarkPoolSymbol,
} from './_lib/dark-pool-query.js';
import logger from './_lib/logger.js';
import { getETDateStr } from '../src/utils/timezone.js';

const VALID_SYMBOLS: ReadonlySet<DarkPoolSymbol> = new Set([
  'SPX',
  'NDX',
  'SPY',
  'QQQ',
]);

function parseSymbol(raw: string | undefined): DarkPoolSymbol {
  if (raw && VALID_SYMBOLS.has(raw as DarkPoolSymbol)) {
    return raw as DarkPoolSymbol;
  }
  return 'SPX';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/darkpool-levels');
    const done = metrics.request('/api/darkpool-levels');

    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        return res.status(405).json({ error: 'GET only' });
      }

      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const dateParam = req.query.date as string | undefined;
      const date =
        dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
          ? dateParam
          : getETDateStr(new Date());

      const symbol = parseSymbol(req.query.symbol as string | undefined);

      const timeParam = req.query.time as string | undefined;
      const asOfTimeCT =
        timeParam && /^\d{2}:\d{2}$/.test(timeParam) ? timeParam : undefined;

      const result = await getDarkPoolLevels({ date, symbol, asOfTimeCT });

      // Expose the new `level` field always; ALSO emit the legacy
      // `spxLevel` alias only when the selector is SPX. For NDX/SPY/QQQ
      // selectors `spxLevel` would be a misleading label (the value is
      // actually the NDX/SPY/QQQ level), so the alias is omitted to
      // force frontend code that conflates the two to fail loudly
      // rather than silently mis-render. Removed in Phase 7 once the
      // frontend migrates to `level`.
      const levels = result.levels.map((l) => ({
        level: l.level,
        ...(symbol === 'SPX' ? { spxLevel: l.level } : {}),
        totalPremium: l.totalPremium,
        tradeCount: l.tradeCount,
        totalShares: l.totalShares,
        latestTime: l.latestTime,
        updatedAt: l.updatedAt,
      }));

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({
        levels,
        date,
        symbol,
        meta: {
          lastUpdated: result.lastUpdated,
        },
      });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'darkpool-levels fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
