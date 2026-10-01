/**
 * GET /api/cron/backfill-futures-gaps
 *
 * Daily gap repair for `futures_bars`. Live bars come from the uw-stream
 * `futures_trades` handler (`uw-stream/src/handlers/futures_trades.py`);
 * this cron finds holes it left over the three prior UTC days — deploys,
 * lease handoffs, websocket drops — and refills them from Unusual Whales
 * REST 1-minute candles.
 *
 *   1. Gap detection (Postgres only): any CME Globex-open minute with no
 *      bar — a deploy or lease handoff typically drops 1–2. Halts and
 *      weekends don't count. A genuinely untraded minute also reads as a
 *      gap (ZN/RTY go quiet for up to ~4 minutes overnight), which only
 *      costs the UW calls: UW has no candle for it, so nothing is
 *      inserted. A run with no gaps makes no UW calls.
 *   2. Front month: `GET /futures/contracts?days=5` (volume ranked over
 *      the 5 sessions the candles span), the six roots filtered by EXACT
 *      `product` (`q=ES` would also match MES/EST) with spreads excluded,
 *      top FRONT_MONTH_CANDIDATES by volume.
 *   3. `GET /futures/{contract}/candles?interval=1m&range=5d` per
 *      candidate, then the uw-stream rule replayed per minute: the
 *      contract with the larger cumulative UTC-day volume is the front
 *      month, ties to the larger symbol, and a minute where the leader
 *      has no candle stays empty (never back-filled from another month,
 *      which trades at a carry basis). This keeps repaired minutes on
 *      the same contract the live handler would have written, including
 *      through a roll — for an uninterrupted live handler. Its tally is
 *      in-memory, so a mid-day uw-stream restart restarts it from zero;
 *      on a roll day the two can then pick different months for a minute.
 *   4. Batched `INSERT … SELECT FROM unnest(…) ON CONFLICT (symbol, ts)
 *      DO NOTHING` for the leader's bars inside each gap. DO NOTHING
 *      never overwrites a bar the live handler wrote.
 *
 * Candle `start` is the bar's minute (UTC), which is exactly the
 * handler's `ts` (executed_at floored to the minute); `symbol` is the
 * root ('ES'), not the contract.
 *
 * Failures surface: a UW error, an empty or malformed payload, or a DB
 * reject fails that symbol (Sentry exception); the run reports
 * 'partial' / 'error' via deriveCronStatus, and 'error' turns the Sentry
 * cron monitor red. The Databento version swallowed non-OK responses and
 * reported success.
 *
 * Depth: UW caps 1m candles at 5,000 rows and keeps the NEWEST (probed
 * 2026-09-30: `range=1w` → first 09-24 15:16Z, last = the in-progress
 * minute), ≈3.5 trading days. That still reaches the window start of a
 * 06:00 UTC run on every weekday; a capped payload that doesn't reach
 * the oldest gap fails the symbol rather than reporting a clean run. The
 * in-progress minute is never written: the window ends at 00:00 UTC.
 *
 * Schedule: 0 6 * * 1-6 (06:00 UTC, after the previous UTC day closes).
 *
 * Environment: CRON_SECRET, UW_API_KEY
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { uwFetch, withRetry } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  deriveCronStatus,
  type CronContext,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { isFuturesMarketOpen } from '../../src/utils/timezone.js';

// Worst case is ~13 UW calls (1 contracts + 2 candles × 6 roots), each up
// to 3 attempts × 15s timeout plus backoff under withRetry ≈ 48s → ~10
// min if UW hangs on every call. Typical runs finish in seconds.
export const config = {
  maxDuration: 800,
};

// ── Constants ───────────────────────────────────────────────

const JOB = 'backfill-futures-gaps';

// Mirrors `_TARGET_PRODUCTS` in the uw-stream futures_trades handler.
// DX (ICE) and VX (Cboe CFE) have no UW source.
const SYMBOLS = ['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN'] as const;

const LOOKBACK_DAYS = 3;
// Front + next month: the pair a roll moves between.
const FRONT_MONTH_CANDIDATES = 2;
const INSERT_CHUNK = 500;
// UW's documented-by-probe ceiling on one 1m candle response.
const UW_CANDLE_ROW_CAP = 5000;
// NUMERIC(12,4) ceiling — a larger value would reject the whole chunk.
const MAX_PRICE = 99_999_999;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// ── Types ───────────────────────────────────────────────────

type FuturesRoot = (typeof SYMBOLS)[number];

interface Bar {
  ts: string; // ISO minute, UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Bars are missing strictly between `prevMs` and `nextMs`. */
interface Gap {
  prevMs: number;
  nextMs: number;
  /** Globex-open minutes strictly inside the gap. */
  openMinutes: number;
}

interface GapRow {
  symbol: string;
  prev_bar: Date | string;
  next_bar: Date | string;
}

interface SymbolResult {
  contracts: string[];
  /** Total Globex-open minutes missing across the symbol's gaps. */
  gapMinutes: number;
  inserted: number;
  malformed: number;
}

// ── Gap detection ───────────────────────────────────────────

/** Globex-open minutes strictly between two bars. */
function countOpenMinutes(prevMs: number, nextMs: number): number {
  let open = 0;
  for (let t = prevMs + MINUTE_MS; t < nextMs; t += MINUTE_MS) {
    if (isFuturesMarketOpen(new Date(t))) open += 1;
  }
  return open;
}

/**
 * Per root, the missing intervals that contain at least one Globex-open
 * minute. Sentinel rows at both window edges make a hole touching either
 * edge — or a root with no bars at all — pair up like any other.
 */
async function detectGaps(
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<FuturesRoot, Gap[]>> {
  const sql = getDb();
  const startIso = windowStart.toISOString();
  const endIso = windowEnd.toISOString();
  const symbols = [...SYMBOLS];

  const rows = (await withDbRetry(
    () => sql`
      WITH bars AS (
        SELECT symbol, ts
        FROM futures_bars
        WHERE symbol = ANY(${symbols}::text[])
          AND ts >= ${startIso}::timestamptz
          AND ts < ${endIso}::timestamptz
        UNION ALL
        SELECT s, ${startIso}::timestamptz - interval '1 minute'
        FROM unnest(${symbols}::text[]) AS s
        UNION ALL
        SELECT s, ${endIso}::timestamptz
        FROM unnest(${symbols}::text[]) AS s
      ),
      paired AS (
        SELECT symbol, ts,
               LEAD(ts) OVER (PARTITION BY symbol ORDER BY ts) AS next_ts
        FROM bars
      )
      SELECT symbol, ts AS prev_bar, next_ts AS next_bar
      FROM paired
      WHERE next_ts - ts > interval '1 minute'
      ORDER BY symbol, ts
    `,
    2,
    10_000,
  )) as GapRow[];

  const gaps = new Map<FuturesRoot, Gap[]>();
  for (const row of rows) {
    const symbol = SYMBOLS.find((s) => s === row.symbol);
    if (!symbol) continue;
    const prevMs = new Date(row.prev_bar).getTime();
    const nextMs = new Date(row.next_bar).getTime();
    const openMinutes = countOpenMinutes(prevMs, nextMs);
    if (openMinutes === 0) continue;
    const list = gaps.get(symbol) ?? [];
    list.push({ prevMs, nextMs, openMinutes });
    gaps.set(symbol, list);
  }
  return gaps;
}

// ── UW payload parsing ──────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Top candidates for a root, most active first (volume, then name). */
function frontMonthCandidates(contracts: unknown[], root: string): string[] {
  const rows: Array<{ name: string; volume: number }> = [];
  for (const c of contracts) {
    if (!isRecord(c) || c.product !== root || c.is_spread === true) continue;
    if (typeof c.name !== 'string' || c.name === '') continue;
    rows.push({
      name: c.name,
      volume: typeof c.volume === 'number' ? c.volume : 0,
    });
  }
  // Codepoint order on ties, like the replay below (names are unique).
  rows.sort((a, b) => b.volume - a.volume || (a.name < b.name ? 1 : -1));
  return rows.slice(0, FRONT_MONTH_CANDIDATES).map((r) => r.name);
}

function parsePrice(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= MAX_PRICE ? n : null;
}

function parseCandle(raw: unknown): Bar | null {
  if (!isRecord(raw) || typeof raw.start !== 'string') return null;
  const startMs = Date.parse(raw.start);
  if (!Number.isFinite(startMs) || startMs % MINUTE_MS !== 0) return null;
  const open = parsePrice(raw.o);
  const high = parsePrice(raw.h);
  const low = parsePrice(raw.l);
  const close = parsePrice(raw.c);
  if (open === null || high === null || low === null || close === null) {
    return null;
  }
  if (low > Math.min(open, close) || high < Math.max(open, close)) return null;
  const volume = raw.v;
  if (typeof volume !== 'number' || !Number.isSafeInteger(volume)) return null;
  if (volume < 0) return null;
  return {
    ts: new Date(startMs).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };
}

// ── Front-month replay ──────────────────────────────────────

/**
 * Replays the uw-stream front-month rule over per-contract candles: per
 * minute, add every contract's volume to a UTC-day tally (reset at each
 * new UTC date), then emit the tally leader's bar if it has one. Ties go
 * to the larger contract symbol, matching Python's
 * `max(tally.items(), key=lambda kv: (kv[1], kv[0]))`.
 */
function selectFrontMonthBars(byContract: Map<string, Bar[]>): Bar[] {
  const byMinute = new Map<string, Map<string, Bar>>();
  for (const [contract, bars] of byContract) {
    for (const bar of bars) {
      const minute = byMinute.get(bar.ts) ?? new Map<string, Bar>();
      minute.set(contract, bar);
      byMinute.set(bar.ts, minute);
    }
  }

  const out: Bar[] = [];
  const tally = new Map<string, number>();
  let day = '';
  // ISO-8601 UTC strings of equal length sort chronologically.
  for (const ts of [...byMinute.keys()].sort()) {
    const minute = byMinute.get(ts)!;
    if (ts.slice(0, 10) !== day) {
      day = ts.slice(0, 10);
      tally.clear();
    }
    for (const [contract, bar] of minute) {
      tally.set(contract, (tally.get(contract) ?? 0) + bar.volume);
    }
    let leader = '';
    let leaderVolume = -1;
    for (const [contract, volume] of tally) {
      if (
        volume > leaderVolume ||
        (volume === leaderVolume && contract > leader)
      ) {
        leader = contract;
        leaderVolume = volume;
      }
    }
    const bar = minute.get(leader);
    if (bar) out.push(bar);
  }
  return out;
}

// ── DB write ────────────────────────────────────────────────

async function insertBars(symbol: FuturesRoot, bars: Bar[]): Promise<number> {
  const sql = getDb();
  let inserted = 0;
  for (let i = 0; i < bars.length; i += INSERT_CHUNK) {
    const chunk = bars.slice(i, i + INSERT_CHUNK);
    const rows = (await withDbRetry(
      () => sql`
        INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
        SELECT ${symbol}, t.ts, t.open, t.high, t.low, t.close, t.volume
        FROM unnest(
          ${chunk.map((b) => b.ts)}::timestamptz[],
          ${chunk.map((b) => b.open)}::numeric[],
          ${chunk.map((b) => b.high)}::numeric[],
          ${chunk.map((b) => b.low)}::numeric[],
          ${chunk.map((b) => b.close)}::numeric[],
          ${chunk.map((b) => b.volume)}::bigint[]
        ) AS t(ts, open, high, low, close, volume)
        ON CONFLICT (symbol, ts) DO NOTHING
        RETURNING ts
      `,
      2,
      10_000,
    )) as unknown[];
    inserted += rows.length;
  }
  return inserted;
}

// ── Per-symbol repair ───────────────────────────────────────

async function repairSymbol(
  ctx: CronContext,
  symbol: FuturesRoot,
  gaps: Gap[],
  contracts: unknown[],
): Promise<SymbolResult> {
  const candidates = frontMonthCandidates(contracts, symbol);
  if (candidates.length === 0) {
    throw new Error(`UW /futures/contracts lists no ${symbol} contract`);
  }

  // A capped payload must reach 00:00 UTC of the oldest gap's day: the
  // front-month replay needs that whole day's volume tally, not just the
  // gap minutes themselves.
  const firstGapMinuteMs = Math.min(...gaps.map((g) => g.prevMs)) + MINUTE_MS;
  const oldestNeededMs = firstGapMinuteMs - (firstGapMinuteMs % DAY_MS);
  const byContract = new Map<string, Bar[]>();
  let malformed = 0;
  for (const [idx, contract] of candidates.entries()) {
    const raw: unknown = await withRetry(() =>
      uwFetch<unknown>(
        ctx.apiKey,
        `/futures/${encodeURIComponent(contract)}/candles?interval=1m&range=5d`,
      ),
    );
    if (!Array.isArray(raw)) {
      throw new Error(`UW candles for ${contract}: non-array payload`);
    }
    // The most-active contract always has candles over 5 days; an empty
    // payload (also what UW returns for an unknown contract) is a fault.
    if (idx === 0 && raw.length === 0) {
      throw new Error(`UW returned no candles for ${contract}`);
    }
    const bars = raw.map(parseCandle).filter((b): b is Bar => b !== null);
    if (raw.length > 0 && bars.length === 0) {
      throw new Error(
        `UW candles for ${contract}: all ${raw.length} malformed`,
      );
    }
    const earliestMs = Math.min(...bars.map((b) => Date.parse(b.ts)));
    if (raw.length >= UW_CANDLE_ROW_CAP && earliestMs > oldestNeededMs) {
      const earliest = new Date(earliestMs).toISOString();
      const needed = new Date(oldestNeededMs).toISOString();
      throw new Error(
        `UW candles for ${contract}: depth truncated at ${raw.length} rows (earliest ${earliest}, gap needs ${needed})`,
      );
    }
    malformed += raw.length - bars.length;
    byContract.set(contract, bars);
  }

  if (malformed > 0) {
    ctx.logger.warn(
      { symbol, contracts: candidates, malformed },
      `${JOB}: skipped malformed UW candles`,
    );
    metrics.increment('backfill_futures_gaps.malformed_candle');
    Sentry.captureMessage(`${JOB}: malformed UW candles skipped`, {
      level: 'warning',
      extra: { symbol, contracts: candidates, malformed },
    });
  }

  const inGap = (bar: Bar) => {
    const t = Date.parse(bar.ts);
    return gaps.some((g) => t > g.prevMs && t < g.nextMs);
  };
  const bars = selectFrontMonthBars(byContract).filter(inGap);
  const inserted = await insertBars(symbol, bars);

  return {
    contracts: candidates,
    gapMinutes: gaps.reduce((sum, g) => sum + g.openMinutes, 0),
    inserted,
    malformed,
  };
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  JOB,
  async (ctx): Promise<CronResult> => {
    const now = Date.now();
    const windowEnd = new Date(now - (now % DAY_MS)); // today 00:00 UTC
    const windowStart = new Date(windowEnd.getTime() - LOOKBACK_DAYS * DAY_MS);
    const range = `${windowStart.toISOString()} to ${windowEnd.toISOString()}`;

    const gaps = await detectGaps(windowStart, windowEnd);
    if (gaps.size === 0) {
      return {
        status: 'success',
        rows: 0,
        message: 'no gaps',
        metadata: { range, gapSymbols: [] },
      };
    }

    // One unfiltered call covers every root (~365 rows). A failure here
    // fails the whole run: the wrapper captures it and reports 'error'.
    const contracts: unknown = await withRetry(() =>
      uwFetch<unknown>(ctx.apiKey, '/futures/contracts?days=5'),
    );
    if (!Array.isArray(contracts)) {
      throw new Error('UW /futures/contracts returned a non-array payload');
    }

    const symbols: Partial<Record<FuturesRoot, SymbolResult>> = {};
    const failures: string[] = [];
    for (const [symbol, symbolGaps] of gaps) {
      try {
        symbols[symbol] = await repairSymbol(
          ctx,
          symbol,
          symbolGaps,
          contracts,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${symbol}: ${message}`);
        ctx.logger.error({ err, symbol }, `${JOB}: symbol repair failed`);
        metrics.increment('backfill_futures_gaps.symbol_error');
        Sentry.captureException(err, { tags: { cron: JOB, symbol } });
      }
    }

    const rows = Object.values(symbols).reduce((n, r) => n + r.inserted, 0);
    const status = deriveCronStatus(failures.length, gaps.size);
    ctx.logger.info(
      { range, status, rows, symbols, failures },
      `${JOB} completed`,
    );

    return {
      status,
      rows,
      metadata: {
        range,
        gapSymbols: [...gaps.keys()],
        symbols,
        ...(failures.length > 0 ? { failures } : {}),
      },
    };
  },
  { marketHours: false },
);
