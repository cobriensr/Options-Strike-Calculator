/**
 * GET /api/futures/snapshot
 *
 * Returns a futures snapshot for the frontend Futures Panel.
 *
 * Default mode (no `at`): reads from `futures_snapshots` (populated
 *   every 5 min by the fetch-futures-snapshot cron) and returns the
 *   latest row for today.
 *
 * Historical mode (`?at=<ISO>`): derives a snapshot on the fly from
 *   the 1-minute `futures_bars` table, using the same `computeSnapshot`
 *   logic as the cron but with the caller-supplied moment. Nearest-bar
 *   snapping: the latest bar is the most recent bar with `ts <= at`.
 *
 * Cross-symbol derived metrics (VX term spread, ES-SPX basis) are
 * computed from whichever snapshot set is returned. In historical mode,
 * the SPX reference is pulled from `market_snapshots` on the picked
 * trade date; if none exists, `esSpxBasis = null`.
 *
 * Owner-or-guest: Yes (matches ML Insights pattern).
 * Cache: private, s-maxage=60 (data updates every 5 min).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import { rejectIfNotOwnerOrGuest, checkBot } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import {
  FUTURES_SYMBOLS,
  computeSnapshot,
  type SnapshotRow,
} from '../_lib/futures-derive.js';

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
  oldestTs: string | null;
  requestedAt: string | null;
}

// ── Query validation ────────────────────────────────────────

/**
 * Small tolerance for future-`at` values to accommodate client clock
 * skew without allowing the user to "see the future". Any actual bar
 * with `ts > Date.now()` can't exist anyway — this just prevents a
 * picker that's a few seconds ahead of the server from 400ing.
 */
const FUTURE_AT_TOLERANCE_MS = 60_000;

const querySchema = z.object({
  // UTC-only. The frontend picker is <input type="datetime-local"> (no
  // offset); we expect it to round-trip through new Date(...).toISOString()
  // before hitting the endpoint, producing a `Z`-suffixed value. Accepting
  // arbitrary offsets would create two representations of the same moment
  // and muddy the nearest-bar semantics.
  at: z
    .string()
    .datetime()
    .refine(
      (v) => new Date(v).getTime() <= Date.now() + FUTURE_AT_TOLERANCE_MS,
      'at must not be in the future',
    )
    .optional(),
});

// ── Helpers ─────────────────────────────────────────────────

function classifyTermStructure(
  spread: number,
): 'CONTANGO' | 'FLAT' | 'BACKWARDATION' {
  if (spread > 0.25) return 'BACKWARDATION';
  if (spread < -0.25) return 'CONTANGO';
  return 'FLAT';
}

function round2(v: number | null): number | null {
  return v != null ? Number.parseFloat(v.toFixed(2)) : null;
}

/**
 * Fetch `MIN(ts)` from futures_bars. Used to populate the picker's
 * minimum allowed datetime. Returns `null` if the table is empty.
 */
async function fetchOldestTs(): Promise<string | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT MIN(ts) AS oldest FROM futures_bars
  `;
  const oldest = rows[0]?.oldest;
  if (!oldest) return null;
  return new Date(String(oldest)).toISOString();
}

/**
 * Look up today's / picked-day SPX price for ES-SPX basis.
 * Returns null when no row matches.
 */
async function fetchSpxForDate(tradeDate: string): Promise<number | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT spx FROM market_snapshots
    WHERE date = ${tradeDate} AND spx IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `;
  if (rows.length === 0 || !rows[0]?.spx) return null;
  return Number.parseFloat(String(rows[0].spx));
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
  if (rejectIfNotOwnerOrGuest(req, res)) return;

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({
      error: 'Invalid query',
      details: parsed.error.flatten(),
    });
  }

  try {
    if (parsed.data.at) {
      return await handleHistorical(parsed.data.at, res);
    }
    return await handleLatest(res);
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'futures snapshot fetch error');
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ── Latest (default) path ───────────────────────────────────

async function handleLatest(res: VercelResponse) {
  const sql = getDb();
  const tradeDate = getETDateStr(new Date());

  // Get all symbols at the latest snapshot timestamp for today
  // Uses inline MAX to avoid JS Date round-trip precision loss
  const rows = await sql`
    SELECT symbol, price, change_1h_pct, change_day_pct, volume_ratio, ts
    FROM futures_snapshots
    WHERE trade_date = ${tradeDate}
      AND ts = (
        SELECT MAX(ts) FROM futures_snapshots
        WHERE trade_date = ${tradeDate}
      )
    ORDER BY symbol
  `;

  const oldestTs = await fetchOldestTs();

  if (rows.length === 0) {
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
      oldestTs,
      requestedAt: null,
    } satisfies FuturesSnapshotResponse);
  }

  const latestTs = rows[0]!.ts
    ? new Date(String(rows[0]!.ts)).toISOString()
    : null;

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
      r.volume_ratio != null ? Number.parseFloat(String(r.volume_ratio)) : null,
  }));

  const { vxTermSpread, vxTermStructure } = deriveVxTermStructure(snapshots);
  const esSpxBasis = await deriveEsSpxBasis(snapshots, tradeDate);

  const response: FuturesSnapshotResponse = {
    snapshots,
    vxTermSpread: round2(vxTermSpread),
    vxTermStructure,
    esSpxBasis: round2(esSpxBasis),
    updatedAt: latestTs,
    oldestTs,
    requestedAt: null,
  };

  res.setHeader(
    'Cache-Control',
    'private, s-maxage=60, stale-while-revalidate=30',
  );
  return res.status(200).json(response);
}

// ── Historical path ─────────────────────────────────────────

async function handleHistorical(atIso: string, res: VercelResponse) {
  const pickedDate = new Date(atIso);
  const tradeDate = getETDateStr(pickedDate);

  // Derive each symbol's snapshot in parallel. We use Promise.allSettled
  // so a single failing symbol doesn't take down the whole response —
  // same pattern the cron uses.
  const results = await Promise.allSettled(
    FUTURES_SYMBOLS.map((sym) => computeSnapshot(sym, tradeDate, pickedDate)),
  );

  const derived: SnapshotRow[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      derived.push(result.value);
    } else if (result.status === 'rejected') {
      logger.warn(
        { err: result.reason },
        'historical computeSnapshot failed for one symbol',
      );
    }
  }

  const oldestTs = await fetchOldestTs();

  if (derived.length === 0) {
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
      oldestTs,
      requestedAt: atIso,
    } satisfies FuturesSnapshotResponse);
  }

  const snapshots: FuturesSnapshotItem[] = derived.map((d) => ({
    symbol: d.symbol,
    price: d.price,
    change1hPct: d.change1hPct,
    changeDayPct: d.changeDayPct,
    volumeRatio: d.volumeRatio,
  }));

  // updatedAt = the newest actual bar ts across derived symbols
  let updatedAt: string | null = null;
  for (const d of derived) {
    if (d.latestTs && (!updatedAt || d.latestTs > updatedAt)) {
      updatedAt = d.latestTs;
    }
  }

  const { vxTermSpread, vxTermStructure } = deriveVxTermStructure(snapshots);
  const esSpxBasis = await deriveEsSpxBasis(snapshots, tradeDate);

  const response: FuturesSnapshotResponse = {
    snapshots,
    vxTermSpread: round2(vxTermSpread),
    vxTermStructure,
    esSpxBasis: round2(esSpxBasis),
    updatedAt,
    oldestTs,
    requestedAt: atIso,
  };

  res.setHeader(
    'Cache-Control',
    'private, s-maxage=60, stale-while-revalidate=30',
  );
  return res.status(200).json(response);
}

// ── Cross-symbol derivations ────────────────────────────────

function deriveVxTermStructure(snapshots: FuturesSnapshotItem[]): {
  vxTermSpread: number | null;
  vxTermStructure: 'CONTANGO' | 'FLAT' | 'BACKWARDATION' | null;
} {
  const vx1 = snapshots.find((s) => s.symbol === 'VX1');
  const vx2 = snapshots.find((s) => s.symbol === 'VX2');
  if (!vx1 || !vx2) {
    return { vxTermSpread: null, vxTermStructure: null };
  }
  const spread = vx1.price - vx2.price;
  return {
    vxTermSpread: spread,
    vxTermStructure: classifyTermStructure(spread),
  };
}

async function deriveEsSpxBasis(
  snapshots: FuturesSnapshotItem[],
  tradeDate: string,
): Promise<number | null> {
  const es = snapshots.find((s) => s.symbol === 'ES');
  if (!es) return null;
  const spx = await fetchSpxForDate(tradeDate);
  if (spx == null) return null;
  return es.price - spx;
}
