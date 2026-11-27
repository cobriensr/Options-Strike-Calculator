/**
 * The closed market's read plan for the SPX-only live Periscope / GEX readers
 * (`/api/gex-landscape`, `/api/periscope-map`): one session, and how each panel
 * read is confined to it. One rule in one place, so the two endpoints cannot
 * drift on which session they serve or on the instants that bound it.
 *
 * After the cash close nothing new lands, and "the newest row within the
 * staleness window" is empty minutes later. The reply is the last session's
 * final panels instead. `getClosedAnchors` reads the session off the newest
 * capture in `gexbot_api_capture` (a weekend, a holiday and the pre-open all
 * read the last session) and gives each ticker's last real capture of it, its
 * anchor. A panel's read (`readPanelRowInBound`) is then the newest row at or
 * before SPX's anchor and after ET midnight of the session date, so a row from
 * another session never shows under this session's label. A `?at=` scrub of
 * `/api/gex-landscape` reads through the same function, bounded by `at`.
 *
 * Spec: docs/superpowers/specs/2026-11-20-gexbot-after-close-design.md
 */

import { etWallClockToUtcIso } from '../../src/utils/timezone.js';
import { getDb, withDbRetry } from './db.js';
import { getClosedAnchors } from './gexbot-queries.js';
import logger from './logger.js';
import {
  PANEL_TO_CATEGORY,
  TICKER,
  type PanelName,
} from './periscope-gexbot.js';

/**
 * The instants (ISO strings) that confine a panel read to one session.
 * `upper` is the newest instant the read may return, to the millisecond.
 *
 * A read ends after `upper`'s whole millisecond, as `captured_at < upper +
 * INTERVAL '1 millisecond'`, not at `captured_at <= upper`: `captured_at` is
 * `now()` and keeps microseconds while `upper` travels as a millisecond ISO
 * string, so `<=` would drop the very row an anchor names. The explicit
 * `::timestamptz` cast on `upper` keeps Postgres from reading `$n + INTERVAL`
 * as interval arithmetic.
 */
export interface PanelBound {
  /** ET midnight of the session date, so no row from an earlier session. */
  lower: string;
  /** A scrub's `at`, or the SPX anchor when the market is closed. */
  upper: string;
}

/** A `gexbot_api_capture` row, as a panel read selects it. */
export interface CaptureRow {
  captured_at: Date | string;
  raw_response: unknown;
}

/**
 * The newest SPX capture of one panel inside `bound`, or undefined when no row
 * qualifies (a cron gap, or a scrub before the session's first capture). There
 * is no staleness floor: a scrub reads history, and a closed market's last
 * capture is hours old.
 */
export async function readPanelRowInBound(
  panel: PanelName,
  bound: PanelBound,
): Promise<CaptureRow | undefined> {
  const sql = getDb();
  const category = PANEL_TO_CATEGORY[panel];
  const rows = (await withDbRetry(
    () => sql`
      SELECT captured_at, raw_response
      FROM gexbot_api_capture
      WHERE ticker = ${TICKER}
        AND endpoint = 'state'
        AND category = ${category}
        AND captured_at >= ${bound.lower}
        AND captured_at < ${bound.upper}::timestamptz + INTERVAL '1 millisecond'
      ORDER BY captured_at DESC
      LIMIT 1
    `,
  )) as CaptureRow[];
  return rows[0];
}

/**
 * What a closed-market request reads: the session date and the bound on each
 * panel read, or `no_slot` when there is no SPX anchor to read up to. A
 * `no_slot`'s `date` is the session the table's newest row is on, or null when
 * the table is empty.
 */
export type ClosedSpxPlan =
  | { kind: 'read'; date: string; bound: PanelBound }
  | { kind: 'no_slot'; date: string | null };

/**
 * ET midnight of the closed session's date, as a UTC ISO instant. The date
 * comes from `to_char` in `getClosedAnchors`, so a null conversion means a bug;
 * fail the request rather than read without a lower bound.
 */
function etMidnightUtcIso(date: string, endpoint: string): string {
  const iso = etWallClockToUtcIso(date, 0);
  if (iso === null) {
    throw new Error(`${endpoint}: no ET midnight for session date ${date}`);
  }
  return iso;
}

/**
 * Plan a closed-market read for `endpoint` (its name, for the log line and the
 * error): the last session's date and the bound on each panel read.
 *
 * An empty table, or one with no SPX anchor, is `no_slot` and is logged: a
 * closed market with nothing to serve is worth a line. A rejected anchors read
 * propagates, for the caller's error reply.
 */
export async function getClosedSpxBound(
  endpoint: string,
): Promise<ClosedSpxPlan> {
  const anchors = await getClosedAnchors('gexbot_api_capture');
  const spxAnchor = anchors?.byTicker.get(TICKER);
  if (anchors == null || spxAnchor === undefined) {
    const sessionDate = anchors?.sessionDate ?? null;
    logger.warn(
      { ticker: TICKER, sessionDate },
      `${endpoint}: no SPX anchor for the closed market — returning no_slot`,
    );
    return { kind: 'no_slot', date: sessionDate };
  }
  return {
    kind: 'read',
    date: anchors.sessionDate,
    bound: {
      lower: etMidnightUtcIso(anchors.sessionDate, endpoint),
      upper: spxAnchor,
    },
  };
}
