/**
 * GET /api/gex-landscape
 *
 * Per-strike gamma / charm / vanna rows (GEXBot State) served straight
 * from `gexbot_api_capture` at 1-min cadence, with each row carrying its
 * own prior values (position-4 of the GEXBot `mini_contracts` payload,
 * holding the strike's value at t-5, t-15 and t-30 min — see
 * `decodeStrikesWithHistory`).
 *
 * Sign: gamma, charm, vanna and their priors are served in GEXBot's own
 * taker-side sign (positive = traders net long that Greek at the strike),
 * never negated (owner decision D1 revised, 2026-10-29). They are not
 * market-maker positions.
 *
 * Replaces the 10-min `usePeriscopeStrikes` path the legacy GexLandscape
 * hook used. Phase 1 of the rebuild spec:
 *   docs/superpowers/specs/gex-landscape-1min-gexbot-rebuild-2026-05-26.md
 *
 * Pipeline:
 *   1. Pick the session and the bound on each panel read. Every read stays
 *      inside one session, so a row from another session never shows under
 *      this one's label.
 *      - Scrub `?at=ISO` (malformed, or a date outside years 1000-9999 that
 *        has no ET session date → fall back to "latest", matching the
 *        project's permissive query handling): the session is the ET date of
 *        `at`, and a panel's row is the newest at or before `at` and after ET
 *        midnight of that date. The date comes from `at`, not from the row
 *        found: a session's first scrub minute finds the previous session's
 *        last row, which the lower bound turns into `no_slot`.
 *      - Live, market closed: the session is the one `getClosedAnchors` reads
 *        off the newest capture (a weekend, a holiday and the pre-open all
 *        read the last session). A panel's row is the newest at or before the
 *        SPX anchor, its last real capture of the session, and after ET
 *        midnight. No SPX anchor, or an empty table, is `no_slot`.
 *      - Live, in session: today, and the newest row within STALENESS_CUTOFF_MS.
 *      A bounded read ends after its upper bound's whole millisecond
 *      (`< upper + 1 ms`): `captured_at` is `now()` and keeps microseconds
 *      while the bound travels as a millisecond ISO string.
 *   2. Read the row per panel (gamma_zero / charm_zero / vanna_zero) for SPX.
 *   3. Decode each panel via `decodeStrikesWithHistory()`.
 *   4. Join the three panels by strike. Missing scalar values default
 *      to 0 so client arithmetic doesn't have to null-guard; missing
 *      prev values stay null (source-of-truth).
 *   5. `fetchSpxSpot(date, capturedAt)` → spot anchor, on the session date;
 *      null returns `data: null, reason: 'no_spot'`.
 *   6. Distinct minutes for SPX gamma_zero on the session date →
 *      `availableMinutes` for the scrub stepper (one panel is enough — same
 *      cron writes all three at the same minute mark).
 *
 * `asOf` is a capture time on every path: the freshest panel's `captured_at`
 * for a reply with data or `no_spot`, and null for `no_slot` (no capture backs
 * it). A `no_slot` that lists minutes also carries `lastMinuteAgeSec`: how old
 * the last listed minute is on the server's clock, so a client can show a stall
 * age without trusting its own clock.
 *
 * Auth: owner OR guest (read-only). Identical to /api/periscope-map.
 * Cache, chosen per response once its kind is known (an error sets none):
 *   - live, market closed (any body): `setClosedReadCache`
 *     (`_lib/live-read-cache.ts`). Nothing new lands after the close, so the
 *     response lives as long as is safe: it ends before the client's final
 *     fetch (close + 3 min) and before the next open.
 *   - the rest, by `setLiveReadCache` (same file, shared with the Periscope
 *     readers):
 *     - live, response carries data: 10s edge, no stale reuse. A capture under
 *       5 minutes old means captures are running, so healthy data never sits at
 *       the edge for a minute.
 *     - live, during the session, no_slot / no_spot: 10s edge, so a recovering
 *       feed shows within seconds.
 *     - scrubbed (`at` set), market open or closed: 300s edge + 60s SWR. A
 *       past minute doesn't change.
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isMarketOpen } from './_lib/api-helpers.js';
import {
  setClosedReadCache,
  setLiveReadCache,
} from './_lib/live-read-cache.js';
import { guardOwnerOrGuestEndpoint } from './_lib/guest-auth.js';
import { getDb, withDbRetry } from './_lib/db.js';
import { DB_RETRY_ATTEMPTS, DB_RETRY_TIMEOUT_MS } from './_lib/constants.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import { fetchSpxSpot } from './_lib/periscope-query.js';
import {
  getClosedSpxBound,
  readPanelRowInBound,
  type CaptureRow,
  type PanelBound,
} from './_lib/closed-spx-bound.js';
import { etWallClockToUtcIso, getETDateStr } from '../src/utils/timezone.js';
import logger from './_lib/logger.js';
import {
  PANELS,
  PANEL_TO_CATEGORY,
  STALENESS_CUTOFF_MS,
  TICKER,
  decodeStrikesWithHistory,
  type DecodedStrikeWithHistory,
  type GexbotStatePayload,
  type PanelName,
} from './_lib/periscope-gexbot.js';

interface GexLandscapeStrike {
  strike: number;
  gamma: number;
  charm: number;
  vanna: number;
  gammaPrev5m: number | null;
  gammaPrev15m: number | null;
  gammaPrev30m: number | null;
  charmPrev5m: number | null;
  charmPrev15m: number | null;
  charmPrev30m: number | null;
  vannaPrev5m: number | null;
  vannaPrev15m: number | null;
  vannaPrev30m: number | null;
}

interface PanelSlot {
  capturedAt: Date;
  rows: DecodedStrikeWithHistory[];
}

/** A usable `?at=`: the instant, the ET session it falls on, and its start. */
interface Scrub {
  /** The requested instant, as an ISO string. */
  at: string;
  /** Its ET calendar date: the one session a scrub reads. */
  date: string;
  /** ET midnight of `date`, as an instant. */
  midnight: string;
}

/**
 * Try parsing `at` into a scrub. Returns null when the value is missing, not a
 * string, `new Date(at)` yields Invalid Date, or the instant has no ET session
 * date we can bound a read with. The last case is a parseable date outside
 * years 1000-9999: the ET formatter then returns `1-01-01` or `275760-09-12`,
 * which has no ET midnight. Matches the project's permissive convention — we
 * don't 400 (or 500) on bad scrub input, we fall back to "latest".
 */
function parseScrub(raw: unknown): Scrub | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  // The session is the ET date of `at`, not the date of any row found.
  const date = getETDateStr(d);
  const midnight = etWallClockToUtcIso(date, 0);
  if (midnight === null) return null;
  return { at: d.toISOString(), date, midnight };
}

/**
 * Which of the three reads a request is, decided once in `planRead`: a scrub
 * (`?at=`), a live read in the session, or a live read with the market closed.
 * The cache rule follows it.
 */
type ReadMode = 'scrub' | 'live' | 'closed';

/**
 * What a request reads: its mode, the session date, and how its panels are
 * bounded.
 */
type ReadPlan = { mode: ReadMode } & (
  | {
      kind: 'read';
      date: string;
      /** null: a live in-session read, held to the staleness window. */
      bound: PanelBound | null;
    }
  // The market is closed and there is no SPX anchor to read up to. `date` is
  // the session the table's newest row is on, or null when the table is empty.
  | { kind: 'no_slot'; date: string | null }
);

/**
 * Decide the mode of a request, the session it reads, and how each panel read
 * is bounded. See the pipeline notes in the file header. The closed market's
 * session and bound come from `getClosedSpxBound`, shared with
 * `/api/periscope-map`; a scrub's date is user-controlled, so `parseScrub` has
 * already ruled out one with no ET midnight.
 */
async function planRead(
  scrub: Scrub | null,
  marketOpen: boolean,
  now: Date,
): Promise<ReadPlan> {
  if (scrub != null) {
    return {
      mode: 'scrub',
      kind: 'read',
      date: scrub.date,
      bound: { lower: scrub.midnight, upper: scrub.at },
    };
  }
  if (marketOpen) {
    return {
      mode: 'live',
      kind: 'read',
      date: getETDateStr(now),
      bound: null,
    };
  }
  return { mode: 'closed', ...(await getClosedSpxBound('gex-landscape')) };
}

/**
 * Fetch one panel's newest capture inside `bound` (a scrub, or the closed
 * market's last session), OR the latest capture under the staleness window
 * when `bound` is null (live, in session). Returns null when no row qualifies
 * (panel stale / cron gap / scrub before the session's first capture).
 */
async function fetchPanelSlot(
  panel: PanelName,
  bound: PanelBound | null,
): Promise<PanelSlot | null> {
  let row: CaptureRow | undefined;
  if (bound != null) {
    // Bounded mode: the newest row at or before `upper`, on the session. No
    // staleness floor (scrubbing back into history is the whole point of the
    // param, and a closed market's last capture is hours old).
    row = await readPanelRowInBound(panel, bound);
  } else {
    // Live mode: enforce the staleness window so we don't render a
    // multi-hour-old slice from a stalled cron as if it were "now".
    const sql = getDb();
    const category = PANEL_TO_CATEGORY[panel];
    const stalenessCutoff = new Date(
      Date.now() - STALENESS_CUTOFF_MS,
    ).toISOString();
    const rows = (await withDbRetry(
      () => sql`
        SELECT captured_at, raw_response
        FROM gexbot_api_capture
        WHERE ticker = ${TICKER}
          AND endpoint = 'state'
          AND category = ${category}
          AND captured_at >= ${stalenessCutoff}
        ORDER BY captured_at DESC
        LIMIT 1
      `,
    )) as CaptureRow[];
    row = rows[0];
  }

  if (row === undefined) {
    logger.warn(
      { panel, ticker: TICKER, bound },
      'gex-landscape: no qualifying gexbot row for panel — returning no_slot',
    );
    return null;
  }

  const decoded = decodeStrikesWithHistory(
    row.raw_response as GexbotStatePayload,
  );
  return {
    capturedAt: new Date(row.captured_at),
    rows: decoded,
  };
}

/**
 * Distinct minute-truncated capture timestamps for the day. Anchored on
 * gamma_zero since the populate-periscope-from-gexbot cron writes all
 * three panels at the same minute mark.
 */
async function fetchAvailableMinutes(date: string): Promise<string[]> {
  const sql = getDb();
  // Wrap in withDbRetry so a transient blip on this secondary read surfaces
  // as a TransientDbError (→ soft 503) instead of a raw NeonDbError that
  // hard-500s the whole endpoint.
  const rows = (await withDbRetry(
    () => sql`
      SELECT DISTINCT date_trunc('minute', captured_at) AS minute
      FROM gexbot_api_capture
      WHERE ticker = ${TICKER}
        AND endpoint = 'state'
        AND category = 'gamma_zero'
        AND captured_at::date = ${date}::date
      ORDER BY minute ASC
    `,
    DB_RETRY_ATTEMPTS,
    DB_RETRY_TIMEOUT_MS,
  )) as Array<{ minute: Date | string }>;
  return rows.map((r) =>
    r.minute instanceof Date ? r.minute.toISOString() : r.minute,
  );
}

/**
 * Join the three panel decodes by strike. A strike present in one panel
 * but missing in another gets 0 for the scalar fields (so the frontend
 * can compute Δ without null-guarding arithmetic), but null for the
 * corresponding prev fields (source-of-truth — we don't fabricate
 * history we don't have).
 */
function joinPanelsByStrike(
  gamma: DecodedStrikeWithHistory[],
  charm: DecodedStrikeWithHistory[],
  vanna: DecodedStrikeWithHistory[],
): GexLandscapeStrike[] {
  const byStrike = new Map<number, GexLandscapeStrike>();

  const ensure = (strike: number): GexLandscapeStrike => {
    const existing = byStrike.get(strike);
    if (existing) return existing;
    const fresh: GexLandscapeStrike = {
      strike,
      gamma: 0,
      charm: 0,
      vanna: 0,
      gammaPrev5m: null,
      gammaPrev15m: null,
      gammaPrev30m: null,
      charmPrev5m: null,
      charmPrev15m: null,
      charmPrev30m: null,
      vannaPrev5m: null,
      vannaPrev15m: null,
      vannaPrev30m: null,
    };
    byStrike.set(strike, fresh);
    return fresh;
  };

  for (const row of gamma) {
    const target = ensure(row.strike);
    target.gamma = row.value;
    target.gammaPrev5m = row.prev5m;
    target.gammaPrev15m = row.prev15m;
    target.gammaPrev30m = row.prev30m;
  }
  for (const row of charm) {
    const target = ensure(row.strike);
    target.charm = row.value;
    target.charmPrev5m = row.prev5m;
    target.charmPrev15m = row.prev15m;
    target.charmPrev30m = row.prev30m;
  }
  for (const row of vanna) {
    const target = ensure(row.strike);
    target.vanna = row.value;
    target.vannaPrev5m = row.prev5m;
    target.vannaPrev15m = row.prev15m;
    target.vannaPrev30m = row.prev30m;
  }

  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const done = metrics.request('/api/gex-landscape');

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  try {
    Sentry.setTag('route', '/api/gex-landscape');
    // One clock reading per request, handed to the closed cache rule so its
    // close and open checks see a single instant. `isMarketOpen()` takes no
    // date and reads its own clock a moment later.
    const now = new Date();
    const marketOpen = isMarketOpen();

    const plan = await planRead(parseScrub(req.query.at), marketOpen, now);

    // Cache headers are set on each success path below, not up front, so an
    // error reply carries none. A scrub reads one past minute, so it keeps the
    // scrub cache even with the market closed.
    const setCache = (hasData: boolean): void => {
      if (plan.mode === 'closed') {
        setClosedReadCache(res, now);
      } else {
        setLiveReadCache(res, {
          historical: plan.mode === 'scrub',
          hasData,
          marketOpen,
        });
      }
    };

    // Available minutes is small (~390 rows max for a full session) and
    // backs the scrub stepper — fetch unconditionally so the panel can
    // step backward even when the live slot is missing.
    const availableMinutes =
      plan.date === null ? [] : await fetchAvailableMinutes(plan.date);

    // Fetch all three panels in parallel — independent reads. With no SPX
    // anchor there is nothing to read up to, so no panel is read.
    const [gammaSlot, charmSlot, vannaSlot] =
      plan.kind === 'read'
        ? await Promise.all(
            PANELS.map((panel) => fetchPanelSlot(panel, plan.bound)),
          )
        : [null, null, null];

    if (
      plan.kind !== 'read' ||
      gammaSlot == null ||
      charmSlot == null ||
      vannaSlot == null
    ) {
      setCache(false);
      done({ status: 200 });
      // No capture backs this reply, so `asOf` is null. Without it a client
      // can't tell how long the feed has been stalled, so the reply carries the
      // age of its last listed minute, measured on this server's clock.
      const lastMinute = availableMinutes.at(-1);
      res.status(200).json({
        marketOpen,
        asOf: null,
        data: null,
        reason: 'no_slot',
        availableMinutes,
        ...(lastMinute !== undefined && {
          lastMinuteAgeSec: Math.round(
            (now.getTime() - Date.parse(lastMinute)) / 1000,
          ),
        }),
      });
      return;
    }

    // Anchor `asOf` on the freshest panel timestamp — they should agree
    // to the minute but capture jitter can put them off by a few seconds.
    const latestCapturedAt = new Date(
      Math.max(
        gammaSlot.capturedAt.getTime(),
        charmSlot.capturedAt.getTime(),
        vannaSlot.capturedAt.getTime(),
      ),
    );

    const spot = await fetchSpxSpot(plan.date, latestCapturedAt.toISOString());
    if (spot == null) {
      setCache(false);
      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: latestCapturedAt.toISOString(),
        data: null,
        reason: 'no_spot',
        availableMinutes,
      });
      return;
    }

    const strikes = joinPanelsByStrike(
      gammaSlot.rows,
      charmSlot.rows,
      vannaSlot.rows,
    );

    const ageSec = Math.round((Date.now() - latestCapturedAt.getTime()) / 1000);

    setCache(true);
    done({ status: 200 });
    res.status(200).json({
      marketOpen,
      asOf: latestCapturedAt.toISOString(),
      data: { strikes, spot },
      ageSec,
      availableMinutes,
    });
  } catch (error) {
    sendDbErrorResponse(res, error, {
      label: 'gex_landscape',
      serverErrorBody: { error: 'Internal server error' },
      done,
    });
  }
}
