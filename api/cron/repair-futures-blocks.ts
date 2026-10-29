/**
 * GET /api/cron/repair-futures-blocks
 *
 * Nightly repair of `futures_blocks` (migration #196) from Unusual Whales
 * REST (spec Phase 6c). Live blocks come from uw-stream's `futures_blocks`
 * websocket handler (`uw-stream/src/handlers/futures_blocks.py`), but the
 * websocket has no replay and the socket drops 50–260 times a day, so
 * blocks reported during a drop are lost. After the close, this pages
 * `GET /futures/flow?blocks_only=true` newest-first back over the last 3
 * UTC days and upserts every block it gets (CLAUDE.md "websocket over
 * REST": gap repair after the close). `/futures/{c}/trades?blocks_only`
 * returned no rows in probe 0a, so the all-contract flow feed is used.
 *
 *   1. Paging: `limit=500`, an `older_than` cursor at the page's oldest
 *      `executed_at` + 1 µs (the cursor is strict and block times have
 *      second precision), until a page reaches before the window start,
 *      an empty page (the edge of UW's history), or MAX_PAGES / the
 *      deadline. Every valid row fetched is kept, including the last
 *      page's rows from before the window.
 *   2. Validation (Zod), as defensive as the websocket handler: ISO or
 *      epoch-ms times inside a plausibility window; `product`/`sym`/
 *      `sec_type` null or "" → NULL; numbers as decimal strings with a
 *      non-finite and column-range reject (one bad value would fail the
 *      whole INSERT). An invalid row is skipped and counted.
 *   3. Collapse: one row per `(trade_id, exchange, trade_date)`, the one
 *      the SQL guard would keep (newest `reported_at`, a tie to the later
 *      row, a NULL `reported_at` losing to any dated one), because one
 *      `INSERT … ON CONFLICT DO UPDATE` can't touch a key twice.
 *   4. One batched upsert per 500 rows, newest-wins exactly like uw-stream's
 *      `db.bulk_upsert_if_newer`: `DO UPDATE … WHERE EXCLUDED.reported_at
 *      >= futures_blocks.reported_at OR futures_blocks.reported_at IS NULL`.
 *      A late older message never overwrites a newer one, a `delete` is
 *      kept as a row state, and a re-run is idempotent. `raw_payload` is
 *      the REST row as received.
 *
 * Failures surface (R4): a UW error, a non-array page, a page of only
 * invalid rows, or a rejected write throws, so the wrapper reports 'error'
 * and returns 500. Invalid rows (a Sentry warning) or a run cut short by
 * the page cap or deadline (a Sentry warning) report 'partial'. No blocks
 * at all in three days is an upstream fault, not a quiet market: 'error'.
 *
 * Schedule: 15 22 * * 1-5 (22:15 UTC, after the CME close). The Monday run
 * reaches back to Friday 00:00 UTC.
 *
 * Spec: docs/superpowers/specs/2026-10-28-uw-futures-orderflow-design.md
 *
 * Environment: CRON_SECRET, UW_API_KEY
 */

import { z } from 'zod';
import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { uwFetch, withRetry } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronContext,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { formatMicrosIso, parseUwTimeMicros } from '../_lib/uw-time.js';

// ── Constants ───────────────────────────────────────────────

const JOB = 'repair-futures-blocks';

const LOOKBACK_DAYS = 3;
const DAY_MS = 86_400_000;
/** UW's maximum `limit` on /futures/flow. */
const PAGE_LIMIT = 500;
/**
 * A runaway bound, not a budget: 50,000 blocks over 3 days, against a
 * few thousand a day across every CME product.
 */
const MAX_PAGES = 100;
/**
 * No page starts this long after the run began: one more page under
 * withRetry (~48 s worst case) plus the upsert still ends inside the
 * default 300 s function limit.
 */
const DEADLINE_MS = 240_000;
const UPSERT_CHUNK = 500;

/** NUMERIC(18,8) (price, quotes) holds |x| < 1e10; NUMERIC(24,8) (qty) 1e16. */
const PRICE_LIMIT = 1e10;
const QTY_LIMIT = 1e16;
const BIGINT_MAX = 2n ** 63n - 1n;
const DECIMAL_RX = /^-?\d+(\.\d+)?$/;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

// ── Validation ──────────────────────────────────────────────

function isIsoDate(s: string): boolean {
  if (!DATE_RX.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** A non-negative BIGINT id from an int or a digit string, as a string. */
const Id = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const s =
    typeof v === 'number'
      ? Number.isSafeInteger(v) && v >= 0
        ? String(v)
        : ''
      : v;
  if (!/^\d+$/.test(s) || BigInt(s) > BIGINT_MAX) {
    ctx.addIssue({ code: 'custom', message: 'not a BIGINT id' });
    return z.NEVER;
  }
  return s;
});

/** A finite decimal with |x| < limit, kept as its string; null/"" → null. */
function decimal(limit: number) {
  return z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v, ctx) => {
      if (v == null || v === '') return null;
      const s = typeof v === 'number' ? String(v) : v.trim();
      // The regex rejects NaN, Infinity and exponents ('1e400').
      if (!DECIMAL_RX.test(s) || Math.abs(Number(s)) >= limit) {
        ctx.addIssue({ code: 'custom', message: `not a decimal < ${limit}` });
        return z.NEVER;
      }
      return s;
    });
}

/** ISO (with offset) or epoch ms → µs; absent → null; unusable → issue. */
const OptTime = z.unknown().transform((v, ctx) => {
  if (v == null || v === '') return null;
  const us = parseUwTimeMicros(v);
  if (us === null) {
    ctx.addIssue({ code: 'custom', message: 'not a plausible time' });
    return z.NEVER;
  }
  return us;
});

/** "" for an MLEG or an unknown root on the websocket, null on REST. */
const OptText = z
  .string()
  .nullish()
  .transform((v) => (v ? v : null));

const BlockRowSchema = z.object({
  trade_id: Id,
  // Part of the key, so '' (no MIC) is kept as ''.
  exchange: z.string(),
  trade_date: z.string().refine(isIsoDate, 'not a YYYY-MM-DD date'),
  action: z.enum(['new', 'update', 'delete']),
  sym: OptText,
  product: OptText,
  sec_type: OptText,
  price: decimal(PRICE_LIMIT),
  qty: decimal(QTY_LIMIT),
  executed_at: OptTime.refine((v) => v !== null, 'executed_at is required'),
  reported_at: OptTime,
  strategy_link_id: Id.nullish(),
  legs: z.array(z.unknown()).nullish(),
  quote_bid: decimal(PRICE_LIMIT),
  quote_ask: decimal(PRICE_LIMIT),
  quote_ts: OptTime,
});

interface Block {
  tradeId: string;
  exchange: string;
  tradeDate: string;
  sym: string | null;
  product: string | null;
  secType: string | null;
  action: string;
  price: string | null;
  qty: string | null;
  executedUs: bigint;
  reportedUs: bigint | null;
  strategyLinkId: string | null;
  legs: string | null;
  quoteBid: string | null;
  quoteAsk: string | null;
  quoteUs: bigint | null;
  raw: string;
}

function toBlock(raw: unknown): Block | { issue: string } {
  const parsed = BlockRowSchema.safeParse(raw);
  if (!parsed.success) return { issue: z.prettifyError(parsed.error) };
  const r = parsed.data;
  return {
    tradeId: r.trade_id,
    exchange: r.exchange,
    tradeDate: r.trade_date,
    sym: r.sym,
    product: r.product,
    secType: r.sec_type,
    action: r.action,
    price: r.price,
    qty: r.qty,
    executedUs: r.executed_at!,
    reportedUs: r.reported_at,
    strategyLinkId: r.strategy_link_id ?? null,
    legs: r.legs == null ? null : JSON.stringify(r.legs),
    quoteBid: r.quote_bid,
    quoteAsk: r.quote_ask,
    quoteUs: r.quote_ts,
    raw: JSON.stringify(raw),
  };
}

// ── Fetch ───────────────────────────────────────────────────

interface FetchResult {
  blocks: Block[];
  pages: number;
  invalid: number;
  firstIssue: string | null;
  /** The page cap or the deadline stopped paging before the window start. */
  cutShort: boolean;
}

async function fetchBlocks(
  ctx: CronContext,
  windowStartUs: bigint,
): Promise<FetchResult> {
  const out: FetchResult = {
    blocks: [],
    pages: 0,
    invalid: 0,
    firstIssue: null,
    cutShort: false,
  };
  let cursorUs: bigint | null = null;
  let prevOldestUs: bigint | null = null;
  for (;;) {
    if (out.pages >= MAX_PAGES || Date.now() >= ctx.startTimeMs + DEADLINE_MS) {
      out.cutShort = true;
      return out;
    }
    const query = new URLSearchParams({
      blocks_only: 'true',
      limit: String(PAGE_LIMIT),
    });
    if (cursorUs !== null) query.set('older_than', formatMicrosIso(cursorUs));
    const path = `/futures/flow?${query}`;
    const page: unknown = await withRetry(() =>
      uwFetch<unknown>(ctx.apiKey, path),
    );
    out.pages += 1;
    if (!Array.isArray(page)) {
      throw new Error('UW /futures/flow blocks: non-array page');
    }
    if (page.length === 0) return out;

    let pageOldest: bigint | null = null;
    let valid = 0;
    for (const raw of page) {
      const b = toBlock(raw);
      if ('issue' in b) {
        out.invalid += 1;
        out.firstIssue ??= b.issue;
        continue;
      }
      valid += 1;
      out.blocks.push(b);
      if (pageOldest === null || b.executedUs < pageOldest) {
        pageOldest = b.executedUs;
      }
    }
    if (valid === 0 || pageOldest === null) {
      throw new Error(
        `UW /futures/flow blocks: all ${page.length} rows on a page are invalid (${out.firstIssue ?? 'unknown'})`,
      );
    }
    if (pageOldest < windowStartUs) return out;
    // +1 µs re-reads the oldest second's blocks (deduped by the collapse).
    // A page that made no progress steps strictly past that instant.
    cursorUs = pageOldest === prevOldestUs ? pageOldest : pageOldest + 1n;
    prevOldestUs = pageOldest;
  }
}

/** One block per key: the message bulk_upsert_if_newer's guard keeps. */
function collapseToNewest(blocks: readonly Block[]): Block[] {
  const kept = new Map<string, Block>();
  for (const b of blocks) {
    const key = `${b.tradeId}|${b.exchange}|${b.tradeDate}`;
    const prev = kept.get(key);
    if (
      prev === undefined ||
      prev.reportedUs === null ||
      (b.reportedUs !== null && b.reportedUs >= prev.reportedUs)
    ) {
      kept.set(key, b);
    }
  }
  return [...kept.values()];
}

// ── DB write ────────────────────────────────────────────────

const iso = (us: bigint | null): string | null =>
  us === null ? null : formatMicrosIso(us);

/** Rows inserted or replaced. Throws on a rejected write. */
async function upsertBlocks(blocks: readonly Block[]): Promise<number> {
  const sql = getDb();
  let written = 0;
  for (let i = 0; i < blocks.length; i += UPSERT_CHUNK) {
    const c = blocks.slice(i, i + UPSERT_CHUNK);
    const rows = (await withDbRetry(
      () => sql`
        INSERT INTO futures_blocks (
          trade_id, exchange, trade_date, sym, product, sec_type, action,
          price, qty, executed_at, reported_at, strategy_link_id, legs,
          quote_bid, quote_ask, quote_ts, raw_payload
        )
        SELECT t.trade_id, t.exchange, t.trade_date, t.sym, t.product,
               t.sec_type, t.action, t.price, t.qty, t.executed_at,
               t.reported_at, t.strategy_link_id, t.legs::jsonb,
               t.quote_bid, t.quote_ask, t.quote_ts, t.raw_payload::jsonb
        FROM unnest(
          ${c.map((b) => b.tradeId)}::bigint[],
          ${c.map((b) => b.exchange)}::text[],
          ${c.map((b) => b.tradeDate)}::date[],
          ${c.map((b) => b.sym)}::text[],
          ${c.map((b) => b.product)}::text[],
          ${c.map((b) => b.secType)}::text[],
          ${c.map((b) => b.action)}::text[],
          ${c.map((b) => b.price)}::numeric[],
          ${c.map((b) => b.qty)}::numeric[],
          ${c.map((b) => iso(b.executedUs))}::timestamptz[],
          ${c.map((b) => iso(b.reportedUs))}::timestamptz[],
          ${c.map((b) => b.strategyLinkId)}::bigint[],
          ${c.map((b) => b.legs)}::text[],
          ${c.map((b) => b.quoteBid)}::numeric[],
          ${c.map((b) => b.quoteAsk)}::numeric[],
          ${c.map((b) => iso(b.quoteUs))}::timestamptz[],
          ${c.map((b) => b.raw)}::text[]
        ) AS t(
          trade_id, exchange, trade_date, sym, product, sec_type, action,
          price, qty, executed_at, reported_at, strategy_link_id, legs,
          quote_bid, quote_ask, quote_ts, raw_payload
        )
        ON CONFLICT (trade_id, exchange, trade_date) DO UPDATE SET
          sym = EXCLUDED.sym,
          product = EXCLUDED.product,
          sec_type = EXCLUDED.sec_type,
          action = EXCLUDED.action,
          price = EXCLUDED.price,
          qty = EXCLUDED.qty,
          executed_at = EXCLUDED.executed_at,
          reported_at = EXCLUDED.reported_at,
          strategy_link_id = EXCLUDED.strategy_link_id,
          legs = EXCLUDED.legs,
          quote_bid = EXCLUDED.quote_bid,
          quote_ask = EXCLUDED.quote_ask,
          quote_ts = EXCLUDED.quote_ts,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = now()
        WHERE EXCLUDED.reported_at >= futures_blocks.reported_at
           OR futures_blocks.reported_at IS NULL
        RETURNING trade_id
      `,
      2,
      10_000,
    )) as unknown[];
    written += rows.length;
  }
  return written;
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  JOB,
  async (ctx): Promise<CronResult> => {
    const now = Date.now();
    const windowStartMs = now - (now % DAY_MS) - LOOKBACK_DAYS * DAY_MS;
    const windowStart = new Date(windowStartMs).toISOString();

    const fetched = await fetchBlocks(ctx, BigInt(windowStartMs) * 1000n);
    const metadata = {
      windowStart,
      pages: fetched.pages,
      fetched: fetched.blocks.length,
      invalidRows: fetched.invalid,
    };

    if (fetched.blocks.length === 0) {
      const message = `UW returned no block trades since ${windowStart}`;
      ctx.logger.warn({ ...metadata }, `${JOB}: ${message}`);
      metrics.increment('repair_futures_blocks.empty');
      Sentry.captureMessage(`${JOB}: ${message}`, {
        level: 'warning',
        extra: metadata,
      });
      return { status: 'error', rows: 0, message, metadata };
    }

    if (fetched.invalid > 0) {
      ctx.logger.warn(
        { invalid: fetched.invalid, firstIssue: fetched.firstIssue },
        `${JOB}: skipped invalid UW block rows`,
      );
      metrics.increment('repair_futures_blocks.invalid_row');
      Sentry.captureMessage(`${JOB}: invalid UW block rows skipped`, {
        level: 'warning',
        extra: { invalid: fetched.invalid, firstIssue: fetched.firstIssue },
      });
    }
    if (fetched.cutShort) {
      ctx.logger.warn(
        { ...metadata },
        `${JOB}: stopped before the window start`,
      );
      Sentry.captureMessage(
        `${JOB}: stopped at the page cap or deadline before the window start`,
        { level: 'warning', extra: { ...metadata, maxPages: MAX_PAGES } },
      );
    }

    // A rejected write throws past this point: never a 'success' run.
    const blocks = collapseToNewest(fetched.blocks);
    const rows = await upsertBlocks(blocks);

    const status =
      fetched.invalid > 0 || fetched.cutShort ? 'partial' : 'success';
    ctx.logger.info({ status, rows, ...metadata }, `${JOB} completed`);
    return {
      status,
      rows,
      metadata: {
        ...metadata,
        unique: blocks.length,
        ...(fetched.cutShort ? { cutShort: true } : {}),
      },
    };
  },
  { marketHours: false },
);
