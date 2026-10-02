/**
 * GET /api/futures/snapshot
 *
 * Returns a futures snapshot for the frontend Futures Panel.
 *
 * Default mode (no `at`): reads from `futures_snapshots` (populated
 *   every 5 min by the fetch-futures-snapshot cron) and returns the
 *   rows at today's latest cron timestamp. The cron writes a row only
 *   for symbols with a fresh bar, so a symbol that was stale on that run
 *   (e.g. a quiet CL/ZN) is absent rather than shown at an old price.
 *
 * Historical mode (`?at=<ISO>`): derives a snapshot on the fly from
 *   the 1-minute `futures_bars` table, using the same `computeSnapshot`
 *   logic as the cron but with the caller-supplied moment. Nearest-bar
 *   snapping: the latest bar is the most recent bar with `ts <= at`,
 *   and a symbol whose latest bar is more than MAX_BAR_AGE_MS (15 min)
 *   before `at` is omitted — so a pick inside a weekend / maintenance
 *   closure or a feed outage returns no snapshot for that symbol.
 *
 * ES-SPX basis is computed from whichever snapshot set is returned. In
 * historical mode, the SPX reference is pulled from `market_snapshots`
 * on the picked trade date; if none exists, `esSpxBasis = null`.
 *
 * `vixTermStructure` (spot VIX / VIX3M ratio + UW's VIX-futures label,
 * see vix-term-structure.ts) is live-only: neither source has history,
 * so it is null in historical mode. It replaces the VX1/VX2 spread,
 * which never had a data source.
 *
 * Owner-or-guest: Yes (matches ML Insights pattern).
 * Cache: private, s-maxage=60 (data updates every 5 min).
 */

import type { VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { withRequestScope } from '../_lib/request-scope.js';
import { sendDbErrorResponse } from '../_lib/transient-db-response.js';
import logger from '../_lib/logger.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import {
  FUTURES_SYMBOLS,
  computeSnapshot,
  type SnapshotRow,
} from '../_lib/futures-derive.js';
import {
  fetchVixTermStructure,
  type VixTermStructure,
} from '../_lib/vix-term-structure.js';

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
  /** Null in historical mode (no history for either source). */
  vixTermStructure: VixTermStructure | null;
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

function round2(v: number | null): number | null {
  return v != null ? Number.parseFloat(v.toFixed(2)) : null;
}

/**
 * Fetch `MIN(ts)` from futures_bars. Used to populate the picker's
 * minimum allowed datetime. Returns `null` if the table is empty.
 */
async function fetchOldestTs(): Promise<string | null> {
  const sql = getDb();
  const rows = await withDbRetry(
    () => sql`SELECT MIN(ts) AS oldest FROM futures_bars`,
    2,
    10_000,
  );
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
  const rows = await withDbRetry(
    () => sql`
      SELECT spx FROM market_snapshots
      WHERE date = ${tradeDate} AND spx IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `,
    2,
    10_000,
  );
  if (rows.length === 0 || !rows[0]?.spx) return null;
  return Number.parseFloat(String(rows[0].spx));
}

// ── Handler ─────────────────────────────────────────────────

export default withRequestScope(
  'GET',
  '/api/futures/snapshot',
  async (req, res, done) => {
    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      done({ status: 400 });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({
        error: 'Invalid query',
        details: parsed.error.flatten(),
      });
    }

    try {
      if (parsed.data.at) {
        const result = await handleHistorical(parsed.data.at, res);
        done({ status: 200 });
        return result;
      }
      const result = await handleLatest(res);
      done({ status: 200 });
      return result;
    } catch (err) {
      sendDbErrorResponse(res, err, {
        label: 'futures_snapshot',
        serverErrorBody: { error: 'Internal error' },
        done,
      });
      return;
    }
  },
);

// ── Latest (default) path ───────────────────────────────────

async function handleLatest(res: VercelResponse) {
  const sql = getDb();
  const tradeDate = getETDateStr(new Date());

  // Runs alongside the DB reads. Never rejects, so if a DB read throws
  // first this promise is simply dropped.
  const vixTermPromise = fetchVixTermStructure();

  // Get all symbols at the latest snapshot timestamp for today
  // Uses inline MAX to avoid JS Date round-trip precision loss
  const rows = await withDbRetry(
    () => sql`
      SELECT symbol, price, change_1h_pct, change_day_pct, volume_ratio, ts
      FROM futures_snapshots
      WHERE trade_date = ${tradeDate}
        AND ts = (
          SELECT MAX(ts) FROM futures_snapshots
          WHERE trade_date = ${tradeDate}
        )
      ORDER BY symbol
    `,
    2,
    10_000,
  );

  const oldestTs = await fetchOldestTs();

  if (rows.length === 0) {
    // VIX term structure doesn't depend on futures bars — still return it.
    const vixTermStructure = await vixTermPromise;
    res.setHeader(
      'Cache-Control',
      'private, s-maxage=60, stale-while-revalidate=30',
    );
    return res.status(200).json({
      snapshots: [],
      vixTermStructure,
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

  const esSpxBasis = await deriveEsSpxBasis(snapshots, tradeDate);
  const vixTermStructure = await vixTermPromise;

  const response: FuturesSnapshotResponse = {
    snapshots,
    vixTermStructure,
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
  let anyRejected = false;
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn(
        { err: result.reason },
        'historical computeSnapshot failed for one symbol',
      );
      Sentry.captureException(result.reason);
      anyRejected = true;
    } else if (result.value.kind === 'fresh') {
      // `stale` / `missing` symbols are omitted — no price at `at`.
      derived.push(result.value.snapshot);
    }
  }

  const oldestTs = await fetchOldestTs();

  if (derived.length === 0) {
    if (anyRejected) {
      Sentry.captureMessage('futures snapshot: all symbols failed', {
        level: 'error',
      });
    }
    res.setHeader(
      'Cache-Control',
      'private, s-maxage=60, stale-while-revalidate=30',
    );
    return res.status(200).json({
      snapshots: [],
      vixTermStructure: null,
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
    if (!updatedAt || d.latestTs > updatedAt) {
      updatedAt = d.latestTs;
    }
  }

  const esSpxBasis = await deriveEsSpxBasis(snapshots, tradeDate);

  const response: FuturesSnapshotResponse = {
    snapshots,
    vixTermStructure: null,
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
