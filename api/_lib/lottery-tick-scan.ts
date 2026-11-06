/**
 * The tick scan behind detect-lottery-fires: the last 7 minutes of
 * ws_option_trades, read once and grouped by chain.
 *
 * The scan is 7 one-minute slices, run in parallel, anchored on one instant
 * the caller captures (`scanEnd`):
 *
 *   slice i = [scanEnd - 7 min + i min, scanEnd - 7 min + (i + 1) min)
 *
 * The last slice has no upper bound, as the single-window query it replaced
 * had none, so a print stamped after `scanEnd` is still read. The slices tile
 * the window with no gap and no overlap, so every row is read exactly once.
 * The old scan read each row three times: three hash partitions of `ticker`,
 * and each partition scanned the whole window by `executed_at` and discarded
 * two thirds of it on the hash. Each slice is one range scan on
 * `ws_option_trades_executed_idx (executed_at)`. Plan:
 * docs/superpowers/plans/2026-10-29-lottery-phase-b-e.md, B1.
 *
 * Neon's HTTP driver caps a response at 64 MiB (SENTRY-EMERALD-DESERT-CB,
 * 2026-05-22, the 08:30–09:00 CT spike). Volume at the open isn't uniform, so
 * a slice can still overflow: it is then split in half and each half is read
 * again, at most MAX_SPLIT_DEPTH levels down (down to 7.5 s pieces), and the
 * scan fails after that. Any other error fails the scan at once.
 *
 * The slices are appended in time order, so each chain's ticks stay sorted by
 * `executed_at`; `ORDER BY executed_at, id` makes the order of prints in the
 * same millisecond deterministic. The old scan ordered by
 * `option_chain, executed_at`, which left same-millisecond ties unordered.
 */

import type { getDb } from './db.js';
import { withDbRetry } from './db.js';
import type { OptionTradeTick } from './lottery-finder.js';

type DbSql = ReturnType<typeof getDb>;

/**
 * Scan window length in minutes, and so the number of one-minute slices.
 * 7 = the 5-min v4 window plus 2 min of slack, so a slow cron tick can't drop
 * a trigger that landed at the start of its window.
 */
export const SCAN_WINDOW_MIN = 7;

/** How many times a slice that overflows Neon's response cap may be halved. */
export const MAX_SPLIT_DEPTH = 3;

const SLICE_MS = 60_000;

// Postgres reads 'infinity' as a timestamptz above every finite instant, so
// the last slice stays open-ended with the same query as the others.
const OPEN_END = 'infinity';

type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;
type DbSide = 'ask' | 'bid' | 'mid' | 'no_side';

/** One ws_option_trades row as the scan SELECT returns it. */
export interface TickRow {
  ticker: string;
  option_chain: string;
  option_type: 'C' | 'P';
  strike: DbNumeric;
  // expiry is selected as `expiry::text` so the wire value is always a
  // YYYY-MM-DD string, bypassing any driver-side Date<->TIMESTAMPTZ
  // round-trip that could shift the date by a TZ offset.
  expiry: string;
  executed_at: DbTimestamp;
  price: DbNumeric;
  size: number;
  underlying_price: DbNullableNumeric;
  side: DbSide;
  implied_volatility: DbNullableNumeric;
  delta: DbNullableNumeric;
  // Gamma is extracted from raw_payload JSONB at SELECT time —
  // ws_option_trades' typed columns only carry implied_volatility and
  // delta; the full UW payload (which includes gamma) lives in
  // raw_payload. Migration #168 added the storage column on
  // lottery_finder_fires; this is the read side.
  gamma: DbNullableNumeric;
  open_interest: number | null;
}

export interface ChainGroup {
  ticker: string;
  optionChain: string;
  optionType: 'C' | 'P';
  strike: number;
  // YYYY-MM-DD string (read from SQL as ::text — see TickRow.expiry).
  expiry: string;
  ticks: OptionTradeTick[];
  oi: number;
}

export interface LotteryTickScan {
  /** Rows read: every non-canceled, positively priced print in the window. */
  scanned: number;
  /** One group per option chain, ticks in time order. */
  groups: Map<string, ChainGroup>;
}

interface Slice {
  fromMs: number;
  /** Where the slice ends; for the open slice, where it would end if closed. */
  toMs: number;
  open: boolean;
}

/**
 * Whether Neon refused a response for its size. The HTTP driver
 * (@neondatabase/serverless) turns every non-400 failure into a NeonDbError
 * whose message is `Server error (HTTP status <status>): <body>`, and Neon
 * answers 507 when a result passes the 64 MiB cap (see also
 * api/_lib/flow-regime-rows.ts and
 * docs/superpowers/specs/sentry-railway-triage-fixes-2026-06-08.md). Match
 * the status the driver writes, not Neon's wording of the body.
 */
export function isResponseTooLargeError(err: unknown): boolean {
  return err instanceof Error && /HTTP status 507\b/.test(err.message);
}

const iso = (ms: number): string => new Date(ms).toISOString();

function describeSlice(slice: Slice): string {
  return `[${iso(slice.fromMs)}, ${slice.open ? 'open end' : iso(slice.toMs)})`;
}

async function readSlice(
  db: DbSql,
  slice: Slice,
  depth: number,
): Promise<TickRow[]> {
  const from = iso(slice.fromMs);
  const to = slice.open ? OPEN_END : iso(slice.toMs);
  try {
    // Gamma is read from raw_payload (migration #168): uw-stream only
    // promotes delta to a typed column. NULLIF guards against UW's literal
    // empty-string payloads (~0.3%) before the ::numeric cast.
    //
    // withDbRetry covers transient Neon HTTP failures (ECONNRESET / fetch
    // failed / socket hang up) — see SENTRY-EMERALD-DESERT-8X (2026-05-18,
    // 2h Neon blip that silently zeroed out hours 18-20 UTC). A 507 is not
    // one: it passes through untouched and is split below.
    return (await withDbRetry(
      () => db`
        SELECT
          ticker, option_chain, option_type, strike, expiry::text AS expiry,
          executed_at, price, size, underlying_price, side,
          implied_volatility, delta,
          NULLIF(raw_payload->>'gamma', '')::numeric AS gamma,
          open_interest
        FROM ws_option_trades
        WHERE executed_at >= ${from}::timestamptz
          AND executed_at < ${to}::timestamptz
          AND canceled = FALSE
          AND price > 0
        ORDER BY executed_at, id
      `,
      2,
      10_000,
    )) as TickRow[];
  } catch (err) {
    if (!isResponseTooLargeError(err)) throw err;
    if (depth >= MAX_SPLIT_DEPTH) {
      throw new Error(
        `lottery tick scan: slice ${describeSlice(slice)} still too large after ${MAX_SPLIT_DEPTH} splits`,
        { cause: err },
      );
    }
    const midMs = slice.fromMs + (slice.toMs - slice.fromMs) / 2;
    const [lower, upper] = await Promise.all([
      readSlice(
        db,
        { fromMs: slice.fromMs, toMs: midMs, open: false },
        depth + 1,
      ),
      readSlice(
        db,
        { fromMs: midMs, toMs: slice.toMs, open: slice.open },
        depth + 1,
      ),
    ]);
    return [...lower, ...upper];
  }
}

/**
 * Group scan rows by chain and normalise each into an OptionTradeTick. The
 * rows must already be in time order: a chain's ticks keep the order they
 * arrive in.
 */
export function groupTickRows(rows: readonly TickRow[]): LotteryTickScan {
  const groups = new Map<string, ChainGroup>();
  for (const r of rows) {
    let g = groups.get(r.option_chain);
    if (!g) {
      g = {
        ticker: r.ticker,
        optionChain: r.option_chain,
        optionType: r.option_type,
        strike: Number(r.strike),
        expiry: r.expiry,
        ticks: [],
        oi: 0,
      };
      groups.set(r.option_chain, g);
    }
    g.ticks.push({
      executedAt: new Date(r.executed_at),
      optionChain: r.option_chain,
      optionType: r.option_type,
      strike: Number(r.strike),
      // OptionTradeTick.expiry is typed as Date — the detector uses it
      // for parity with the parquet shape; a UTC midnight Date matches.
      expiry: new Date(`${r.expiry}T00:00:00Z`),
      price: Number(r.price),
      size: r.size,
      underlyingPrice:
        r.underlying_price != null ? Number(r.underlying_price) : null,
      side: r.side,
      impliedVolatility:
        r.implied_volatility != null ? Number(r.implied_volatility) : null,
      delta: r.delta != null ? Number(r.delta) : null,
      gamma: r.gamma != null ? Number(r.gamma) : null,
      openInterest: r.open_interest,
    });
    // Take the per-chain max OI — matches Python p14.py
    // `g['open_interest'].max()`.
    if (r.open_interest != null && r.open_interest > g.oi) {
      g.oi = r.open_interest;
    }
  }
  return { scanned: rows.length, groups };
}

/**
 * Read the trades of the last SCAN_WINDOW_MIN minutes before `scanEnd` and
 * group them by chain. `scanEnd` is the one instant the whole run is anchored
 * on: nothing here asks the database for the time.
 */
export async function scanLotteryTicks(
  db: DbSql,
  scanEnd: Date,
): Promise<LotteryTickScan> {
  const firstMs = scanEnd.getTime() - SCAN_WINDOW_MIN * SLICE_MS;
  const perSlice = await Promise.all(
    Array.from({ length: SCAN_WINDOW_MIN }, (_, i) =>
      readSlice(
        db,
        {
          fromMs: firstMs + i * SLICE_MS,
          toMs: firstMs + (i + 1) * SLICE_MS,
          open: i === SCAN_WINDOW_MIN - 1,
        },
        0,
      ),
    ),
  );
  return groupTickRows(perSlice.flat());
}
