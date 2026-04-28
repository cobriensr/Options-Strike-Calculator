/**
 * GET /api/cron/fetch-strike-iv
 *
 * 1-minute cron that snapshots per-strike implied volatility for the
 * tickers in STRIKE_IV_TICKERS (SPXW, NDXP, SPY, QQQ, IWM, SMH, NVDA,
 * TSLA, META, MSFT, SNDK, MSTR, MU — 13 tickers after the 2026-04-25
 * multi-theme expansion) into the `strike_iv_snapshots` table.
 * Foundation for the Strike IV Anomaly Detector (Phase 2 layers
 * detection + context capture on top).
 *
 * Per ticker, per run:
 *   1. Fetch the Schwab option chain for today → next 2 Fridays.
 *      SPXW/NDXP are not separately queryable; the cron queries `$SPX`
 *      and `$NDX` respectively and filters contract symbols to the
 *      desired weekly root after the fetch.
 *   2. Filter to OTM ±3% of spot.
 *   3. Filter to per-ticker min OI (see minOiFor).
 *   4. Recompute IV from bid/ask/mid price via Black-Scholes — Schwab's
 *      quoted IV may use a different forward/model, and recomputing keeps
 *      the cross-ticker time series consistent.
 *   5. Batch-insert one row per strike × expiry × side into
 *      strike_iv_snapshots.
 *
 * Fault tolerance: a Schwab auth or fetch failure for one ticker must NOT
 * block the others. Each ticker runs independently and its errors are
 * captured to Sentry but not rethrown to the handler. NDXP in particular
 * may legitimately have no 0DTE listed on some sessions — logged as
 * `empty_chain`, not an error.
 *
 * Cron cadence: `* 13-21 * * 1-5` — every minute during market hours.
 * Volume budget: 13 tickers × 1 request/min = 780 Schwab requests/hour,
 * still well under the per-app rate limit.
 *
 * Environment: CRON_SECRET (no UW API key — pure Schwab + Neon).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard, schwabFetch } from '../_lib/api-helpers.js';
import {
  STRIKE_IV_OTM_RANGE_PCT_CASH_INDEX,
  STRIKE_IV_OTM_RANGE_PCT_BROAD_ETF,
  STRIKE_IV_OTM_RANGE_PCT_SINGLE_NAME,
  STRIKE_IV_OTM_RANGE_PCT_HIGH_LIQ_NAME,
  STRIKE_IV_MIN_OI_CASH_INDEX,
  STRIKE_IV_MIN_OI_SPY_QQQ,
  STRIKE_IV_MIN_OI_IWM,
  STRIKE_IV_MIN_OI_SECTOR_ETF,
  STRIKE_IV_MIN_OI_HIGH_LIQ,
  STRIKE_IV_MIN_OI_SINGLE_NAME,
  STRIKE_IV_TICKERS,
  Z_WINDOW_SIZE,
  type StrikeIVTicker,
} from '../_lib/constants.js';
import { impliedVolatility } from '../../src/utils/black-scholes.js';
import { getETCloseUtcIso } from '../../src/utils/timezone.js';
import {
  detectAnomalies,
  classifyFlowPhase,
  strikeKey,
  tapeKey,
  type StrikeSample,
  type TapeStats,
} from '../_lib/iv-anomaly.js';
import {
  detectGammaSqueezes,
  squeezeKey,
  type SqueezeFlag,
  type SqueezeWindowSample,
} from '../_lib/gamma-squeeze.js';
import { gatherContextSnapshot } from '../_lib/anomaly-context.js';

// ── Schwab types (duplicated locally — api/chain.ts is an endpoint, not a
//    reusable module, and extracting a shared helper is out of scope for
//    Phase 1). Only include the fields we actually read.
// ────────────────────────────────────────────────────────────

interface SchwabOptionContract {
  putCall: 'PUT' | 'CALL';
  /**
   * OSI-format symbol, e.g. "SPXW  260424P07030000". Used to filter
   * SPXW vs SPX and NDXP vs NDX contracts from the shared `$SPX` /
   * `$NDX` chain responses.
   */
  symbol: string;
  bid: number;
  ask: number;
  mark: number;
  totalVolume: number;
  openInterest: number;
  strikePrice: number;
  daysToExpiration: number;
  expirationDate: string; // ISO "YYYY-MM-DDTHH:mm:ss..."
}

interface SchwabChainResponse {
  symbol: string;
  status: string;
  underlying: {
    symbol: string;
    last: number;
    close: number;
  };
  putExpDateMap: Record<string, Record<string, SchwabOptionContract[]>>;
  callExpDateMap: Record<string, Record<string, SchwabOptionContract[]>>;
}

// ── Row payload for a single insert ──────────────────────────

interface SnapshotRow {
  ticker: StrikeIVTicker;
  strike: number;
  side: 'call' | 'put';
  expiry: string; // YYYY-MM-DD
  spot: number;
  ivMid: number | null;
  ivBid: number | null;
  ivAsk: number | null;
  midPrice: number;
  oi: number;
  volume: number;
}

// ── Date / expiry helpers ────────────────────────────────────

/**
 * Given an ISO date string (YYYY-MM-DD), return the next N Fridays
 * (including today if today IS a Friday). Used to bound the Schwab
 * chain fetch to 0DTE + 2 near-dated Friday expiries.
 */
function nextFridays(fromDate: string, count: number): string[] {
  const [y, m, d] = fromDate.split('-').map(Number);
  if (y == null || m == null || d == null) return [];
  const out: string[] = [];
  const cursor = new Date(Date.UTC(y, m - 1, d));
  // Walk forward until we've collected `count` Fridays.
  for (let i = 0; i < 30 && out.length < count; i += 1) {
    if (cursor.getUTCDay() === 5) {
      out.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Build the sorted, deduped list of expiries we snapshot for: today (0DTE)
 * followed by the next 2 Fridays after today. If today IS a Friday, today
 * doubles as the first "next Friday" so we end up with exactly [today,
 * next Friday, Friday-after-that].
 */
function buildExpirySet(today: string): string[] {
  const fridays = nextFridays(today, 3);
  const set = new Set<string>([today, ...fridays]);
  return [...set].sort();
}

/**
 * Parse "YYYY-MM-DD:DTE" key from Schwab's {put,call}ExpDateMap into just
 * the date portion. Schwab sometimes returns the raw date with no DTE
 * suffix on ITM-exercised maps — handle both shapes defensively.
 */
function parseExpKey(key: string): string {
  const colon = key.indexOf(':');
  return colon === -1 ? key : key.slice(0, colon);
}

// ── Schwab chain fetch ───────────────────────────────────────

/**
 * Schwab chain-endpoint symbol for each ticker.
 *
 *   - SPXW (weekly SPX) → `$SPX`: Schwab returns BOTH SPX monthlies and
 *     SPXW weeklies in the same chain, so we filter by OSI root downstream.
 *   - NDXP (weekly NDX) → `$NDX`: same pattern — NDX monthlies + NDXP
 *     weeklies come back together, filtered by root after fetch.
 *   - All other tickers (SPY/QQQ/IWM/SMH/NVDA/TSLA/META/MSFT/SNDK/MSTR/MU)
 *     → bare symbol (ETF + equity option roots are root-unique).
 *
 * The `$`-prefix convention matches api/chain.ts; cash indices take it,
 * ETFs and single-name equities don't.
 */
function schwabSymbol(ticker: StrikeIVTicker): string {
  switch (ticker) {
    case 'SPXW':
      return '$SPX';
    case 'NDXP':
      return '$NDX';
    case 'SPY':
    case 'QQQ':
    case 'IWM':
    case 'SMH':
    case 'NVDA':
    case 'TSLA':
    case 'META':
    case 'MSFT':
    case 'GOOGL':
    case 'SNDK':
    case 'MSTR':
    case 'MU':
      return ticker;
    default: {
      const _exhaustive: never = ticker;
      throw new Error(`No Schwab symbol for ticker: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Per-ticker minimum open interest. Six tiers reflect chain-wide strike
 * density and liquidity depth; see constants for rationale.
 *
 * The exhaustiveness check means adding a new ticker to STRIKE_IV_TICKERS
 * without a matching case here is a compile error — not a silent fallback.
 */
function minOiFor(ticker: StrikeIVTicker): number {
  switch (ticker) {
    case 'SPXW':
    case 'NDXP':
      return STRIKE_IV_MIN_OI_CASH_INDEX;
    case 'SPY':
    case 'QQQ':
      return STRIKE_IV_MIN_OI_SPY_QQQ;
    case 'IWM':
      return STRIKE_IV_MIN_OI_IWM;
    case 'SMH':
      return STRIKE_IV_MIN_OI_SECTOR_ETF;
    case 'NVDA':
    case 'TSLA':
    case 'META':
    case 'MSFT':
    case 'GOOGL':
      return STRIKE_IV_MIN_OI_HIGH_LIQ;
    case 'SNDK':
    case 'MSTR':
    case 'MU':
      return STRIKE_IV_MIN_OI_SINGLE_NAME;
    default: {
      const _exhaustive: never = ticker;
      throw new Error(`No OI threshold for ticker: ${String(_exhaustive)}`);
    }
  }
}

/**
 * OTM range as a fraction of spot. Four-tier 2026-04-28:
 *   - Cash-index weeklies (SPXW/NDXP): ±12% — captures lottery-ticket
 *     whale prints at 8-12% OTM (e.g. NDXP 27300C +2,155% on
 *     2026-04-24 was 11.4% OTM, invisible to a ±3% gate).
 *   - Broad ETFs (SPY/QQQ/IWM): ±3% — reaction surface, flow
 *     concentrates near ATM.
 *   - High-liq single names (NVDA/TSLA/META/MSFT/GOOGL): ±12% —
 *     widened from ±5% to catch deep-OTM whales (TSLA 400C @ 11.4% OTM
 *     was profitable on 2026-04-27 but invisible to the prior ±5% gate).
 *     Liquidity supports it: $1-spaced strikes through ~15% OTM with
 *     tradeable OI on these names.
 *   - Sector ETF + mid-liq single names (SMH/SNDK/MSTR/MU): ±5% —
 *     thinner ladders, informed flow concentrates 4-5% OTM.
 */
function otmRangePctFor(ticker: StrikeIVTicker): number {
  switch (ticker) {
    case 'SPXW':
    case 'NDXP':
      return STRIKE_IV_OTM_RANGE_PCT_CASH_INDEX;
    case 'SPY':
    case 'QQQ':
    case 'IWM':
      return STRIKE_IV_OTM_RANGE_PCT_BROAD_ETF;
    case 'NVDA':
    case 'TSLA':
    case 'META':
    case 'MSFT':
    case 'GOOGL':
      return STRIKE_IV_OTM_RANGE_PCT_HIGH_LIQ_NAME;
    case 'SMH':
    case 'SNDK':
    case 'MSTR':
    case 'MU':
      return STRIKE_IV_OTM_RANGE_PCT_SINGLE_NAME;
    default: {
      const _exhaustive: never = ticker;
      throw new Error(`No OTM range for ticker: ${String(_exhaustive)}`);
    }
  }
}

/**
 * OSI-root filter. SPXW/NDXP chains come back under the parent `$SPX` /
 * `$NDX` fetch mixed with the monthly (SPX / NDX) contracts; we only want
 * the weekly root. A Schwab OSI symbol is `<ROOT-padded-to-6><YYMMDD><C|P><strike-pad>`,
 * so the first token (whitespace-separated) is the root.
 *
 * For everything else the fetch is already root-unique — returns `true`.
 * ETF and single-name equity roots don't have parallel weekly-vs-monthly
 * namespaces like SPX/SPXW and NDX/NDXP do.
 */
function matchesRoot(
  ticker: StrikeIVTicker,
  contractSymbol: string | undefined,
): boolean {
  if (ticker !== 'SPXW' && ticker !== 'NDXP') return true;
  if (!contractSymbol) return false;
  // OSI root lives before the first whitespace block; fall back to the
  // first non-digit/non-space run for exotic formatting.
  const root = contractSymbol.split(/\s+/)[0] ?? '';
  return root === ticker;
}

async function fetchChain(
  ticker: StrikeIVTicker,
  fromDate: string,
  toDate: string,
): Promise<SchwabChainResponse | null> {
  const symbol = encodeURIComponent(schwabSymbol(ticker));
  // `strategy=SINGLE&range=ALL&strikeCount=500` pulls the full strike ladder
  // across the date window — we filter to the ±3% OTM band downstream.
  const path =
    `/chains?symbol=${symbol}&contractType=ALL&includeUnderlyingQuote=true` +
    `&strategy=SINGLE&range=ALL` +
    `&fromDate=${fromDate}&toDate=${toDate}&strikeCount=500`;
  const result = await schwabFetch<SchwabChainResponse>(path);
  if (!result.ok) {
    logger.warn(
      { ticker, status: result.status, error: result.error },
      'fetch-strike-iv: Schwab chain fetch failed',
    );
    return null;
  }
  return result.data;
}

// ── Row extraction (per ticker) ──────────────────────────────

/**
 * Convert the nested {put,call}ExpDateMap → flat array of per-strike rows
 * filtered to the allowed expiries, OTM ±3% band, and min OI for the
 * ticker. IV is recomputed from bid/ask/mid prices via Black-Scholes and
 * may be null when the solver can't invert a stale quote.
 */
function extractRows(
  chain: SchwabChainResponse,
  ticker: StrikeIVTicker,
  allowedExpiries: Set<string>,
  nowMs: number,
): SnapshotRow[] {
  const spot = chain.underlying?.last;
  if (!Number.isFinite(spot) || spot <= 0) return [];

  const otmRangePct = otmRangePctFor(ticker);
  const lowerBound = spot * (1 - otmRangePct);
  const upperBound = spot * (1 + otmRangePct);
  const minOi = minOiFor(ticker);
  const rows: SnapshotRow[] = [];

  for (const [side, map] of [
    ['call', chain.callExpDateMap ?? {}] as const,
    ['put', chain.putExpDateMap ?? {}] as const,
  ]) {
    for (const expKey of Object.keys(map)) {
      const expiry = parseExpKey(expKey);
      if (!allowedExpiries.has(expiry)) continue;

      const strikesMap = map[expKey]!;
      for (const rawStrikeKey of Object.keys(strikesMap)) {
        const contracts = strikesMap[rawStrikeKey]!;
        if (contracts.length === 0) continue;
        // OSI root filter — discards SPX monthlies returned alongside
        // SPXW weeklies (same for NDX / NDXP). No-op for SPY/QQQ/IWM.
        const c = contracts.find((cx) => matchesRoot(ticker, cx.symbol));
        if (!c) continue;

        const strike = c.strikePrice;
        if (!Number.isFinite(strike)) continue;

        // OTM gate: strict sense of "out of the money" for the given side.
        //   calls: strike > spot
        //   puts:  strike < spot
        // Plus the ±3% band.
        if (side === 'call' && strike <= spot) continue;
        if (side === 'put' && strike >= spot) continue;
        if (strike < lowerBound || strike > upperBound) continue;

        // Min OI gate. Treat NaN as 0 (illiquid).
        const oi = Number.isFinite(c.openInterest) ? c.openInterest : 0;
        if (oi < minOi) continue;

        // Prices must form a valid bid ≤ mid ≤ ask with a positive mid.
        //
        // We prefer Schwab's `mark` field when it's a valid in-window
        // value because it represents the broker's market mark — which
        // can deviate from (bid+ask)/2 when MMs lean the displayed mid
        // toward bid or ask in response to flow pressure. The
        // side-skew gate (`detectAnomalies`) reads that asymmetry as a
        // proxy for tape-side dominance: when mark sits closer to the
        // bid, ask_skew rises; closer to ask, bid_skew rises. Falling
        // back to (bid+ask)/2 keeps the cron working when mark is
        // missing or out-of-band (NaN, ≤0, outside the bid/ask cone).
        const bid = Number.isFinite(c.bid) ? c.bid : 0;
        const ask = Number.isFinite(c.ask) ? c.ask : 0;
        if (bid <= 0 || ask <= 0 || ask < bid) continue;
        const midpoint = (bid + ask) / 2;
        const mark = Number.isFinite(c.mark) ? c.mark : 0;
        const mid = mark > 0 && mark >= bid && mark <= ask ? mark : midpoint;
        if (mid <= 0) continue;

        // Time-to-expiry in YEARS. Use 4:00 PM ET settlement on the expiry
        // date — this is DST-aware (20:00 UTC during EDT, 21:00 UTC during
        // EST), matching the actual cash-session close. Near enough for
        // IV inversion at the ±3% OTM band where vega is well-behaved.
        // (For a 0DTE snapshot at 10:00 ET this gives T ≈ 6h/8760h ≈ 0.00068
        // — the solver handles this regime cleanly down to its tail guards.)
        const expiryCloseIso = getETCloseUtcIso(expiry);
        if (!expiryCloseIso) continue;
        const expiryMs = Date.parse(expiryCloseIso);
        if (!Number.isFinite(expiryMs)) continue;
        const T = Math.max(expiryMs - nowMs, 60_000) / (365 * 24 * 3600 * 1000);

        const ivMid = impliedVolatility(mid, spot, strike, T, side);
        const ivBid = impliedVolatility(bid, spot, strike, T, side);
        const ivAsk = impliedVolatility(ask, spot, strike, T, side);

        // Drop the row entirely if the mid-IV doesn't invert — the anomaly
        // detector keys off iv_mid, so a row without it is noise. bid/ask
        // legs can still be null (wider tolerance) and we let the schema
        // nullability handle that.
        if (ivMid == null || !Number.isFinite(ivMid) || ivMid <= 0) {
          logger.warn(
            { ticker, strike, side, expiry, bid, ask, mid, spot, T },
            'fetch-strike-iv: mid IV inversion failed — skipping strike',
          );
          continue;
        }

        rows.push({
          ticker,
          strike,
          side,
          expiry,
          spot,
          ivMid,
          ivBid: ivBid != null && Number.isFinite(ivBid) ? ivBid : null,
          ivAsk: ivAsk != null && Number.isFinite(ivAsk) ? ivAsk : null,
          midPrice: mid,
          oi,
          volume: Number.isFinite(c.totalVolume) ? c.totalVolume : 0,
        });
      }
    }
  }

  return rows;
}

// ── DB insert ────────────────────────────────────────────────

async function insertRows(
  sql: ReturnType<typeof getDb>,
  rows: SnapshotRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  // One transaction per ticker; each row inserted via a tagged template
  // call inside the transaction so Neon builds the parameterized query
  // correctly. Follows the same shape as fetch-strike-exposure.
  const results = await sql.transaction((txn) =>
    rows.map(
      (row) => txn`
        INSERT INTO strike_iv_snapshots (
          ticker, strike, side, expiry, spot,
          iv_mid, iv_bid, iv_ask,
          mid_price, oi, volume
        )
        VALUES (
          ${row.ticker}, ${row.strike}, ${row.side}, ${row.expiry}, ${row.spot},
          ${row.ivMid}, ${row.ivBid}, ${row.ivAsk},
          ${row.midPrice}, ${row.oi}, ${row.volume}
        )
        ON CONFLICT (ticker, strike, side, expiry, ts) DO NOTHING
        RETURNING id
      `,
    ),
  );

  let inserted = 0;
  for (const r of results) {
    if (r.length > 0) inserted += 1;
  }
  return inserted;
}

// ── Detection (Phase 2) ──────────────────────────────────────

/**
 * Convert a freshly-ingested SnapshotRow (what we just INSERTed) into
 * the detector's StrikeSample shape. Volume/OI are included for the
 * primary vol/OI gate in `detectAnomalies`; iv_mid/iv_bid/iv_ask + ts +
 * identity keys are used for the signal checks.
 */
function toStrikeSample(row: SnapshotRow, ts: string): StrikeSample {
  return {
    ticker: row.ticker,
    strike: row.strike,
    side: row.side,
    expiry: row.expiry,
    iv_mid: row.ivMid,
    iv_bid: row.ivBid,
    iv_ask: row.ivAsk,
    volume: Number.isFinite(row.volume) ? row.volume : null,
    oi: Number.isFinite(row.oi) ? row.oi : null,
    ts,
  };
}

/**
 * Load the last Z_WINDOW_SIZE iv_mid samples per (ticker, strike, side,
 * expiry) tuple for this ticker, excluding the target sample itself
 * (WHERE ts < now). Returns a map keyed by strikeKey() for O(1) lookup
 * inside the detector.
 *
 * Composite index `idx_strike_iv_snapshots_lookup` covers every WHERE
 * column + ORDER BY so this is an index-only scan per tuple.
 */
async function loadHistoryForTicker(
  sql: ReturnType<typeof getDb>,
  ticker: StrikeIVTicker,
  sampledAt: string,
): Promise<Map<string, StrikeSample[]>> {
  // Row shape from the window-function query. Neon returns NUMERIC
  // columns as strings and TIMESTAMPTZ as either string or Date — hence
  // the string | number variants per column.
  type NullableNumeric = string | number | null;
  interface HistoryRow {
    ticker: string;
    strike: string | number;
    side: string;
    expiry: string | Date;
    iv_mid: NullableNumeric;
    iv_bid: NullableNumeric;
    iv_ask: NullableNumeric;
    volume: NullableNumeric;
    oi: NullableNumeric;
    ts: string | Date;
  }

  // Single query that pulls the last N samples per strike tuple using
  // a window function. Much cheaper than issuing one query per strike.
  // Volume/OI are selected alongside IV so historical samples keep the
  // same StrikeSample shape as the freshly-ingested target; the detector
  // only consults vol/OI on the target sample, not on history, but
  // keeping the shape uniform avoids future shape-drift surprises.
  const rows = (await sql`
    SELECT ticker, strike, side, expiry, iv_mid, iv_bid, iv_ask, volume, oi, ts
    FROM (
      SELECT
        ticker, strike, side, expiry, iv_mid, iv_bid, iv_ask, volume, oi, ts,
        ROW_NUMBER() OVER (
          PARTITION BY ticker, strike, side, expiry
          ORDER BY ts DESC
        ) AS rn
      FROM strike_iv_snapshots
      WHERE ticker = ${ticker}
        AND ts < ${sampledAt}
    ) sub
    WHERE rn <= ${Z_WINDOW_SIZE}
    ORDER BY ticker, strike, side, expiry, ts DESC
  `) as HistoryRow[];

  const result = new Map<string, StrikeSample[]>();
  for (const r of rows) {
    const strike = Number(r.strike);
    const side = r.side as 'call' | 'put';
    const expiry =
      r.expiry instanceof Date
        ? r.expiry.toISOString().slice(0, 10)
        : String(r.expiry).slice(0, 10);
    const ts = r.ts instanceof Date ? r.ts.toISOString() : String(r.ts);
    const key = strikeKey(r.ticker, strike, side, expiry);
    const bucket = result.get(key);
    const sample: StrikeSample = {
      ticker: r.ticker,
      strike,
      side,
      expiry,
      iv_mid: r.iv_mid == null ? null : Number(r.iv_mid),
      iv_bid: r.iv_bid == null ? null : Number(r.iv_bid),
      iv_ask: r.iv_ask == null ? null : Number(r.iv_ask),
      volume: r.volume == null ? null : Number(r.volume),
      oi: r.oi == null ? null : Number(r.oi),
      ts,
    };
    if (bucket) bucket.push(sample);
    else result.set(key, [sample]);
  }
  return result;
}

/**
 * Load cumulative-since-open bid/ask volume splits from `strike_trade_volume`
 * for every (ticker, strike, side) tuple that traded today up to `sampledAt`.
 *
 * The tape table is populated by the per-minute `fetch-strike-trade-volume`
 * cron from UW's flow-per-strike-intraday endpoint. It aggregates ACROSS
 * expiries by design — there's no expiry column. A strike with 0 rows in
 * the day gets dropped from the map, and `detectAnomalies` skips that
 * strike (the gate cannot judge directionality without prints).
 *
 * Single SUM-by-group query per ticker — index `idx_strike_trade_volume_ticker_ts`
 * covers the WHERE clause cleanly.
 */
async function loadTapeStatsForTicker(
  sql: ReturnType<typeof getDb>,
  ticker: StrikeIVTicker,
  sampledAtIso: string,
): Promise<Map<string, TapeStats>> {
  type AggRow = {
    strike: string | number;
    side: string;
    bid_total: string | number | null;
    ask_total: string | number | null;
    mid_total: string | number | null;
    vol_total: string | number | null;
  };
  const rows = (await sql`
    SELECT strike,
           side,
           SUM(bid_side_vol) AS bid_total,
           SUM(ask_side_vol) AS ask_total,
           SUM(mid_vol)      AS mid_total,
           SUM(total_vol)    AS vol_total
    FROM strike_trade_volume
    WHERE ticker = ${ticker}
      AND ts::date = (${sampledAtIso}::timestamptz AT TIME ZONE 'America/New_York')::date
      AND ts <= ${sampledAtIso}
    GROUP BY strike, side
  `) as AggRow[];

  const out = new Map<string, TapeStats>();
  for (const r of rows) {
    const total = Number(r.vol_total ?? 0);
    if (!Number.isFinite(total) || total <= 0) continue;
    const bid = Number(r.bid_total ?? 0);
    const ask = Number(r.ask_total ?? 0);
    const mid = Number(r.mid_total ?? 0);
    const strike = Number(r.strike);
    const side = r.side === 'call' ? 'call' : 'put';
    out.set(tapeKey(ticker, strike, side), {
      bid_pct: bid / total,
      ask_pct: ask / total,
      mid_pct: mid / total,
      total_vol: total,
    });
  }
  return out;
}

/**
 * Load the trailing 45-min window of `strike_iv_snapshots` for the gamma
 * squeeze detector. Same source as `loadHistoryForTicker` but with a
 * different shape: keyed by squeezeKey(strike, side, expiry) and
 * including spot per sample.
 *
 * 45 min covers the detector's deepest lookback (30-min for prior
 * velocity baseline) plus 15 min of the current velocity window.
 */
async function loadSqueezeWindowForTicker(
  sql: ReturnType<typeof getDb>,
  ticker: StrikeIVTicker,
  sampledAtIso: string,
): Promise<Map<string, SqueezeWindowSample[]>> {
  type WindowRow = {
    strike: string | number;
    side: string;
    expiry: string | Date;
    ts: string | Date;
    volume: string | number | null;
    oi: string | number | null;
    spot: string | number | null;
  };
  const rows = (await sql`
    SELECT strike, side, expiry, ts, volume, oi, spot
    FROM strike_iv_snapshots
    WHERE ticker = ${ticker}
      AND ts >= (${sampledAtIso}::timestamptz - INTERVAL '45 minutes')
      AND ts <= ${sampledAtIso}
      AND volume IS NOT NULL
      AND oi IS NOT NULL
      AND oi > 0
    ORDER BY strike, side, expiry, ts
  `) as WindowRow[];

  const out = new Map<string, SqueezeWindowSample[]>();
  for (const r of rows) {
    const strike = Number(r.strike);
    const side = r.side === 'call' ? 'call' : 'put';
    const expiry =
      r.expiry instanceof Date
        ? r.expiry.toISOString().slice(0, 10)
        : String(r.expiry).slice(0, 10);
    const ts = r.ts instanceof Date ? r.ts.toISOString() : String(r.ts);
    const volume = Number(r.volume ?? 0);
    const oi = Number(r.oi ?? 0);
    const spot = Number(r.spot ?? 0);
    if (!Number.isFinite(strike) || !Number.isFinite(volume)) continue;
    if (!Number.isFinite(oi) || oi <= 0) continue;
    if (!Number.isFinite(spot) || spot <= 0) continue;
    const key = squeezeKey(strike, side, expiry);
    const sample: SqueezeWindowSample = {
      strike,
      side,
      expiry,
      ts,
      volume,
      oi,
      spot,
    };
    const bucket = out.get(key);
    if (bucket) bucket.push(sample);
    else out.set(key, [sample]);
  }
  return out;
}

/**
 * Load net dealer gamma per strike from `strike_exposures` for SPXW.
 *
 * Schema reality (2026-04-28): the `strike_exposures` table is populated
 * exclusively by the SPX GEX cron with `ticker = 'SPX'` (literal). SPY,
 * QQQ, and single names have no rows here. So this loader normalizes
 * SPXW → 'SPX' for the lookup and returns an empty Map for every other
 * ticker. The squeeze detector treats unknown NDG as 'pass' on Gate 6,
 * so non-SPXW tickers run on Gates 1-5 only.
 *
 * Net gamma is computed as `call_gamma_oi + put_gamma_oi` matching the
 * convention in `gex-per-strike.ts`. Sign convention: NDG > 0 = dealers
 * net LONG gamma (their hedging dampens moves) → squeeze gate filters
 * those strikes out. NDG < 0 = dealers SHORT gamma (hedging amplifies
 * moves — squeeze is real).
 */
async function loadNetDealerGammaForTicker(
  sql: ReturnType<typeof getDb>,
  ticker: StrikeIVTicker,
  sampledAtIso: string,
): Promise<Map<number, number>> {
  // Only SPXW has a corresponding row set in strike_exposures (under
  // ticker 'SPX'). NDXP / SPY / QQQ / IWM / SMH / single-names all skip
  // this query and inherit 'unknown' NDG from the detector.
  if (ticker !== 'SPXW') return new Map();

  type ExposureRow = {
    strike: string | number;
    net_gamma: string | number | null;
  };
  // Most-recent snapshot per strike, looking back 1 hour from the detect
  // ts. The GEX cron writes 5-min-rounded timestamps so a 1-hour window
  // comfortably covers the freshest snapshot even after a cron skip.
  const rows = (await sql`
    SELECT DISTINCT ON (strike)
           strike,
           (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
    FROM strike_exposures
    WHERE ticker = 'SPX'
      AND timestamp <= ${sampledAtIso}
      AND timestamp >= (${sampledAtIso}::timestamptz - INTERVAL '1 hour')
    ORDER BY strike, timestamp DESC
  `) as ExposureRow[];

  const out = new Map<number, number>();
  for (const r of rows) {
    const strike = Number(r.strike);
    const ndg = Number(r.net_gamma ?? 0);
    if (!Number.isFinite(strike) || !Number.isFinite(ndg)) continue;
    out.set(strike, ndg);
  }
  return out;
}

/**
 * Persist gamma squeeze flags emitted in this run. Mirrors
 * `runIvAnomalyDetection` shape but for the new
 * `gamma_squeeze_events` table. A failure here is logged + captured to
 * Sentry but does NOT roll back the IV anomaly path or the snapshot
 * ingestion — squeeze detection is the lowest-priority signal.
 */
async function persistSqueezeFlags(
  sql: ReturnType<typeof getDb>,
  flags: SqueezeFlag[],
  contextJson: string,
): Promise<number> {
  if (flags.length === 0) return 0;
  let inserted = 0;
  for (const f of flags) {
    const result = await sql`
      INSERT INTO gamma_squeeze_events (
        ticker, strike, side, expiry, ts,
        spot_at_detect, pct_from_strike, spot_trend_5m,
        vol_oi_15m, vol_oi_15m_prior, vol_oi_acceleration, vol_oi_total,
        net_gamma_sign, squeeze_phase, context_snapshot
      ) VALUES (
        ${f.ticker}, ${f.strike}, ${f.side}, ${f.expiry}, ${f.ts},
        ${f.spot_at_detect}, ${f.pct_from_strike}, ${f.spot_trend_5m},
        ${f.vol_oi_15m}, ${f.vol_oi_15m_prior}, ${f.vol_oi_acceleration}, ${f.vol_oi_total},
        ${f.net_gamma_sign}, ${f.squeeze_phase}, ${contextJson}::jsonb
      )
      ON CONFLICT (ticker, strike, side, expiry, ts) DO NOTHING
      RETURNING id
    `;
    if ((result as unknown[]).length > 0) inserted += 1;
  }
  return inserted;
}

/**
 * For every row we just inserted, check for anomalies against the
 * trailing Z_WINDOW_SIZE history + the current cross-strike snapshot.
 * Flags are enriched with a ContextSnapshot + flow_phase label and
 * inserted into iv_anomalies.
 *
 * Returns the count of anomalies written. A detection failure logs
 * + captures to Sentry but does NOT cause the ingestion cron to
 * report failure — Phase 1 ingestion always takes precedence.
 */
async function runDetection(
  sql: ReturnType<typeof getDb>,
  ticker: StrikeIVTicker,
  insertedRows: SnapshotRow[],
  sampledAtIso: string,
): Promise<number> {
  if (insertedRows.length === 0) return 0;

  const spot = insertedRows[0]!.spot;
  const samples = insertedRows.map((r) => toStrikeSample(r, sampledAtIso));

  const [historyByStrike, tapeByKey, squeezeWindow, ndgByStrike] =
    await Promise.all([
      loadHistoryForTicker(sql, ticker, sampledAtIso),
      loadTapeStatsForTicker(sql, ticker, sampledAtIso),
      loadSqueezeWindowForTicker(sql, ticker, sampledAtIso),
      loadNetDealerGammaForTicker(sql, ticker, sampledAtIso),
    ]);

  const flags = detectAnomalies(samples, historyByStrike, tapeByKey, spot);
  // Run gamma-squeeze detection in parallel to IV-anomaly detection.
  // It uses different gates (velocity vs side concentration), so the two
  // signals can both fire on the same compound key without contradiction.
  const squeezeFlags = detectGammaSqueezes(
    squeezeWindow,
    ticker,
    sampledAtIso,
    ndgByStrike,
  );

  if (flags.length === 0 && squeezeFlags.length === 0) return 0;

  // All flags in this batch share the same (ticker, sampledAtIso) pair —
  // gather the context snapshot ONCE instead of re-running ~30 queries
  // per flag. Any per-flag micro-drift in detectTs is below the
  // staleness windows the context queries use.
  const detectTs = new Date(sampledAtIso);
  const context = await gatherContextSnapshot(ticker, detectTs);
  const contextJson = JSON.stringify(context);

  // Persist squeeze flags first (they don't depend on IV-anomaly output
  // and are best-effort — failure won't block the IV-anomaly path).
  try {
    await persistSqueezeFlags(sql, squeezeFlags, contextJson);
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-iv');
    Sentry.setTag('strike_iv.ticker', ticker);
    Sentry.setTag('strike_iv.phase', 'gamma_squeeze_persist');
    Sentry.captureException(err);
    logger.error(
      { err, ticker, count: squeezeFlags.length },
      'fetch-strike-iv: gamma squeeze persist failed — IV anomaly path continues',
    );
  }

  if (flags.length === 0) return 0;

  let inserted = 0;
  for (const flag of flags) {
    const flowPhase = classifyFlowPhase(flag, context);

    const result = await sql`
      INSERT INTO iv_anomalies (
        ticker, strike, side, expiry,
        spot_at_detect, iv_at_detect,
        skew_delta, z_score, ask_mid_div, vol_oi_ratio,
        side_skew, side_dominant,
        bid_pct, ask_pct, mid_pct, total_vol_at_detect,
        flag_reasons, flow_phase, context_snapshot, ts
      ) VALUES (
        ${flag.ticker}, ${flag.strike}, ${flag.side}, ${flag.expiry},
        ${flag.spot_at_detect}, ${flag.iv_at_detect},
        ${flag.skew_delta}, ${flag.z_score}, ${flag.ask_mid_div}, ${flag.vol_oi_ratio},
        ${flag.side_skew}, ${flag.side_dominant},
        ${flag.bid_pct}, ${flag.ask_pct}, ${flag.mid_pct}, ${flag.total_vol_at_detect},
        ${flag.flag_reasons}, ${flowPhase}, ${contextJson}::jsonb,
        ${flag.ts}
      )
      ON CONFLICT (ticker, strike, side, expiry, ts) DO NOTHING
      RETURNING id
    `;
    if ((result as unknown[]).length > 0) inserted += 1;
  }
  return inserted;
}

// ── Per-ticker runner ────────────────────────────────────────

interface TickerResult {
  ticker: StrikeIVTicker;
  rowsInserted: number;
  anomaliesDetected: number;
  skipped: boolean;
  reason?: string;
}

async function runTicker(
  ticker: StrikeIVTicker,
  sql: ReturnType<typeof getDb>,
  today: string,
  nowMs: number,
): Promise<TickerResult> {
  try {
    const expiries = buildExpirySet(today);
    const allowed = new Set(expiries);
    // Inclusive bounds for the Schwab call.
    const fromDate = expiries[0]!;
    const toDate = expiries.at(-1)!;

    const chain = await fetchChain(ticker, fromDate, toDate);
    if (chain == null) {
      return {
        ticker,
        rowsInserted: 0,
        anomaliesDetected: 0,
        skipped: true,
        reason: 'schwab_error',
      };
    }

    const rows = extractRows(chain, ticker, allowed, nowMs);
    if (rows.length === 0) {
      logger.info(
        { ticker, expiries, spot: chain.underlying?.last ?? null },
        'fetch-strike-iv: no rows after filter',
      );
      return {
        ticker,
        rowsInserted: 0,
        anomaliesDetected: 0,
        skipped: true,
        reason: 'empty_chain',
      };
    }

    const rowsInserted = await insertRows(sql, rows);

    // ── Phase 2: anomaly detection ────────────────────────────
    //
    // Runs after ingestion so a detection failure cannot roll back
    // the per-strike snapshot rows — Phase 1 data is strictly
    // first-class. We use the cron's wall-clock start as the
    // canonical ts so the window function that loads history can
    // exclude the just-inserted samples cleanly (WHERE ts <
    // sampledAtIso). The ingestion transaction stamps rows with
    // NOW() which is slightly after nowMs, hence the < comparison
    // is safe.
    let anomaliesDetected = 0;
    try {
      const sampledAtIso = new Date(nowMs).toISOString();
      anomaliesDetected = await runDetection(sql, ticker, rows, sampledAtIso);
    } catch (err) {
      Sentry.setTag('cron.job', 'fetch-strike-iv');
      Sentry.setTag('strike_iv.ticker', ticker);
      Sentry.setTag('strike_iv.phase', 'detection');
      Sentry.captureException(err);
      logger.error(
        { err, ticker },
        'fetch-strike-iv: detection failed — ingestion already persisted',
      );
    }

    logger.info(
      {
        ticker,
        spot: chain.underlying?.last ?? null,
        expiries,
        rowsInserted,
        candidateRows: rows.length,
        anomaliesDetected,
      },
      'strike_iv_snapshots written',
    );

    return { ticker, rowsInserted, anomaliesDetected, skipped: false };
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-iv');
    Sentry.setTag('strike_iv.ticker', ticker);
    Sentry.captureException(err);
    logger.error({ err, ticker }, 'fetch-strike-iv: ticker failed');
    return {
      ticker,
      rowsInserted: 0,
      anomaliesDetected: 0,
      skipped: true,
      reason: 'exception',
    };
  }
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, { requireApiKey: false });
  if (!guard) return;
  const { today } = guard;

  const startTime = Date.now();
  const sql = getDb();

  try {
    // Run tickers in parallel — they're independent and fault-isolated.
    const results = await Promise.all(
      STRIKE_IV_TICKERS.map((t) => runTicker(t, sql, today, startTime)),
    );

    const totalInserted = results.reduce((sum, r) => sum + r.rowsInserted, 0);
    const totalAnomalies = results.reduce(
      (sum, r) => sum + r.anomaliesDetected,
      0,
    );
    const durationMs = Date.now() - startTime;

    return res.status(200).json({
      job: 'fetch-strike-iv',
      totalInserted,
      totalAnomalies,
      results,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-iv');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-strike-iv error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
