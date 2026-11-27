/**
 * GET /api/gexbot
 *
 * Owner-or-guest read endpoint dispatching to multiple GEXBot views.
 * Single endpoint with `?view=` query param keeps the auth surface
 * narrow (one botid entry) and lets the frontend hook fan out without
 * needing a fetch-per-view.
 *
 * Views:
 *   ?view=snapshots-latest     → latest snapshot row per ticker
 *   ?view=velocity             → minute-over-minute change per ticker
 *                                (Δagg_dex, Δzgr, Δzcvr via LAG)
 *   ?view=convexity-trend      → 60-min zcvr timeseries per ticker
 *   ?view=maxchange-winners    → latest maxchange winner per (ticker, cat)
 *   ?view=expected-move        → SPX ±1σ expected move from the latest
 *                                per-strike IV (GEXBot's documented formula)
 *   ?view=sibling-confirm      → requires &ticker=AAPL&side=call|put&at=<ISO
 *                                fire time>: sibling taker-flow direction then
 *
 * While the market is closed, `snapshots-latest`, `velocity`,
 * `convexity-trend` and `maxchange-winners` end each ticker's window at its
 * anchor (its last real capture of the session) instead of at now, so they
 * keep showing the session after the close; an empty table, or one with no
 * anchored ticker, gives no rows. Those four bodies are `{ rows, asOf }`,
 * where `asOf` is the latest capture time in the payload, or null when it is
 * empty. A closed response takes the closed-market edge cache, a live one 15 s.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md (sibling-confirm
 * superseded by P12a: docs/superpowers/specs/gexbot-refresh-2026-10-28.md);
 * closed mode: docs/superpowers/specs/2026-11-20-gexbot-after-close-design.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  guardOwnerOrGuestEndpoint,
  isMarketOpen,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import {
  getClosedAnchors,
  getConvexityTrend,
  getExpectedMove,
  getLatestSnapshots,
  getMaxchangeWinners,
  getSiblingConfirmation,
  getVelocityTape,
  type ClosedAnchors,
  type GexbotAnchorTable,
} from './_lib/gexbot-queries.js';
import { setClosedReadCache } from './_lib/live-read-cache.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { gexbotQuerySchema } from './_lib/validation.js';

/**
 * Read one anchored view. While the market is open it is the plain read from
 * the clock. When closed it reads from each ticker's anchor in `table`; an
 * empty table, or one whose rows name no ticker, gives no rows without
 * touching the reader.
 */
async function readView<T>(
  closed: boolean,
  table: GexbotAnchorTable,
  read: (anchors?: ClosedAnchors) => Promise<T[]>,
): Promise<T[]> {
  if (!closed) return read();
  const anchors = await getClosedAnchors(table);
  return anchors && anchors.byTicker.size > 0 ? read(anchors) : [];
}

/** The latest of some capture times, as the original string; null if none. */
function latestCapture(times: Iterable<string>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    const ms = Date.parse(time);
    if (ms > latestMs) {
      latest = time;
      latestMs = ms;
    }
  }
  return latest;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/gexbot');

  if (req.method !== 'GET') {
    done({ status: 405 });
    res.status(405).json({ error: 'GET only' });
    return;
  }

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  const parsed = gexbotQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    done({ status: 400 });
    res
      .status(400)
      .json({ error: 'Invalid query', issues: parsed.error.issues });
    return;
  }

  const { view, ticker, side, at } = parsed.data;

  // One clock reading per request, handed to the closed cache rule so its
  // close and open checks read a single instant. `isMarketOpen()` takes no
  // date and reads its own clock a moment later.
  const now = new Date();
  const closed = !isMarketOpen();

  try {
    let body: unknown;
    switch (view) {
      case 'snapshots-latest': {
        const rows = await readView(
          closed,
          'gexbot_snapshots',
          getLatestSnapshots,
        );
        body = {
          rows,
          asOf: latestCapture(rows.map((r) => r.capturedAt)),
        };
        break;
      }
      case 'velocity': {
        const rows = await readView(
          closed,
          'gexbot_snapshots',
          getVelocityTape,
        );
        body = {
          rows,
          asOf: latestCapture(rows.map((r) => r.capturedAt)),
        };
        break;
      }
      case 'convexity-trend': {
        const rows = await readView(closed, 'gexbot_snapshots', (anchors) =>
          anchors ? getConvexityTrend(undefined, anchors) : getConvexityTrend(),
        );
        body = {
          rows,
          asOf: latestCapture(rows.flatMap((r) => r.series.map(([t]) => t))),
        };
        break;
      }
      case 'maxchange-winners': {
        const rows = await readView(
          closed,
          'gexbot_api_capture',
          getMaxchangeWinners,
        );
        body = {
          rows,
          asOf: latestCapture(rows.map((r) => r.capturedAt)),
        };
        break;
      }
      case 'expected-move':
        body = { rows: await getExpectedMove() };
        break;
      case 'sibling-confirm': {
        // Zod .refine guarantees these are set, but TS narrowing
        // doesn't propagate through .refine — guard explicitly to
        // avoid non-null assertions on user input.
        if (!ticker || !side || !at) {
          done({ status: 400 });
          res.status(400).json({
            error: 'sibling-confirm requires ticker, side and at',
          });
          return;
        }
        body = {
          rows: await getSiblingConfirmation(ticker, side, new Date(at)),
        };
        break;
      }
    }

    if (closed) {
      // Nothing new lands after the close, so cache for as long as is safe:
      // the rule ends the cache life before the final fetch and the next open.
      setClosedReadCache(res, now);
    } else {
      // Tight cache — 15s — lets the 30s frontend poll get a fresh read
      // on alternating ticks while shielding the DB from repeated tab
      // refreshes.
      setCacheHeaders(res, 15);
    }
    done({ status: 200 });
    res.status(200).json(body);
  } catch (err) {
    Sentry.captureException(err, { tags: { route: '/api/gexbot', view } });
    logger.error({ err, view, ticker, side, at }, '/api/gexbot failed');
    done({ status: 500 });
    res.status(500).json({ error: 'Internal error' });
  }
}
