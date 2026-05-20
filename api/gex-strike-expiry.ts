/**
 * GET /api/gex-strike-expiry
 *
 * Owner-or-guest read endpoint backing the Strike Battle Map panel
 * (Phase 1 of docs/superpowers/specs/strike-battle-map-2026-05-03.md).
 *
 * Reads from `ws_gex_strike_expiry` (populated by the uw-stream daemon's
 * `gex_strike_expiry:<TICKER>` WS handler). Returns the latest GEX row
 * per strike for a (ticker, expiry), optionally snapshotted to a
 * specific timestamp via `at` for the historical scrubber.
 *
 * Owner-or-guest tier because the data derives from UW (OPRA-licensed
 * options flow) — same access category as /api/zero-gamma and
 * /api/greek-flow.
 *
 * Query params:
 *   ?ticker=SPY|QQQ|SPX|NDX — required
 *   ?expiry=YYYY-MM-DD      — required (typically today's 0DTE)
 *   ?at=<ISO timestamp>     — optional; latest row per strike at-or-before
 *                             this timestamp. Omit for live latest.
 *
 * Response:
 *   {
 *     ticker: string,
 *     expiry: string,
 *     at: string | null,
 *     rows: GexStrikeExpiryRowWithDeltas[],  // includes 1m/5m/10m/15m/30m Δ%
 *     timestamps: string[],                  // every ts_minute for the day
 *     asOf: string
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  isMarketOpen,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { gexStrikeExpiryQuerySchema } from './_lib/validation.js';
import {
  getLatestGexPerStrikeWithDeltas,
  getTimestampsForDay,
  type GexStrikeExpiryRowWithDeltas,
  type GexStrikeExpiryTicker,
} from './_lib/db-gex-strike-expiry.js';

export interface GexStrikeExpiryResponse {
  ticker: GexStrikeExpiryTicker;
  expiry: string;
  at: string | null;
  rows: GexStrikeExpiryRowWithDeltas[];
  /**
   * Every distinct `ts_minute` value for (ticker, expiry), ascending.
   * Powers the scrub control's prev/next navigation — same role
   * `timestamps[]` plays in /api/gex-per-strike's response.
   */
  timestamps: string[];
  asOf: string;
}

/**
 * Per-function-instance response cache with single-flight de-dup.
 *
 * The endpoint is polled ~30s by the GexLandscape (SPX) + the
 * StrikeBattleMap (4 tickers). When Neon's serverless HTTP path has
 * cold-connection hangs (p50 = 169s observed 2026-05-13), every poll
 * stacks on top of the same slow upstream call.
 *
 * Two-layer mitigation:
 *
 *   1. TTL cache. Live keys (no `at` arg) cache for LIVE_TTL_MS; the
 *      uw-stream daemon UPSERTs ws_gex_strike_expiry every minute, so
 *      ~15s of staleness is invisible. Snapshot keys (`at` present)
 *      cache for SNAPSHOT_TTL_MS — the past doesn't change.
 *   2. In-flight promise sharing. Concurrent requests for the same key
 *      share the SQL call instead of fanning out N→Neon. The first
 *      caller pays the cost; subsequent callers await the same promise.
 *
 * Fluid Compute reuses function instances across concurrent invocations,
 * so a per-instance Map gets ~80-95% hit rate during market hours. The
 * stale-on-error fallback path serves the prior payload when the
 * upstream call throws — preferable to a 500 for a panel that polls.
 */
const LIVE_TTL_MS = 15_000;
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
  expiresAt: number;
  body: GexStrikeExpiryResponse;
}
const responseCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GexStrikeExpiryResponse>>();

// Periodic eviction of expired entries. Fluid Compute reuses instances
// for many minutes; without eviction, 30s polling × 4 tickers × 24h
// accumulates ~12k stale entries per instance lifetime. Walks the map
// on every write — bounded O(n) where n is the live working set
// (typically <50 in production). Audit 2026-05-19.
function evictExpiredCacheEntries(): void {
  const now = Date.now();
  for (const [k, v] of responseCache) {
    if (v.expiresAt <= now) responseCache.delete(k);
  }
}

function cacheKey(
  ticker: string,
  expiry: string,
  at: string | null | undefined,
): string {
  return `${ticker}|${expiry}|${at ?? 'live'}`;
}

/** Exported for tests so cache state doesn't leak across cases. */
export function _resetCacheForTests(): void {
  responseCache.clear();
  inFlight.clear();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/gex-strike-expiry');
    const done = metrics.request('/api/gex-strike-expiry');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const parsed = gexStrikeExpiryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 400 });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    const { ticker, expiry, at } = parsed.data;
    const key = cacheKey(ticker, expiry, at);
    const now = Date.now();

    // 1. Fresh cache hit → instant return. Skips both the DB and any
    //    in-flight wait.
    const cached = responseCache.get(key);
    if (cached && cached.expiresAt > now) {
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      done({ status: 200 });
      return res.status(200).json(cached.body);
    }

    // 2. In-flight de-dup. If another concurrent request is already
    //    fetching this key, await its promise instead of firing a
    //    duplicate SQL call. Critical under polling fan-out.
    let inProgress = inFlight.get(key);
    if (inProgress == null) {
      const ttlMs = at ? SNAPSHOT_TTL_MS : LIVE_TTL_MS;
      inProgress = (async () => {
        // Run both queries in parallel so the scrub-timestamp helper
        // doesn't bolt extra latency onto the panel's primary fetch.
        const [rows, timestamps] = await Promise.all([
          getLatestGexPerStrikeWithDeltas({
            ticker,
            expiry,
            at: at ?? null,
          }),
          getTimestampsForDay(ticker, expiry, at ?? null),
        ]);
        const body: GexStrikeExpiryResponse = {
          ticker,
          expiry,
          at: at ?? null,
          rows,
          timestamps,
          asOf: new Date().toISOString(),
        };
        evictExpiredCacheEntries();
        responseCache.set(key, { body, expiresAt: Date.now() + ttlMs });
        return body;
      })();
      inFlight.set(key, inProgress);
      // Clear from in-flight regardless of outcome so a transient
      // upstream failure doesn't permanently stick a rejected promise.
      // The trailing .catch swallows the rejection on this cleanup
      // path so Node doesn't flag it as unhandled — the actual catch
      // happens at the `await inProgress` below.
      inProgress.finally(() => inFlight.delete(key)).catch(() => {});
    }

    try {
      const body = await inProgress;
      // Match the live Greek-flow panel cadence: short cache during
      // market hours so the daemon's UPSERTs surface quickly, longer
      // off-hours since values are settled. Vary on Cookie so the
      // owner / guest / anon caches don't collide.
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      done({ status: 200 });
      return res.status(200).json(body);
    } catch (err) {
      // Stale-on-error: if we have ANY prior payload (even past its
      // TTL), serve it rather than failing the panel. The user's
      // poll-driven UI prefers stale-but-rendered to a red banner.
      if (cached) {
        setCacheHeaders(res, 5, 30);
        res.setHeader('X-Cache-Stale', '1');
        done({ status: 200 });
        return res.status(200).json(cached.body);
      }
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error(
        { err, ticker, expiry, at },
        'gex-strike-expiry fetch error',
      );
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
