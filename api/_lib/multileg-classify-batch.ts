/**
 * Multileg classification helper for the detect crons.
 *
 * Wraps the Railway sidecar's POST /takeit/multileg-classify endpoint
 * (see `multileg-client.ts`) with the cron-side logic needed by both
 * detect-lottery-fires and detect-silent-boom:
 *
 *   1. Locate the alert's anchor trade in ws_option_trades — the
 *      highest-premium print on the alert's option_chain inside a
 *      ±45s window around the trigger.
 *   2. Pull the ticker-wide context window (all chains on the same
 *      underlying symbol within ±45s) — the matcher needs neighboring
 *      legs to detect verticals / strangles / risk-reversals.
 *   3. Call the sidecar classifier on the window.
 *   4. Return the anchor trade's classification.
 *
 * The helper is fail-open: any failure (sidecar unreachable, no anchor
 * trade located, window too large, DB error) returns `null`. The
 * detect crons treat the four lottery_finder_fires / silent_boom_alerts
 * columns added in migration #160 as NULLABLE for exactly this reason —
 * a transient classifier outage must NOT block alert insertion.
 *
 * Per-cron-tick cache: pass a fresh empty Map at the top of each cron
 * invocation. Keyed by `${ticker}|${optionChain}|${minuteBucket}` so
 * two alerts on the same chain in the same minute reuse one classifier
 * call. Two different chains on the same ticker do NOT share a result
 * — each has its own anchor trade.
 *
 * Spec: migration #160 in `db-migrations.ts` is the canonical column
 * shape; see commit ced5ff10 for the sidecar wiring.
 */

import type { getDb } from './db.js';
import logger from './logger.js';
import {
  classifyMultilegBatch,
  type MultilegClassification,
  type MultilegTradeInput,
} from './multileg-client.js';
import { Sentry } from './sentry.js';

type DbSql = ReturnType<typeof getDb>;

// ── Public types ───────────────────────────────────────────────────────────

/**
 * Per-cron-tick cache. Owned by the cron handler — pass a fresh empty
 * Map at the top of each invocation. Cached value is the anchor trade's
 * classification, or `null` if classification failed/was unavailable.
 * The cache memoizes the null path so a transient sidecar outage doesn't
 * cause N retries within one cron tick.
 */
export type MultilegClassifyCache = Map<string, MultilegClassification | null>;

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Match the sidecar default `window_seconds=90` and the Python
 * multileg matcher's window. The anchor lookup uses ±45s and the
 * ticker-wide window uses the same span.
 */
const HALF_WINDOW_SEC = 45;

/**
 * Defensive size cap. The matcher scales fine up to ~600K rows per
 * ticker per day, but a single ±45s window with > 5000 prints (SPXW
 * 0DTE peak minutes) would blow the cron's per-tick latency budget.
 * Above this cap we return `null` rather than calling the sidecar —
 * matches the project's flagged SPY/SPXW OOM follow-up.
 */
const MAX_WINDOW_TRADES = 5000;

// ── DB row shape ───────────────────────────────────────────────────────────

type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbSide = 'ask' | 'bid' | 'mid' | 'no_side';

interface WsOptionTradeRow {
  ws_trade_id: string;
  ticker: string;
  option_chain: string;
  option_type: 'C' | 'P';
  strike: DbNumeric;
  /** Selected as `expiry::text` so the wire value is YYYY-MM-DD. */
  expiry: string;
  /** Selected as `executed_at` (TIMESTAMPTZ); driver returns Date. */
  executed_at: string | Date;
  price: DbNumeric;
  size: number;
  side: DbSide;
  delta: DbNullableNumeric;
}

// ── NBBO synthesis ─────────────────────────────────────────────────────────

/**
 * ws_option_trades does NOT carry NBBO as typed columns — only the
 * pre-classified `side`. The sidecar matcher reproduces the same
 * side-classification rule:
 *   price >= nbbo_ask - 0.01   → buy
 *   price <= nbbo_bid + 0.01   → sell
 *   else                       → mid
 * Synthesize permissive bounds that round-trip through that rule so
 * downstream `side` reads match what the daemon already wrote.
 */
function synthesizeNbbo(
  side: DbSide,
  price: number,
): { nbboBid: number; nbboAsk: number } {
  if (side === 'ask') return { nbboBid: 0.01, nbboAsk: price }; // → buy
  if (side === 'bid') return { nbboBid: price, nbboAsk: 9999 }; // → sell
  // mid + no_side → wide spread; matcher returns 'mid'.
  return { nbboBid: 0.01, nbboAsk: 9999 };
}

// ── Row → wire conversion ──────────────────────────────────────────────────

function rowToInput(row: WsOptionTradeRow): MultilegTradeInput {
  const price = Number(row.price);
  const size = row.size;
  const executedAtIso =
    typeof row.executed_at === 'string'
      ? new Date(row.executed_at).toISOString()
      : row.executed_at.toISOString();
  const { nbboBid, nbboAsk } = synthesizeNbbo(row.side, price);
  const input: MultilegTradeInput = {
    id: row.ws_trade_id,
    underlyingSymbol: row.ticker,
    executedAt: executedAtIso,
    optionChainId: row.option_chain,
    strike: Number(row.strike),
    expiry: row.expiry,
    optionType: row.option_type === 'C' ? 'call' : 'put',
    size,
    price,
    nbboBid,
    nbboAsk,
    premium: size * price * 100,
  };
  if (row.delta !== null && row.delta !== undefined) {
    input.delta = Number(row.delta);
  }
  return input;
}

// ── Cache key helper ───────────────────────────────────────────────────────

function minuteBucketKey(
  ticker: string,
  optionChain: string,
  triggerTimeCt: Date,
): string {
  // Floor to the minute so multiple alerts on the same chain in the
  // same minute reuse one classifier call.
  const minute = Math.floor(triggerTimeCt.getTime() / 60_000);
  return `${ticker}|${optionChain}|${minute}`;
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Classify the multileg structure of the alert's anchor trade.
 *
 * Returns `null` on any failure — never throws. Crons MUST NOT block
 * alert insertion on a null return; migration #160's four columns are
 * NULLABLE for exactly this reason.
 *
 * @param db            Neon SQL client (tagged-template).
 * @param cache         Per-cron-tick cache keyed by (ticker, chain, minute).
 *                      Multiple alerts in the same minute reuse one call.
 * @param ticker        Underlying symbol (e.g. 'AAPL').
 * @param optionChain   OCC OSI symbol of the alert's chain.
 * @param triggerTimeCt The alert's trigger timestamp.
 */
export async function classifyAlertMultileg(
  db: DbSql,
  cache: MultilegClassifyCache,
  ticker: string,
  optionChain: string,
  triggerTimeCt: Date,
): Promise<MultilegClassification | null> {
  const cacheKey = minuteBucketKey(ticker, optionChain, triggerTimeCt);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  try {
    const result = await classifyAlertMultilegInner(
      db,
      ticker,
      optionChain,
      triggerTimeCt,
    );
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    // Defensive — `classifyAlertMultilegInner` already swallows known
    // failure modes; this top-level catch covers any unexpected throw
    // (e.g. driver crash) so the cron loop continues.
    logger.warn(
      { err, ticker, optionChain },
      'classifyAlertMultileg unexpected failure; returning null',
    );
    Sentry.captureException(err, {
      tags: { module: 'multileg-classify-batch' },
      extra: { ticker, optionChain },
    });
    cache.set(cacheKey, null);
    return null;
  }
}

async function classifyAlertMultilegInner(
  db: DbSql,
  ticker: string,
  optionChain: string,
  triggerTimeCt: Date,
): Promise<MultilegClassification | null> {
  const windowStart = new Date(
    triggerTimeCt.getTime() - HALF_WINDOW_SEC * 1000,
  );
  const windowEnd = new Date(triggerTimeCt.getTime() + HALF_WINDOW_SEC * 1000);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  let rows: WsOptionTradeRow[];
  try {
    rows = (await db`
      SELECT
        ws_trade_id, ticker, option_chain, option_type, strike,
        expiry::text AS expiry, executed_at, price, size, side, delta
      FROM ws_option_trades
      WHERE ticker = ${ticker}
        AND executed_at >= ${windowStartIso}::timestamptz
        AND executed_at <= ${windowEndIso}::timestamptz
        AND canceled = FALSE
        AND price > 0
      ORDER BY executed_at ASC
    `) as WsOptionTradeRow[];
  } catch (err) {
    logger.warn(
      { err, ticker, optionChain },
      'multileg-classify ws_option_trades query failed; returning null',
    );
    Sentry.captureException(err, {
      tags: { module: 'multileg-classify-batch', stage: 'db_query' },
      extra: { ticker, optionChain },
    });
    return null;
  }

  if (rows.length === 0) {
    return null;
  }
  if (rows.length > MAX_WINDOW_TRADES) {
    // Window too large — log + skip. Matches the SPY/SPXW OOM
    // follow-up. We still cache the null so subsequent alerts in the
    // same minute don't reissue the query.
    logger.warn(
      {
        ticker,
        optionChain,
        windowTrades: rows.length,
        cap: MAX_WINDOW_TRADES,
      },
      'multileg-classify window exceeds size cap; skipping classifier',
    );
    Sentry.captureMessage('multileg.classify.window_too_large', {
      level: 'warning',
      extra: {
        ticker,
        optionChain,
        windowTrades: rows.length,
        cap: MAX_WINDOW_TRADES,
      },
    });
    return null;
  }

  // Find the anchor trade: highest premium (size * price) on the
  // alert's chain within the window. No anchor → no classification.
  let anchorIndex = -1;
  let anchorPremium = -Infinity;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!;
    if (r.option_chain !== optionChain) continue;
    const premium = r.size * Number(r.price);
    if (premium > anchorPremium) {
      anchorPremium = premium;
      anchorIndex = i;
    }
  }
  if (anchorIndex === -1) {
    return null;
  }
  const anchorRow = rows[anchorIndex]!;

  const trades = rows.map(rowToInput);

  let classifications: Map<string, MultilegClassification>;
  try {
    classifications = await classifyMultilegBatch(trades);
  } catch (err) {
    logger.warn(
      { err, ticker, optionChain, windowTrades: rows.length },
      'multileg-classify sidecar call failed; returning null',
    );
    // The client already captured a Sentry message at the typed-error
    // boundary; don't double-capture as exception. A debug log here is
    // enough for local triage.
    return null;
  }

  return classifications.get(anchorRow.ws_trade_id) ?? null;
}
