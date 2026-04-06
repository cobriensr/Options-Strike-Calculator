/**
 * GET /api/futures/snapshot
 *
 * Returns the latest futures snapshot data for the frontend Futures
 * Panel. Reads from futures_snapshots (populated every 5 min by the
 * fetch-futures-snapshot cron) and computes cross-symbol derived
 * metrics (VX term spread, ES-SPX basis).
 *
 * Owner-gated: Yes (matches ML Insights pattern).
 * Cache: private, s-maxage=60 (data updates every 5 min).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import { rejectIfNotOwner, checkBot } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';
import { getETDateStr } from '../../src/utils/timezone.js';

// ── Types ───────────────────────────────────────────────────

interface FuturesSnapshotItem {
  symbol: string;
  price: number;
  change1hPct: number | null;
  changeDayPct: number | null;
  volumeRatio: number | null;
}

interface FuturesSnapshotResponse {
  snapshots: FuturesSnapshotItem[];
  vxTermSpread: number | null;
  vxTermStructure: 'CONTANGO' | 'FLAT' | 'BACKWARDATION' | null;
  esSpxBasis: number | null;
  updatedAt: string | null;
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const botCheck = await checkBot(req);
  if (botCheck.isBot) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (rejectIfNotOwner(req, res)) return;

  const sql = getDb();

  try {
    const tradeDate = getETDateStr(new Date());

    // Get the latest snapshot timestamp for today
    const latestTsRows = await sql`
      SELECT MAX(ts) AS latest_ts
      FROM futures_snapshots
      WHERE trade_date = ${tradeDate}
    `;

    const latestTs = latestTsRows[0]?.latest_ts
      ? new Date(String(latestTsRows[0].latest_ts)).toISOString()
      : null;

    if (!latestTs) {
      res.setHeader(
        'Cache-Control',
        'private, s-maxage=60, stale-while-revalidate=30',
      );
      return res.status(200).json({
        snapshots: [],
        vxTermSpread: null,
        vxTermStructure: null,
        esSpxBasis: null,
        updatedAt: null,
      } satisfies FuturesSnapshotResponse);
    }

    // Get all symbols at the latest timestamp
    const rows = await sql`
      SELECT symbol, price, change_1h_pct, change_day_pct, volume_ratio
      FROM futures_snapshots
      WHERE ts = ${latestTs}
      ORDER BY symbol
    `;

    const snapshots: FuturesSnapshotItem[] = rows.map((r) => ({
      symbol: String(r.symbol),
      price: Number.parseFloat(String(r.price)),
      change1hPct:
        r.change_1h_pct != null
          ? Number.parseFloat(String(r.change_1h_pct))
          : null,
      changeDayPct:
        r.change_day_pct != null
          ? Number.parseFloat(String(r.change_day_pct))
          : null,
      volumeRatio:
        r.volume_ratio != null
          ? Number.parseFloat(String(r.volume_ratio))
          : null,
    }));

    // Compute cross-symbol metrics
    const vxm1 = snapshots.find((s) => s.symbol === 'VXM1');
    const vxm2 = snapshots.find((s) => s.symbol === 'VXM2');
    let vxTermSpread: number | null = null;
    let vxTermStructure: 'CONTANGO' | 'FLAT' | 'BACKWARDATION' | null = null;

    if (vxm1 && vxm2) {
      vxTermSpread = vxm1.price - vxm2.price;
      if (vxTermSpread > 0.25) {
        vxTermStructure = 'BACKWARDATION';
      } else if (vxTermSpread < -0.25) {
        vxTermStructure = 'CONTANGO';
      } else {
        vxTermStructure = 'FLAT';
      }
    }

    // ES-SPX basis: read today's SPX from market_snapshots
    const es = snapshots.find((s) => s.symbol === 'ES');
    let esSpxBasis: number | null = null;

    if (es) {
      const spxRows = await sql`
        SELECT spx FROM market_snapshots
        WHERE date = ${tradeDate} AND spx IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `;
      if (spxRows.length > 0 && spxRows[0]?.spx) {
        const spx = Number.parseFloat(String(spxRows[0].spx));
        esSpxBasis = es.price - spx;
      }
    }

    const response: FuturesSnapshotResponse = {
      snapshots,
      vxTermSpread:
        vxTermSpread != null
          ? Number.parseFloat(vxTermSpread.toFixed(2))
          : null,
      vxTermStructure,
      esSpxBasis:
        esSpxBasis != null ? Number.parseFloat(esSpxBasis.toFixed(2)) : null,
      updatedAt: latestTs,
    };

    res.setHeader(
      'Cache-Control',
      'private, s-maxage=60, stale-while-revalidate=30',
    );
    return res.status(200).json(response);
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'futures snapshot fetch error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
