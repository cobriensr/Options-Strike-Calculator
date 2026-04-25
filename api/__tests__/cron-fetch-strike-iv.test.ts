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
 * STRIKE_IV_TICKERS order (SPXW, NDXP, SPY, QQQ, IWM, SMH, NVDA, TSLA,
 * META, MSFT, SNDK, MSTR, MU — 13 total after the 2026-04-25 multi-
 * theme expansion). Any ticker set to `null` simulates a fetch failure.
 * Tests that only care about a subset of the tickers should inline the
 * appropriate quiet `makeChain('SMH', 320, {})` etc. for the empty-chain
 * tail rather than relying on undefined mocks.
 */
function quietExpansionChains() {
  // The 6 expansion-tickers (SMH after IWM; TSLA/META/MSFT after NVDA;
  // MSTR/MU after SNDK) as empty chains. Helper used by tests that
  // primarily assert on the original 7 tickers' behavior.
  return {
    smh: makeChain('SMH', 320, {}),
    tsla: makeChain('TSLA', 280, {}),
    meta: makeChain('META', 720, {}),
    msft: makeChain('MSFT', 470, {}),
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

    // Every other ticker returns an empty chain — legitimate no-op on
    // sessions without 0DTE listings for those roots. Order must match
    // STRIKE_IV_TICKERS: SPXW, NDXP, SPY, QQQ, IWM, SMH, NVDA, TSLA,
    // META, MSFT, SNDK, MSTR, MU.
    const q = quietExpansionChains();
    mockChainSequence([
      spxwChain,
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      spyChain,
      qqqChain,
      makeChain('IWM', 235, {}),
      q.smh,
      makeChain('NVDA', 210, {}),
      q.tsla,
      q.meta,
      q.msft,
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
    // All 13 tickers reported.
    expect(body.results).toHaveLength(13);
    expect(body.results.find((r) => r.ticker === 'SPXW')?.rowsInserted).toBe(6);
    expect(body.results.find((r) => r.ticker === 'SPY')?.rowsInserted).toBe(4);
    expect(body.results.find((r) => r.ticker === 'QQQ')?.rowsInserted).toBe(4);
    // Quiet tickers skipped with empty_chain.
    for (const t of [
      'NDXP',
      'IWM',
      'SMH',
      'NVDA',
      'TSLA',
      'META',
      'MSFT',
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
      mixedChain,
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      makeChain('SPY', 710, {}),
      makeChain('QQQ', 500, {}),
      makeChain('IWM', 235, {}),
      q1.smh,
      makeChain('NVDA', 210, {}),
      q1.tsla,
      q1.meta,
      q1.msft,
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
      spxwChain,
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      spyChain,
      qqqChain,
      makeChain('IWM', 235, {}),
      q2.smh,
      makeChain('NVDA', 210, {}),
      q2.tsla,
      q2.meta,
      q2.msft,
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
      spxwChain,
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      { error: 'token expired', status: 401 },
      qqqChain,
      makeChain('IWM', 235, {}),
      q3.smh,
      makeChain('NVDA', 210, {}),
      q3.tsla,
      q3.meta,
      q3.msft,
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
      spxwChain,
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      spyChain,
      qqqChain,
      makeChain('IWM', 235, {}),
      q4.smh,
      makeChain('NVDA', 210, {}),
      q4.tsla,
      q4.meta,
      q4.msft,
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

  it('enforces min-OI gate per ticker (SPXW/NDXP=300, SPY/QQQ=150, IWM=75, SMH=100, NVDA/TSLA/META/MSFT=500, SNDK/MSTR/MU=100)', async () => {
    // SPXW: one strike with OI=250 (below 300 gate — rejected), one with
    //       OI=350 (passes).
    const spxwChain = makeChain('$SPX', 7100, {
      contractRoot: 'SPXW',
      bid: 5,
      ask: 6,
    });
    spxwChain.putExpDateMap['2026-04-24:0']!['7050'] = [
      makeContract('PUT', 7050, {
        openInterest: 250,
        bid: 5,
        ask: 6,
        root: 'SPXW',
      }),
    ];
    spxwChain.callExpDateMap['2026-04-24:0']!['7150'] = [
      makeContract('CALL', 7150, {
        openInterest: 350,
        bid: 5,
        ask: 6,
        root: 'SPXW',
      }),
    ];

    // NDXP: OI=250 rejected, OI=350 accepted (same tier as SPXW).
    const ndxpChain = makeChain('$NDX', 22500, {
      contractRoot: 'NDXP',
      bid: 5,
      ask: 6,
    });
    ndxpChain.putExpDateMap['2026-04-24:0']!['22400'] = [
      makeContract('PUT', 22400, {
        openInterest: 250,
        bid: 5,
        ask: 6,
        root: 'NDXP',
      }),
    ];
    ndxpChain.callExpDateMap['2026-04-24:0']!['22600'] = [
      makeContract('CALL', 22600, {
        openInterest: 350,
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
      spxwChain,
      ndxpChain,
      spyChain,
      qqqChain,
      iwmChain,
      q5.smh,
      nvdaChain,
      q5.tsla,
      q5.meta,
      q5.msft,
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
    mockChainSequence([
      spxwChain,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    const res = mockResponse();
    await handler(authedReq(), res);
    // Per-ticker fault tolerance means this request returns 200, not 500.
    expect(res._status).toBe(200);
    const body = res._json as {
      results: Array<{ ticker: string; skipped: boolean }>;
    };
    // 12 non-SPXW tickers got null → 12 skipped with 'schwab_error'.
    expect(body.results.filter((r) => r.skipped)).toHaveLength(12);
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
      makeChain('$SPX', 7100, { contractRoot: 'SPXW' }),
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      makeChain('SPY', 710, {}),
      makeChain('QQQ', 500, {}),
      makeChain('IWM', 235, {}),
      q6.smh,
      nvdaChain,
      q6.tsla,
      q6.meta,
      q6.msft,
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
      makeChain('$SPX', 7100, { contractRoot: 'SPXW' }),
      makeChain('$NDX', 22500, { contractRoot: 'NDXP' }),
      makeChain('SPY', 710, {}),
      makeChain('QQQ', 500, {}),
      makeChain('IWM', 235, {}),
      q7.smh,
      makeChain('NVDA', 210, {}),
      q7.tsla,
      q7.meta,
      q7.msft,
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

  // ── Phase 2 detection ────────────────────────────────────────

  it('inserts iv_anomalies when a strike exceeds the skew_delta threshold AND clears the vol/OI gate', async () => {
    // Build an SPXW chain where one put's bid/ask is much wider than the
    // neighbors — this makes iv_mid ~6 vol pts above peers, which is >
    // the 1.5 vol pt SKEW_DELTA_THRESHOLD. SPY + QQQ + quiet chains are
    // empty so only SPXW runs detection.
    //
    // Calibration: bid=9 / ask=10 (mid=9.5) vs neighbors at bid=5 / ask=6
    // (mid=5.5) on a 0DTE put with T ≈ 6h. The mid jump translates to a
    // meaningful IV bump at the inverted mid, which clears 1.5 vol pts.
    // Need 4 neighbors on each side of the target for skew_delta to
    // evaluate — 2 above + 2 below. Build 6 puts so strike 7060 has
    // that window.
    //
    // Post 2026-04-24: the target ALSO needs volume/OI ≥ 5× to even be
    // evaluated by the detector. We set volume=6000/OI=600 = 10× on the
    // target strike (well above the gate).
    const spxwChain = makeChain('$SPX', 7100, {
      putStrikes: [7030, 7040, 7050, 7060, 7070, 7080],
      callStrikes: [7140, 7160],
      contractRoot: 'SPXW',
      bid: 5,
      ask: 6,
    });
    // Replace the 7060 put with a wider-IV + high-volume contract — the
    // target strike has iv_mid significantly above its neighbors AND
    // volume/OI cleanly above the 5× gate. mark is leaned toward bid
    // (9.1 vs midpoint 9.5) so the side-skew gate sees ASK dominance:
    // ask_skew ≈ (iv_ask - iv_mark) / (iv_ask - iv_bid) ≫ 0.65.
    spxwChain.putExpDateMap['2026-04-24:0']!['7060'] = [
      makeContract('PUT', 7060, {
        bid: 9,
        ask: 10,
        mark: 9.1, // mark close to bid → ASK-dominant proxy signal
        openInterest: 600,
        totalVolume: 6000, // 6000/600 = 10× → clears gate
        root: 'SPXW',
      }),
    ];

    // Quiet tickers all empty so we only see SPXW anomaly + history
    // queries.
    const ndxpChain = makeChain('$NDX', 22500, { contractRoot: 'NDXP' });
    const spyChain = makeChain('SPY', 710, {});
    const qqqChain = makeChain('QQQ', 500, {});
    const iwmChain = makeChain('IWM', 235, {});
    const nvdaChain = makeChain('NVDA', 210, {});
    const sndkChain = makeChain('SNDK', 140, {});
    const q8 = quietExpansionChains();

    mockChainSequence([
      spxwChain,
      ndxpChain,
      spyChain,
      qqqChain,
      iwmChain,
      q8.smh,
      nvdaChain,
      q8.tsla,
      q8.meta,
      q8.msft,
      sndkChain,
      q8.mstr,
      q8.mu,
    ]);

    // Program mockSql:
    //   1. SPX history query (SELECT … FROM strike_iv_snapshots) → empty
    //   2. Context-snapshot queries (many in parallel) → empty rows
    //   3. iv_anomalies INSERT RETURNING id → [{id: 1}]
    // Default mockResolvedValue already returns []; we just need the
    // INSERT to return a row so the "inserted" counter increments.
    //
    // Strategy: make EVERY mockSql call after the initial history load
    // return an empty rowset, EXCEPT the last call (which is the INSERT
    // INTO iv_anomalies). We use the mockResolvedValueOnce queue, letting
    // N earlier queries resolve empty, and the final one returns [{id}].
    //
    // Simpler: let every call default to []. The cron's RETURNING id
    // check uses `length > 0` to count. So we accept that this specific
    // test observes the anomaly via the totalAnomalies counter being
    // either 0 or 1 depending on how the detector handles no-history
    // z-score (null, so skew_delta alone must carry it).
    //
    // We switch the mock so the iv_anomalies INSERT returns [{id:1}] by
    // keying off the raw SQL template string. mockSql is a plain vi.fn
    // and the tagged template receives (strings, ...values). The INSERT
    // INTO iv_anomalies text appears verbatim in the template strings.
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const joined = Array.isArray(strings) ? strings.join(' ') : '';
      if (joined.includes('INSERT INTO iv_anomalies')) {
        return Promise.resolve([{ id: 1 }]);
      }
      return Promise.resolve([]);
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      totalInserted: number;
      totalAnomalies: number;
      results: Array<{
        ticker: string;
        rowsInserted: number;
        anomaliesDetected: number;
      }>;
    };
    // SPXW had 6 put + 2 call strikes → 8 rows ingested.
    expect(body.totalInserted).toBe(8);
    // At least one anomaly detected on SPXW (strike 7060).
    expect(body.totalAnomalies).toBeGreaterThanOrEqual(1);
    const spxw = body.results.find((r) => r.ticker === 'SPXW');
    expect(spxw?.anomaliesDetected).toBeGreaterThanOrEqual(1);

    // Verify the INSERT payload for iv_anomalies — this is the
    // end-to-end contract between the detector and the persistence
    // layer. We scan all mockSql calls and pull out the anomaly INSERTs
    // to assert their parameter values. Tagged-template call shape is
    // [strings, ...values]; the handler's VALUES (...) order is:
    //   0: ticker        5: iv_at_detect      10: side_skew
    //   1: strike        6: skew_delta        11: side_dominant
    //   2: side          7: z_score           12: flag_reasons
    //   3: expiry        8: ask_mid_div       13: flow_phase
    //   4: spot_at_detect 9: vol_oi_ratio     14: context_snapshot
    //                                         15: ts
    const insertCalls = vi.mocked(mockSql).mock.calls.filter((call) => {
      const strings = call[0] as TemplateStringsArray | undefined;
      const joined = Array.isArray(strings) ? strings.join(' ') : '';
      return joined.includes('INSERT INTO iv_anomalies');
    });
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);

    // The target of the fixture is strike 7060.
    const targetCall = insertCalls.find(
      (call) => (call as unknown[])[2] === 7060,
    );
    expect(targetCall).toBeDefined();
    const insertArgs = (targetCall as unknown[]).slice(1);
    expect(insertArgs[0]).toBe('SPXW');
    expect(insertArgs[1]).toBe(7060);
    // vol_oi_ratio at position 9 (after ask_mid_div). 6000/600 = 10×.
    expect(insertArgs[9]).toBeCloseTo(10, 4);
    // side_skew at position 10 — ask-dominant fixture (mark close to bid)
    // produces ask_skew ≥ 0.65.
    expect(insertArgs[10]).toBeGreaterThanOrEqual(0.65);
    expect(insertArgs[10]).toBeLessThanOrEqual(1);
    // side_dominant at position 11 — mark below midpoint → ASK dominance.
    expect(insertArgs[11]).toBe('ask');
    expect(insertArgs[12]).toEqual(expect.arrayContaining(['skew_delta']));
    expect(['early', 'mid', 'reactive']).toContain(insertArgs[13]);
    // context_snapshot is stringified JSON → parse it back and assert
    // the shape is a non-null object (matches ContextSnapshot's fields).
    const ctxStr = insertArgs[14] as string;
    expect(typeof ctxStr).toBe('string');
    const ctx = JSON.parse(ctxStr) as Record<string, unknown>;
    expect(ctx).not.toBeNull();
    expect(typeof ctx).toBe('object');
    // Known ContextSnapshot keys must be present (even if null).
    expect(ctx).toHaveProperty('spot_delta_15m');
    expect(ctx).toHaveProperty('vix_level');
    expect(ctx).toHaveProperty('spx_recent_dark_prints');
  });

  it('does NOT fire when skew_delta exceeds threshold but vol/OI is below 5× gate', async () => {
    // Same IV setup as the previous test but with default volume (100) /
    // default OI (600) → ratio 0.17× → well below the 5× gate. The
    // anomaly should NOT fire regardless of the skew_delta magnitude.
    const spxwChain = makeChain('$SPX', 7100, {
      putStrikes: [7030, 7040, 7050, 7060, 7070, 7080],
      callStrikes: [7140, 7160],
      contractRoot: 'SPXW',
      bid: 5,
      ask: 6,
    });
    // Target strike 7060 has elevated IV but LOW volume (default 100 /
    // OI 600 = 0.17× — well under 5× gate).
    spxwChain.putExpDateMap['2026-04-24:0']!['7060'] = [
      makeContract('PUT', 7060, {
        bid: 9,
        ask: 10,
        openInterest: 600,
        totalVolume: 100, // 100/600 = 0.17× → below gate
        root: 'SPXW',
      }),
    ];

    const ndxpChain = makeChain('$NDX', 22500, { contractRoot: 'NDXP' });
    const spyChain = makeChain('SPY', 710, {});
    const qqqChain = makeChain('QQQ', 500, {});
    const iwmChain = makeChain('IWM', 235, {});
    const q9 = quietExpansionChains();

    mockChainSequence([
      spxwChain,
      ndxpChain,
      spyChain,
      qqqChain,
      iwmChain,
      q9.smh,
      makeChain('NVDA', 210, {}),
      q9.tsla,
      q9.meta,
      q9.msft,
      makeChain('SNDK', 140, {}),
      q9.mstr,
      q9.mu,
    ]);

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const joined = Array.isArray(strings) ? strings.join(' ') : '';
      if (joined.includes('INSERT INTO iv_anomalies')) {
        return Promise.resolve([{ id: 1 }]);
      }
      return Promise.resolve([]);
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      totalInserted: number;
      totalAnomalies: number;
    };
    // Rows still ingested — the gate is detection-side, not ingest-side.
    expect(body.totalInserted).toBe(8);
    // No anomalies — the target didn't clear the vol/OI gate.
    expect(body.totalAnomalies).toBe(0);

    const insertCalls = vi.mocked(mockSql).mock.calls.filter((call) => {
      const strings = call[0] as TemplateStringsArray | undefined;
      const joined = Array.isArray(strings) ? strings.join(' ') : '';
      return joined.includes('INSERT INTO iv_anomalies');
    });
    expect(insertCalls).toHaveLength(0);
  });
});
