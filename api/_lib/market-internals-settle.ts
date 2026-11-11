/**
 * Post-close settle of the NYSE market internals ($TICK, $ADD, $VOLD, $TRIN)
 * into `market_internals`: which sessions to cover, the Schwab request, the
 * payload check, the per-symbol plan, and the batched upsert. Shared by
 * `api/cron/fetch-market-internals.ts` and
 * `scripts/_lib/market-internals-backfill.ts`.
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.5, F9, F10).
 *
 * Why the cron no longer captures in session. Schwab has no trustworthy live
 * source for these four symbols (verified 2026-11-07):
 *   - `/quotes` answers $ADD and $VOLD with a zeroed placeholder
 *     (lastPrice 0, securityStatus "Unknown"). The old cron stored that as a
 *     flat bar, 50,480 of them per symbol, and stamped about 1,259 per symbol
 *     outside the session.
 *   - live `/pricehistory` returns $TICK with its negative values clamped to
 *     0 (0 of 50,862 stored bars negative since 04-15, against 63% before)
 *     and $TRIN at the wrong scale (0.0026 where the settled value was 0.83).
 *   - the old write was `ON CONFLICT DO NOTHING`, so a wrong first-seen row
 *     stuck for good.
 * Schwab's SETTLED one-minute series (after the close) is correct for all
 * four: 390 bars per session, 09:30 to 15:59 ET, no all-zero bar, no
 * duplicate, in each of the 35 sessions (09-21 to 11-06) of the saved probe
 * files. So the cron runs once after the close and upserts that series.
 *
 * What a run does to a symbol's session, in order:
 *   1. Keep the bars from 09:30 ET to the last minute before the close (16:00
 *      ET, or 13:00 ET on an early-close day: `sessionWindowIso`), one per
 *      timestamp. Everything else is counted as out of session.
 *   2. $TICK clamp signature. A $TICK session of at least CLAMP_MIN_BARS bars
 *      with no negative value is the live clamp, never real: it is refused,
 *      nothing of it is written, and it is reported by name.
 *   3. Reject an all-zero bar (open = high = low = close = 0) and count it.
 *   4. The session is complete only with the calendar's bar count
 *      (`cashSessionMinutes`: 390, or 210 on a half day). Anything else is
 *      incomplete: what is valid is written, and the session is reported.
 */

import { z } from 'zod';

import type { InternalSymbol } from '../../src/types/market-internals.js';
import {
  cashSessionMinutes,
  priorTradingDay,
  isTradingDay,
} from '../../src/data/marketHours.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { sessionWindowIso } from './closed-buckets.js';
import { getDb, withDbRetry } from './db.js';

// ── Constants ───────────────────────────────────────────────

/** The four symbols the table holds, in the order a run settles them. */
export const SETTLE_SYMBOLS: readonly InternalSymbol[] = [
  '$TICK',
  '$ADD',
  '$VOLD',
  '$TRIN',
];

/**
 * Sessions each run covers, counted back from the newest settled one. Self
 * heal: a session whose series was not final the same evening (the check
 * after the close found it incomplete or clamped), or a run that did not
 * happen, is fetched and written again by the next four evenings.
 */
export const SETTLE_SESSIONS = 5;

/**
 * Raw in-session $TICK bars needed before "no negative value" counts as the
 * clamp signature. Tuned on the 35 settled sessions of the saved probe
 * (09-21 to 11-06): every one has negative values on at least 129 of its 390
 * bars, the longest run of bars without a negative low is 44 and the latest
 * first negative low is bar 38. 60 bars (an hour) is past all of that, and
 * below it a partial session is written and reported as incomplete.
 */
export const CLAMP_MIN_BARS = 60;

/**
 * A symbol-session needs more than this many stored rows, all of them
 * all-zero, to raise the alert (the same floor as checkDataQuality's
 * `minRows`): a handful of zero rows is not yet a dead feed.
 */
export const ALL_ZERO_MIN_ROWS = 10;

/**
 * The request window reaches this far before the oldest open and after the
 * newest close, so a bound that turns out to be exclusive cannot cost the
 * 09:30 bar. The extra bars are out of session and dropped.
 */
export const FETCH_MARGIN_MS = 60 * 60_000;

/** Rows per INSERT statement (R5). */
const UPSERT_CHUNK = 500;

// ── Types ───────────────────────────────────────────────────

export interface SettleCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  /** Epoch ms of the bar's start. */
  datetime: number;
}

export interface InternalBarRow {
  /** ISO instant of the bar's start. */
  ts: string;
  symbol: InternalSymbol;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type SettleFailureKind =
  | 'schwab_logged_out'
  | 'schwab_error'
  | 'empty_payload'
  | 'malformed_payload'
  /** A throw from our own parse or plan code: not Schwab's fault. */
  | 'unexpected';

/** Why a symbol's fetch could not be used, by name. */
export class SettleFailure extends Error {
  kind: SettleFailureKind;
  constructor(kind: SettleFailureKind, message: string) {
    super(message);
    this.name = 'SettleFailure';
    this.kind = kind;
  }
}

export type SessionStatus = 'complete' | 'incomplete' | 'tick_clamped';

export interface SessionOutcome {
  /** ET trading day, `YYYY-MM-DD`. */
  date: string;
  /** Bars a complete session has: 390, or 210 on a half day. */
  expected: number;
  /** Valid bars kept for writing (0 for a refused session). */
  bars: number;
  /** All-zero bars rejected. */
  zeroBars: number;
  status: SessionStatus;
}

export interface SymbolPlan {
  symbol: InternalSymbol;
  /** Valid bars to write, oldest first. */
  rows: InternalBarRow[];
  /** Candles outside every requested session (extended hours, other days). */
  outOfSession: number;
  /** Candles that repeated a timestamp already seen (the later one is kept). */
  duplicates: number;
  /** One entry per requested session, oldest first. */
  sessions: SessionOutcome[];
}

export interface SessionProblem {
  symbol: InternalSymbol;
  date: string;
  kind: 'incomplete' | 'tick_clamped';
  bars: number;
  expected: number;
  zeroBars: number;
}

export interface UpsertCounts {
  /** New rows. */
  inserted: number;
  /** Existing rows whose values differed and were replaced. */
  updated: number;
  /** Existing rows that already held these values (not rewritten). */
  unchanged: number;
}

/** Which planned rows changed, by ISO ts. A row absent from it is unchanged. */
export type ChangedBars = Map<string, 'inserted' | 'updated'>;

export interface SessionRowCount {
  symbol: InternalSymbol;
  date: string;
  total: number;
  nonzero: number;
}

// ── Sessions and the request ────────────────────────────────

/**
 * The `count` newest sessions that are over at `now`, oldest first. Today
 * counts only once its close (13:00 ET on a half day) has passed: before it
 * the series is still being written. Weekends and holidays are skipped.
 */
export function settleSessions(
  now: Date,
  count: number = SETTLE_SESSIONS,
): string[] {
  const today = getETDateStr(now);
  const todayIsOver =
    isTradingDay(today) &&
    now.getTime() >= Date.parse(sessionWindowIso(today).closeIso);
  const sessions: string[] = [];
  let day = todayIsOver ? today : priorTradingDay(today);
  while (sessions.length < count) {
    sessions.unshift(day);
    day = priorTradingDay(day);
  }
  return sessions;
}

/** First open and last close of `sessions` (oldest first, non-empty), as ISO. */
function sessionSpan(sessions: readonly string[]): {
  openIso: string;
  closeIso: string;
} {
  const first = sessions[0];
  const last = sessions.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('sessionSpan: no sessions');
  }
  return {
    openIso: sessionWindowIso(first).openIso,
    closeIso: sessionWindowIso(last).closeIso,
  };
}

/** The request window for `sessions`: their span plus FETCH_MARGIN_MS each side. */
export function fetchWindow(sessions: readonly string[]): {
  startMs: number;
  endMs: number;
} {
  const { openIso, closeIso } = sessionSpan(sessions);
  return {
    startMs: Date.parse(openIso) - FETCH_MARGIN_MS,
    endMs: Date.parse(closeIso) + FETCH_MARGIN_MS,
  };
}

/** Schwab path and query for `symbol`'s 1-minute bars between two instants. */
export function pricehistoryPath(
  symbol: InternalSymbol,
  startMs: number,
  endMs: number,
): string {
  const params = new URLSearchParams({
    symbol,
    periodType: 'day',
    frequencyType: 'minute',
    frequency: '1',
    startDate: String(startMs),
    endDate: String(endMs),
    needExtendedHoursData: 'false',
    needPreviousClose: 'false',
  });
  return `/pricehistory?${params.toString()}`;
}

// ── The payload ─────────────────────────────────────────────

const payloadSchema = z.object({
  empty: z.boolean().optional(),
  candles: z.array(z.unknown()),
});

const candleSchema = z.object({
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  datetime: z.number(),
});

/**
 * The usable candles of a Schwab pricehistory answer. A body that is not
 * `{ candles: [...] }` throws `malformed_payload`; no candle at all (the list
 * is empty, or Schwab says `empty`) throws `empty_payload`, as does a list
 * where none is usable. A single candle with a missing or non-finite field is
 * dropped and counted in `malformed`.
 */
export function parsePriceHistory(body: unknown): {
  candles: SettleCandle[];
  malformed: number;
} {
  const payload = payloadSchema.safeParse(body);
  if (!payload.success) {
    throw new SettleFailure(
      'malformed_payload',
      'Schwab pricehistory payload has no candles list',
    );
  }
  if (payload.data.empty === true || payload.data.candles.length === 0) {
    throw new SettleFailure(
      'empty_payload',
      'Schwab pricehistory returned no candles',
    );
  }
  const candles: SettleCandle[] = [];
  for (const raw of payload.data.candles) {
    const parsed = candleSchema.safeParse(raw);
    if (parsed.success) candles.push(parsed.data);
  }
  if (candles.length === 0) {
    throw new SettleFailure(
      'malformed_payload',
      `Schwab pricehistory returned ${payload.data.candles.length} candles and none is usable`,
    );
  }
  return { candles, malformed: payload.data.candles.length - candles.length };
}

// ── The plan ────────────────────────────────────────────────

const isAllZero = (c: SettleCandle): boolean =>
  c.open === 0 && c.high === 0 && c.low === 0 && c.close === 0;

const hasNegative = (c: SettleCandle): boolean =>
  Math.min(c.open, c.high, c.low, c.close) < 0;

/**
 * What to write for `symbol` out of `candles`, session by session (see the
 * header for the order of the rules). Pure.
 */
export function planSymbol(
  symbol: InternalSymbol,
  candles: readonly SettleCandle[],
  sessions: readonly string[],
): SymbolPlan {
  const windows = new Map(
    sessions.map((day) => {
      const { openIso, closeIso } = sessionWindowIso(day);
      return [
        day,
        { open: Date.parse(openIso), close: Date.parse(closeIso) },
      ] as const;
    }),
  );
  const bySession = new Map<string, Map<number, SettleCandle>>(
    sessions.map((day) => [day, new Map()]),
  );

  let outOfSession = 0;
  let duplicates = 0;
  for (const candle of candles) {
    const day = getETDateStr(new Date(candle.datetime));
    const window = windows.get(day);
    if (
      window === undefined ||
      candle.datetime < window.open ||
      candle.datetime >= window.close
    ) {
      outOfSession++;
      continue;
    }
    const bucket = bySession.get(day);
    if (bucket === undefined) continue;
    if (bucket.has(candle.datetime)) duplicates++;
    bucket.set(candle.datetime, candle);
  }

  const rows: InternalBarRow[] = [];
  const outcomes: SessionOutcome[] = [];
  for (const day of sessions) {
    const raw = [...(bySession.get(day)?.values() ?? [])].sort(
      (a, b) => a.datetime - b.datetime,
    );
    const expected = cashSessionMinutes(day);

    if (
      symbol === '$TICK' &&
      raw.length >= CLAMP_MIN_BARS &&
      !raw.some(hasNegative)
    ) {
      outcomes.push({
        date: day,
        expected,
        bars: 0,
        zeroBars: 0,
        status: 'tick_clamped',
      });
      continue;
    }

    const valid = raw.filter((c) => !isAllZero(c));
    for (const c of valid) {
      rows.push({
        ts: new Date(c.datetime).toISOString(),
        symbol,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      });
    }
    outcomes.push({
      date: day,
      expected,
      bars: valid.length,
      zeroBars: raw.length - valid.length,
      status: valid.length === expected ? 'complete' : 'incomplete',
    });
  }

  return { symbol, rows, outOfSession, duplicates, sessions: outcomes };
}

/** The sessions of `plan` that are not complete, for the alert and the report. */
export function sessionProblems(plan: SymbolPlan): SessionProblem[] {
  const problems: SessionProblem[] = [];
  for (const s of plan.sessions) {
    if (s.status === 'complete') continue;
    problems.push({
      symbol: plan.symbol,
      date: s.date,
      kind: s.status,
      bars: s.bars,
      expected: s.expected,
      zeroBars: s.zeroBars,
    });
  }
  return problems;
}

/**
 * Split session problems into the ones to raise and the ones still pending.
 *
 * Schwab's SAME-day settled series is not final at the 22:30 UTC run for every
 * symbol. Observed in production on 2026-11-09 and 2026-11-10 (Sentry issue
 * SENTRY-EMERALD-DESERT-KJ, "settled series unusable for session(s)"): both
 * evenings the error fired for today's own session only (11-10: `$TICK`
 * `tick_clamped` with 0 bars, `$ADD` and `$VOLD` `incomplete` with 0 bars),
 * and the next evening's run found 11-09 complete for all four symbols. So a
 * problem on the newest session, when that session is the run's own ET date,
 * is *pending*: the next run heals it, and an error now would be noise. A
 * problem on any older session has had a full night to settle and is
 * `unusable`: that is the Sentry error. Before the close the window holds no
 * session of today (`settleSessions`), and on a forced weekend run the newest
 * session is a day or more old, so neither is ever pending.
 */
export function splitPendingProblems(
  problems: readonly SessionProblem[],
  sessions: readonly string[],
  today: string,
): { pending: SessionProblem[]; unusable: SessionProblem[] } {
  const newest = sessions.at(-1);
  const pending: SessionProblem[] = [];
  const unusable: SessionProblem[] = [];
  for (const problem of problems) {
    const isPending = problem.date === newest && problem.date === today;
    (isPending ? pending : unusable).push(problem);
  }
  return { pending, unusable };
}

/** The symbol-sessions stored all-zero over more than ALL_ZERO_MIN_ROWS rows. */
export function allZeroSessions(
  counts: readonly SessionRowCount[],
): SessionRowCount[] {
  return counts.filter((c) => c.total > ALL_ZERO_MIN_ROWS && c.nonzero === 0);
}

/**
 * Classify `planned` rows against the rows `stored` for the same symbol: a
 * planned row is unchanged when the stored one has the same four values,
 * updated when it differs, inserted when there is none. This is what the
 * upsert does, worked out without writing (the backfill's dry run).
 */
export function diffBars(
  planned: readonly InternalBarRow[],
  stored: ReadonlyArray<Omit<InternalBarRow, 'symbol'>>,
): { counts: UpsertCounts; changed: ChangedBars } {
  const byTs = new Map(stored.map((s) => [s.ts, s]));
  const changed: ChangedBars = new Map();
  let unchanged = 0;
  for (const row of planned) {
    const old = byTs.get(row.ts);
    if (old === undefined) changed.set(row.ts, 'inserted');
    else if (
      old.open === row.open &&
      old.high === row.high &&
      old.low === row.low &&
      old.close === row.close
    ) {
      unchanged++;
    } else changed.set(row.ts, 'updated');
  }
  const inserted = [...changed.values()].filter((v) => v === 'inserted').length;
  return {
    counts: { inserted, updated: changed.size - inserted, unchanged },
    changed,
  };
}

// ── The database ────────────────────────────────────────────

/**
 * Upsert `rows` (one symbol, one row per ts) into market_internals, 500 rows
 * an INSERT, all chunks in one transaction. A row that exists with other
 * values is replaced: the settled series is the truth and a wrong first-seen
 * row must not stick (the old DO NOTHING kept it). A row that already holds
 * these values is not rewritten (the WHERE is false, so no new tuple version
 * is made). `xmax = 0` marks a tuple this statement inserted. Throws on a
 * rejected write; the caller fails its run (R4).
 */
export async function upsertInternalBars(
  rows: readonly InternalBarRow[],
): Promise<{ counts: UpsertCounts; changed: ChangedBars }> {
  if (rows.length === 0) {
    return {
      counts: { inserted: 0, updated: 0, unchanged: 0 },
      changed: new Map(),
    };
  }
  const chunks: InternalBarRow[][] = [];
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    chunks.push(rows.slice(i, i + UPSERT_CHUNK));
  }

  const sql = getDb();
  const results = await withDbRetry(
    () =>
      sql.transaction((txn) =>
        chunks.map(
          (chunk) => txn`
            INSERT INTO market_internals (ts, symbol, open, high, low, close)
            SELECT t.ts, t.symbol, t.open, t.high, t.low, t.close
            FROM unnest(
              ${chunk.map((r) => r.ts)}::timestamptz[],
              ${chunk.map((r) => r.symbol)}::text[],
              ${chunk.map((r) => r.open)}::numeric[],
              ${chunk.map((r) => r.high)}::numeric[],
              ${chunk.map((r) => r.low)}::numeric[],
              ${chunk.map((r) => r.close)}::numeric[]
            ) AS t(ts, symbol, open, high, low, close)
            ON CONFLICT (ts, symbol) DO UPDATE
              SET open = EXCLUDED.open,
                  high = EXCLUDED.high,
                  low = EXCLUDED.low,
                  close = EXCLUDED.close
              WHERE (market_internals.open, market_internals.high,
                     market_internals.low, market_internals.close)
                IS DISTINCT FROM
                    (EXCLUDED.open, EXCLUDED.high, EXCLUDED.low, EXCLUDED.close)
            RETURNING ts, (xmax = 0) AS inserted
          `,
        ),
      ),
    2,
    10_000,
  );

  const changed: ChangedBars = new Map();
  for (const result of results) {
    for (const r of result as Array<{ ts: Date | string; inserted: boolean }>) {
      changed.set(
        new Date(r.ts).toISOString(),
        r.inserted ? 'inserted' : 'updated',
      );
    }
  }
  const inserted = [...changed.values()].filter((v) => v === 'inserted').length;
  return {
    counts: {
      inserted,
      updated: changed.size - inserted,
      unchanged: rows.length - changed.size,
    },
    changed,
  };
}

/**
 * `symbol`'s stored rows between the first open and the last close of
 * `sessions`, for the dry run to compare with (read only).
 */
export async function readStoredBars(
  symbol: InternalSymbol,
  sessions: readonly string[],
): Promise<Array<Omit<InternalBarRow, 'symbol'>>> {
  const { openIso, closeIso } = sessionSpan(sessions);
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT ts, open::float8 AS open, high::float8 AS high,
             low::float8 AS low, close::float8 AS close
      FROM market_internals
      WHERE symbol = ${symbol}
        AND ts >= ${openIso}::timestamptz
        AND ts < ${closeIso}::timestamptz
    `,
    2,
    10_000,
  )) as Array<{
    ts: Date | string;
    open: number | string;
    high: number | string;
    low: number | string;
    close: number | string;
  }>;
  return rows.map((r) => ({
    ts: new Date(r.ts).toISOString(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));
}

/**
 * Per symbol and session: the rows stored inside the session (09:30 ET to
 * the close, the bounds worked out in code, not in SQL) and how many of them
 * are not all-zero. Rows stamped outside the session, such as the extended
 * hours rows the old cron wrote, are not counted, so they cannot hide a dead
 * session. A symbol-session with no row is absent.
 */
export async function sessionRowCounts(
  sessions: readonly string[],
): Promise<SessionRowCount[]> {
  if (sessions.length === 0) return [];
  const windows = sessions.map((day) => ({ day, ...sessionWindowIso(day) }));
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT m.symbol, s.day,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (
               WHERE NOT (m.open = 0 AND m.high = 0 AND m.low = 0 AND m.close = 0)
             )::int AS nonzero
      FROM unnest(
        ${windows.map((w) => w.day)}::text[],
        ${windows.map((w) => w.openIso)}::timestamptz[],
        ${windows.map((w) => w.closeIso)}::timestamptz[]
      ) AS s(day, open_ts, close_ts)
      JOIN market_internals m ON m.ts >= s.open_ts AND m.ts < s.close_ts
      GROUP BY m.symbol, s.day
      ORDER BY s.day, m.symbol
    `,
    2,
    10_000,
  )) as Array<{
    symbol: InternalSymbol;
    day: string;
    total: number | string;
    nonzero: number | string;
  }>;
  return rows.map((r) => ({
    symbol: r.symbol,
    date: r.day,
    total: Number(r.total),
    nonzero: Number(r.nonzero),
  }));
}
