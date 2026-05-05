/**
 * Per-minute option-contract intraday cache helper.
 *
 * Fetches `/option-contract/{id}/intraday?date=YYYY-MM-DD` from UW REST,
 * caches the per-minute side-split premium + volume rows in
 * `option_intraday_nbbo`, and tracks fetch attempts in
 * `option_intraday_nbbo_fetches` so empty responses are not retried on
 * every cron run. Returns the per-minute synthetic mid array used by
 * the flow-inversion exit policy.
 *
 * The UW endpoint does not expose nbbo_bid / nbbo_ask directly. We
 * derive a synthetic mid in `deriveMid()` from the side-split fields
 * (premium_ask_side / volume_ask_side ≈ avg ask price; same for bid)
 * with (high+low)/2 and close fallbacks. See migration #127.
 */

import { getDb } from './db.js';
import logger from './logger.js';
import { uwFetch, withRetry } from './uw-fetch.js';

export interface OptionIntradayMinute {
  ts: Date;
  mid: number;
}

interface UwIntradayRow {
  start_time: string;
  avg_price?: string | null;
  close?: string | null;
  high?: string | null;
  low?: string | null;
  premium_ask_side?: string | null;
  premium_bid_side?: string | null;
  premium_mid_side?: string | null;
  volume_ask_side?: number | null;
  volume_bid_side?: number | null;
  volume_mid_side?: number | null;
}

type DbNumeric = string | number | null;

interface CachedRow {
  ts: Date;
  avg_price: DbNumeric;
  close_price: DbNumeric;
  high_price: DbNumeric;
  low_price: DbNumeric;
  premium_ask_side: DbNumeric;
  premium_bid_side: DbNumeric;
  volume_ask_side: number | null;
  volume_bid_side: number | null;
}

function parseNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Synthetic mid in dollars per share. Best path is per-side avg price
 * ((premium_ask_side / volume_ask_side + premium_bid_side / volume_bid_side) / 2).
 * Falls back to (high+low)/2 then close then avg_price.
 */
export function deriveMid(input: {
  premiumAskSide: number | null;
  premiumBidSide: number | null;
  volumeAskSide: number | null;
  volumeBidSide: number | null;
  high: number | null;
  low: number | null;
  closePrice: number | null;
  avgPrice: number | null;
}): number | null {
  const { premiumAskSide, premiumBidSide, volumeAskSide, volumeBidSide } =
    input;
  if (
    premiumAskSide != null &&
    volumeAskSide != null &&
    volumeAskSide > 0 &&
    premiumBidSide != null &&
    volumeBidSide != null &&
    volumeBidSide > 0
  ) {
    // UW premium fields are price×volume (no contract multiplier), so
    // dividing yields per-share avg price. Verified against the docs
    // example where avg_price=30.186 and premium_ask_side/volume_ask_side
    // = 3138/104 = 30.17 (the ask-side avg, slightly above the all-side
    // mean as expected).
    const avgAsk = premiumAskSide / volumeAskSide;
    const avgBid = premiumBidSide / volumeBidSide;
    return (avgAsk + avgBid) / 2;
  }
  if (input.high != null && input.low != null) {
    return (input.high + input.low) / 2;
  }
  return input.closePrice ?? input.avgPrice;
}

function rowFromUw(r: UwIntradayRow): OptionIntradayMinute | null {
  const mid = deriveMid({
    premiumAskSide: parseNum(r.premium_ask_side),
    premiumBidSide: parseNum(r.premium_bid_side),
    volumeAskSide: r.volume_ask_side ?? null,
    volumeBidSide: r.volume_bid_side ?? null,
    high: parseNum(r.high),
    low: parseNum(r.low),
    closePrice: parseNum(r.close),
    avgPrice: parseNum(r.avg_price),
  });
  if (mid == null || mid <= 0) return null;
  return { ts: new Date(r.start_time), mid };
}

function rowFromCache(r: CachedRow): OptionIntradayMinute | null {
  const mid = deriveMid({
    premiumAskSide: parseNum(r.premium_ask_side),
    premiumBidSide: parseNum(r.premium_bid_side),
    volumeAskSide: r.volume_ask_side,
    volumeBidSide: r.volume_bid_side,
    high: parseNum(r.high_price),
    low: parseNum(r.low_price),
    closePrice: parseNum(r.close_price),
    avgPrice: parseNum(r.avg_price),
  });
  if (mid == null || mid <= 0) return null;
  return { ts: new Date(r.ts), mid };
}

async function readCached(
  optionChain: string,
  date: string,
): Promise<OptionIntradayMinute[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT ts, avg_price, close_price, high_price, low_price,
           premium_ask_side, premium_bid_side,
           volume_ask_side, volume_bid_side
    FROM option_intraday_nbbo
    WHERE option_chain = ${optionChain}
      AND ts >= ${`${date}T00:00:00Z`}::timestamptz
      AND ts <  ${`${date}T00:00:00Z`}::timestamptz + INTERVAL '1 day'
    ORDER BY ts ASC
  `) as CachedRow[];
  const out: OptionIntradayMinute[] = [];
  for (const r of rows) {
    const m = rowFromCache(r);
    if (m) out.push(m);
  }
  return out;
}

async function recordFetch(
  optionChain: string,
  date: string,
  rowsFetched: number,
  status: 'ok' | 'empty' | 'error',
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO option_intraday_nbbo_fetches
      (option_chain, date, rows_fetched, status)
    VALUES (${optionChain}, ${date}::date, ${rowsFetched}, ${status})
    ON CONFLICT (option_chain, date) DO UPDATE SET
      rows_fetched = EXCLUDED.rows_fetched,
      status = EXCLUDED.status,
      fetched_at = NOW()
  `;
}

async function persistRows(
  optionChain: string,
  rows: readonly UwIntradayRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const sql = getDb();
  // Single round-trip via unnest. All payload fields are nullable in
  // the table so we pass NULL through for missing UW values rather
  // than coalescing to 0 (preserves the difference between "no
  // ask-side prints" and "ask-side prints summed to zero").
  const ts = rows.map((r) => r.start_time);
  const avgPrice = rows.map((r) => parseNum(r.avg_price));
  const closePrice = rows.map((r) => parseNum(r.close));
  const highPrice = rows.map((r) => parseNum(r.high));
  const lowPrice = rows.map((r) => parseNum(r.low));
  const premAsk = rows.map((r) => parseNum(r.premium_ask_side));
  const premBid = rows.map((r) => parseNum(r.premium_bid_side));
  const premMid = rows.map((r) => parseNum(r.premium_mid_side));
  const volAsk = rows.map((r) => r.volume_ask_side ?? null);
  const volBid = rows.map((r) => r.volume_bid_side ?? null);
  const volMid = rows.map((r) => r.volume_mid_side ?? null);

  await sql`
    INSERT INTO option_intraday_nbbo (
      option_chain, ts,
      avg_price, close_price, high_price, low_price,
      premium_ask_side, premium_bid_side, premium_mid_side,
      volume_ask_side, volume_bid_side, volume_mid_side
    )
    SELECT ${optionChain}, t.ts::timestamptz,
           t.avg_price, t.close_price, t.high_price, t.low_price,
           t.prem_ask, t.prem_bid, t.prem_mid,
           t.vol_ask, t.vol_bid, t.vol_mid
    FROM unnest(
      ${ts}::text[],
      ${avgPrice}::numeric[],
      ${closePrice}::numeric[],
      ${highPrice}::numeric[],
      ${lowPrice}::numeric[],
      ${premAsk}::numeric[],
      ${premBid}::numeric[],
      ${premMid}::numeric[],
      ${volAsk}::int[],
      ${volBid}::int[],
      ${volMid}::int[]
    ) AS t(ts, avg_price, close_price, high_price, low_price,
           prem_ask, prem_bid, prem_mid, vol_ask, vol_bid, vol_mid)
    ON CONFLICT (option_chain, ts) DO NOTHING
  `;
}

/**
 * Fetch and cache one (chain, date) intraday tape from UW REST.
 *
 * Cache hit (`ok` or `empty` row in option_intraday_nbbo_fetches) skips
 * the UW call entirely. Cache miss or prior `error` triggers a refetch.
 * UW failures are logged + tombstoned with status='error' so the next
 * cron run will try again. Empty UW responses tombstone with
 * status='empty' so we don't repeatedly hammer expired contracts.
 */
export async function fetchAndCacheOptionIntraday(
  apiKey: string,
  optionChain: string,
  date: string,
): Promise<OptionIntradayMinute[]> {
  const sql = getDb();
  const cached = (await sql`
    SELECT status FROM option_intraday_nbbo_fetches
    WHERE option_chain = ${optionChain} AND date = ${date}::date
  `) as Array<{ status: string }>;
  if (cached.length > 0 && cached[0]!.status !== 'error') {
    return readCached(optionChain, date);
  }

  let rows: UwIntradayRow[];
  try {
    rows = await withRetry(() =>
      uwFetch<UwIntradayRow>(
        apiKey,
        `/option-contract/${optionChain}/intraday?date=${date}`,
      ),
    );
  } catch (err) {
    logger.warn({ err, optionChain, date }, 'option-intraday: UW fetch failed');
    await recordFetch(optionChain, date, 0, 'error');
    return [];
  }

  await persistRows(optionChain, rows);
  await recordFetch(
    optionChain,
    date,
    rows.length,
    rows.length === 0 ? 'empty' : 'ok',
  );

  const out: OptionIntradayMinute[] = [];
  for (const r of rows) {
    const m = rowFromUw(r);
    if (m) out.push(m);
  }
  return out;
}
