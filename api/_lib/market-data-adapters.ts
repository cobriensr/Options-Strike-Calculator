/**
 * Market-data adapters — Schwab-shaped assemblers over Unusual Whales
 * REST + the Railway sidecar's Theta Terminal index routes.
 *
 * Phase 2 of docs/superpowers/specs/schwab-replacement-2026-08-16.md.
 *
 * `schwabFetch` (api/_lib/schwab-fetch.ts) dispatches by path prefix to
 * these adapters, which rebuild the EXACT response shapes the 14 legacy
 * `schwabFetch<T>` call sites parse — the generic `T` is a compile-time
 * contract only, so every field path a consumer reads must exist here
 * with the same name, type, and unit (see the recon fields_consumed
 * inventory captured in the spec).
 *
 * Sources:
 *   - Unusual Whales REST via `uwFetch` — ALL calls flow through the
 *     shared per-minute budget (uw-rate-limit) + concurrency semaphore
 *     (uw-concurrency) exactly like every other UW consumer.
 *   - Railway sidecar Theta index routes for the Cboe index values the
 *     sidecar's allowlist serves ($SPX/$VIX/$VIX1D/$VIX9D/$VVIX — see
 *     SIDECAR_INDEX_ROOTS; $NDX is NOT on the sidecar allowlist and
 *     routes to the UW stock screener instead, see UW_INDEX_ROOTS):
 *
 *       GET {SIDECAR_URL}/theta/index/price?root=SPX
 *         → { root, price, prev_close, ts }
 *           (snapshot only — NO open/high/low; the quotes adapter
 *           derives those from today's /theta/index/history candles)
 *       GET {SIDECAR_URL}/theta/index/history?root=SPX&date=YYYY-MM-DD
 *         → { root, date, candles: [{ ts_ms, open, high, low, close }] }
 *           (1-min OHLC of index values; indices have no volume)
 *
 *     Auth: `Authorization: Bearer ${SIDECAR_TAKEIT_SECRET}` (same
 *     shared secret as the /takeit routes), 8s timeout per call, 404 =
 *     no data for that date (holiday / not yet open). The sidecar
 *     serialises these routes (cap 2, 5s wait) and sheds
 *     `503 theta_busy` + Retry-After past that — retried ONCE here
 *     (thetaIndexGetJson); `503 theta_unavailable` (Terminal down) is
 *     not retried and falls to the UW screener where UW carries the root.
 *
 *   - Index spot on UW (sidecar fallback for SPX/VIX, primary for NDX)
 *     is the stock SCREENER row (`/screener/stocks?ticker=SPY,{ROOT}`
 *     → close/prev_close/high/low). UW's `/stock/{t}/stock-state`
 *     returns 422 "not available for index ticker" for EVERY index
 *     root and `/stock/{t}/ohlc/*` 422s on plan permissions, so neither
 *     can serve indices (recon 2026-08-18; see fetchUwIndexState).
 *
 *   - NYSE breadth internals ($TICK/$ADD/$VOLD/$TRIN) and $RUT (UW has
 *     no RUT index price anywhere) have NO replacement source →
 *     `SOURCE_UNAVAILABLE` (501). Consumers are fail-open
 *     (fetch-market-internals stores NULL feature columns) and
 *     schwab-fetch passes 501 through to real Schwab Market Data when
 *     Schwab is configured.
 *
 * Error semantics: failures keep the `[SCHWAB_*]`-prefixed error
 * strings and the 401/429/502/504 status mapping of the legacy fetch
 * layer so caller branches (retry-on-429, soft-fail-on-502, etc.) stay
 * live. Timeouts/network errors → 504 `[SCHWAB_API_NETWORK]`.
 */

import type { ApiResult } from './schwab-fetch.js';
import { mapWithConcurrency, parseUwHttpStatus, uwFetch } from './uw-fetch.js';
import logger from './logger.js';
import { getETDateStr, getETTotalMinutes } from '../../src/utils/timezone.js';

// ── Tuning constants ─────────────────────────────────────────

/** Sidecar Theta proxy calls get an interactive-latency budget. */
const SIDECAR_TIMEOUT_MS = 8_000;
/** UW option-contracts page size (UW max). */
const CHAIN_PAGE_LIMIT = 500;
/** Max UW pages walked per chain expiry (spec: 3 pages ≈ 1,500 rows). */
const CHAIN_MAX_PAGES = 3;
/** Max expiries assembled per /chains request (today + near Fridays). */
const CHAIN_MAX_EXPIRIES = 4;
/** Max trading days fanned out per /pricehistory request (~3 months). */
const MAX_HISTORY_DATES = 66;
/**
 * Per-date fan-out for the UW equity history branch
 * (fetchEquityDayCandles). UW calls are already bounded by uw-fetch's
 * own concurrency semaphore + per-minute budget, so this only shapes
 * how many dates one request has in flight.
 */
const HISTORY_CONCURRENCY = 6;
/**
 * Per-date fan-out for the sidecar index history branch
 * (fetchIndexDayCandles). The sidecar serialises /theta/index/* to cap
 * 2 with a 5s wait budget (sidecar/src/health.py theta_index_slot) and
 * sheds `503 theta_busy` past it, so client concurrency above ~3 buys
 * ZERO throughput — it only converts into sidecar queue wait, and when
 * /api/history's symbol pairs × 6 dates stacked 12 arrivals at once
 * the tail of that queue waited out the budget and came back empty
 * (the 2026-08-19 "$VIX1D n/a" blank). 3 rather than 2 hides the
 * Vercel→Railway RTT: one call is always on the wire while the other
 * two hold the Terminal slots.
 */
const INDEX_HISTORY_CONCURRENCY = 3;
/**
 * Backoff before the single retry of a `503 theta_busy` shed when the
 * sidecar sent no usable Retry-After (it always sends `1`; this is
 * the belt-and-braces default).
 */
const THETA_BUSY_RETRY_DEFAULT_MS = 1_000;
/**
 * Ceiling for an honoured Retry-After. The retry is a second
 * SIDECAR_TIMEOUT_MS-bounded call, so the wait must stay well inside
 * an interactive budget rather than following an arbitrary header.
 */
const THETA_BUSY_RETRY_MAX_MS = 2_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Schwab index symbols → Theta/UW index roots. */
const INDEX_ROOT_BY_SYMBOL: Record<string, string> = {
  $SPX: 'SPX',
  $NDX: 'NDX',
  $RUT: 'RUT',
  $VIX: 'VIX',
  $VIX1D: 'VIX1D',
  $VIX9D: 'VIX9D',
  $VVIX: 'VVIX',
};

/**
 * Index roots the sidecar's Theta allowlist actually serves — MUST
 * mirror `_THETA_INDEX_ROOTS` in sidecar/src/health.py. Roots outside
 * this set (NDX, RUT) would 400 on every sidecar call, so they never
 * touch the sidecar and go to UW (NDX) or SOURCE_UNAVAILABLE (RUT).
 */
const SIDECAR_INDEX_ROOTS = new Set(['SPX', 'VIX', 'VIX1D', 'VIX9D', 'VVIX']);

/**
 * Index roots whose spot UW carries — as stock SCREENER rows, not
 * stock-state (recon 2026-08-18, markets closed, verified per root):
 *
 *   endpoint                          SPX     VIX     NDX     RUT
 *   /stock/{t}/stock-state            422     422     422     422
 *     ("Stock state data is not available for index ticker …" —
 *      deterministic, so the pre-08-18 fallback could never succeed
 *      and NDX/RUT quotes were permanently dead)
 *   /stock/{t}/ohlc/1m | /ohlc/1d      422     422     422     422
 *     ("You do not have permissions to retrieve OHLC data for index
 *      ticker …" — plan permission)
 *   /stock/{t}/spot-exposures/strike   200     200     200     200
 *     but `price` is the ATM STRIKE bucket (7 distinct SPX values over
 *     a full session, VIX only 15.5/16) — unusable as a spot
 *   /screener/stocks?ticker=SPY,{t}    close   close   close   NULL
 *     + prev_close/high/low (precise, e.g. SPX 7691.76 / prev 7745.06)
 *
 * Used as the sidecar fallback for SPX/VIX and as the primary source
 * for NDX. RUT is NULL on the screener, max-pain, iv-rank AND realized
 * → not carried → SOURCE_UNAVAILABLE. VIX1D/VIX9D/VVIX are
 * sidecar-only — the screener has no rows for them.
 */
const UW_INDEX_ROOTS = new Set(['SPX', 'NDX', 'VIX']);

/**
 * Equity ticker paired with every index screener request. UW quirk
 * (recon 2026-08-18, deterministic across SPY/QQQ/AAPL/IWM): a screener
 * request whose ticker set is index-only returns the index rows with
 * NULL close/high/low (prev_close still set); adding any equity/ETF to
 * the same request populates them. One extra row, same single call.
 */
const UW_SCREENER_COMPANION = 'SPY';

/** NYSE breadth internals with no UW/Theta source. */
const INTERNALS_SYMBOLS = new Set(['$TICK', '$ADD', '$VOLD', '$TRIN']);

// ── Shared error plumbing ────────────────────────────────────

class ConfigError extends Error {}

class SidecarHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** Parsed `Retry-After` header in seconds, when the sidecar sent one. */
    readonly retryAfterSec: number | null = null,
  ) {
    super(`Sidecar API ${status}: ${body.slice(0, 200)}`);
    this.name = 'SidecarHttpError';
  }
}

/** Sidecar 404 — "no data for this date" (holiday, pre-open, etc.). */
class NoDataError extends Error {}

/**
 * Thrown deep in a per-symbol fetch when the symbol has NO source at
 * all (e.g. $RUT — see UW_INDEX_ROOTS). `mapError` turns it into the
 * 501 SOURCE_UNAVAILABLE envelope instead of a 502, so schwab-fetch's
 * Schwab passthrough can pick the request up. Deliberately NOT thrown
 * for transient failures of a covered symbol — those stay 502/504.
 */
class NoSourceError extends Error {}

/**
 * `{ok:false}` for a path with no replacement source (breadth internals,
 * unknown endpoints). Consumers of these paths are fail-open per recon.
 */
export function sourceUnavailable(path: string): ApiResult<never> {
  const endpoint = path.split('?')[0] ?? path;
  return {
    ok: false,
    status: 501,
    code: 'SOURCE_UNAVAILABLE',
    error: `[SOURCE_UNAVAILABLE] No market-data source for ${endpoint}`,
  };
}

function isTimeoutish(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
    return /timeout|timed out|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|socket hang up|network/i.test(
      err.message,
    );
  }
  return false;
}

/**
 * Translate an adapter-internal throw into the legacy schwab-fetch
 * ApiResult error contract:
 *   - upstream 401  → 401 `[SCHWAB_API_REJECTED]`
 *   - upstream 429  → 429 `[SCHWAB_API_429]` (incl. our own limiter)
 *   - other HTTP    → 502 `[SCHWAB_API_<status>]`
 *   - network/timeout → 504 `[SCHWAB_API_NETWORK]`
 *   - missing env   → 500 `[SCHWAB_TOKEN_ERROR]`
 *   - no source     → 501 `[SOURCE_UNAVAILABLE]` (NoSourceError; `path`
 *                     names the endpoint in the message)
 */
function mapError(err: unknown, path: string): ApiResult<never> {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof NoSourceError) {
    return sourceUnavailable(path);
  }

  if (err instanceof ConfigError) {
    return { ok: false, status: 500, error: `[SCHWAB_TOKEN_ERROR] ${message}` };
  }

  let upstreamStatus =
    err instanceof SidecarHttpError ? err.status : parseUwHttpStatus(message);
  if (upstreamStatus === null && /UW rate limiter/i.test(message)) {
    upstreamStatus = 429;
  }

  if (upstreamStatus !== null) {
    if (upstreamStatus === 401) {
      return {
        ok: false,
        status: 401,
        error: `[SCHWAB_API_REJECTED] ${message}`,
      };
    }
    if (upstreamStatus === 429) {
      return { ok: false, status: 429, error: `[SCHWAB_API_429] ${message}` };
    }
    return {
      ok: false,
      status: 502,
      error: `[SCHWAB_API_${upstreamStatus}] ${message}`,
    };
  }

  if (isTimeoutish(err)) {
    return {
      ok: false,
      status: 504,
      error: `[SCHWAB_API_NETWORK] Market data network error: ${message}`,
    };
  }

  return { ok: false, status: 502, error: `[SCHWAB_API_502] ${message}` };
}

// ── Env + transport helpers ──────────────────────────────────

function uwKey(): string {
  const key = process.env.UW_API_KEY;
  if (!key) throw new ConfigError('UW_API_KEY not configured');
  return key;
}

function sidecarBase(): string {
  const url = process.env.SIDECAR_URL?.trim().replace(/\/$/, '');
  if (!url) throw new ConfigError('SIDECAR_URL not configured');
  return url;
}

/** `Retry-After: <seconds>` → seconds, or null when absent/unparseable. */
function parseRetryAfterSec(header: string | null): number | null {
  if (header == null) return null;
  const sec = Number.parseFloat(header);
  return Number.isFinite(sec) && sec >= 0 ? sec : null;
}

async function sidecarGetJson<T>(pathAndQuery: string): Promise<T> {
  const base = sidecarBase();
  const secret = process.env.SIDECAR_TAKEIT_SECRET;
  const res = await fetch(`${base}${pathAndQuery}`, {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
  });
  if (res.status === 404) {
    throw new NoDataError(`Sidecar 404 for ${pathAndQuery}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SidecarHttpError(
      res.status,
      body,
      parseRetryAfterSec(res.headers.get('Retry-After')),
    );
  }
  return (await res.json()) as T;
}

/**
 * Backoff (ms) before retrying a sidecar failure once, or null when the
 * failure is not a load shed. The sidecar's /theta/index/* routes
 * serialise Terminal access and answer `503 {"error":"theta_busy"}` +
 * `Retry-After: 1` when a request waits out its slot budget — a
 * transient "too many of us", worth exactly one retry. `503
 * theta_unavailable` is the Terminal being DOWN (the UW screener
 * fallback owns that for SPX/VIX), and 404 (NoDataError) is an
 * authoritative "no data" — neither is retried. A 503 with some other
 * body is treated as busy (same shed contract as the archive routes).
 * Mirrors multileg-client's Retry-After handling: body/header hint
 * first, a fixed default otherwise, always capped.
 */
function thetaBusyRetryDelayMs(err: unknown): number | null {
  if (!(err instanceof SidecarHttpError) || err.status !== 503) return null;
  if (err.body.includes('theta_unavailable')) return null;
  if (err.retryAfterSec == null) return THETA_BUSY_RETRY_DEFAULT_MS;
  return Math.min(err.retryAfterSec * 1000, THETA_BUSY_RETRY_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET a sidecar /theta/index/* route, retrying ONCE after a
 * `theta_busy` shed (see thetaBusyRetryDelayMs). Each attempt is its
 * own SIDECAR_TIMEOUT_MS-bounded call, so the worst case is two
 * timeouts plus the (≤2s) backoff — acceptable for the interactive
 * callers, and far better than blanking a whole symbol because one
 * date lost the Terminal-slot race. If the retry is shed again the
 * ORIGINAL error surfaces (no loop); anything more specific the retry
 * learns — 404 no-data, Terminal down — is thrown as-is.
 */
async function thetaIndexGetJson<T>(pathAndQuery: string): Promise<T> {
  try {
    return await sidecarGetJson<T>(pathAndQuery);
  } catch (err) {
    const delayMs = thetaBusyRetryDelayMs(err);
    if (delayMs == null) throw err;
    logger.warn(
      { pathAndQuery, delayMs },
      'market-data-adapters: sidecar theta_busy shed, retrying once',
    );
    await sleep(delayMs);
    try {
      return await sidecarGetJson<T>(pathAndQuery);
    } catch (retryErr) {
      throw thetaBusyRetryDelayMs(retryErr) == null ? retryErr : err;
    }
  }
}

// ── Small parsing helpers ────────────────────────────────────

/** UW returns numerics as JSON numbers OR strings; coerce defensively. */
type UwNum = string | number | null | undefined;

function num(v: UwNum): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function parseQuery(path: string): URLSearchParams {
  return new URLSearchParams(path.split('?')[1] ?? '');
}

function addDaysStr(dateStr: string, days: number): string {
  const ms = Date.parse(`${dateStr}T12:00:00Z`) + days * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC day-of-week for a YYYY-MM-DD string (0=Sun … 6=Sat). */
function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

function isWeekday(dateStr: string): boolean {
  const dow = dayOfWeek(dateStr);
  return dow >= 1 && dow <= 5;
}

/** Whole days between two YYYY-MM-DD strings (to − from). */
function dteBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

/** Regular-hours gate: 9:30 ≤ t < 16:00 ET (Schwab RTH equivalent). */
function isRegularHours(ms: number): boolean {
  const m = getETTotalMinutes(new Date(ms));
  return m >= 570 && m < 960;
}

// ── OSI symbol handling ──────────────────────────────────────

interface ParsedOsi {
  root: string;
  cp: 'C' | 'P';
  strike: number;
  /** YYYY-MM-DD */
  expiry: string;
  /** Schwab-style OSI with the root padded to 6 chars. */
  schwabSymbol: string;
}

/**
 * Parse a UW option_symbol (unpadded OSI, e.g. "SPXW260814P07780000")
 * into its parts and the Schwab-style space-padded form consumers'
 * root filters split on (`"SPXW  260814P07780000"`).
 */
function parseOsi(symbol: string | undefined | null): ParsedOsi | null {
  if (!symbol) return null;
  const s = symbol.trim().toUpperCase().replaceAll(/\s+/g, '');
  if (s.length < 16) return null;
  const strikeStr = s.slice(-8);
  const cp = s.slice(-9, -8);
  const dateStr = s.slice(-15, -9);
  const root = s.slice(0, -15);
  if (
    !/^\d{8}$/.test(strikeStr) ||
    !/^\d{6}$/.test(dateStr) ||
    (cp !== 'C' && cp !== 'P') ||
    !/^[A-Z][A-Z0-9.]*$/.test(root)
  ) {
    return null;
  }
  const yy = dateStr.slice(0, 2);
  const mm = dateStr.slice(2, 4);
  const dd = dateStr.slice(4, 6);
  return {
    root,
    cp,
    strike: Number.parseInt(strikeStr, 10) / 1000,
    expiry: `20${yy}-${mm}-${dd}`,
    schwabSymbol: `${root.padEnd(6, ' ')}${dateStr}${cp}${strikeStr}`,
  };
}

// ── Underlying spot (chains + quotes) ────────────────────────

/**
 * Sidecar /theta/index/price response. The real contract is
 * `{ root, price, prev_close, ts }` — open/high/low are typed optional
 * so the adapter picks them up if the sidecar ever adds them, but today
 * they are ALWAYS absent and the quotes adapter derives them from
 * today's /theta/index/history candles.
 */
interface SidecarIndexPrice {
  root?: string;
  price?: UwNum;
  open?: UwNum;
  high?: UwNum;
  low?: UwNum;
  prev_close?: UwNum;
  ts?: string;
}

interface UwStockState {
  open?: UwNum;
  high?: UwNum;
  low?: UwNum;
  close?: UwNum;
  last?: UwNum;
  price?: UwNum;
  prev_close?: UwNum;
  previous_close?: UwNum;
}

async function fetchUwStockState(ticker: string): Promise<UwStockState> {
  const rows = await uwFetch<UwStockState>(
    uwKey(),
    `/stock/${encodeURIComponent(ticker)}/stock-state`,
    (body) => {
      const data = (body as { data?: unknown }).data;
      if (Array.isArray(data)) return data as UwStockState[];
      if (data && typeof data === 'object') return [data as UwStockState];
      return [];
    },
  );
  const row = rows[0];
  if (!row) throw new Error('UW stock-state: empty response');
  return row;
}

/**
 * UW stock-screener row (`/screener/stocks`). Shared by the index-spot
 * path (ticker filter) and the movers adapter (S&P 500 filter).
 */
interface UwScreenerRow {
  ticker?: string;
  full_name?: string;
  close?: UwNum;
  prev_close?: UwNum;
  high?: UwNum;
  low?: UwNum;
  stock_volume?: UwNum;
}

interface UwIndexState {
  last: number;
  prevClose: number;
  high: number;
  low: number;
}

/**
 * Index spot from the UW stock screener — the only UW endpoint that
 * carries a precise index last + prev close (see UW_INDEX_ROOTS for
 * the per-endpoint recon). The root is always paired with
 * UW_SCREENER_COMPANION because index-only requests come back with
 * NULL close/high/low. No `open` on the screener → callers use 0.
 *
 * A row without a usable close is a plain Error (→ 502): the root IS
 * carried, so an empty close is a transient upstream hiccup, not a
 * missing source.
 */
async function fetchUwIndexState(root: string): Promise<UwIndexState> {
  const tickers = encodeURIComponent(`${UW_SCREENER_COMPANION},${root}`);
  const rows = await uwFetch<UwScreenerRow>(
    uwKey(),
    `/screener/stocks?ticker=${tickers}`,
  );
  const row = rows.find((r) => r.ticker?.toUpperCase() === root);
  const last = num(row?.close);
  if (last == null || last <= 0) {
    throw new Error(`UW screener: no price for index ${root}`);
  }
  return {
    last,
    prevClose: num(row?.prev_close) ?? 0,
    high: num(row?.high) ?? 0,
    low: num(row?.low) ?? 0,
  };
}

interface UnderlyingSpot {
  last: number;
  close: number;
}

/**
 * Underlying spot + prev close. Sidecar-served index roots hit the
 * sidecar first (Theta index snapshot); on failure the UW-carried ones
 * (SPX/VIX) fall back to the UW screener while sidecar-only roots
 * (VIX1D/VIX9D/VVIX) rethrow. NDX skips the sidecar entirely (not on
 * its allowlist — a call would just burn a 400 + warn log every time)
 * and goes straight to the screener; RUT has no source at all
 * (NoSourceError → 501). Equities go to UW stock-state.
 */
async function fetchUnderlyingSpot(
  schwabSymbol: string,
  uwTicker: string,
): Promise<UnderlyingSpot> {
  const indexRoot = INDEX_ROOT_BY_SYMBOL[schwabSymbol];
  if (indexRoot) {
    if (SIDECAR_INDEX_ROOTS.has(indexRoot)) {
      try {
        const p = await thetaIndexGetJson<SidecarIndexPrice>(
          `/theta/index/price?root=${encodeURIComponent(indexRoot)}`,
        );
        const last = num(p.price);
        if (last != null && last > 0) {
          return { last, close: num(p.prev_close) ?? 0 };
        }
        throw new Error(`Sidecar index price missing for ${schwabSymbol}`);
      } catch (err) {
        if (!UW_INDEX_ROOTS.has(indexRoot)) throw err;
        logger.warn(
          {
            schwabSymbol,
            err: err instanceof Error ? err.message : String(err),
          },
          'market-data-adapters: sidecar spot failed, falling back to UW screener',
        );
      }
    } else if (!UW_INDEX_ROOTS.has(indexRoot)) {
      throw new NoSourceError(
        `No market-data source for index ${schwabSymbol}`,
      );
    }
    const s = await fetchUwIndexState(indexRoot);
    return { last: s.last, close: s.prevClose };
  }

  const state = await fetchUwStockState(uwTicker);
  const last =
    num(state.close) ?? num(state.last) ?? num(state.price) ?? Number.NaN;
  if (!Number.isFinite(last)) {
    throw new Error(`UW stock-state: no price for ${uwTicker}`);
  }
  return {
    last,
    close: num(state.prev_close) ?? num(state.previous_close) ?? 0,
  };
}

// ── /chains adapter ──────────────────────────────────────────

interface UwOptionContractRow {
  option_symbol?: string;
  implied_volatility?: UwNum;
  delta?: UwNum;
  gamma?: UwNum;
  theta?: UwNum;
  vega?: UwNum;
  open_interest?: UwNum;
  volume?: UwNum;
  nbbo_bid?: UwNum;
  nbbo_ask?: UwNum;
  last_price?: UwNum;
}

interface SchwabShapedContract {
  putCall: 'PUT' | 'CALL';
  symbol: string;
  description: string;
  bid: number;
  ask: number;
  last: number;
  mark: number;
  totalVolume: number;
  openInterest: number;
  strikePrice: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  /** IV as PERCENT (25.5 = 25.5%) — Schwab unit; UW is decimal. */
  volatility: number;
  daysToExpiration: number;
  inTheMoney: boolean;
  theoreticalValue: number;
  expirationDate: string;
}

type ExpDateMap = Record<string, Record<string, SchwabShapedContract[]>>;

/**
 * Expiries to assemble for a [fromDate, toDate] chain request: today
 * when the window starts today (the 0DTE case) plus every Friday in
 * the window, capped. When a window that does NOT start today contains
 * no Friday at all (e.g. the 14-DTE analyze block's +12..+16d window
 * fired on a Mon/Tue spans Sat→Wed), fall back to the weekday closest
 * to the window midpoint so the request still yields a near-target
 * expiry instead of an empty chain.
 *
 * This mirrors what the consumers actually read: api/chain.ts and
 * compute-cone use fromDate === toDate === today; fetch-strike-iv
 * requests a single expiry per fire; the 14-DTE analyze block's 5-day
 * window contains at most one Friday (and hits the midpoint-weekday
 * fallback when it contains none). Other non-Friday dailies in a
 * Friday-bearing window were fetched by Schwab but discarded by every
 * consumer, so we skip the UW requests for them.
 */
function enumerateExpiries(
  fromDate: string,
  toDate: string,
  today: string,
): string[] {
  const out: string[] = [];
  let cur = fromDate;
  for (let i = 0; i < 45 && cur <= toDate; i += 1) {
    if (
      ((cur === fromDate && cur === today) || dayOfWeek(cur) === 5) &&
      !out.includes(cur) &&
      out.length < CHAIN_MAX_EXPIRIES
    ) {
      out.push(cur);
    }
    cur = addDaysStr(cur, 1);
  }
  if (out.length === 0) {
    // No 0DTE anchor and no Friday in the window. Pick the weekday
    // closest to the window midpoint (ties go to the earlier day).
    const midMs =
      (Date.parse(`${fromDate}T12:00:00Z`) +
        Date.parse(`${toDate}T12:00:00Z`)) /
      2;
    let best: string | null = null;
    let bestDist = Infinity;
    cur = fromDate;
    for (let i = 0; i < 45 && cur <= toDate; i += 1) {
      if (isWeekday(cur)) {
        const dist = Math.abs(Date.parse(`${cur}T12:00:00Z`) - midMs);
        if (dist < bestDist) {
          best = cur;
          bestDist = dist;
        }
      }
      cur = addDaysStr(cur, 1);
    }
    if (best) out.push(best);
  }
  return out;
}

/** Fetch all pages of UW option-contracts for one ticker × expiry. */
async function fetchChainContracts(
  uwTicker: string,
  expiry: string,
  filterSuffix: string,
): Promise<UwOptionContractRow[]> {
  const key = uwKey();
  const rows: UwOptionContractRow[] = [];
  for (let page = 0; page < CHAIN_MAX_PAGES; page += 1) {
    const batch = await uwFetch<UwOptionContractRow>(
      key,
      `/stock/${encodeURIComponent(uwTicker)}/option-contracts` +
        `?expiry=${expiry}&limit=${CHAIN_PAGE_LIMIT}&page=${page}` +
        filterSuffix,
    );
    rows.push(...batch);
    if (batch.length < CHAIN_PAGE_LIMIT) break;
  }
  return rows;
}

function toSchwabContract(
  row: UwOptionContractRow,
  osi: ParsedOsi,
  spot: number,
  dte: number,
): SchwabShapedContract {
  const putCall = osi.cp === 'C' ? 'CALL' : 'PUT';
  const bid = num(row.nbbo_bid) ?? 0;
  const ask = num(row.nbbo_ask) ?? 0;
  const mark = round4((bid + ask) / 2);
  const ivDecimal = num(row.implied_volatility) ?? 0;
  return {
    putCall,
    symbol: osi.schwabSymbol,
    description: `${osi.root} ${osi.expiry} ${osi.strike} ${putCall}`,
    bid,
    ask,
    last: num(row.last_price) ?? 0,
    mark,
    totalVolume: num(row.volume) ?? 0,
    openInterest: num(row.open_interest) ?? 0,
    strikePrice: osi.strike,
    delta: num(row.delta) ?? 0,
    gamma: num(row.gamma) ?? 0,
    theta: num(row.theta) ?? 0,
    vega: num(row.vega) ?? 0,
    volatility: round4(ivDecimal * 100),
    daysToExpiration: dte,
    inTheMoney: osi.cp === 'C' ? osi.strike < spot : osi.strike > spot,
    theoreticalValue: 0,
    expirationDate: osi.expiry,
  };
}

/**
 * `/chains` → Schwab chain shape from UW option-contracts + sidecar/UW
 * underlying spot. ExpDateMap keys are `YYYY-MM-DD:DTE`; each strike
 * key holds an ARRAY of contracts (SPX monthlies ride alongside SPXW
 * weeklies at shared strikes, exactly like Schwab — consumers' OSI
 * root filters depend on that).
 *
 * `range=OTM` (Schwab's out-of-the-money range) is honored server-side
 * via UW's `maybe_otm_only` filter — this is what keeps the
 * fetch-strike-iv path to ~1 UW page per expiry instead of paging the
 * full ladder. Other `range` values (ALL/NTM/…) fetch the full chain,
 * exactly like before.
 */
export async function chainAdapter(path: string): Promise<ApiResult<unknown>> {
  try {
    const q = parseQuery(path);
    const symbol = q.get('symbol') ?? '';
    const contractType = (q.get('contractType') ?? 'ALL').toUpperCase();
    const range = (q.get('range') ?? 'ALL').toUpperCase();
    const today = getETDateStr(new Date());
    const fromDate = q.get('fromDate') ?? today;
    const toDate = q.get('toDate') ?? fromDate;

    let uwTicker: string;
    if (symbol.startsWith('$')) {
      const root = INDEX_ROOT_BY_SYMBOL[symbol];
      if (!root) return sourceUnavailable(path);
      uwTicker = root;
    } else {
      uwTicker = symbol;
    }
    if (!uwTicker) return sourceUnavailable(path);

    const spot = await fetchUnderlyingSpot(symbol, uwTicker);

    const optionTypeSuffix =
      contractType === 'CALL'
        ? '&option_type=call'
        : contractType === 'PUT'
          ? '&option_type=put'
          : '';
    const otmSuffix = range === 'OTM' ? '&maybe_otm_only=true' : '';
    const filterSuffix = `${optionTypeSuffix}${otmSuffix}`;

    const callExpDateMap: ExpDateMap = {};
    const putExpDateMap: ExpDateMap = {};
    let contractCount = 0;

    for (const expiry of enumerateExpiries(fromDate, toDate, today)) {
      const rows = await fetchChainContracts(uwTicker, expiry, filterSuffix);
      const dte = dteBetween(today, expiry);
      const key = `${expiry}:${dte}`;
      for (const row of rows) {
        const osi = parseOsi(row.option_symbol);
        if (!osi) continue;
        if (contractType === 'CALL' && osi.cp !== 'C') continue;
        if (contractType === 'PUT' && osi.cp !== 'P') continue;
        const contract = toSchwabContract(row, osi, spot.last, dte);
        const map = osi.cp === 'C' ? callExpDateMap : putExpDateMap;
        const strikes = (map[key] ??= {});
        const strikeKey = osi.strike.toFixed(1);
        strikes[strikeKey] ??= [];
        strikes[strikeKey].push(contract);
        contractCount += 1;
      }
    }

    return {
      ok: true,
      data: {
        symbol,
        status: 'SUCCESS',
        underlying: {
          symbol,
          last: spot.last,
          close: spot.close,
          change: round4(spot.last - spot.close),
        },
        isDelayed: false,
        numberOfContracts: contractCount,
        callExpDateMap,
        putExpDateMap,
      },
    };
  } catch (err) {
    return mapError(err, path);
  }
}

// ── /pricehistory adapter ────────────────────────────────────

interface MinuteCandle {
  datetime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SidecarIndexHistory {
  root?: string;
  date?: string;
  candles?: {
    ts_ms?: UwNum;
    open?: UwNum;
    high?: UwNum;
    low?: UwNum;
    close?: UwNum;
  }[];
}

interface UwOhlcRow {
  start_time?: string;
  open?: UwNum;
  high?: UwNum;
  low?: UwNum;
  close?: UwNum;
  volume?: UwNum;
  market_time?: string;
}

/**
 * A price field of `0` (or negative / non-finite) is NEVER data.
 * Theta marks a minute with no print on an index root by zeroing the
 * field, so a bar arrives either ALL-zero (no print at all — 70 of
 * VIX's 312 bars on 2026-08-19, the session's first among them) or
 * PARTIAL, e.g. `{open:0, high:15.13, low:0, close:15.12}`. Letting a
 * `0` through poisons every downstream min/range (VIX session low,
 * the running OHLC low, term structure), so treat it as missing.
 */
function priceOrNull(v: UwNum): number | null {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

/**
 * Rebuild a bar's four price fields from whichever are present, or
 * null when NONE are (drop the bar). A no-print `open` is best
 * approximated by the bar's `close` (the level the minute actually
 * settled at — not its high, which would bias every reconstructed
 * open upward); a no-print `close` by the last present field; and
 * `high`/`low` are the max/min over PRESENT fields only — a bar with
 * one real price survives with all four fields positive. The real
 * Theta partial `{open:0, high:15.13, low:0, close:15.12}` therefore
 * yields open 15.12, high 15.13, low 15.12, close 15.12.
 */
function sanitizePrices(raw: {
  open?: UwNum;
  high?: UwNum;
  low?: UwNum;
  close?: UwNum;
}): Pick<MinuteCandle, 'open' | 'high' | 'low' | 'close'> | null {
  const open = priceOrNull(raw.open);
  const high = priceOrNull(raw.high);
  const low = priceOrNull(raw.low);
  const close = priceOrNull(raw.close);
  const present = [open, high, low, close].filter((v) => v != null);
  if (present.length === 0) return null;
  return {
    open: open ?? close ?? present[0]!,
    high: Math.max(...present),
    low: Math.min(...present),
    close: close ?? present.at(-1)!,
  };
}

/**
 * Time-sorted copy with every no-print bar dropped and every partial
 * bar rebuilt (see sanitizePrices).
 */
function sanitizeCandles(candles: MinuteCandle[]): MinuteCandle[] {
  const out: MinuteCandle[] = [];
  for (const c of candles) {
    const prices = sanitizePrices(c);
    if (prices) out.push({ ...c, ...prices });
  }
  return out.sort((a, b) => a.datetime - b.datetime);
}

/**
 * ET trading dates (Mon–Fri, ≤ today) covered by [startMs, endMs],
 * capped to the most recent MAX_HISTORY_DATES.
 */
function tradingDatesInRange(
  startMs: number,
  endMs: number,
  todayStr: string,
): string[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  const clampedEnd = Math.min(endMs, Date.now());
  if (clampedEnd < startMs) return [];
  const dates = new Set<string>();
  for (let t = startMs; t <= clampedEnd; t += DAY_MS) {
    dates.add(getETDateStr(new Date(t)));
  }
  dates.add(getETDateStr(new Date(clampedEnd)));
  return [...dates]
    .filter((d) => isWeekday(d) && d <= todayStr)
    .sort((a, b) => a.localeCompare(b))
    .slice(-MAX_HISTORY_DATES);
}

async function fetchIndexDayCandles(
  root: string,
  date: string,
): Promise<MinuteCandle[]> {
  let day: SidecarIndexHistory;
  try {
    day = await thetaIndexGetJson<SidecarIndexHistory>(
      `/theta/index/history?root=${encodeURIComponent(root)}&date=${date}`,
    );
  } catch (err) {
    if (err instanceof NoDataError) return [];
    throw err;
  }
  const out: MinuteCandle[] = [];
  for (const c of day.candles ?? []) {
    const datetime = num(c.ts_ms);
    if (datetime == null) continue;
    if (!isRegularHours(datetime)) continue;
    const prices = sanitizePrices(c);
    if (!prices) continue;
    out.push({ datetime, ...prices, volume: 0 });
  }
  return out;
}

async function fetchEquityDayCandles(
  ticker: string,
  date: string,
): Promise<MinuteCandle[]> {
  const rows = await uwFetch<UwOhlcRow>(
    uwKey(),
    `/stock/${encodeURIComponent(ticker)}/ohlc/1m?date=${date}`,
  );
  const out: MinuteCandle[] = [];
  for (const r of rows) {
    const datetime = r.start_time ? Date.parse(r.start_time) : Number.NaN;
    if (!Number.isFinite(datetime)) continue;
    // Regular session only (Schwab needExtendedHoursData=false parity):
    // trust UW's market_time tag when present, ET wall-clock otherwise.
    const rth = r.market_time
      ? r.market_time === 'r'
      : isRegularHours(datetime);
    if (!rth) continue;
    const prices = sanitizePrices(r);
    if (!prices) continue;
    out.push({ datetime, ...prices, volume: num(r.volume) ?? 0 });
  }
  return out;
}

/**
 * Aggregate 1-min candles into N-minute buckets (wall-clock aligned).
 * Sanitizing BEFORE bucketing is what keeps `Math.min` off a no-print
 * `0`: a window whose bars all lack prices produces NO bucket (not a
 * row of zeros), and a mixed one keeps the minimum POSITIVE low.
 */
function aggregateMinutes(
  candles: MinuteCandle[],
  freqMinutes: number,
): MinuteCandle[] {
  const sorted = sanitizeCandles(candles);
  if (freqMinutes <= 1) return sorted;
  const bucketMs = freqMinutes * 60_000;
  const buckets = new Map<number, MinuteCandle>();
  for (const c of sorted) {
    const start = c.datetime - (c.datetime % bucketMs);
    const b = buckets.get(start);
    if (!b) {
      buckets.set(start, { ...c, datetime: start });
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.datetime - b.datetime);
}

/**
 * Aggregate a day's minute candles into one daily candle. `datetime`
 * is NOON UTC of the trading date so BOTH consumer conventions —
 * UTC date parts (yesterday.ts) and ET conversion (fetch-outcomes
 * backfill) — resolve to the trading date. Null when every bar of the
 * session was a no-print minute (the day has no candle at all).
 */
function toDailyCandle(
  date: string,
  candles: MinuteCandle[],
): MinuteCandle | null {
  const sorted = sanitizeCandles(candles);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return null;
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (const c of sorted) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    volume += c.volume;
  }
  const [y, m, d] = date.split('-').map(Number);
  return {
    datetime: Date.UTC(y!, m! - 1, d!, 12, 0, 0),
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
  };
}

/**
 * `/pricehistory` → Schwab price-history shape.
 *
 * Symbol routing: Cboe/index roots → sidecar Theta history; equities →
 * UW `/stock/{t}/ohlc/1m`; NYSE internals → SOURCE_UNAVAILABLE.
 * `previousClose` is the final RTH close of the session before the
 * latest session in the returned window (the live-consumer semantic:
 * intraday.ts/ticker-candles get "yesterday's close").
 */
export async function historyAdapter(
  path: string,
): Promise<ApiResult<unknown>> {
  try {
    const q = parseQuery(path);
    const symbol = q.get('symbol') ?? '';
    if (INTERNALS_SYMBOLS.has(symbol)) return sourceUnavailable(path);

    const periodType = q.get('periodType') ?? 'day';
    const period = Number.parseInt(q.get('period') ?? '1', 10) || 1;
    const frequencyType = q.get('frequencyType') ?? 'minute';
    const frequency = Number.parseInt(q.get('frequency') ?? '1', 10) || 1;
    const startDateRaw = q.get('startDate');
    const endDateRaw = q.get('endDate');

    const now = Date.now();
    const todayStr = getETDateStr(new Date());

    let startMs: number;
    let endMs: number;
    if (startDateRaw != null && endDateRaw != null) {
      startMs = Number.parseInt(startDateRaw, 10);
      endMs = Number.parseInt(endDateRaw, 10);
    } else if (periodType === 'month') {
      startMs = now - period * 31 * DAY_MS;
      endMs = now;
    } else {
      // periodType=day (or anything else): last `period` calendar days.
      startMs = now - (period - 1) * DAY_MS;
      endMs = now;
    }

    const dates = tradingDatesInRange(startMs, endMs, todayStr);

    let perDay: { date: string; candles: MinuteCandle[] }[];
    if (symbol.startsWith('$')) {
      const root = INDEX_ROOT_BY_SYMBOL[symbol];
      if (!root) return sourceUnavailable(path);
      perDay = await mapWithConcurrency(
        dates,
        INDEX_HISTORY_CONCURRENCY,
        async (date) => ({
          date,
          candles: await fetchIndexDayCandles(root, date),
        }),
      );
    } else if (symbol) {
      perDay = await mapWithConcurrency(
        dates,
        HISTORY_CONCURRENCY,
        async (date) => ({
          date,
          candles: await fetchEquityDayCandles(symbol, date),
        }),
      );
    } else {
      return sourceUnavailable(path);
    }

    const daysWithData = perDay.filter((d) => d.candles.length > 0);

    let candles: MinuteCandle[];
    if (frequencyType === 'daily') {
      candles = daysWithData
        .map((d) => toDailyCandle(d.date, d.candles))
        .filter((c) => c != null);
      if (symbol.startsWith('$')) {
        for (const c of candles) c.volume = 0;
      }
    } else {
      candles = aggregateMinutes(
        daysWithData.flatMap((d) => d.candles),
        frequency,
      );
    }

    // previousClose: last close of the session before the latest one.
    let previousClose = 0;
    if (daysWithData.length >= 2) {
      const prevDay = daysWithData.at(-2)!;
      const sortedPrev = sanitizeCandles(prevDay.candles);
      previousClose = sortedPrev.at(-1)?.close ?? 0;
    }

    return {
      ok: true,
      data: {
        symbol,
        empty: candles.length === 0,
        previousClose,
        previousCloseDate: 0,
        candles,
      },
    };
  } catch (err) {
    return mapError(err, path);
  }
}

// ── /quotes adapter ──────────────────────────────────────────

interface SchwabShapedQuote {
  quote: {
    lastPrice: number;
    openPrice: number;
    highPrice: number;
    lowPrice: number;
    closePrice: number;
    netChange: number;
    netPercentChange: number;
    tradeTime: number;
  };
}

function buildQuote(
  last: number,
  open: number,
  high: number,
  low: number,
  prevClose: number,
): SchwabShapedQuote {
  const netChange = prevClose > 0 ? round4(last - prevClose) : 0;
  const netPercentChange =
    prevClose > 0 ? round4(((last - prevClose) / prevClose) * 100) : 0;
  return {
    quote: {
      lastPrice: last,
      openPrice: open,
      highPrice: high,
      lowPrice: low,
      closePrice: prevClose,
      netChange,
      netPercentChange,
      tradeTime: 0,
    },
  };
}

/**
 * Sidecar index quote. The price route only carries `{price,
 * prev_close}` — Schwab's quote shape also needs open/high/low (the
 * app's quote board reads openPrice/highPrice/lowPrice), so when the
 * snapshot omits them we derive today's session OHL from the sidecar's
 * RTH-filtered 1-min history. A missing/404 history (pre-open,
 * holiday) degrades to 0s without failing the quote — `lastPrice` is
 * the load-bearing field.
 */
async function fetchSidecarIndexQuote(
  root: string,
  symbol: string,
): Promise<SchwabShapedQuote> {
  const p = await thetaIndexGetJson<SidecarIndexPrice>(
    `/theta/index/price?root=${encodeURIComponent(root)}`,
  );
  const last = num(p.price);
  if (last == null || last <= 0) {
    throw new Error(`Sidecar index price missing for ${symbol}`);
  }
  let open = num(p.open);
  let high = num(p.high);
  let low = num(p.low);
  if (open == null || high == null || low == null) {
    try {
      const candles = await fetchIndexDayCandles(
        root,
        getETDateStr(new Date()),
      );
      const sorted = sanitizeCandles(candles);
      if (sorted.length > 0) {
        open ??= sorted[0]!.open;
        high ??= Math.max(...sorted.map((c) => c.high));
        low ??= Math.min(...sorted.map((c) => c.low));
      }
    } catch (err) {
      logger.warn(
        { symbol, err: err instanceof Error ? err.message : String(err) },
        'market-data-adapters: index OHL derivation failed — quote keeps 0s',
      );
    }
  }
  return buildQuote(
    last,
    open ?? 0,
    high ?? 0,
    low ?? 0,
    num(p.prev_close) ?? 0,
  );
}

async function fetchUwStockStateQuote(
  ticker: string,
): Promise<SchwabShapedQuote> {
  const state = await fetchUwStockState(ticker);
  const last =
    num(state.close) ?? num(state.last) ?? num(state.price) ?? Number.NaN;
  if (!Number.isFinite(last)) {
    throw new Error(`UW stock-state: no price for ${ticker}`);
  }
  return buildQuote(
    last,
    num(state.open) ?? 0,
    num(state.high) ?? 0,
    num(state.low) ?? 0,
    num(state.prev_close) ?? num(state.previous_close) ?? 0,
  );
}

/**
 * Index quote from the UW screener row. The screener has no `open`
 * (0, like the sidecar's pre-open degrade); high/low are today's
 * session values; lastPrice is the load-bearing field.
 */
async function fetchUwIndexQuote(root: string): Promise<SchwabShapedQuote> {
  const s = await fetchUwIndexState(root);
  return buildQuote(s.last, 0, s.high, s.low, s.prevClose);
}

/**
 * One symbol's quote. Routing:
 *   - sidecar-allowlisted index roots (SPX/VIX family) → sidecar,
 *     falling back to the UW screener for the roots UW carries
 *     (SPX/VIX); VIX1D/VIX9D/VVIX are sidecar-only and rethrow;
 *   - NDX → UW screener directly (NOT on the sidecar allowlist —
 *     calling it would 400 every time and quotesAdapter has no
 *     per-symbol retry);
 *   - RUT → NoSourceError (UW has no RUT index price; the old
 *     stock-state route 422'd deterministically);
 *   - equities → UW stock-state.
 */
async function fetchQuoteForSymbol(symbol: string): Promise<SchwabShapedQuote> {
  const indexRoot = INDEX_ROOT_BY_SYMBOL[symbol];
  if (indexRoot) {
    if (SIDECAR_INDEX_ROOTS.has(indexRoot)) {
      try {
        return await fetchSidecarIndexQuote(indexRoot, symbol);
      } catch (err) {
        if (!UW_INDEX_ROOTS.has(indexRoot)) throw err;
        logger.warn(
          { symbol, err: err instanceof Error ? err.message : String(err) },
          'market-data-adapters: sidecar quote failed, falling back to UW screener',
        );
      }
    } else if (!UW_INDEX_ROOTS.has(indexRoot)) {
      throw new NoSourceError(`No market-data source for index ${symbol}`);
    }
    return fetchUwIndexQuote(indexRoot);
  }
  return fetchUwStockStateQuote(symbol);
}

/**
 * `/quotes` → `Record<symbol, {quote}>` keyed by the exact requested
 * symbols. Per-symbol failures OMIT the key (consumers already map a
 * missing symbol to null); the call only fails when every requested
 * symbol fails. Internals-only requests are SOURCE_UNAVAILABLE, and so
 * is an all-failed request whose every failure is a no-source symbol
 * (e.g. `$RUT` alone) — but one transient failure among them wins, so
 * a sidecar blip is never mis-reported as "no source".
 */
export async function quotesAdapter(path: string): Promise<ApiResult<unknown>> {
  try {
    const q = parseQuery(path);
    const symbols = (q.get('symbols') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const fetchable = symbols.filter((s) => !INTERNALS_SYMBOLS.has(s));
    if (fetchable.length === 0) return sourceUnavailable(path);

    const settled = await Promise.allSettled(
      fetchable.map((s) => fetchQuoteForSymbol(s)),
    );

    const data: Record<string, SchwabShapedQuote> = {};
    let firstFailure: unknown = null;
    let firstTransient: unknown = null;
    settled.forEach((res, i) => {
      const sym = fetchable[i]!;
      if (res.status === 'fulfilled') {
        data[sym] = res.value;
      } else {
        firstFailure ??= res.reason;
        if (!(res.reason instanceof NoSourceError)) {
          firstTransient ??= res.reason;
        }
        logger.warn(
          {
            symbol: sym,
            err:
              res.reason instanceof Error
                ? res.reason.message
                : String(res.reason),
          },
          'market-data-adapters: quote symbol failed',
        );
      }
    });

    if (Object.keys(data).length === 0 && firstFailure != null) {
      return mapError(firstTransient ?? firstFailure, path);
    }
    return { ok: true, data };
  } catch (err) {
    return mapError(err, path);
  }
}

// ── /movers adapter ──────────────────────────────────────────

/**
 * `/movers/$SPX` → `{screeners: [...]}` from the UW stock screener
 * (S&P 500 constituents ordered by percent change). Percent change is
 * DERIVED from close vs prev_close — accepted semantic drift per spec.
 */
export async function moversAdapter(path: string): Promise<ApiResult<unknown>> {
  try {
    const q = parseQuery(path);
    const sort = q.get('sort') ?? 'percent_change_up';
    const down = sort.includes('down');
    const rows = await uwFetch<UwScreenerRow>(
      uwKey(),
      `/screener/stocks?is_s_p_500=true&order=perc_change` +
        `&order_direction=${down ? 'asc' : 'desc'}&limit=10`,
    );

    const screeners = rows
      .map((r) => {
        const close = num(r.close) ?? 0;
        const prev = num(r.prev_close) ?? 0;
        const change = prev > 0 ? round2(((close - prev) / prev) * 100) : 0;
        return {
          symbol: r.ticker ?? '',
          description: r.full_name ?? r.ticker ?? '',
          change,
          direction: down ? 'down' : 'up',
          last: close,
          totalVolume: num(r.stock_volume) ?? 0,
        };
      })
      .sort((a, b) => (down ? a.change - b.change : b.change - a.change));

    return { ok: true, data: { screeners } };
  } catch (err) {
    return mapError(err, path);
  }
}
