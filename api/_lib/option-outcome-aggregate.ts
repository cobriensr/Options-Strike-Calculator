/**
 * Per-fire realized outcomes aggregated in SQL from ws_option_trades, for
 * the option-outcome enrichment crons.
 *
 * Those crons used to pull every post-entry tick into JS and run the exit
 * policies of lottery-exit-policies.ts over it. A single 0DTE chain prints
 * up to ~40K times a day, so that does not scale to 4-5K fires a day. This
 * module computes, in ONE statement per chunk of fires, the handful of
 * prices each policy actually selects. `realizedFromAggregate` then turns
 * them into the same percentages the JS policies return (pinned by
 * option-outcome-aggregate-sql.test.ts, which runs the SQL in pglite against
 * the JS policies on the same ticks).
 *
 * Tape window per fire: [entry, close + LATE_PRINT_MINUTES] on the fire's ET
 * trade date. The upper bound is explicit: a 1-3 DTE contract keeps
 * printing on later days, and those prints are not this fire's outcome
 * (the parquet enrichment, scripts/enrich_lottery_outcomes.py, reads one
 * day's file). ETF options print until 16:15 ET, hence the allowance.
 *
 * Feed liveness. The entry of every fire is itself a print, so a complete
 * tape always has >= 1 tick. Every fire ticker also prints in every
 * CONTINUITY_BUCKET_MINUTES bucket of the session (0 empty buckets in 13,026
 * probes, 2026-09-29..10-01), so a quiet bucket means uw-stream (or its
 * shard) was down, not that nobody traded. A window is `tapeGap` (never
 * locked) when:
 *   - any bucket between its entry and the close is empty for its ticker
 *     (a mid-session outage, even one that recovered before the close), or
 *   - its ticker printed nothing in the close tail
 *     [close - TAPE_TAIL_MINUTES, close + LATE_PRINT_MINUTES].
 * A live ticker with no print on the contract is `noPrints` (the entry print
 * itself is missing), also never locked.
 * Not detected: a gap shorter than one bucket, or a loss of only some of a
 * ticker's prints while others keep arriving.
 */

import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import { etWallClockToUtcIso } from '../../src/utils/timezone.js';
import { TransientDbError, withDbRetry, type getDb } from './db.js';
import type logger from './logger.js';
import { Sentry } from './sentry.js';

type Sql = ReturnType<typeof getDb>;
type DbNumeric = string | number;
type DbTimestamp = string | Date;

/** ETF/index options print until 16:15 ET; single names stop at 16:00. */
export const LATE_PRINT_MINUTES = 15;

/** Every fire ticker prints in the last 10 min before the close. */
export const TAPE_TAIL_MINUTES = 10;

/** uw-stream lands prints within seconds; 5 min covers a slow batch. */
export const SETTLE_GRACE_MINUTES = 5;

/**
 * Feed-continuity bucket. Every fire ticker printed in every 5-min bucket of
 * the session on 2026-09-29..10-01 (0 of 13,026 empty); the probe costs
 * ~70 ms for two days of ~45 tickers.
 */
export const CONTINUITY_BUCKET_MINUTES = 5;

/**
 * Fires per aggregate statement. Measured on prod 2026-10-02 over all 4,400
 * fires of 2026-10-01 (6.17M tick visits): chain-grouped 100-fire chunks
 * ran 0.4-4 s each, worst 11.7 s cold, 109 s for the whole day, so a chunk
 * stays well inside the 30 s per-attempt timeout.
 */
export const READ_CHUNK_SIZE = 100;

export interface SessionTapeBounds {
  /** 09:30 ET: start of the feed-continuity probe. */
  openAt: Date;
  /** The NYSE close: end of the feed-continuity probe. */
  closeAt: Date;
  /** Start of the ticker liveness tail (close - TAPE_TAIL_MINUTES). */
  tailStart: Date;
  /** Upper bound of every tape read for this date. */
  tapeEnd: Date;
  /** No print for this date can still land after this instant. */
  settledAt: Date;
}

/** 09:30 ET in minutes past midnight. */
const OPEN_MIN_ET = 9 * 60 + 30;

/**
 * Tape bounds for one ET trade date: the NYSE open and close (13:00 ET on
 * early-close days), the late-print allowance, and the settle instant.
 * Returns null for an unparseable date. A full-holiday date (no fires are
 * expected) falls back to the regular 16:00 close.
 */
export function sessionTapeBounds(date: string): SessionTapeBounds | null {
  const closeMinEt = (getMarketCloseHourET(date) ?? 16) * 60;
  const isos = [
    etWallClockToUtcIso(date, OPEN_MIN_ET),
    etWallClockToUtcIso(date, closeMinEt),
    etWallClockToUtcIso(date, closeMinEt - TAPE_TAIL_MINUTES),
    etWallClockToUtcIso(date, closeMinEt + LATE_PRINT_MINUTES),
  ];
  if (isos.includes(null)) return null;
  const [openAt, closeAt, tailStart, tapeEnd] = isos.map(
    (iso) => new Date(iso!),
  ) as [Date, Date, Date, Date];
  return {
    openAt,
    closeAt,
    tailStart,
    tapeEnd,
    settledAt: new Date(tapeEnd.getTime() + SETTLE_GRACE_MINUTES * 60_000),
  };
}

/** One fire (or alert) whose tape is read by the aggregate statement. */
export interface OutcomeWindow {
  /** Row id, normalized to a number (int8 arrives as a string). */
  id: number;
  /** ws_option_trades.option_chain of the fired contract. */
  chain: string;
  /** ws_option_trades.ticker of the contract (the liveness probe). */
  ticker: string;
  /** ET trade date (YYYY-MM-DD) the window belongs to. */
  date: string;
  /** First instant of the tape window (the entry print). */
  entry: Date;
  /** Entry price, > 0. */
  entryPx: number;
  tailStart: Date;
  tapeEnd: Date;
}

/**
 * Split windows into read chunks of at most READ_CHUNK_SIZE, keeping every
 * (chain, date) group whole whenever it fits. The fires on one chain read
 * the same ws_option_trades rows, so reading them in one statement turns
 * all but the first scan into shared-buffer hits (prod: 345K hits / 1 read
 * for 147 fires on 3 chains). Groups keep their first-seen order, so a
 * newest-first input stays newest-first at group granularity.
 */
export function chunkByChain<W extends { chain: string; date: string }>(
  windows: readonly W[],
): W[][] {
  const size = READ_CHUNK_SIZE;
  const groups = new Map<string, W[]>();
  for (const w of windows) {
    const key = `${w.chain}|${w.date}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [w]);
    else group.push(w);
  }
  const chunks: W[][] = [];
  let current: W[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += size) {
      const slice = group.slice(i, i + size);
      if (current.length > 0 && current.length + slice.length > size) {
        chunks.push(current);
        current = [];
      }
      current.push(...slice);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * ONE statement, ONE row per window. Per unnest row:
 *   - g: EXISTS any print on the ticker in the liveness tail
 *     (ws_option_trades_ticker_executed_idx; stops at the first hit).
 *     OFFSET 0 keeps the planner from re-running it per joined row.
 *   - a: one pass over the contract's prints in [entry, tape_end]
 *     (ws_option_trades_chain_executed_idx) in (executed_at, id) order,
 *     with r = return % vs entry, row number rn, the running max of r and
 *     whether r has reached +30% yet. Aggregates pick single prints with
 *     min/max over ARRAY[rn, px] (no extra sort):
 *       last_px        last print                        (EOD)
 *       hN_px          last print at or before entry+N    (hard stop, horizons)
 *       tier1_px       first print with r >= 50           (tier-50 first half)
 *       trail_exit_px  first print after the trail armed (r >= 30) with
 *                      r <= running-max r - 10           (trail 30/10 exit)
 *       peak_px        max price; peak_minutes = earliest minute at that max
 *     r is computed in float8 exactly as the JS policies compute it, so the
 *     threshold comparisons agree bit for bit.
 * Bind order: ids, chains, tickers, entries, entry prices, tape ends,
 * tail starts. ids are bigint[] (BIGSERIAL; numbers on the way in).
 */
export function buildOutcomeAggregateStatement(
  chunk: readonly OutcomeWindow[],
): { text: string; params: unknown[] } {
  const text = `
    SELECT u.id AS window_id, g.tape_live, a.ticks, a.peak_px, a.peak_minutes,
           a.last_px, a.h30_px, a.h60_px, a.h120_px, a.tier1_px,
           a.trail_exit_px
      FROM unnest(
             $1::bigint[], $2::text[], $3::text[], $4::timestamptz[],
             $5::float8[], $6::timestamptz[], $7::timestamptz[]
           ) AS u(id, chain, ticker, entry, entry_px, tape_end, tail_start)
      CROSS JOIN LATERAL (
             SELECT EXISTS (
                      SELECT 1
                        FROM ws_option_trades
                       WHERE ticker = u.ticker
                         AND executed_at >= u.tail_start
                         AND executed_at <= u.tape_end
                    ) AS tape_live
             OFFSET 0
           ) g
      CROSS JOIN LATERAL (
             SELECT count(*)::int AS ticks,
                    max(w.px) AS peak_px,
                    (min(ARRAY[-w.px, w.mins]))[2] AS peak_minutes,
                    (max(ARRAY[w.rn, w.px]))[2] AS last_px,
                    (max(ARRAY[w.rn, w.px])
                       FILTER (WHERE w.executed_at <= u.entry + interval '30 minutes'))[2] AS h30_px,
                    (max(ARRAY[w.rn, w.px])
                       FILTER (WHERE w.executed_at <= u.entry + interval '60 minutes'))[2] AS h60_px,
                    (max(ARRAY[w.rn, w.px])
                       FILTER (WHERE w.executed_at <= u.entry + interval '120 minutes'))[2] AS h120_px,
                    (min(ARRAY[w.rn, w.px]) FILTER (WHERE w.r >= 50))[2] AS tier1_px,
                    (min(ARRAY[w.rn, w.px])
                       FILTER (WHERE w.armed AND w.r <= w.run_max_r - 10))[2] AS trail_exit_px
               FROM (
                      SELECT s.executed_at, s.px, s.r, s.mins,
                             (row_number() OVER o)::float8 AS rn,
                             max(s.r) OVER o AS run_max_r,
                             bool_or(s.r >= 30) OVER o AS armed
                        FROM (
                               SELECT t.id, t.executed_at,
                                      t.price::float8 AS px,
                                      (t.price::float8 - u.entry_px) / u.entry_px * 100 AS r,
                                      extract(epoch FROM t.executed_at - u.entry)::float8 / 60 AS mins
                                 FROM ws_option_trades t
                                WHERE t.option_chain = u.chain
                                  AND t.executed_at >= u.entry
                                  AND t.executed_at <= u.tape_end
                                  AND t.canceled = FALSE
                                  AND t.price > 0
                             ) s
                      WINDOW o AS (ORDER BY s.executed_at, s.id
                                   ROWS UNBOUNDED PRECEDING)
                    ) w
           ) a
     ORDER BY u.id
  `;
  return {
    text,
    params: [
      chunk.map((w) => w.id),
      chunk.map((w) => w.chain),
      chunk.map((w) => w.ticker),
      chunk.map((w) => w.entry.toISOString()),
      chunk.map((w) => w.entryPx),
      chunk.map((w) => w.tapeEnd.toISOString()),
      chunk.map((w) => w.tailStart.toISOString()),
    ],
  };
}

/** One aggregate row as the driver returns it (int8 / float8 may be strings). */
export interface OutcomeAggregateRow {
  window_id: DbNumeric;
  tape_live: boolean | null;
  ticks: DbNumeric | null;
  peak_px: DbNumeric | null;
  peak_minutes: DbNumeric | null;
  last_px: DbNumeric | null;
  h30_px: DbNumeric | null;
  h60_px: DbNumeric | null;
  h120_px: DbNumeric | null;
  tier1_px: DbNumeric | null;
  trail_exit_px: DbNumeric | null;
}

/** Run one chunk's aggregate statement. A DB error propagates. */
export async function readOutcomeAggregates(
  sql: Sql,
  chunk: readonly OutcomeWindow[],
): Promise<OutcomeAggregateRow[]> {
  const { text, params } = buildOutcomeAggregateStatement(chunk);
  return (await withDbRetry(
    () => sql.query(text, params),
    2,
    30_000,
  )) as OutcomeAggregateRow[];
}

/** Index aggregate rows by window id, normalizing the int8 id to a number. */
export function aggregatesById(
  rows: readonly OutcomeAggregateRow[],
): Map<number, OutcomeAggregateRow> {
  return new Map(rows.map((r) => [Number(r.window_id), r]));
}

/** One (ticker, ET date) session probed for feed continuity. */
export interface TickerSession {
  ticker: string;
  date: string;
  openAt: Date;
  closeAt: Date;
}

const BUCKET_MS = CONTINUITY_BUCKET_MINUTES * 60_000;

/**
 * ONE statement listing every empty CONTINUITY_BUCKET_MINUTES bucket in
 * [open, close) per (ticker, date) session. Each bucket is an EXISTS probe on
 * ws_option_trades_ticker_executed_idx that stops at the first print, so a
 * healthy session costs one index seek per bucket (~70 ms for 87 sessions of
 * 78 buckets on prod). Bind order: tickers, dates, opens, closes.
 */
export function buildContinuityGapStatement(
  sessions: readonly TickerSession[],
): { text: string; params: unknown[] } {
  const text = `
    SELECT p.ticker, p.date::text AS date, b.start AS gap_start
      FROM unnest($1::text[], $2::date[], $3::timestamptz[], $4::timestamptz[])
             AS p(ticker, date, open_at, close_at)
      CROSS JOIN LATERAL generate_series(
             p.open_at,
             p.close_at - interval '${CONTINUITY_BUCKET_MINUTES} minutes',
             interval '${CONTINUITY_BUCKET_MINUTES} minutes'
           ) AS b(start)
     WHERE NOT EXISTS (
             SELECT 1
               FROM ws_option_trades t
              WHERE t.ticker = p.ticker
                AND t.executed_at >= b.start
                AND t.executed_at < b.start + interval '${CONTINUITY_BUCKET_MINUTES} minutes'
           )
     ORDER BY p.ticker, p.date, b.start
  `;
  return {
    text,
    params: [
      sessions.map((s) => s.ticker),
      sessions.map((s) => s.date),
      sessions.map((s) => s.openAt.toISOString()),
      sessions.map((s) => s.closeAt.toISOString()),
    ],
  };
}

const sessionKey = (ticker: string, date: string): string =>
  `${ticker}|${date}`;

/**
 * Empty-bucket starts per (ticker, date) for every session the windows
 * touch. A DB error propagates; a malformed row throws (a gap must never
 * be silently dropped).
 */
export async function readContinuityGaps(
  sql: Sql,
  windows: readonly OutcomeWindow[],
): Promise<Map<string, Date[]>> {
  const sessions = new Map<string, TickerSession>();
  for (const w of windows) {
    const key = sessionKey(w.ticker, w.date);
    if (sessions.has(key)) continue;
    const bounds = sessionTapeBounds(w.date);
    if (bounds === null) continue; // prepareWindows already rejected it
    sessions.set(key, {
      ticker: w.ticker,
      date: w.date,
      openAt: bounds.openAt,
      closeAt: bounds.closeAt,
    });
  }
  const gaps = new Map<string, Date[]>();
  if (sessions.size === 0) return gaps;
  const { text, params } = buildContinuityGapStatement([...sessions.values()]);
  const rows = (await withDbRetry(
    () => sql.query(text, params),
    2,
    30_000,
  )) as Array<{ ticker: string; date: string; gap_start: DbTimestamp }>;
  for (const r of rows) {
    const start =
      r.gap_start instanceof Date ? r.gap_start : new Date(r.gap_start);
    if (typeof r.ticker !== 'string' || Number.isNaN(start.getTime())) {
      throw new Error(
        `option-outcome-aggregate: malformed continuity row ${JSON.stringify(r)}`,
      );
    }
    const key = sessionKey(r.ticker, r.date);
    const list = gaps.get(key);
    if (list === undefined) gaps.set(key, [start]);
    else list.push(start);
  }
  return gaps;
}

/** True when an empty bucket ends after the window's entry. */
export function windowHitsGap(
  w: OutcomeWindow,
  gaps: ReadonlyMap<string, readonly Date[]>,
): boolean {
  const list = gaps.get(sessionKey(w.ticker, w.date));
  if (list === undefined) return false;
  const entryMs = w.entry.getTime();
  return list.some((g) => g.getTime() + BUCKET_MS > entryMs);
}

/** A fully-priced aggregate: every price is finite and > 0. */
export interface PricedAggregate {
  ticks: number;
  peakPx: number;
  peakMinutes: number;
  lastPx: number;
  h30Px: number | null;
  h60Px: number | null;
  h120Px: number | null;
  tier1Px: number | null;
  trailExitPx: number | null;
}

export type AggregateVerdict =
  | { kind: 'priced'; agg: PricedAggregate }
  /** Ticker tail quiet: the feed was down at the close. */
  | { kind: 'tapeGap' }
  /** Ticker live but no print on the contract (entry print missing). */
  | { kind: 'noPrints' }
  /** Missing, partial or malformed aggregate: never lock it. */
  | { kind: 'unreadable' };

const UNREADABLE: AggregateVerdict = { kind: 'unreadable' };

/** undefined = malformed; null = SQL NULL; else a finite positive price. */
function parsePrice(v: DbNumeric | null): number | null | undefined {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Validate one aggregate row. Anything not fully consistent is
 * `unreadable` so a partial or garbled read can never be locked as an
 * outcome.
 */
export function classifyAggregate(
  row: OutcomeAggregateRow | undefined,
): AggregateVerdict {
  if (row === undefined || typeof row.tape_live !== 'boolean') {
    return UNREADABLE;
  }
  const ticks = row.ticks == null ? Number.NaN : Number(row.ticks);
  if (!Number.isInteger(ticks) || ticks < 0) return UNREADABLE;
  if (!row.tape_live) return { kind: 'tapeGap' };
  if (ticks === 0) return { kind: 'noPrints' };

  const peakPx = parsePrice(row.peak_px);
  const lastPx = parsePrice(row.last_px);
  const h30Px = parsePrice(row.h30_px);
  const h60Px = parsePrice(row.h60_px);
  const h120Px = parsePrice(row.h120_px);
  const tier1Px = parsePrice(row.tier1_px);
  const trailExitPx = parsePrice(row.trail_exit_px);
  const peakMinutes =
    row.peak_minutes == null ? Number.NaN : Number(row.peak_minutes);
  if (
    peakPx == null ||
    lastPx == null ||
    h30Px === undefined ||
    h60Px === undefined ||
    h120Px === undefined ||
    tier1Px === undefined ||
    trailExitPx === undefined ||
    !Number.isFinite(peakMinutes) ||
    peakMinutes < 0
  ) {
    return UNREADABLE;
  }
  // The peak is the max of every print, so no selected print can exceed it.
  const selected = [lastPx, h30Px, h60Px, h120Px, tier1Px, trailExitPx];
  if (selected.some((px) => px !== null && px > peakPx)) return UNREADABLE;

  return {
    kind: 'priced',
    agg: {
      ticks,
      peakPx,
      peakMinutes,
      lastPx,
      h30Px,
      h60Px,
      h120Px,
      tier1Px,
      trailExitPx,
    },
  };
}

/** Realized outcomes, % of entry, matching lottery-exit-policies.ts. */
export interface RealizedOutcomes {
  /** peakCeiling */
  peakPct: number;
  /** minutesToPeak */
  minutesToPeak: number;
  /** last print */
  eodPct: number;
  /** realizedTrailAct30Trail10 */
  trail30_10Pct: number;
  /** realizedHardStop30m (0 when nothing printed in the first 30 min) */
  hard30mPct: number;
  /** realizedTier50HoldEod */
  tier50Pct: number;
  /** last print at or before +30/+60/+120 min; null when none */
  r30Pct: number | null;
  r60Pct: number | null;
  r120Pct: number | null;
}

/** Turn a priced aggregate into the realized-outcome percentages. */
export function realizedFromAggregate(
  agg: PricedAggregate,
  entryPx: number,
): RealizedOutcomes {
  const pct = (px: number): number => ((px - entryPx) / entryPx) * 100;
  const eodPct = pct(agg.lastPx);
  return {
    peakPct: pct(agg.peakPx),
    minutesToPeak: agg.peakMinutes,
    eodPct,
    trail30_10Pct: agg.trailExitPx === null ? eodPct : pct(agg.trailExitPx),
    hard30mPct: agg.h30Px === null ? 0 : pct(agg.h30Px),
    tier50Pct: agg.tier1Px === null ? eodPct : (pct(agg.tier1Px) + eodPct) / 2,
    r30Pct: agg.h30Px === null ? null : pct(agg.h30Px),
    r60Pct: agg.h60Px === null ? null : pct(agg.h60Px),
    r120Pct: agg.h120Px === null ? null : pct(agg.h120Px),
  };
}

// ============================================================
// The enrichment pass shared by the lottery and silent-boom crons
// ============================================================

/** A candidate row, normalized by the caller from its own table. */
export interface OutcomeCandidate {
  /** int8 id as the driver returns it (string or number). */
  id: DbNumeric;
  chain: string;
  ticker: string;
  /** ET trade date, YYYY-MM-DD (select it as `date::text`). */
  date: string;
  /** Start of the outcome window (the entry print / spike bucket). */
  entry: DbTimestamp;
  entryPx: DbNumeric | null;
}

export interface PreparedWindows {
  windows: OutcomeWindow[];
  /** Unusable entry price, entry time or date: never read. */
  skipped: number;
  /** Session not settled yet: read on a later run. */
  inFlight: number;
}

/**
 * Turn candidates into readable windows. A window is read only once its
 * session has settled (close + late prints + ingest grace), so a manual
 * mid-session run never locks a fire on a partial tape.
 */
export function prepareWindows(
  candidates: readonly OutcomeCandidate[],
  nowMs: number,
): PreparedWindows {
  const out: PreparedWindows = { windows: [], skipped: 0, inFlight: 0 };
  for (const c of candidates) {
    const entryPx = c.entryPx == null ? Number.NaN : Number(c.entryPx);
    const entry = c.entry instanceof Date ? c.entry : new Date(c.entry);
    const bounds = sessionTapeBounds(c.date);
    if (
      !Number.isFinite(entryPx) ||
      entryPx <= 0 ||
      Number.isNaN(entry.getTime()) ||
      bounds === null ||
      // Outside the date's session: the window (and the continuity probe,
      // which starts at the open) would not cover it.
      entry < bounds.openAt ||
      entry > bounds.tapeEnd
    ) {
      out.skipped += 1;
      continue;
    }
    if (bounds.settledAt.getTime() > nowMs) {
      out.inFlight += 1;
      continue;
    }
    out.windows.push({
      id: Number(c.id),
      chain: c.chain,
      ticker: c.ticker,
      date: c.date,
      entry,
      entryPx,
      tailStart: bounds.tailStart,
      tapeEnd: bounds.tapeEnd,
    });
  }
  return out;
}

export interface OutcomePassOptions<U> {
  /** Cron name: log prefix + Sentry fingerprint. */
  job: string;
  /** What an operator runs once a gap ages out of the retention window. */
  recovery: string;
  logger: typeof logger;
  /** Epoch ms after which no new chunk starts; the rest is deferred. */
  deadlineMs: number;
  /** Map one priced window to the caller's UPDATE row. */
  toUpdate: (w: OutcomeWindow, outcomes: RealizedOutcomes) => U;
  /**
   * Write one chunk's rows with a conditional UPDATE ... RETURNING and
   * return how many rows it locked. A rejection propagates.
   */
  lock: (updates: U[]) => Promise<number>;
}

export interface OutcomePassResult {
  locked: number;
  /** Priced, but a concurrent run locked the row first. */
  alreadyLocked: number;
  /** Windows left for the next run by the deadline. */
  deferred: number;
  tapeGapIds: number[];
  noPrintsIds: number[];
  unreadableIds: number[];
  /** Windows whose tape read kept timing out even when read alone. */
  readFailedIds: number[];
}

/** Ids named in a log/Sentry payload, so a bad night stays readable. */
const MAX_LISTED_IDS = 50;

interface ChunkRead {
  rows: Map<number, OutcomeAggregateRow>;
  /** Single windows whose read still exhausted its retries. */
  readFailedIds: number[];
  /** Halves not started because the deadline passed mid-bisection. */
  deferredIds: number[];
}

/**
 * Read one chunk's aggregates. A retry-exhausted transient failure
 * (TransientDbError: the statement kept timing out, e.g. two cold TSLA 0DTE
 * chains; 116 fires on two 09-30 chains took ~11.3 s cold) splits the chunk
 * in half and reads each half, down to single windows. A window that still
 * fails alone is returned in readFailedIds instead of throwing. Otherwise
 * that chunk would head every later run (newest-first order is
 * deterministic) and the windows behind it would age out unread. A genuine
 * (non-transient) error propagates. No half starts after the deadline.
 */
async function readChunkBisecting(
  sql: Sql,
  chunk: readonly OutcomeWindow[],
  deadlineMs: number,
): Promise<ChunkRead> {
  try {
    return {
      rows: aggregatesById(await readOutcomeAggregates(sql, chunk)),
      readFailedIds: [],
      deferredIds: [],
    };
  } catch (err) {
    if (!(err instanceof TransientDbError)) throw err;
    const out: ChunkRead = {
      rows: new Map(),
      readFailedIds: [],
      deferredIds: [],
    };
    if (chunk.length === 1) {
      out.readFailedIds.push(chunk[0]!.id);
      return out;
    }
    const mid = Math.ceil(chunk.length / 2);
    for (const half of [chunk.slice(0, mid), chunk.slice(mid)]) {
      if (Date.now() > deadlineMs) {
        out.deferredIds.push(...half.map((w) => w.id));
        continue;
      }
      const read = await readChunkBisecting(sql, half, deadlineMs);
      for (const [id, row] of read.rows) out.rows.set(id, row);
      out.readFailedIds.push(...read.readFailedIds);
      out.deferredIds.push(...read.deferredIds);
    }
    return out;
  }
}

/**
 * Read + lock chain-grouped chunk by chunk until the deadline. Windows whose
 * ticker shows a feed gap after their entry are tapeGap without being read.
 * Only priced windows are written; tapeGap / noPrints / unreadable /
 * read-failed windows are never stamped (they stay candidates and are
 * retried). A chunk whose read keeps timing out is bisected (see
 * readChunkBisecting). A genuine DB error propagates, after the anomaly
 * report for the windows already classified.
 */
export async function enrichOutcomeWindows<U>(
  sql: Sql,
  windows: readonly OutcomeWindow[],
  opts: OutcomePassOptions<U>,
): Promise<OutcomePassResult> {
  const result: OutcomePassResult = {
    locked: 0,
    alreadyLocked: 0,
    deferred: 0,
    tapeGapIds: [],
    noPrintsIds: [],
    unreadableIds: [],
    readFailedIds: [],
  };
  try {
    const gaps = await readContinuityGaps(sql, windows);
    const readable: OutcomeWindow[] = [];
    for (const w of windows) {
      if (windowHitsGap(w, gaps)) result.tapeGapIds.push(w.id);
      else readable.push(w);
    }
    const chunks = chunkByChain(readable);
    for (const [i, chunk] of chunks.entries()) {
      if (Date.now() > opts.deadlineMs) {
        result.deferred += chunks.slice(i).reduce((n, c) => n + c.length, 0);
        break;
      }
      const read = await readChunkBisecting(sql, chunk, opts.deadlineMs);
      result.readFailedIds.push(...read.readFailedIds);
      result.deferred += read.deferredIds.length;
      const unread = new Set([...read.readFailedIds, ...read.deferredIds]);
      const updates: U[] = [];
      for (const w of chunk) {
        if (unread.has(w.id)) continue;
        const verdict = classifyAggregate(read.rows.get(w.id));
        if (verdict.kind === 'priced') {
          updates.push(
            opts.toUpdate(w, realizedFromAggregate(verdict.agg, w.entryPx)),
          );
        } else if (verdict.kind === 'tapeGap') {
          result.tapeGapIds.push(w.id);
        } else if (verdict.kind === 'noPrints') {
          result.noPrintsIds.push(w.id);
        } else {
          result.unreadableIds.push(w.id);
        }
      }
      if (updates.length > 0) {
        const locked = await opts.lock(updates);
        result.locked += locked;
        result.alreadyLocked += updates.length - locked;
      }
    }
  } finally {
    // In `finally` so windows classified before a later chunk throws are
    // still named.
    reportOutcomeAnomalies(opts, result);
  }
  return result;
}

/**
 * Fingerprinted Sentry events per run: one for missing tape (feed gap or
 * no contract print), one for unreadable aggregates (the SQL returns one
 * row per window, so an unreadable row means a bug, not market data), and
 * one naming the windows whose tape read kept failing even alone.
 */
function reportOutcomeAnomalies<U>(
  opts: OutcomePassOptions<U>,
  r: OutcomePassResult,
): void {
  if (r.readFailedIds.length > 0) {
    const message =
      `${opts.job}: ${r.readFailedIds.length} row(s) whose tape read kept ` +
      'timing out even when read alone (retry-exhausted); left unenriched ' +
      'and retried next run';
    const detail = {
      readFailed: r.readFailedIds.length,
      readFailedIds: r.readFailedIds.slice(0, MAX_LISTED_IDS),
    };
    opts.logger.error(detail, message);
    Sentry.captureMessage(message, {
      level: 'error',
      fingerprint: [opts.job, 'read-failed'],
      tags: { 'cron.anomaly': `${opts.job}-read-failed` },
      extra: detail,
    });
  }
  if (r.unreadableIds.length > 0) {
    const message =
      `${opts.job}: ${r.unreadableIds.length} unreadable aggregate row(s) ` +
      '(missing or inconsistent); left unenriched';
    const detail = {
      unreadable: r.unreadableIds.length,
      unreadableIds: r.unreadableIds.slice(0, MAX_LISTED_IDS),
    };
    opts.logger.warn(detail, message);
    Sentry.captureMessage(message, {
      level: 'warning',
      fingerprint: [opts.job, 'unreadable-aggregate'],
      tags: { 'cron.anomaly': `${opts.job}-unreadable-aggregate` },
      extra: detail,
    });
  }
  if (r.tapeGapIds.length === 0 && r.noPrintsIds.length === 0) return;
  const message =
    `${opts.job}: ${r.tapeGapIds.length} row(s) whose ticker tape has a ` +
    'gap after entry or a quiet close tail (ws_option_trades outage, e.g. ' +
    `uw-stream down) and ${r.noPrintsIds.length} with no print on the ` +
    'contract; left unenriched. Retried while inside the retention window; ' +
    `after that run ${opts.recovery}`;
  const detail = {
    tapeGap: r.tapeGapIds.length,
    noPrints: r.noPrintsIds.length,
    tapeGapIds: r.tapeGapIds.slice(0, MAX_LISTED_IDS),
    noPrintsIds: r.noPrintsIds.slice(0, MAX_LISTED_IDS),
  };
  opts.logger.warn(detail, message);
  Sentry.captureMessage(message, {
    level: 'warning',
    fingerprint: [opts.job, 'missing-tape'],
    tags: { 'cron.anomaly': `${opts.job}-missing-tape` },
    extra: detail,
  });
}

/**
 * Cron status for a finished pass: a feed gap or a read that kept failing
 * pages; missing or unreadable rows degrade.
 */
export function outcomePassStatus(
  r: OutcomePassResult,
): 'success' | 'partial' | 'error' {
  if (r.tapeGapIds.length > 0 || r.readFailedIds.length > 0) return 'error';
  return r.noPrintsIds.length + r.unreadableIds.length > 0
    ? 'partial'
    : 'success';
}
