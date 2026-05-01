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
  type StrikeIVTicker,
} from '../_lib/constants.js';
import { impliedVolatility } from '../../src/utils/black-scholes.js';
import { getETCloseUtcIso } from '../../src/utils/timezone.js';
import {
  detectGammaSqueezes,
  squeezeKey,
  type SqueezeFlag,
  type SqueezeWindowSample,
} from '../_lib/gamma-squeeze.js';
import { gatherContextSnapshot } from '../_lib/anomaly-context.js';
import {
  computeHhi,
  computeIvMorningVolCorr,
  IV_MORNING_CUTOFF_HOUR_CT,
  PROXIMITY_BAND_PCT,
  type BandStrikeSample,
  type IvVolSample,
} from '../_lib/precision-stack.js';

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
    case 'RUTW':
      return '$RUT';
    case 'SPY':
    case 'QQQ':
    case 'IWM':
    case 'SMH':
    case 'NVDA':
    case 'TSLA':
    case 'META':
    case 'MSFT':
    case 'GOOGL':
    case 'NFLX':
    case 'TSM':
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
    case 'RUTW':
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
    case 'NFLX':
    case 'TSM':
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
    case 'RUTW':
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
    case 'NFLX':
    case 'TSM':
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
  // SPXW/NDXP/RUTW share their parent symbol's chain ($SPX/$NDX/$RUT) and
  // need OSI-root filtering to drop monthlies (which would conflict with
  // weeklies on third-Friday expiries via the unique key).
  if (ticker !== 'SPXW' && ticker !== 'NDXP' && ticker !== 'RUTW') return true;
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
/**
 * Stamp HHI and morning IV-vol correlation on every squeeze flag in place.
 * Two queries per flag — one for the band's per-strike notional (within
 * ±0.5% of spot, same side), one for the strike's pre-11:00 CT IV
 * trajectory. Both run in parallel across all flags via Promise.all so
 * a 10-flag batch issues 20 concurrent queries instead of 20 sequential.
 * Per-flag failures are caught individually so one bad fire can't poison
 * the rest of the batch — failed enrichment stamps null (columns are
 * nullable; the read endpoint treats null as "not eligible for pass").
 */
type NumericFromDb = string | number | null;
interface BandRow {
  strike: string | number;
  volume: NumericFromDb;
  mid_price: NumericFromDb;
}
interface IvRow {
  minute_ct: string | Date;
  iv: NumericFromDb;
  cum_volume: NumericFromDb;
}

async function enrichSingleFlag(
  sql: ReturnType<typeof getDb>,
  f: SqueezeFlag,
): Promise<void> {
  try {
    const bandLow = f.spot_at_detect * (1 - PROXIMITY_BAND_PCT);
    const bandHigh = f.spot_at_detect * (1 + PROXIMITY_BAND_PCT);

    // Fire both queries in parallel — they're independent.
    const [bandRows, ivRows] = (await Promise.all([
      sql`
        SELECT DISTINCT ON (strike)
               strike, volume, mid_price
        FROM strike_iv_snapshots
        WHERE ticker = ${f.ticker}
          AND side = ${f.side}
          AND expiry = ${f.expiry}
          AND ts <= ${f.ts}
          AND ts >= (${f.ts}::timestamptz - INTERVAL '15 minutes')
          AND strike BETWEEN ${bandLow} AND ${bandHigh}
        ORDER BY strike, ts DESC
      `,
      sql`
        SELECT date_trunc('minute', ts AT TIME ZONE 'America/Chicago') AS minute_ct,
               AVG(iv_mid) AS iv,
               MAX(volume) AS cum_volume
        FROM strike_iv_snapshots
        WHERE ticker = ${f.ticker}
          AND strike = ${f.strike}
          AND side = ${f.side}
          AND expiry = ${f.expiry}
          AND DATE(ts AT TIME ZONE 'America/Chicago') = DATE(${f.ts}::timestamptz AT TIME ZONE 'America/Chicago')
          AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/Chicago') < ${IV_MORNING_CUTOFF_HOUR_CT}
          AND iv_mid IS NOT NULL
          AND iv_mid > 0
          AND iv_mid < 5
        GROUP BY 1
        ORDER BY minute_ct
      `,
    ])) as [BandRow[], IvRow[]];

    const bandSamples: BandStrikeSample[] = [];
    for (const r of bandRows) {
      const strike = Number(r.strike);
      const volume = r.volume == null ? NaN : Number(r.volume);
      const midPrice = r.mid_price == null ? NaN : Number(r.mid_price);
      if (
        Number.isFinite(strike) &&
        Number.isFinite(volume) &&
        Number.isFinite(midPrice)
      ) {
        bandSamples.push({ strike, volume, midPrice });
      }
    }
    f.hhi_neighborhood = computeHhi(bandSamples);

    const ivSamples: IvVolSample[] = [];
    for (const r of ivRows) {
      const ts =
        r.minute_ct instanceof Date
          ? r.minute_ct.toISOString()
          : String(r.minute_ct);
      const iv = r.iv == null ? NaN : Number(r.iv);
      const volume = r.cum_volume == null ? NaN : Number(r.cum_volume);
      if (Number.isFinite(iv) && Number.isFinite(volume)) {
        ivSamples.push({ ts, iv, volume });
      }
    }
    f.iv_morning_vol_corr = computeIvMorningVolCorr(ivSamples);
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-iv');
    Sentry.setTag('strike_iv.phase', 'precision_stack_enrichment');
    Sentry.captureException(err);
    logger.warn(
      { err, ticker: f.ticker, strike: f.strike },
      'fetch-strike-iv: precision-stack enrichment failed (non-fatal)',
    );
    f.hhi_neighborhood = null;
    f.iv_morning_vol_corr = null;
  }
}

async function enrichWithPrecisionStack(
  sql: ReturnType<typeof getDb>,
  flags: SqueezeFlag[],
): Promise<void> {
  // Fan out across flags — each enrichSingleFlag handles its own errors.
  await Promise.all(flags.map((f) => enrichSingleFlag(sql, f)));
}

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
        net_gamma_sign, squeeze_phase, context_snapshot,
        hhi_neighborhood, iv_morning_vol_corr
      ) VALUES (
        ${f.ticker}, ${f.strike}, ${f.side}, ${f.expiry}, ${f.ts},
        ${f.spot_at_detect}, ${f.pct_from_strike}, ${f.spot_trend_5m},
        ${f.vol_oi_15m}, ${f.vol_oi_15m_prior}, ${f.vol_oi_acceleration}, ${f.vol_oi_total},
        ${f.net_gamma_sign}, ${f.squeeze_phase}, ${contextJson}::jsonb,
        ${f.hhi_neighborhood ?? null}, ${f.iv_morning_vol_corr ?? null}
      )
      ON CONFLICT (ticker, strike, side, expiry, ts) DO NOTHING
      RETURNING id
    `;
    if ((result as unknown[]).length > 0) inserted += 1;
  }
  return inserted;
}

/**
 * For every row we just inserted, run the gamma-squeeze detector against
 * the trailing window. Flags are enriched with a `ContextSnapshot` and
 * persisted to `gamma_squeeze_events`.
 *
 * IV-anomaly persistence retired with the Whale Anomalies migration —
 * see docs/superpowers/specs/whale-anomalies-2026-04-29.md, Phase 7.
 * `iv_anomalies` is dropped in migration #100 and no consumer reads it.
 *
 * Returns the squeeze flag count (or 0). Detection failures log + capture
 * to Sentry but don't fail the cron — ingestion always takes precedence.
 */
async function runDetection(
  sql: ReturnType<typeof getDb>,
  ticker: StrikeIVTicker,
  insertedRows: SnapshotRow[],
  sampledAtIso: string,
): Promise<number> {
  if (insertedRows.length === 0) return 0;

  const [squeezeWindow, ndgByStrike] = await Promise.all([
    loadSqueezeWindowForTicker(sql, ticker, sampledAtIso),
    loadNetDealerGammaForTicker(sql, ticker, sampledAtIso),
  ]);

  const squeezeFlags = detectGammaSqueezes(
    squeezeWindow,
    ticker,
    sampledAtIso,
    ndgByStrike,
  );

  if (squeezeFlags.length === 0) return 0;

  // All flags in this batch share the same (ticker, sampledAtIso) pair —
  // gather the context snapshot ONCE instead of re-running ~30 queries
  // per flag. Any per-flag micro-drift in detectTs is below the
  // staleness windows the context queries use.
  const detectTs = new Date(sampledAtIso);
  const context = await gatherContextSnapshot(ticker, detectTs);
  const contextJson = JSON.stringify(context);

  // Stamp HHI + iv_morning_vol_corr on every flag before persisting. Pure
  // enrichment — failures are caught per-flag and stamp NULL columns.
  await enrichWithPrecisionStack(sql, squeezeFlags);

  try {
    await persistSqueezeFlags(sql, squeezeFlags, contextJson);
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-iv');
    Sentry.setTag('strike_iv.ticker', ticker);
    Sentry.setTag('strike_iv.phase', 'gamma_squeeze_persist');
    Sentry.captureException(err);
    logger.error(
      { err, ticker, count: squeezeFlags.length },
      'fetch-strike-iv: gamma squeeze persist failed',
    );
    return 0;
  }
  return squeezeFlags.length;
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
