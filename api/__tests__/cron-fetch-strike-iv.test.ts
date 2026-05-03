// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
//
// cronGuard is re-exported from api-helpers.ts, so we mock the whole module
// and implement cronGuard with a simple stub that mirrors its production
// contract: auth-check via process.env.CRON_SECRET, market-hours check,
// return { apiKey, today }. schwabFetch is a vi.fn() that each test can
// program per ticker via mockResolvedValueOnce.

// Shared mutable mock for the Neon tagged template — same pattern as
// cron-compute-zero-gamma.test.ts.
const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
  transaction: vi.fn(),
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

// Redis is used by the Phase 2 context-snapshot collector (VIX1D). In
// tests we don't have Upstash env vars, so the real client hangs with
// retries. Stub it to a resolved-null so the detection path returns
// quickly.
vi.mock('../_lib/schwab.js', () => ({
  redis: { get: vi.fn().mockResolvedValue(null) },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  // Programmable Schwab fetch.
  schwabFetch: vi.fn(),
  // Real implementation — preserves call ordering by sharing a cursor.
  // Worker idx 0 calls schwabFetch first, yielding the first
  // `mockResolvedValueOnce` queue entry; runners then pull subsequent
  // indices in order, so the mock-queue contract is unchanged.
  mapWithConcurrency: async <T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, idx: number) => Promise<R>,
  ): Promise<R[]> => {
    if (items.length === 0) return [];
    const results = new Array<R>(items.length);
    let cursor = 0;
    const runner = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor;
        cursor += 1;
        results[idx] = await worker(items[idx]!, idx);
      }
    };
    const runnerCount = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: runnerCount }, runner));
    return results;
  },
  // Re-implemented cronGuard that matches the production contract but
  // reads from the test's env + fake timers.
  cronGuard: vi.fn((req, res) => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'GET only' });
      return null;
    }
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    const authHeader = req.headers.authorization ?? '';
    if (authHeader !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    // Off-hours check: MARKET_TIME (13:00-21:00 UTC on weekdays) is "open",
    // everything else returns skipped. Minimal but faithful to production.
    const now = new Date();
    const utcDay = now.getUTCDay();
    const utcHour = now.getUTCHours();
    const isMarketHours =
      utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour <= 21;
    if (!isMarketHours) {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    }
    return {
      apiKey: '',
      today: now.toISOString().slice(0, 10),
    };
  }),
}));

import handler from '../cron/fetch-strike-iv.js';
import { schwabFetch } from '../_lib/api-helpers.js';

// ── Fixtures ──────────────────────────────────────────────────

// 2026-04-24 is a Friday — by design, so `buildExpirySet` yields today +
// next 2 Fridays = [2026-04-24, 2026-05-01, 2026-05-08]. Testing at 14:30Z
// (10:30 AM ET) puts us mid-session.
const MARKET_TIME = new Date('2026-04-24T14:30:00.000Z');
const OFF_HOURS_TIME = new Date('2026-04-24T11:00:00.000Z');

/**
 * Build a Schwab option contract. Price + strike are sized to invert
 * cleanly for an OTM put/call near a spot of 7100 (SPXW) or 710 (SPY/QQQ).
 *
 * `root` populates the OSI symbol prefix so the cron's root-filter can
 * distinguish SPXW from SPX (and NDXP from NDX) inside a shared `$SPX` /
 * `$NDX` chain response. Defaults to 'SPY' which the cron treats as a
 * root-unique ETF (no filtering applied).
 */
function makeContract(
  putCall: 'PUT' | 'CALL',
  strike: number,
  overrides: Partial<{
    bid: number;
    ask: number;
    mark: number;
    totalVolume: number;
    openInterest: number;
    root: string;
  }> = {},
) {
  const root = overrides.root ?? 'SPY';
  const bid = overrides.bid ?? 2.0;
  const ask = overrides.ask ?? 2.5;
  // Default mark = midpoint. Tests that exercise the side-skew gate
  // override `mark` to lean toward bid (ask-dominant) or ask (bid-dominant).
  const mark = overrides.mark ?? (bid + ask) / 2;
  return {
    putCall,
    // OSI-ish symbol: `<root-padded> <YYMMDD><C|P><strike-pad>`. The
    // cron splits on whitespace and compares the first token to ticker.
    symbol: `${root.padEnd(6)}260424${putCall === 'PUT' ? 'P' : 'C'}${String(Math.round(strike * 1000)).padStart(8, '0')}`,
    bid,
    ask,
    mark,
    totalVolume: overrides.totalVolume ?? 100,
    openInterest: overrides.openInterest ?? 600,
    strikePrice: strike,
    daysToExpiration: 0,
    expirationDate: '2026-04-24T21:00:00.000Z',
  };
}

/**
 * Build a chain response with a handful of OTM puts + calls bracketing a
 * given spot for a single 0DTE expiry (today). `expiry` defaults to
 * 2026-04-24 which matches MARKET_TIME.
 *
 * `symbol` is the Schwab chain-endpoint symbol (e.g. `$SPX`, `$NDX`,
 * `SPY`). `contractRoot` is the OSI root the cron's filter will match
 * on — defaults to the symbol stripped of `$`. This keeps SPXW/NDXP
 * chains producing contracts whose root is SPXW/NDXP (not SPX/NDX).
 */
function makeChain(
  symbol: string,
  spot: number,
  opts: {
    expiry?: string;
    putStrikes?: number[];
    callStrikes?: number[];
    contractRoot?: string;
    openInterest?: number;
    bid?: number;
    ask?: number;
    totalVolume?: number;
  } = {},
) {
  const expiry = opts.expiry ?? '2026-04-24';
  const expKey = `${expiry}:0`;
  // Default contract root strips the `$` prefix from the chain symbol
  // (SPY→SPY, $SPX→SPX). Callers should pass explicit `contractRoot:
  // 'SPXW'` or `'NDXP'` when building a mixed index chain response.
  const defaultRoot = symbol.replace(/^\$/, '');
  const root = opts.contractRoot ?? defaultRoot;
  const callExpDateMap: Record<
    string,
    Record<string, ReturnType<typeof makeContract>[]>
  > = { [expKey]: {} };
  const putExpDateMap: Record<
    string,
    Record<string, ReturnType<typeof makeContract>[]>
  > = { [expKey]: {} };
  for (const strike of opts.callStrikes ?? []) {
    callExpDateMap[expKey]![String(strike)] = [
      makeContract('CALL', strike, {
        openInterest: opts.openInterest ?? 600,
        bid: opts.bid,
        ask: opts.ask,
        totalVolume: opts.totalVolume,
        root,
      }),
    ];
  }
  for (const strike of opts.putStrikes ?? []) {
    putExpDateMap[expKey]![String(strike)] = [
      makeContract('PUT', strike, {
        openInterest: opts.openInterest ?? 600,
        bid: opts.bid,
        ask: opts.ask,
        totalVolume: opts.totalVolume,
        root,
      }),
    ];
  }
  return {
    symbol,
    status: 'SUCCESS',
    underlying: { symbol, last: spot, close: spot },
    callExpDateMap,
    putExpDateMap,
  };
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

/**
 * Feed the schwabFetch mock a fresh chain for each ticker in
 * STRIKE_IV_TICKERS order (SPY, SPXW, NDXP, RUTW, QQQ, IWM, SMH, NVDA,
 * TSLA, META, MSFT, GOOGL, NFLX, TSM, SNDK, MSTR, MU — 17 total after the
 * 2026-04-29 outlier-driven additions). Any ticker set to `null`
 * simulates a fetch failure.
 */
function quietExpansionChains() {
  // The expansion/empty-chain helpers — quiet entries for tests that
  // primarily assert on a subset of tickers.
  return {
    rutw: makeChain('$RUT', 2400, { contractRoot: 'RUTW' }),
    smh: makeChain('SMH', 320, {}),
    tsla: makeChain('TSLA', 280, {}),
    meta: makeChain('META', 720, {}),
    msft: makeChain('MSFT', 470, {}),
    googl: makeChain('GOOGL', 180, {}),
    nflx: makeChain('NFLX', 700, {}),
    tsm: makeChain('TSM', 220, {}),
    mstr: makeChain('MSTR', 380, {}),
    mu: makeChain('MU', 180, {}),
  };
}
type ChainOrError =
  | ReturnType<typeof makeChain>
  | { error: string; status: number };

function mockChainSequence(chains: (ChainOrError | null)[]) {
  const mocked = vi.mocked(schwabFetch);
  mocked.mockReset();
  for (const chain of chains) {
    if (chain == null) {
      mocked.mockResolvedValueOnce({
        ok: false,
        error: 'fetch failed',
        status: 500,
      });
    } else if ('error' in chain) {
      mocked.mockResolvedValueOnce({
        ok: false,
        error: chain.error,
        status: chain.status,
      });
    } else {
      // The cron reads only `underlying`, `callExpDateMap`, `putExpDateMap`
      // from the chain — coercing through `unknown` lets us supply the
      // shape-compatible subset without enumerating every Schwab field.
      mocked.mockResolvedValueOnce({
        ok: true,
        data: chain as unknown as Awaited<
          ReturnType<typeof schwabFetch>
        > extends { ok: true; data: infer D }
          ? D
          : never,
      });
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────

describe('fetch-strike-iv handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_TIME);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';

    // Default: transaction() returns the mapped promises resolved with
    // one "inserted" row id each. Individual tests override as needed.
    mockSql.transaction.mockImplementation(
      async (cb: (txn: typeof mockSql) => Promise<unknown[]>[]) => {
        const txn = Object.assign(vi.fn().mockResolvedValue([{ id: 1 }]), {
          transaction: vi.fn(),
        });
        const promises = cb(txn);
        return Promise.all(promises);
      },
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Auth guard ──────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(schwabFetch).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Market hours guard ─────────────────────────────────────

  it('skips outside market hours without calling Schwab or DB', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(schwabFetch).not.toHaveBeenCalled();
    expect(mockSql.transaction).not.toHaveBeenCalled();
  });

  // ── Happy path: 3 index/ETF tickers all return valid chains ─

  it('inserts per-strike IV rows for SPXW/SPY/QQQ and skips other tickers when chains are empty', async () => {
    // SPXW chain is fetched via `$SPX` and contains SPXW-rooted contracts.
    const spxwChain = makeChain('$SPX', 7100, {
      putStrikes: [7020, 7050, 7080],
      callStrikes: [7120, 7150, 7180],
      contractRoot: 'SPXW',
      bid: 5,
      ask: 6,
    });
    const spyChain = makeChain('SPY', 710, {
      putStrikes: [700, 705],
      callStrikes: [715, 720],
      bid: 0.8,
      ask: 1.0,
    });
    const qqqChain = makeChain('QQQ', 500, {
      putStrikes: [490, 495],
      callStrikes: [505, 510],
      bid: 0.6,
      ask: 0.8,
    });

    // Order must match STRIKE_IV_TICKERS: SPY, SPXW, NDXP, RUTW, QQQ, IWM,
    // SMH, NVDA, TSLA, META, MSFT, GOOGL, NFLX, TSM, SNDK, MSTR, MU.
    const q = quietExpansionChains();
    mockChainSequence([
      spyChain,
      spxwChain,
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      q.rutw,
      qqqChain,
      makeChain('IWM', 235, {}),
      q.smh,
      makeChain('NVDA', 210, {}),
      q.tsla,
      q.meta,
      q.msft,
      q.googl,
      q.nflx,
      q.tsm,
      makeChain('SNDK', 140, {}),
      q.mstr,
      q.mu,
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      totalInserted: number;
      results: Array<{
        ticker: string;
        rowsInserted: number;
        skipped: boolean;
        reason?: string;
      }>;
    };
    // SPXW: 6 strikes; SPY: 4; QQQ: 4 → 14 total.
    expect(body.totalInserted).toBe(14);
    // All 17 tickers reported.
    expect(body.results).toHaveLength(17);
    expect(body.results.find((r) => r.ticker === 'SPXW')?.rowsInserted).toBe(6);
    expect(body.results.find((r) => r.ticker === 'SPY')?.rowsInserted).toBe(4);
    expect(body.results.find((r) => r.ticker === 'QQQ')?.rowsInserted).toBe(4);
    // Quiet tickers skipped with empty_chain.
    for (const t of [
      'NDXP',
      'RUTW',
      'IWM',
      'SMH',
      'NVDA',
      'TSLA',
      'META',
      'MSFT',
      'GOOGL',
      'NFLX',
      'TSM',
      'SNDK',
      'MSTR',
      'MU',
    ]) {
      expect(body.results.find((r) => r.ticker === t)).toMatchObject({
        rowsInserted: 0,
        skipped: true,
        reason: 'empty_chain',
      });
    }
    // Three transactions (the three tickers that had rows).
    expect(mockSql.transaction).toHaveBeenCalledTimes(3);
  });

  // ── SPXW root filter drops SPX monthlies under the `$SPX` chain ─

  it('filters out SPX-rooted contracts when fetching SPXW (Schwab mixes both roots under $SPX)', async () => {
    // Chain returned by `$SPX` contains BOTH SPXW weeklies AND SPX
    // monthlies. The cron must keep only SPXW.
    const mixedChain = makeChain('$SPX', 7100, {
      contractRoot: 'SPXW', // baseline root
      bid: 5,
      ask: 6,
    });
    // Two SPXW weekly contracts (should be ingested).
    mixedChain.putExpDateMap['2026-04-24:0']!['7050'] = [
      makeContract('PUT', 7050, { root: 'SPXW', bid: 5, ask: 6 }),
    ];
    mixedChain.callExpDateMap['2026-04-24:0']!['7150'] = [
      makeContract('CALL', 7150, { root: 'SPXW', bid: 5, ask: 6 }),
    ];
    // Two SPX monthly contracts under the SAME expiry key (edge case but
    // possible on 3rd-Friday). They should NOT be ingested.
    mixedChain.putExpDateMap['2026-04-24:0']!['7040'] = [
      makeContract('PUT', 7040, { root: 'SPX', bid: 5, ask: 6 }),
    ];
    mixedChain.callExpDateMap['2026-04-24:0']!['7160'] = [
      makeContract('CALL', 7160, { root: 'SPX', bid: 5, ask: 6 }),
    ];

    const q1 = quietExpansionChains();
    mockChainSequence([
      makeChain('SPY', 710, {}),
      mixedChain,
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      q1.rutw,
      makeChain('QQQ', 500, {}),
      makeChain('IWM', 235, {}),
      q1.smh,
      makeChain('NVDA', 210, {}),
      q1.tsla,
      q1.meta,
      q1.msft,
      q1.googl,
      q1.nflx,
      q1.tsm,
      makeChain('SNDK', 140, {}),
      q1.mstr,
      q1.mu,
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as {
      totalInserted: number;
      results: Array<{ ticker: string; rowsInserted: number }>;
    };
    // Only the 2 SPXW-rooted contracts (7050 put + 7150 call) survive.
    expect(body.results.find((r) => r.ticker === 'SPXW')?.rowsInserted).toBe(2);
    expect(body.totalInserted).toBe(2);
  });

  // ── Empty chain for one ticker, others proceed ────────────

  it('skips tickers with empty chains without blocking others', async () => {
    const spxwChain = makeChain('$SPX', 7100, {
      putStrikes: [7050, 7080],
      callStrikes: [7120, 7150],
      contractRoot: 'SPXW',
      bid: 5,
      ask: 6,
    });
    // SPY chain has no strikes at all → 0 rows, skipped=true.
    const spyChain = makeChain('SPY', 710, { putStrikes: [], callStrikes: [] });
    const qqqChain = makeChain('QQQ', 500, {
      putStrikes: [495],
      callStrikes: [505],
      bid: 0.6,
      ask: 0.8,
    });

    const q2 = quietExpansionChains();
    mockChainSequence([
      spyChain,
      spxwChain,
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      q2.rutw,
      qqqChain,
      makeChain('IWM', 235, {}),
      q2.smh,
      makeChain('NVDA', 210, {}),
      q2.tsla,
      q2.meta,
      q2.msft,
      q2.googl,
      q2.nflx,
      q2.tsm,
      makeChain('SNDK', 140, {}),
      q2.mstr,
      q2.mu,
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      totalInserted: number;
      results: Array<{
        ticker: string;
        rowsInserted: number;
        skipped: boolean;
        reason?: string;
      }>;
    };
    expect(body.totalInserted).toBe(6); // 4 SPXW + 0 SPY + 2 QQQ
    const spy = body.results.find((r) => r.ticker === 'SPY');
    expect(spy).toMatchObject({
      rowsInserted: 0,
      skipped: true,
      reason: 'empty_chain',
    });
    const spxw = body.results.find((r) => r.ticker === 'SPXW');
    expect(spxw).toMatchObject({ rowsInserted: 4, skipped: false });
    const qqq = body.results.find((r) => r.ticker === 'QQQ');
    expect(qqq).toMatchObject({ rowsInserted: 2, skipped: false });
    // Two transactions (SPXW + QQQ); everything else returned empty
    // chains.
    expect(mockSql.transaction).toHaveBeenCalledTimes(2);
  });

  // ── Schwab auth error for one ticker, others proceed ──────

  it('logs and continues when one ticker Schwab fetch fails', async () => {
    const spxwChain = makeChain('$SPX', 7100, {
      putStrikes: [7050],
      callStrikes: [7150],
      contractRoot: 'SPXW',
      bid: 5,
      ask: 6,
    });
    const qqqChain = makeChain('QQQ', 500, {
      putStrikes: [495],
      callStrikes: [505],
      bid: 0.6,
      ask: 0.8,
    });

    // SPY returns a 401 (expired token) — must not abort SPXW or QQQ
    // or the other tickers.
    const q3 = quietExpansionChains();
    mockChainSequence([
      { error: 'token expired', status: 401 },
      spxwChain,
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      q3.rutw,
      qqqChain,
      makeChain('IWM', 235, {}),
      q3.smh,
      makeChain('NVDA', 210, {}),
      q3.tsla,
      q3.meta,
      q3.msft,
      q3.googl,
      q3.nflx,
      q3.tsm,
      makeChain('SNDK', 140, {}),
      q3.mstr,
      q3.mu,
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      totalInserted: number;
      results: Array<{
        ticker: string;
        rowsInserted: number;
        skipped: boolean;
        reason?: string;
      }>;
    };
    // SPXW: 2 rows, SPY: 0 (error), QQQ: 2 rows, everything else 0.
    expect(body.totalInserted).toBe(4);
    const spy = body.results.find((r) => r.ticker === 'SPY');
    expect(spy).toMatchObject({
      rowsInserted: 0,
      skipped: true,
      reason: 'schwab_error',
    });
    // SPXW + QQQ actually inserted rows; everything else skipped.
    expect(body.results.filter((r) => !r.skipped)).toHaveLength(2);
  });

  // ── IV inversion fails → row skipped, cron continues ─────

  it('skips strikes whose mid-price is below intrinsic (IV inversion fails)', async () => {
    const spxwChain = makeChain('$SPX', 7100, {
      putStrikes: [7050], // good row
      callStrikes: [7150], // good row
      contractRoot: 'SPXW',
      bid: 5,
      ask: 6,
    });
    // Inject one bad row: a put whose ask > strike — impossible under
    // no-arb, so impliedVolatility() will reject it.
    spxwChain.putExpDateMap['2026-04-24:0']!['7080'] = [
      makeContract('PUT', 7080, {
        bid: 7100, // > strike → violates upper bound for puts
        ask: 7150,
        openInterest: 600,
        root: 'SPXW',
      }),
    ];

    const spyChain = makeChain('SPY', 710, {
      putStrikes: [705],
      callStrikes: [715],
      bid: 0.8,
      ask: 1.0,
    });
    const qqqChain = makeChain('QQQ', 500, {
      putStrikes: [495],
      callStrikes: [505],
      bid: 0.6,
      ask: 0.8,
    });

    const q4 = quietExpansionChains();
    mockChainSequence([
      spyChain,
      spxwChain,
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      q4.rutw,
      qqqChain,
      makeChain('IWM', 235, {}),
      q4.smh,
      makeChain('NVDA', 210, {}),
      q4.tsla,
      q4.meta,
      q4.msft,
      q4.googl,
      q4.nflx,
      q4.tsm,
      makeChain('SNDK', 140, {}),
      q4.mstr,
      q4.mu,
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      totalInserted: number;
      results: Array<{ ticker: string; rowsInserted: number }>;
    };
    // SPXW should have 2 good rows (7050 put + 7150 call); 7080 bad row
    // filtered out at IV-inversion time. Plus 2 SPY + 2 QQQ = 6 total.
    expect(body.totalInserted).toBe(6);
    const spxw = body.results.find((r) => r.ticker === 'SPXW');
    expect(spxw?.rowsInserted).toBe(2);
  });

  // ── OI gate enforcement ──────────────────────────────────

  it('enforces min-OI gate per ticker (SPXW/NDXP=50, SPY/QQQ=150, IWM=75, SMH=100, NVDA/TSLA/META/MSFT=500, SNDK/MSTR/MU=100)', async () => {
    // SPXW: cash-index tier (50) — captures deep-OTM lottery tickets.
    // OI=25 rejected, OI=75 passes.
    const spxwChain = makeChain('$SPX', 7100, {
      contractRoot: 'SPXW',
      bid: 5,
      ask: 6,
    });
    spxwChain.putExpDateMap['2026-04-24:0']!['7050'] = [
      makeContract('PUT', 7050, {
        openInterest: 25,
        bid: 5,
        ask: 6,
        root: 'SPXW',
      }),
    ];
    spxwChain.callExpDateMap['2026-04-24:0']!['7150'] = [
      makeContract('CALL', 7150, {
        openInterest: 75,
        bid: 5,
        ask: 6,
        root: 'SPXW',
      }),
    ];

    // NDXP: OI=25 rejected, OI=75 accepted (same tier as SPXW).
    const ndxpChain = makeChain('$NDX', 22500, {
      contractRoot: 'NDXP',
      bid: 5,
      ask: 6,
    });
    ndxpChain.putExpDateMap['2026-04-24:0']!['22400'] = [
      makeContract('PUT', 22400, {
        openInterest: 25,
        bid: 5,
        ask: 6,
        root: 'NDXP',
      }),
    ];
    ndxpChain.callExpDateMap['2026-04-24:0']!['22600'] = [
      makeContract('CALL', 22600, {
        openInterest: 75,
        bid: 5,
        ask: 6,
        root: 'NDXP',
      }),
    ];

    // SPY: OI=100 rejected (below 150 gate), OI=200 passes.
    const spyChain = makeChain('SPY', 710, { bid: 0.8, ask: 1.0 });
    spyChain.putExpDateMap['2026-04-24:0']!['705'] = [
      makeContract('PUT', 705, { openInterest: 100, bid: 0.8, ask: 1.0 }),
    ];
    spyChain.callExpDateMap['2026-04-24:0']!['715'] = [
      makeContract('CALL', 715, { openInterest: 200, bid: 0.8, ask: 1.0 }),
    ];

    // QQQ: empty (not testing QQQ gate here).
    const qqqChain = makeChain('QQQ', 500, {});

    // IWM: OI=50 rejected (below 75 gate), OI=100 accepted.
    const iwmChain = makeChain('IWM', 235, { bid: 0.5, ask: 0.7 });
    iwmChain.putExpDateMap['2026-04-24:0']!['232'] = [
      makeContract('PUT', 232, { openInterest: 50, bid: 0.5, ask: 0.7 }),
    ];
    iwmChain.callExpDateMap['2026-04-24:0']!['238'] = [
      makeContract('CALL', 238, { openInterest: 100, bid: 0.5, ask: 0.7 }),
    ];

    // NVDA: high-liq tier, 500-OI gate. OI=400 rejected, OI=600 accepted.
    const nvdaChain = makeChain('NVDA', 210, { bid: 0.5, ask: 0.7 });
    nvdaChain.putExpDateMap['2026-04-24:0']!['205'] = [
      makeContract('PUT', 205, { openInterest: 400, bid: 0.5, ask: 0.7 }),
    ];
    nvdaChain.callExpDateMap['2026-04-24:0']!['215'] = [
      makeContract('CALL', 215, { openInterest: 600, bid: 0.5, ask: 0.7 }),
    ];

    // SNDK: single-name mid-tier, 100-OI gate. OI=50 rejected, OI=150
    // accepted. Strikes within ±5% of spot=140 (band = [133, 147]).
    const sndkChain = makeChain('SNDK', 140, { bid: 0.5, ask: 0.7 });
    sndkChain.putExpDateMap['2026-04-24:0']!['137'] = [
      makeContract('PUT', 137, { openInterest: 50, bid: 0.5, ask: 0.7 }),
    ];
    sndkChain.callExpDateMap['2026-04-24:0']!['143'] = [
      makeContract('CALL', 143, { openInterest: 150, bid: 0.5, ask: 0.7 }),
    ];

    const q5 = quietExpansionChains();
    mockChainSequence([
      spyChain,
      spxwChain,
      ndxpChain,
      q5.rutw,
      qqqChain,
      iwmChain,
      q5.smh,
      nvdaChain,
      q5.tsla,
      q5.meta,
      q5.msft,
      q5.googl,
      q5.nflx,
      q5.tsm,
      sndkChain,
      q5.mstr,
      q5.mu,
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as {
      results: Array<{ ticker: string; rowsInserted: number }>;
    };
    // Each ticker that had a gate test: only the above-threshold call
    // strike survives.
    expect(body.results.find((r) => r.ticker === 'SPXW')?.rowsInserted).toBe(1);
    expect(body.results.find((r) => r.ticker === 'NDXP')?.rowsInserted).toBe(1);
    expect(body.results.find((r) => r.ticker === 'SPY')?.rowsInserted).toBe(1);
    expect(body.results.find((r) => r.ticker === 'IWM')?.rowsInserted).toBe(1);
    expect(body.results.find((r) => r.ticker === 'NVDA')?.rowsInserted).toBe(1);
    expect(body.results.find((r) => r.ticker === 'SNDK')?.rowsInserted).toBe(1);
  });

  // ── Error handling (handler-level) ────────────────────────

  it('returns 500 when the transaction throws unexpectedly', async () => {
    const spxwChain = makeChain('$SPX', 7100, {
      putStrikes: [7050],
      callStrikes: [7150],
      contractRoot: 'SPXW',
      bid: 5,
      ask: 6,
    });
    // Everything else gets null chains — only SPXW succeeds, matching
    // the fault-tolerance claim of the cron.
    // STRIKE_IV_TICKERS order: SPY, SPXW, NDXP, RUTW, QQQ, IWM, SMH,
    // NVDA, TSLA, META, MSFT, GOOGL, NFLX, TSM, SNDK, MSTR, MU.
    mockChainSequence([
      null, // SPY
      spxwChain,
      null, // NDXP
      null, // RUTW
      null, // QQQ
      null, // IWM
      null, // SMH
      null, // NVDA
      null, // TSLA
      null, // META
      null, // MSFT
      null, // GOOGL
      null, // NFLX
      null, // TSM
      null, // SNDK
      null, // MSTR
      null, // MU
    ]);
    const res = mockResponse();
    await handler(authedReq(), res);
    // Per-ticker fault tolerance means this request returns 200, not 500.
    expect(res._status).toBe(200);
    const body = res._json as {
      results: Array<{ ticker: string; skipped: boolean }>;
    };
    // 16 non-SPXW tickers got null → 16 skipped with 'schwab_error'.
    expect(body.results.filter((r) => r.skipped)).toHaveLength(16);
  });

  // ── NVDA / SNDK single-name OI tiers (2026-04-24 expansion) ──

  it('applies the 500-OI tier to NVDA (rejects mid-liquidity strikes that would pass single-name tier)', async () => {
    // NVDA is high-liq tier (NVDA/TSLA/META/MSFT share); 500 threshold is
    // higher than the 100 SINGLE_NAME tier so only genuinely-deep strikes
    // contribute. Verify the gate location.
    const nvdaChain = makeChain('NVDA', 210, { bid: 0.5, ask: 0.7 });
    // Boundary probes: OI=499 must be rejected, OI=500 must pass, OI=200
    // (would pass the SNDK tier) must be rejected.
    nvdaChain.putExpDateMap['2026-04-24:0']!['205'] = [
      makeContract('PUT', 205, { openInterest: 200, bid: 0.5, ask: 0.7 }),
    ];
    nvdaChain.putExpDateMap['2026-04-24:0']!['206'] = [
      makeContract('PUT', 206, { openInterest: 499, bid: 0.5, ask: 0.7 }),
    ];
    nvdaChain.callExpDateMap['2026-04-24:0']!['214'] = [
      makeContract('CALL', 214, { openInterest: 500, bid: 0.5, ask: 0.7 }),
    ];
    nvdaChain.callExpDateMap['2026-04-24:0']!['215'] = [
      makeContract('CALL', 215, { openInterest: 5000, bid: 0.5, ask: 0.7 }),
    ];

    // All other tickers empty to isolate the assertion.
    const q6 = quietExpansionChains();
    mockChainSequence([
      makeChain('SPY', 710, {}),
      makeChain('$SPX', 7100, { contractRoot: 'SPXW' }),
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      q6.rutw,
      makeChain('QQQ', 500, {}),
      makeChain('IWM', 235, {}),
      q6.smh,
      nvdaChain,
      q6.tsla,
      q6.meta,
      q6.msft,
      q6.googl,
      q6.nflx,
      q6.tsm,
      makeChain('SNDK', 140, {}),
      q6.mstr,
      q6.mu,
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as {
      results: Array<{ ticker: string; rowsInserted: number }>;
    };
    // Only 214C (OI=500) and 215C (OI=5000) survive the 500-OI gate.
    expect(body.results.find((r) => r.ticker === 'NVDA')?.rowsInserted).toBe(2);
  });

  it('applies the 100-OI tier to SNDK (mid-cap single-name threshold)', async () => {
    // SNDK uses the generic SINGLE_NAME tier (100), well below NVDA's
    // 500 threshold, reflecting its thinner chain. Boundary probes:
    // OI=99 rejected, OI=100 passes. Strikes within ±5% of spot=140
    // (band = [133, 147]).
    const sndkChain = makeChain('SNDK', 140, { bid: 0.5, ask: 0.7 });
    sndkChain.putExpDateMap['2026-04-24:0']!['137'] = [
      makeContract('PUT', 137, { openInterest: 99, bid: 0.5, ask: 0.7 }),
    ];
    sndkChain.callExpDateMap['2026-04-24:0']!['143'] = [
      makeContract('CALL', 143, { openInterest: 100, bid: 0.5, ask: 0.7 }),
    ];
    sndkChain.callExpDateMap['2026-04-24:0']!['144'] = [
      makeContract('CALL', 144, { openInterest: 800, bid: 0.5, ask: 0.7 }),
    ];

    const q7 = quietExpansionChains();
    mockChainSequence([
      makeChain('SPY', 710, {}),
      makeChain('$SPX', 7100, { contractRoot: 'SPXW' }),
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      q7.rutw,
      makeChain('QQQ', 500, {}),
      makeChain('IWM', 235, {}),
      q7.smh,
      makeChain('NVDA', 210, {}),
      q7.tsla,
      q7.meta,
      q7.msft,
      q7.googl,
      q7.nflx,
      q7.tsm,
      sndkChain,
      q7.mstr,
      q7.mu,
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as {
      results: Array<{ ticker: string; rowsInserted: number }>;
    };
    // Two calls pass (OI=200 + OI=800); the OI=199 put is rejected.
    expect(body.results.find((r) => r.ticker === 'SNDK')?.rowsInserted).toBe(2);
  });
});
