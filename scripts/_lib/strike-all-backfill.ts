/**
 * The store-or-refuse rules of scripts/backfill-strike-all.ts for one past
 * date, as a pure function. The script keeps only the UW reads and the SQL.
 *
 * They are the live cron's rules (api/cron/fetch-strike-all.ts) with `date`
 * as the day the rows are stored under, built on the same helpers
 * (`judgeLadder`, `roundTo5Min`, `fetchStrikeAllLadder`): the spot and the
 * ladder must both be from ET day `date`, the ladder is cut to spot ± 200,
 * all-zero gamma is refused, stored price is the spot, and the timestamp is
 * the newest row time floored to 5 minutes. The cron skips a refused ladder
 * and tries again a minute later; a backfill has no next poll, so the script
 * stops on any refusal (R1: stop on the first error).
 *
 * Plan: docs/superpowers/plans/2026-10-23-uw-rest-fixes.md, Task R1.
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.3).
 */

import { getETDateStr } from '../../src/utils/timezone.js';
import {
  STRIKE_ALL_ATM_RANGE,
  type StrikeAllRow,
} from '../../api/_lib/strike-all-fetch.js';
import {
  isBeforeEtDay,
  judgeLadder,
  type LadderSkipKind,
} from '../../api/_lib/strike-ladder.js';
import { roundTo5Min } from '../../api/_lib/uw-fetch.js';

export type DatePlan =
  | {
      ok: true;
      /** The strikes to insert: inside spot ± range, with gamma. */
      rows: StrikeAllRow[];
      /** Stored as `price`: the helper spot. */
      price: number;
      /** Stored as `timestamp`: the newest row time, floored to 5 minutes. */
      timestamp: string;
      strikeMin: number;
      strikeMax: number;
    }
  | {
      ok: false;
      /** What was wrong: a LadderSkipKind, or malformed / wrong_day. */
      kind: LadderSkipKind | 'malformed' | 'wrong_day';
      message: string;
    };

export function planDateStore(
  rows: readonly StrikeAllRow[],
  spot: { price: number; time: string },
  date: string,
): DatePlan {
  const spotDay = getETDateStr(new Date(spot.time));
  if (spotDay !== date) {
    return {
      ok: false,
      kind: isBeforeEtDay(spot.time, date) ? 'stale_spot' : 'wrong_day',
      message: `${date}: the SPX spot row is from ${spotDay} (${spot.time}), not storing`,
    };
  }

  const verdict = judgeLadder(rows, {
    spot: spot.price,
    range: STRIKE_ALL_ATM_RANGE,
    day: date,
  });
  switch (verdict.kind) {
    case 'empty':
      return {
        ok: false,
        kind: 'empty',
        message: `${date}: UW returned no strike rows`,
      };
    case 'malformed':
      return {
        ok: false,
        kind: 'malformed',
        message: `${date}: no strike row carries a parseable time`,
      };
    case 'stale':
      return {
        ok: false,
        kind: 'stale',
        message: `${date}: UW answered with a ladder from ${verdict.dataEtDate} (${verdict.snapshotTime}), not storing it`,
      };
    case 'outside_window':
      return {
        ok: false,
        kind: 'outside_window',
        message: `${date}: none of ${verdict.total} strike rows is inside ${spot.price} ± ${STRIKE_ALL_ATM_RANGE}`,
      };
    case 'all_zero':
      return {
        ok: false,
        kind: 'all_zero',
        message: `${date}: all ${verdict.total} in-range strikes have zero gamma OI, not storing`,
      };
    case 'store':
      break;
  }

  // judgeLadder refuses an earlier day; a later one is as wrong for a past date.
  const ladderDay = getETDateStr(new Date(verdict.snapshotTime));
  if (ladderDay !== date) {
    return {
      ok: false,
      kind: 'wrong_day',
      message: `${date}: UW answered with a ladder from ${ladderDay} (${verdict.snapshotTime}), not storing it`,
    };
  }

  const strikes = verdict.rows.map((r) => Number.parseFloat(r.strike));
  return {
    ok: true,
    rows: verdict.rows,
    price: spot.price,
    timestamp: roundTo5Min(new Date(verdict.snapshotTime)).toISOString(),
    strikeMin: Math.min(...strikes),
    strikeMax: Math.max(...strikes),
  };
}
